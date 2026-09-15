"""
Dereferencing endpoint for the knowledge graph's own IRIs.

Instance IRIs are minted as ``https://atomkg.pyscal.org/id/<scheme>/<local-id>``
(see kg_data/rewrite_iris.py). This route makes them resolve, which is what turns
them from merely-unique identifiers into Linked Data: FAIR A1 asks that an
identifier be retrievable over a standard protocol.

Content negotiation:
  text/turtle, application/n-triples, application/ld+json  -> RDF description
  anything else (browsers)                                 -> redirect to the UI

The description is the concise bounded description of the subject: every triple
where it is the subject, plus every triple where it is the object, so a consumer
that follows the IRI learns how the entity connects in both directions.

atomkg.pyscal.org is canonical. The other hostnames 301 to it at the nginx layer
so that one entity has exactly one IRI.
"""

from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import Response, RedirectResponse

from app.graph_state import get_kg

router = APIRouter(prefix="/id", tags=["resolve"])

CANONICAL_BASE = "https://atomkg.pyscal.org"

# Schemes minted by atomrdf and rewritten into this namespace.
KNOWN_SCHEMES = {
    "sample", "property", "simulation", "person", "publication",
    "software", "method",
    "addatom", "deleteatom", "substituteatom",
    "addition", "subtraction", "multiplication", "division",
}

_RDF_TYPES = {
    "text/turtle": "turtle",
    "application/x-turtle": "turtle",
    "application/n-triples": "nt",
    "application/ld+json": "json-ld",
    "application/rdf+xml": "xml",
}


def _negotiate(accept: str):
    """Return (rdflib_format, content_type) or None when the client wants HTML."""
    best, best_q, best_ct = None, -1.0, None
    for part in (accept or "").split(","):
        part = part.strip()
        if not part:
            continue
        media, _, params = part.partition(";")
        media = media.strip().lower()
        q = 1.0
        for p in params.split(";"):
            p = p.strip()
            if p.startswith("q="):
                try:
                    q = float(p[2:])
                except ValueError:
                    pass
        if media in ("text/html", "application/xhtml+xml") and q > best_q:
            best, best_q, best_ct = None, q, None
        elif media in _RDF_TYPES and q > best_q:
            best, best_q, best_ct = _RDF_TYPES[media], q, media
    return (best, best_ct) if best else None


@router.get("/{scheme}/{local_id:path}")
def resolve(scheme: str, local_id: str, request: Request):
    if scheme not in KNOWN_SCHEMES:
        raise HTTPException(status_code=404, detail=f"Unknown identifier scheme: {scheme}")

    from rdflib import URIRef, Graph

    uri = URIRef(f"{CANONICAL_BASE}/id/{scheme}/{local_id}")
    kg = get_kg()
    g = kg.graph

    out = Graph()
    for prefix, ns in g.namespaces():
        out.bind(prefix, ns)

    n = 0
    for s, p, o in g.triples((uri, None, None)):
        out.add((s, p, o))
        n += 1
    for s, p, o in g.triples((None, None, uri)):
        out.add((s, p, o))
        n += 1

    if n == 0:
        raise HTTPException(status_code=404, detail=f"No such entity: {uri}")

    chosen = _negotiate(request.headers.get("accept", ""))
    if chosen is None:
        # Browser: hand off to the UI. Only samples have a detail view today.
        if scheme == "sample":
            return RedirectResponse(url=f"/?sample={uri}", status_code=303)
        return RedirectResponse(url=f"/sparql?query=DESCRIBE+%3C{uri}%3E", status_code=303)

    fmt, content_type = chosen
    return Response(content=out.serialize(format=fmt), media_type=content_type)
