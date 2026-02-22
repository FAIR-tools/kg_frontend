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

    classes = get_class_list()

    # Fetch properties reachable from AtomicScaleSample (primary source)
    try:
        primary_props = get_properties_for_class(_PRIMARY_SOURCE_URI)
    except Exception:
        primary_props = []

    lines: list[str] = []
    lines.append(
        "You are a query assistant for a materials science RDF knowledge graph "
        "built with the CMSO/ASMO ontologies.\n"
    )

    # ── Available source classes ──────────────────────────────────────────────
    lines.append("## Available source classes (use 'uri' as source_uri)")
    for c in classes:
        lines.append(f"  ns:{c['namespace']}  label:{c['label']}  uri:{c['uri']}")

    # ── Properties reachable from AtomicScaleSample ───────────────────────────
    lines.append(
        f"\n## Properties reachable from AtomicScaleSample  ({_PRIMARY_SOURCE_URI})"
    )
    lines.append("(These are the most common destination properties to query.)")
    if primary_props:
        for p in primary_props:
            lines.append(
                f"  ns:{p['namespace']}  label:{p['label']}  type:{p['property_type']}  uri:{p['uri']}"
            )
    else:
        lines.append("  (none cached yet — check /api/ontology/classes for the full list)")

    # ── Output schema ─────────────────────────────────────────────────────────
    lines.append(
        """
## Output schema
Respond with ONLY a valid JSON object — no explanation, no markdown fences.

{
  "source_uri": "<URI of the starting class>",
  "destinations": [
    {
      "uri": "<URI of a destination property>",
      "operator": "<one of: ==  !=  >  >=  <  <=   — omit the key if no filter>",
      "value": "<filter value as a string — omit the key if no filter>"
    }
  ]
}

Rules:
- source_uri MUST be an exact URI from the class list above.
- Each destination uri MUST be a property URI from the property list above.
- Include a destination WITHOUT operator/value to simply retrieve that property.
- Include operator + value to filter results (e.g. number of atoms == 4).
- Use at least one destination.
- Cast numeric values to strings (e.g. "4", "3.14").
"""
    )

    # ── Few-shot examples ─────────────────────────────────────────────────────
    lines.append(
        """## Examples

User: Find all samples and their space group symbols
{"source_uri":"http://purls.helmholtz-metadaten.de/cmso/AtomicScaleSample","destinations":[{"uri":"http://purls.helmholtz-metadaten.de/cmso/hasSpaceGroupSymbol"}]}

User: Find all samples with exactly 4 atoms
{"source_uri":"http://purls.helmholtz-metadaten.de/cmso/AtomicScaleSample","destinations":[{"uri":"http://purls.helmholtz-metadaten.de/cmso/hasNumberOfAtoms","operator":"==","value":"4"}]}

User: Find samples with more than 100 atoms
{"source_uri":"http://purls.helmholtz-metadaten.de/cmso/AtomicScaleSample","destinations":[{"uri":"http://purls.helmholtz-metadaten.de/cmso/hasNumberOfAtoms","operator":">","value":"100"}]}

User: Show samples with their chemical formula
{"source_uri":"http://purls.helmholtz-metadaten.de/cmso/AtomicScaleSample","destinations":[{"uri":"http://purls.helmholtz-metadaten.de/cmso/hasChemicalFormula"}]}

User: Find samples with cubic crystal structure
{"source_uri":"http://purls.helmholtz-metadaten.de/cmso/AtomicScaleSample","destinations":[{"uri":"http://purls.helmholtz-metadaten.de/cmso/hasCrystalStructure"}]}
"""
    )

    _system_prompt_cache = "\n".join(lines)
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
