"""
/api/graph  — returns nodes and links for the force-directed graph visualisation.

Strategy: take N samples evenly and show ALL their triples (2 hops), skipping
schema/ontology predicates (rdf:type, rdfs:*, owl:*) and literal objects.
Shared nodes (datasets, potentials, software) naturally connect the clusters.
"""

import os
from collections import defaultdict
from fastapi import APIRouter
from rdflib import RDF, URIRef
from rdflib.term import Literal
from app.graph_state import get_kg, _DB_PATH

router = APIRouter(prefix="/api/graph", tags=["graph"])

SAMPLE_TYPE = "http://purls.helmholtz-metadaten.de/cmso/AtomicScaleSample"
_SAMPLE_URI = URIRef(SAMPLE_TYPE)

SAMPLE_LIMIT = (
    200  # cached on first load; force-graph stays interactive up to ~3-4k nodes
)

# Skip schema/ontology predicates — they link to class nodes, not data nodes
_SCHEMA_PREFIXES = (
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#",  # rdf:
    "http://www.w3.org/2000/01/rdf-schema#",  # rdfs:
    "http://www.w3.org/2002/07/owl#",  # owl:
)

# ── In-memory cache, invalidated whenever graph.db is updated ────────────────
_graph_cache: dict | None = None
_graph_cache_mtime: float = -1.0


def _local(uri: str) -> str:
    if "#" in uri:
        return uri.split("#")[-1]
    return uri.rstrip("/").split("/")[-1]


def _is_schema(pred_uri: str) -> bool:
    return any(pred_uri.startswith(p) for p in _SCHEMA_PREFIXES)


def _group(uri: str) -> str:
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
    if "dataset" in u or "zenodo" in u or "github" in u or "hdl.handle" in u:
        return "dataset"
    return "other"


@router.get("")
def get_graph():
    """Return graph data as {nodes, links} for the force-directed visualiser."""
    global _graph_cache, _graph_cache_mtime

    try:
        mtime = os.path.getmtime(_DB_PATH)
    except OSError:
        mtime = -1.0
    if _graph_cache is not None and mtime == _graph_cache_mtime:
        return _graph_cache

    kg = get_kg()
    g = kg.graph

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

    # ── 3. Select a representative subset of samples (evenly spaced) ──────────
    all_sample_list = sorted(sample_uris)
    if len(all_sample_list) > SAMPLE_LIMIT:
        step = len(all_sample_list) / SAMPLE_LIMIT
        selected = {all_sample_list[int(i * step)] for i in range(SAMPLE_LIMIT)}
    else:
        selected = set(all_sample_list)

    # ── 4. Walk all triples 2 hops from each sample ───────────────────────────
    # Hop 1: all outgoing URI→URI edges from each sample (skip schema predicates)
    # Hop 2: all outgoing URI→URI edges from nodes reached in hop 1
    # Shared nodes (datasets, potentials, software) naturally link clusters.

    nodes_map: dict[str, dict] = {}
    links: list[dict] = []
    seen_links: set[tuple] = set()

    def _ensure_node(uri: str, is_sample: bool = False) -> None:
        if uri not in nodes_map:
            nodes_map[uri] = {
                "id": uri,
                "label": (
                    sample_labels.get(uri, _local(uri)) if is_sample else _local(uri)
                ),
                "group": "sample" if is_sample else _group(uri),
            }

    def _add_edge(s: str, pred_label: str, o: str) -> None:
        key = (s, pred_label, o)
        if key in seen_links:
            return
        seen_links.add(key)
        links.append({"source": s, "target": o, "label": pred_label})

    try:
        hop1_nodes: set[str] = set()

        # Hop 1: sample → all non-schema, non-literal neighbours
        for uri in selected:
            _ensure_node(uri, is_sample=True)
            for _, pred, obj in g.triples((URIRef(uri), None, None)):
                if isinstance(obj, Literal):
                    continue
                pred_str = str(pred)
                if _is_schema(pred_str):
                    continue
                obj_str = str(obj)
                is_samp = obj_str in sample_uris
                _ensure_node(obj_str, is_sample=is_samp)
                _add_edge(uri, _local(pred_str), obj_str)
                hop1_nodes.add(obj_str)

        # Hop 2: from each intermediate node, follow its outgoing edges
        for node_uri in hop1_nodes:
            for _, pred, obj in g.triples((URIRef(node_uri), None, None)):
                if isinstance(obj, Literal):
                    continue
                pred_str = str(pred)
                if _is_schema(pred_str):
                    continue
                obj_str = str(obj)
                is_samp = obj_str in sample_uris
                _ensure_node(obj_str, is_sample=is_samp)
                _add_edge(node_uri, _local(pred_str), obj_str)

    except Exception as e:
        return {"nodes": [], "links": [], "error": str(e)}

    # ── 5. Compute degree ─────────────────────────────────────────────────────
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
