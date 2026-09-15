"""
Dereferencing endpoint for the knowledge graph's own IRIs.

Instance IRIs are minted as ``https://atomkg.pyscal.org/id/<scheme>/<local-id>``
(see kg_data/rewrite_iris.py). This route makes them resolve, which is what turns
them from merely-unique identifiers into Linked Data: FAIR A1 asks that an
identifier be retrievable over a standard protocol.

One URI, two representations, no redirect:

  explicit text/html (a browser)   -> an HTML entity page, rendered here
  an explicit RDF media type       -> that serialisation
  */* or no Accept at all          -> Turtle

The last rule matters: a bare ``curl <iri>`` sends ``Accept: */*``, which states no
preference. Answering that with HTML would make the IRI useless to scripted
clients. Browsers always name text/html explicitly, so they still get the page.

Every entity gets a page -- samples, properties, simulations, people, software,
methods, operations -- and every IRI on a page is itself a link, so the graph can
be walked by hand in a browser exactly as a machine would walk it.

atomkg.pyscal.org is canonical; the other hostnames 301 /id/* here at the nginx
layer so that one entity has exactly one IRI.
"""

import html
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, Response

from app.graph_state import get_kg

router = APIRouter(prefix="/id", tags=["resolve"])

CANONICAL_BASE = "https://atomkg.pyscal.org"
_ID_PREFIX = f"{CANONICAL_BASE}/id/"

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

# A few nodes are referenced enormously often -- method/MolecularStatics is the
# object of 37,263 triples. Rendering or serialising all of them would make the
# page useless and the response huge, so inbound links are capped and the page
# says how many were left out.
MAX_INBOUND_HTML = 50
MAX_INBOUND_RDF = 1000


def _negotiate(accept: str):
    """Pick a serialisation, or None when the client explicitly asked for HTML."""
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

    if html_q >= 0 and html_q >= rdf_q:
        return None
    if rdf_best:
        return rdf_best, rdf_ct
    return _RDF_TYPES["text/turtle"], "text/turtle"


def _curie(uri: str) -> str:
    """Short, readable form of a predicate or class IRI."""
    if "#" in uri:
        return uri.rsplit("#", 1)[-1]
    return uri.rstrip("/").rsplit("/", 1)[-1] or uri


def _collect(uri):
    """Outgoing triples in full; incoming capped. Returns (out, inbound, n_inbound)."""
    from rdflib import URIRef

    g = get_kg().graph
    outgoing = list(g.triples((URIRef(str(uri)), None, None)))

    inbound, n_inbound = [], 0
    for trip in g.triples((None, None, URIRef(str(uri)))):
        n_inbound += 1
        if len(inbound) < MAX_INBOUND_RDF:
            inbound.append(trip)
    return outgoing, inbound, n_inbound


# ── HTML rendering ──────────────────────────────────────────────────────────

_CSS = """
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font)}
.wrap{max-width:1000px;margin:0 auto;padding:28px 20px 60px}
a{color:var(--accent-hover);text-decoration:none}
a:hover{text-decoration:underline}
.kind{display:inline-block;font-size:12px;letter-spacing:.08em;text-transform:uppercase;
  color:var(--text-muted);border:1px solid var(--border);border-radius:99px;padding:3px 10px}
h1{font-size:23px;margin:12px 0 6px;word-break:break-word}
.iri{font-family:var(--mono);font-size:12px;color:var(--text-muted);word-break:break-all;margin-bottom:18px}
.formats{margin:0 0 26px;font-size:13px;color:var(--text-muted)}
.formats a{margin-right:12px}
h2{font-size:15px;margin:30px 0 10px;color:var(--text);border-bottom:1px solid var(--border);padding-bottom:7px}
table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:top}
td.k{width:32%;color:var(--text-muted);font-family:var(--mono);font-size:12.5px;word-break:break-word}
td.v{word-break:break-word}
.lit{font-family:var(--mono);font-size:13px}
.dt{color:var(--text-muted);font-size:11px;margin-left:5px}
.note{color:var(--text-muted);font-size:12.5px;margin-top:10px}
.empty{color:var(--text-muted);font-style:italic;font-size:13.5px}
.actions{margin:20px 0 4px}
.btn{display:inline-block;background:var(--accent);color:#fff;border-radius:6px;
  padding:7px 14px;font-size:13px;margin-right:9px}
.btn:hover{background:var(--accent-hover);text-decoration:none}
.btn.sec{background:transparent;border:1px solid var(--border);color:var(--text)}
"""


def _term_html(term) -> str:
    """Render one RDF term. Every IRI becomes a link, so the graph is walkable."""
    from rdflib import Literal, URIRef

    if isinstance(term, Literal):
        out = f'<span class="lit">{html.escape(str(term))}</span>'
        if term.datatype:
            out += f'<span class="dt">{html.escape(_curie(str(term.datatype)))}</span>'
        elif term.language:
            out += f'<span class="dt">@{html.escape(term.language)}</span>'
        return out

    if isinstance(term, URIRef):
        uri = str(term)
        label = uri[len(_ID_PREFIX):] if uri.startswith(_ID_PREFIX) else uri
        return f'<a href="{html.escape(uri, quote=True)}">{html.escape(label)}</a>'

    return f"<span class=\"lit\">{html.escape(str(term))}</span>"


def _rows(pairs) -> str:
    if not pairs:
        return '<p class="empty">none</p>'
    body = "".join(
        f'<tr><td class="k" title="{html.escape(str(k), quote=True)}">'
        f"{html.escape(_curie(str(k)))}</td>"
        f'<td class="v">{v}</td></tr>'
        for k, v in pairs
    )
    return f"<table>{body}</table>"


def _render_page(uri: str, scheme: str, outgoing, inbound, n_inbound: int) -> str:
    from rdflib import RDF, RDFS

    types = [str(o) for s, p, o in outgoing if p == RDF.type]
    labels = [str(o) for s, p, o in outgoing if p == RDFS.label]
    heading = labels[0] if labels else uri[len(_ID_PREFIX):]
    kind = _curie(types[0]) if types else scheme

    out_pairs = [(p, _term_html(o)) for s, p, o in
                 sorted(outgoing, key=lambda t: (str(t[1]), str(t[2])))]
    in_pairs = [(p, _term_html(s)) for s, p, o in
                sorted(inbound[:MAX_INBOUND_HTML], key=lambda t: (str(t[1]), str(t[0])))]

    note = ""
    if n_inbound > MAX_INBOUND_HTML:
        describe = quote(
            f"SELECT ?s ?p WHERE {{ ?s ?p <{uri}> }}", safe=""
        )
        note = (
            f'<p class="note">Showing {MAX_INBOUND_HTML:,} of {n_inbound:,} references. '
            f'<a href="/?tab=query&q={describe}">Query the rest &rarr;</a></p>'
        )

    actions = ""
    if scheme == "sample":
        actions = (
            f'<div class="actions">'
            f'<a class="btn" href="/viewer.html?id={quote(uri, safe="")}'
            f'&name={quote(heading, safe="")}">View structure</a>'
            f'<a class="btn sec" href="/?sample={quote(uri, safe="")}">Open in portal</a>'
            f"</div>"
        )

    e = html.escape
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(heading)} — atomRDF KG</title>
<link rel="stylesheet" href="/style.css">
<link rel="alternate" type="text/turtle" href="{e(uri, quote=True)}">
<link rel="canonical" href="{e(uri, quote=True)}">
<style>{_CSS}</style>
</head><body><div class="wrap">
  <span class="kind">{e(kind)}</span>
  <h1>{e(heading)}</h1>
  <div class="iri">{e(uri)}</div>
  <p class="formats">Also available as
    <a href="{e(uri, quote=True)}" type="text/turtle"
       onclick="return fetchAs(event,'text/turtle')">Turtle</a>
    <a href="{e(uri, quote=True)}" onclick="return fetchAs(event,'application/ld+json')">JSON-LD</a>
    <a href="{e(uri, quote=True)}" onclick="return fetchAs(event,'application/n-triples')">N-Triples</a>
  </p>
  {actions}
  <h2>Properties</h2>
  {_rows(out_pairs)}
  <h2>Referenced by</h2>
  {_rows(in_pairs)}
  {note}
  <p class="note" style="margin-top:34px">
    <a href="/">&larr; atomRDF knowledge graph</a></p>
</div>
<script>
// The alternate formats share this URI, so ask for them by Accept header and
// hand the result over as a download rather than navigating.
function fetchAs(ev, type) {{
  ev.preventDefault();
  fetch(window.location.pathname, {{headers: {{Accept: type}}}})
    .then(r => r.text())
    .then(t => {{
      const b = new Blob([t], {{type}});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = document.title.split(' — ')[0] +
        (type.includes('json') ? '.jsonld' : type.includes('n-triples') ? '.nt' : '.ttl');
      a.click(); URL.revokeObjectURL(a.href);
    }});
  return false;
}}
</script>
</body></html>"""


@router.get("/{scheme}/{local_id:path}")
def resolve(scheme: str, local_id: str, request: Request):
    if scheme not in KNOWN_SCHEMES:
        raise HTTPException(status_code=404, detail=f"Unknown identifier scheme: {scheme}")

    uri = f"{CANONICAL_BASE}/id/{scheme}/{local_id}"
    outgoing, inbound, n_inbound = _collect(uri)

    if not outgoing and not inbound:
        raise HTTPException(status_code=404, detail=f"No such entity: {uri}")

    link_header = f'<{uri}>; rel="canonical", <{uri}>; rel="alternate"; type="text/turtle"'
    chosen = _negotiate(request.headers.get("accept", ""))

    if chosen is None:
        return HTMLResponse(
            content=_render_page(uri, scheme, outgoing, inbound, n_inbound),
            headers={"Link": link_header, "Vary": "Accept"},
        )

    from rdflib import Graph

    g = get_kg().graph
    out = Graph()
    for prefix, ns in g.namespaces():
        out.bind(prefix, ns)
    for trip in outgoing:
        out.add(trip)
    for trip in inbound:
        out.add(trip)

    fmt, content_type = chosen
    return Response(
        content=out.serialize(format=fmt),
        media_type=content_type,
        headers={"Link": link_header, "Vary": "Accept"},
    )
