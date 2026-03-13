"""
W3C SPARQL 1.1 Protocol-compliant endpoint.

Supports:
  GET  /sparql?query=SELECT...
  POST /sparql  (application/sparql-query or application/x-www-form-urlencoded)

Returns results in application/sparql-results+json (default) or +xml,
depending on the Accept header.  CONSTRUCT/DESCRIBE return text/turtle.

Read-only: INSERT, DELETE, LOAD, CLEAR, DROP, CREATE, COPY, MOVE, ADD
are rejected with 403.

Intended for federation (SERVICE <url>) and tools like SHMARQL.
"""

from __future__ import annotations

import re
from urllib.parse import parse_qs

from fastapi import APIRouter, Request, Response, HTTPException

from app.graph_state import get_kg

router = APIRouter(tags=["sparql-protocol"])

# ── Security constants ────────────────────────────────────────────────────────

MAX_QUERY_LENGTH = 10_000  # characters
QUERY_TIMEOUT_S = 30

# Reject any query containing a SPARQL Update keyword
_WRITE_PATTERN = re.compile(
    r"\b(INSERT|DELETE|LOAD|CLEAR|DROP|CREATE|COPY|MOVE|ADD)\b",
    re.IGNORECASE,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _extract_query(request: Request, body: bytes) -> str:
    """Extract the SPARQL query string per W3C SPARQL Protocol §2.1."""
    if request.method == "GET":
        query = request.query_params.get("query")
        if not query:
            raise HTTPException(status_code=400, detail="Missing 'query' parameter")
        return query

    # POST
    content_type = (request.headers.get("content-type") or "").split(";")[0].strip()
    if content_type == "application/sparql-query":
        return body.decode("utf-8")
    if content_type == "application/x-www-form-urlencoded":
        params = parse_qs(body.decode("utf-8"))
        queries = params.get("query")
        if not queries or not queries[0]:
            raise HTTPException(status_code=400, detail="Missing 'query' in form body")
        return queries[0]
    # Fallback: treat body as raw query text
    if body:
        return body.decode("utf-8")
    raise HTTPException(status_code=400, detail="No query provided")


def _negotiate_format(request: Request, is_graph_result: bool) -> tuple[str, str]:
    """Return (rdflib_serialization_format, http_content_type)."""
    accept = request.headers.get("accept", "")

    if is_graph_result:
        # CONSTRUCT / DESCRIBE → RDF serialization
        if "application/n-triples" in accept:
            return "nt", "application/n-triples; charset=utf-8"
        if "application/rdf+xml" in accept:
            return "xml", "application/rdf+xml; charset=utf-8"
        return "turtle", "text/turtle; charset=utf-8"

    # SELECT / ASK → SPARQL results
    if "application/sparql-results+xml" in accept:
        return "xml", "application/sparql-results+xml; charset=utf-8"
    return "json", "application/sparql-results+json; charset=utf-8"


_CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
}


# ── Route ─────────────────────────────────────────────────────────────────────

@router.api_route("/sparql", methods=["GET", "POST", "OPTIONS"])
async def sparql_endpoint(request: Request):
    # CORS preflight
    if request.method == "OPTIONS":
        return Response(
            status_code=204,
            headers={**_CORS_HEADERS, "Access-Control-Max-Age": "86400"},
        )

    body = await request.body()

    # ── Parse query ───────────────────────────────────────────────────────
    query = _extract_query(request, body)

    if len(query) > MAX_QUERY_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Query exceeds maximum length of {MAX_QUERY_LENGTH} characters",
        )

    if _WRITE_PATTERN.search(query):
        raise HTTPException(
            status_code=403,
            detail="This is a read-only SPARQL endpoint. "
                   "Write operations (INSERT, DELETE, LOAD, …) are not permitted.",
        )

    # ── Execute ───────────────────────────────────────────────────────────
    kg = get_kg()
    try:
        result = kg.graph.query(query)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"SPARQL error: {exc}")

    # ── Serialize ─────────────────────────────────────────────────────────
    is_graph = result.type == "CONSTRUCT" or result.type == "DESCRIBE"
    fmt, content_type = _negotiate_format(request, is_graph)

    try:
        serialized = result.serialize(format=fmt)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Serialization error: {exc}")

    if isinstance(serialized, bytes):
        serialized = serialized.decode("utf-8")

    return Response(
        content=serialized,
        media_type=content_type.split(";")[0].strip(),
        headers=_CORS_HEADERS,
    )
