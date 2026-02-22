"""
/api/graph  — returns nodes and links for the force-directed graph visualisation.

Nodes: all URI-addressed resources reachable from sample nodes (2 hops).
Links: all URI→URI predicates (rdf:type, owl:* and rdfs:* predicates excluded).
Samples are given type "sample" so the frontend can render them prominently.
"""

import os
from collections import defaultdict
from fastapi import APIRouter
from rdflib import RDF, URIRef
from rdflib.term import Literal
from app.graph_state import get_kg, _DB_PATH

router = APIRouter(prefix="/api/graph", tags=["graph"])

SAMPLE_TYPE = "http://purls.helmholtz-metadaten.de/cmso/AtomicScaleSample"
_SAMPLE_URI  = URIRef(SAMPLE_TYPE)

# ── In-memory cache, invalidated whenever graph.db is updated ────────────────
_graph_cache: dict | None = None
_graph_cache_mtime: float = -1.0

# Predicates to skip (they clutter the graph without adding meaning)
_SKIP_PREFIXES = (
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
    "http://www.w3.org/2002/07/owl#",
    "http://www.w3.org/2000/01/rdf-schema#",
    "http://www.w3.org/2004/02/skos/core#",
)


def _local(uri: str) -> str:
    """Return the local fragment / last path segment of a URI."""
    if "#" in uri:
        return uri.split("#")[-1]
    return uri.rstrip("/").split("/")[-1]


def _group(uri: str) -> str:
    """Classify a node into a display group based on URI keywords.
    NOTE: never returns 'sample' — that is set only when the URI is a known sample instance.
    """
    u = uri.lower()
    if "element" in u:
        return "element"
    if "potential" in u or "interatomic" in u:
        return "potential"
    if "structure" in u or "unitcell" in u or "lattice" in u or "crystalstructure" in u:
        return "structure"
    if "calculation" in u or "workflow" in u or "method" in u or "software" in u:
        return "calculation"
    if "material" in u or "composition" in u:
        return "material"
    if "property" in u or "calculatedproperty" in u:
        return "property"
    return "other"


def _skip_pred(pred: str) -> bool:
    return any(pred.startswith(p) for p in _SKIP_PREFIXES)


@router.get("")
def get_graph():
    """Return graph data as {nodes, links} for the force-directed visualiser."""
    global _graph_cache, _graph_cache_mtime

    # ── Serve from cache if graph.db hasn't changed ───────────────────────────
    try:
        mtime = os.path.getmtime(_DB_PATH)
    except OSError:
        mtime = -1.0
    if _graph_cache is not None and mtime == _graph_cache_mtime:
        return _graph_cache

    kg = get_kg()
    g  = kg.graph  # rdflib ConjunctiveGraph / SQLAlchemy store

    # ── 1. Collect sample URIs (direct triple index, no SPARQL overhead) ──────
    sample_uris: set[str] = set()
    try:
        for s, _, _ in g.triples((None, RDF.type, _SAMPLE_URI)):
            if s is not None:
                sample_uris.add(str(s))
    except Exception:
        pass
    try:                                        # fallback KG attribute
        for uri in kg.sample_ids:
            sample_uris.add(str(uri))
    except Exception:
        pass

    # ── 2. Build sample id → display name map ────────────────────────────────
    sample_labels: dict[str, str] = {}
    try:
        for uri, name in zip(kg.sample_ids, kg.sample_names):
            sample_labels[str(uri)] = str(name) if name else _local(str(uri))
    except Exception:
        pass

    # ── 3. Walk all URI→URI triples (direct iteration, cap at 2000) ──────────
    LIMIT = 2000
    count = 0
    nodes_map: dict[str, dict] = {}
    links: list[dict] = []

    try:
        for s, p, o in g.triples((None, None, None)):
            if s is None or p is None or o is None:
                continue
            if isinstance(s, Literal) or isinstance(o, Literal):
                continue
            ps = str(p)
            if _skip_pred(ps):
                continue
            ss, os_ = str(s), str(o)
            for uri in (ss, os_):
                if uri not in nodes_map:
                    is_sample = uri in sample_uris
                    nodes_map[uri] = {
                        "id": uri,
                        "label": sample_labels.get(uri, _local(uri)) if is_sample else _local(uri),
                        "type": "sample" if is_sample else _group(uri),
                        "group": "sample" if is_sample else _group(uri),
                    }
            links.append({"source": ss, "target": os_, "label": _local(ps)})
            count += 1
            if count >= LIMIT:
                break
    except Exception as e:
        return {"nodes": [], "links": [], "error": str(e)}

    # ── 4. Ensure every sample has a node even if it appears in no URI→URI triples
    for uri in sample_uris:
        if uri not in nodes_map:
            nodes_map[uri] = {
                "id": uri,
                "label": sample_labels.get(uri, _local(uri)),
                "type": "sample",
                "group": "sample",
            }
        else:
            # Correct the label for samples already seen
            nodes_map[uri]["label"] = sample_labels.get(uri, nodes_map[uri]["label"])
            nodes_map[uri]["type"] = "sample"
            nodes_map[uri]["group"] = "sample"

    # ── 5. Compute degree (connection count) for each node ─────────────────
    degree_count: dict[str, int] = defaultdict(int)
    for link in links:
        degree_count[link["source"]] += 1
        degree_count[link["target"]] += 1
    for uri, node in nodes_map.items():
        node["degree"] = degree_count.get(uri, 0)

    result = {"nodes": list(nodes_map.values()), "links": links}
    _graph_cache = result
    _graph_cache_mtime = mtime
    return result
