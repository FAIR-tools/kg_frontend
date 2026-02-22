"""
Natural Language Query endpoint.

POST /api/nlq  { "question": "Find all samples with 4 atoms" }

The LLM is asked to translate the question into a GuidedQueryRequest JSON,
which is then executed via the existing guided-query logic.

Returns:
  { interpretation: {...}, sparql: str, columns: [...], rows: [...] }
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import json

from app.ontology_state import get_class_list, get_properties_for_class
from app.routes.guided import run_guided_query, GuidedQueryRequest, DestinationItem

router = APIRouter(prefix="/api/nlq", tags=["nlq"])

# Primary source class always available in the KG
_PRIMARY_SOURCE_URI = "http://purls.helmholtz-metadaten.de/cmso/AtomicScaleSample"

# Cache the system prompt once built (building it requires expensive ontology traversal)
_system_prompt_cache: str | None = None


def _build_system_prompt() -> str:
    global _system_prompt_cache
    if _system_prompt_cache is not None:
        return _system_prompt_cache

    # Fetch properties reachable from AtomicScaleSample, cap at 50 to stay within token limits
    try:
        all_props = get_properties_for_class(_PRIMARY_SOURCE_URI)
        # Prefer data properties first; deduplicate and limit
        data_props  = [p for p in all_props if p["property_type"] == "data_property"][:30]
        obj_props   = [p for p in all_props if p["property_type"] == "object_property"][:20]
        primary_props = data_props + obj_props
    except Exception:
        primary_props = []

    BASE = "http://purls.helmholtz-metadaten.de/cmso/"

    prop_lines = "\n".join(
        f"  {p['label']} ({p['property_type'][0]}): {p['uri']}"
        for p in primary_props
    )

    _system_prompt_cache = f"""You are a query-builder for a materials-science RDF knowledge graph (CMSO/ASMO ontologies).

Always use this source class:
  source_uri: {_PRIMARY_SOURCE_URI}

Available destination properties (d=data, o=object):
{prop_lines}

Respond with ONLY a JSON object — no markdown, no explanation:
{{"source_uri":"<uri>","destinations":[{{"uri":"<prop uri>","operator":"<== != > >= < <=  — omit if no filter>","value":"<string — omit if no filter>"}}]}}

Rules: source_uri must be exact. Each destination uri must be exact. Omit operator+value for retrieval-only. Numeric values as strings.

Examples:
Q: samples with 4 atoms → {{"source_uri":"{BASE}AtomicScaleSample","destinations":[{{"uri":"{BASE}hasNumberOfAtoms","operator":"==","value":"4"}}]}}
Q: space group of all samples → {{"source_uri":"{BASE}AtomicScaleSample","destinations":[{{"uri":"{BASE}hasSpaceGroupSymbol"}}]}}
Q: samples with more than 50 atoms → {{"source_uri":"{BASE}AtomicScaleSample","destinations":[{{"uri":"{BASE}hasNumberOfAtoms","operator":">","value":"50"}}]}}
Q: chemical formula of all samples → {{"source_uri":"{BASE}AtomicScaleSample","destinations":[{{"uri":"{BASE}hasChemicalFormula"}}]}}"""

    return _system_prompt_cache


# ── Request / response models ─────────────────────────────────────────────────

class NLQRequest(BaseModel):
    question: str


# ── Route ─────────────────────────────────────────────────────────────────────

@router.post("")
def run_nlq(req: NLQRequest):
    """
    Translate a natural language question to a guided query and execute it.
    """
    # 1. Import the LLM client (guarded so the app starts even if groq is not installed)
    try:
        from app.llm_client import call_llm, LLM_PROVIDER, LLM_API_KEY
    except ImportError as exc:
        raise HTTPException(status_code=503, detail=f"LLM client unavailable: {exc}")

    if LLM_PROVIDER == "groq" and not LLM_API_KEY:
        raise HTTPException(
            status_code=503,
            detail=(
                "LLM_API_KEY is not configured. "
                "Set it in docker-compose.yml and redeploy, "
                "or get a free key at https://console.groq.com"
            ),
        )

    # 2. Build system prompt (cached after first call)
    system_prompt = _build_system_prompt()

    # 3. Call the LLM
    try:
        raw_json = call_llm(system_prompt, req.question)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM request failed: {exc}")

    # 4. Parse JSON
    try:
        parsed = json.loads(raw_json)
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=422,
            detail=f"LLM returned non-JSON output: {raw_json[:300]}",
        )

    # 5. Validate against guided-query schema
    try:
        guided_req = GuidedQueryRequest(
            source_uri=parsed["source_uri"],
            destinations=[DestinationItem(**d) for d in parsed.get("destinations", [])],
        )
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"LLM output doesn't match query schema: {exc}. Raw: {raw_json[:300]}",
        )

    # 6. Execute via existing guided-query logic
    result = run_guided_query(guided_req)   # raises HTTPException on bad URIs

    return {
        "interpretation": parsed,
        **result,
    }
