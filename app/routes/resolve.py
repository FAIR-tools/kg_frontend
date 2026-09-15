"""
Dereferencing endpoint for the knowledge graph's own IRIs.

Instance IRIs are minted as ``https://atomkg.pyscal.org/id/<scheme>/<local-id>``
(see kg_data/rewrite_iris.py). This route makes them resolve, which is what turns
them from merely-unique identifiers into Linked Data: FAIR A1 asks that an
identifier be retrievable over a standard protocol.

Content negotiation:
  explicit text/html (i.e. a browser)   -> redirect into the UI
  an explicit RDF media type            -> that serialisation
  */* or no Accept at all               -> Turtle

The last rule matters: a bare `curl <iri>` sends `Accept: */*`, which expresses no
preference. Redirecting that to HTML would make the IRI useless to every scripted
client. Browsers always name text/html explicitly, so they are still served the UI.

The description is the concise bounded description of the subject: every triple
where it is the subject, plus every triple where it is the object, so a consumer
that follows the IRI learns how the entity connects in both directions.

atomkg.pyscal.org is canonical. The other hostnames 301 to it at the nginx layer
so that one entity has exactly one IRI.
"""

from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import Response, RedirectResponse
from urllib.parse import quote

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
    """Pick a serialisation, or None when the client explicitly asked for HTML.

    Returns (rdflib_format, content_type), or None for "send them to the UI".
    Defaults to Turtle: a client that says */* (or nothing) is not a browser.
    """
    accept = (accept or "").strip()
    if not accept:
        return _RDF_TYPES["text/turtle"], "text/turtle"

    html_q, rdf_best, rdf_q, rdf_ct = -1.0, None, -1.0, None
    for part in accept.split(","):
        part = part.strip()
        if not part:
            continue
        media, _, params = part.partition(";")
        media = media.strip().lower()
        q = 1.0
        for prm in params.split(";"):
            prm = prm.strip()
            if prm.startswith("q="):
                try:
                    q = float(prm[2:])
                except ValueError:
                    pass
        if media in ("text/html", "application/xhtml+xml"):
            html_q = max(html_q, q)
        elif media in _RDF_TYPES and q > rdf_q:
            rdf_best, rdf_q, rdf_ct = _RDF_TYPES[media], q, media

    # An explicit, at-least-as-preferred text/html means a browser.
    if html_q >= 0 and html_q >= rdf_q:
        return None
    if rdf_best:
        return rdf_best, rdf_ct
    # Only */* (or unrecognised types): treat as a machine client.
    return _RDF_TYPES["text/turtle"], "text/turtle"


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

    # Point machines at the RDF even when a human followed the link, so the
    # HTML branch stays discoverable rather than being a dead end.
    link_header = f'<{uri}>; rel="canonical", <{uri}>; rel="alternate"; type="text/turtle"'

    chosen = _negotiate(request.headers.get("accept", ""))
    if chosen is None:
        # Browser: hand off to the UI. Only samples have a detail view today.
        target = (
            f"/?sample={quote(str(uri), safe='')}"
            if scheme == "sample"
            else f"/sparql?query={quote(f'DESCRIBE <{uri}>', safe='')}"
        )
        return RedirectResponse(url=target, status_code=303,
                                headers={"Link": link_header})

    fmt, content_type = chosen
    return Response(
        content=out.serialize(format=fmt),
        media_type=content_type,
        headers={"Link": link_header, "Vary": "Accept"},
    )
