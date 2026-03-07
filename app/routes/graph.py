"""
/api/graph  — returns nodes and links for the force-directed graph visualisation.

Strategy: build the graph around *shared* nodes only.
  1. samples → datasets  (dcterms:isPartOf)
  2. samples → workflows  (prov:wasGeneratedBy  on the workflow side)
  3. workflows → potentials / software / methods  (1 more hop)

Per-sample private sub-nodes (SimulationCell, Material, ChemicalSpecies …)
are skipped because they create isolated dumbbells — every sample has its own
unique copy, so they never connect the graph together.

Samples are subsampled to SAMPLE_LIMIT (evenly across datasets) so the
visualisation stays responsive.
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

SAMPLE_LIMIT = 400  # max sample nodes shown

# Predicates we want to follow (whitelist keeps the graph clean)
_DCTERMS_IS_PART_OF = URIRef("http://purl.org/dc/terms/isPartOf")
_PROV_WAS_GEN_BY = URIRef("http://www.w3.org/ns/prov#wasGeneratedBy")
_PROV_DERIVED = URIRef("http://www.w3.org/ns/prov#wasDerivedFrom")
_ASMO_HAS_POT = URIRef(
    "http://purls.helmholtz-metadaten.de/asmo/hasInteratomicPotential"
)
_ASMO_HAS_METHOD = URIRef(
    "http://purls.helmholtz-metadaten.de/asmo/hasComputationalMethod"
)
_PROV_ASSOC = URIRef("http://www.w3.org/ns/prov#wasAssociatedWith")

_BACKBONE_PREDS = {
    _DCTERMS_IS_PART_OF,
    _PROV_WAS_GEN_BY,
    _PROV_DERIVED,
    _ASMO_HAS_POT,
    _ASMO_HAS_METHOD,
    _PROV_ASSOC,
}

# ── In-memory cache, invalidated whenever graph.db is updated ────────────────
_graph_cache: dict | None = None
_graph_cache_mtime: float = -1.0


def _local(uri: str) -> str:
    if "#" in uri:
        return uri.split("#")[-1]
    return uri.rstrip("/").split("/")[-1]


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
        return "other"
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

    # ── 3. Select a representative subset of samples ──────────────────────────
    all_sample_list = sorted(sample_uris)
    if len(all_sample_list) > SAMPLE_LIMIT:
        step = len(all_sample_list) / SAMPLE_LIMIT
        selected = {all_sample_list[int(i * step)] for i in range(SAMPLE_LIMIT)}
    else:
        selected = set(all_sample_list)

    # ── 4. Build backbone graph ────────────────────────────────────────────────
    # Pass A: sample → dataset    (dcterms:isPartOf, always 1:1)
    # Pass B: workflow → sample   (prov:wasGeneratedBy)
    # Pass C: workflow → potential / method / software
    # This guarantees every sample node appears connected to at least the dataset.

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
                "type": "sample" if is_sample else _group(uri),
                "group": "sample" if is_sample else _group(uri),
            }

    def _add_edge(s: str, pred_label: str, o: str) -> None:
        key = (s, pred_label, o)
        if key in seen_links:
            return
        seen_links.add(key)
        links.append({"source": s, "target": o, "label": pred_label})

    try:
        # Pass A: sample → dataset
        for s, _, o in g.triples((None, _DCTERMS_IS_PART_OF, None)):
            if isinstance(o, Literal):
                continue
            ss, os_ = str(s), str(o)
            if ss not in selected:
                continue
            _ensure_node(ss, is_sample=True)
            _ensure_node(os_)
            _add_edge(ss, "isPartOf", os_)

        # Pass B: workflow → output sample  +  workflow → input sample
        for s, _, wf in g.triples((None, _PROV_WAS_GEN_BY, None)):
            if isinstance(s, Literal) or isinstance(wf, Literal):
                continue
            ss, wf_str = str(s), str(wf)
            # Only include if the output sample is in our selected set
            if ss not in selected:
                continue
            _ensure_node(ss, is_sample=True)
            _ensure_node(wf_str)
            _add_edge(ss, "wasGeneratedBy", wf_str)

            # input samples (wasDerivedFrom on the sample)
            for _, _, in_s in g.triples((URIRef(ss), _PROV_DERIVED, None)):
                if isinstance(in_s, Literal):
                    continue
                in_str = str(in_s)
                if in_str in selected:
                    _ensure_node(in_str, is_sample=True)
                    _add_edge(in_str, "derivedFrom→", ss)  # direction: input→output

            # Pass C: workflow → potential / method / software
            for backbone_pred in (_ASMO_HAS_POT, _ASMO_HAS_METHOD, _PROV_ASSOC):
                for _, _, obj in g.triples((URIRef(wf_str), backbone_pred, None)):
                    if isinstance(obj, Literal):
                        continue
                    obj_str = str(obj)
                    _ensure_node(obj_str)
                    _add_edge(wf_str, _local(str(backbone_pred)), obj_str)

    except Exception as e:
        return {"nodes": [], "links": [], "error": str(e)}

    # ── 5. Ensure every selected sample has a node (even without any backbone edge) ──
    # These will show as isolated only if they truly have no backbone connections
    for uri in selected:
        _ensure_node(uri, is_sample=True)

    # ── 6. Compute degree ─────────────────────────────────────────────────────
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
