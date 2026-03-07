"""
/api/graph  — returns nodes and links for the force-directed graph visualisation.

Nodes: a representative subset of sample nodes (at most SAMPLE_LIMIT) plus all
URI resources reachable within 2 hops from those samples.  Every node that
appears in the graph has at least one edge, so there are no isolated floaters.

Links: URI→URI predicates (rdf:type, owl:* and rdfs:* predicates are excluded
because they clutter the layout without adding scientific meaning).
"""

import os
import random
from collections import defaultdict
from fastapi import APIRouter
from rdflib import RDF, URIRef
from rdflib.term import Literal
from app.graph_state import get_kg, _DB_PATH

router = APIRouter(prefix="/api/graph", tags=["graph"])

SAMPLE_TYPE = "http://purls.helmholtz-metadaten.de/cmso/AtomicScaleSample"
_SAMPLE_URI  = URIRef(SAMPLE_TYPE)

# How many sample nodes to include in the graph visualisation.
# Keeping this under ~500 keeps the force-graph responsive in a browser.
SAMPLE_LIMIT = 400
# Hard cap on total number of edges (prevents extremely dense clusters).
LINK_LIMIT = 4000

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
    g  = kg.graph

    # ── 1. Collect all sample URIs ────────────────────────────────────────────
    sample_uris: set[str] = set()
    try:
        for s, _, _ in g.triples((None, RDF.type, _SAMPLE_URI)):
            if s is not None:
                sample_uris.add(str(s))
    except Exception:
        pass
    try:
        for uri in kg.sample_ids:
            sample_uris.add(str(uri))
    except Exception:
        pass

    # ── 2. Build sample id → display name map ─────────────────────────────────
    sample_labels: dict[str, str] = {}
    try:
        for uri, name in zip(kg.sample_ids, kg.sample_names):
            sample_labels[str(uri)] = str(name) if name else _local(str(uri))
    except Exception:
        pass

    # ── 3. Select a representative subset of samples ──────────────────────────
    all_sample_list = sorted(sample_uris)   # deterministic ordering
    if len(all_sample_list) > SAMPLE_LIMIT:
        # Pick evenly spaced indices so every dataset gets representation
        step = len(all_sample_list) / SAMPLE_LIMIT
        selected = [all_sample_list[int(i * step)] for i in range(SAMPLE_LIMIT)]
    else:
        selected = all_sample_list

    # ── 4. 2-hop BFS from selected samples (only URI→URI edges) ───────────────
    nodes_map: dict[str, dict] = {}
    links: list[dict] = []
    seen_links: set[tuple] = set()

    def _ensure_node(uri: str) -> None:
        if uri not in nodes_map:
            is_sample = uri in sample_uris
            nodes_map[uri] = {
                "id": uri,
                "label": sample_labels.get(uri, _local(uri)) if is_sample else _local(uri),
                "type": "sample" if is_sample else _group(uri),
                "group": "sample" if is_sample else _group(uri),
            }

    def _add_edge(s: str, p: str, o: str) -> bool:
        """Add an edge if not already seen and within limit. Returns False when limit hit."""
        key = (s, p, o)
        if key in seen_links:
            return True
        seen_links.add(key)
        _ensure_node(s)
        _ensure_node(o)
        links.append({"source": s, "target": o, "label": _local(p)})
        return len(links) < LINK_LIMIT

    try:
        for sample_str in selected:
            if len(links) >= LINK_LIMIT:
                break
            sample_ref = URIRef(sample_str)
            _ensure_node(sample_str)

            # Hop 1: direct outgoing edges from the sample
            for p, o in g.predicate_objects(sample_ref):
                if isinstance(o, Literal):
                    continue
                if _skip_pred(str(p)):
                    continue
                hop1_str = str(o)
                if not _add_edge(sample_str, str(p), hop1_str):
                    break

                # Hop 2: outgoing edges from hop-1 objects
                for p2, o2 in g.predicate_objects(o):
                    if isinstance(o2, Literal):
                        continue
                    if _skip_pred(str(p2)):
                        continue
                    if not _add_edge(hop1_str, str(p2), str(o2)):
                        break
                else:
                    continue
                break
            else:
                continue
            break
    except Exception as e:
        return {"nodes": [], "links": [], "error": str(e)}

    # ── 5. Compute degree for each node ───────────────────────────────────────
    degree_count: dict[str, int] = defaultdict(int)
    for link in links:
        degree_count[link["source"]] += 1
        degree_count[link["target"]] += 1
    for uri, node in nodes_map.items():
        node["degree"] = degree_count.get(uri, 0)

    result = {
        "nodes": list(nodes_map.values()),
        "links": links,
        "total_samples": len(sample_uris),
        "shown_samples": len(selected),
    }
    _graph_cache = result
    _graph_cache_mtime = mtime
    return result
