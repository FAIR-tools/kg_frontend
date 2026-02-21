"""
/api/graph  — returns nodes and links for the force-directed graph visualisation.

Nodes: all URI-addressed resources reachable from sample nodes (2 hops).
Links: all URI→URI predicates (rdf:type, owl:* and rdfs:* predicates excluded).
Samples are given type "sample" so the frontend can render them prominently.
"""

from fastapi import APIRouter
from app.graph_state import get_kg

router = APIRouter(prefix="/api/graph", tags=["graph"])

SAMPLE_TYPE = "http://purls.helmholtz-metadaten.de/cmso/AtomicScaleSample"

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
    """Classify a node into a display group based on URI keywords."""
    u = uri.lower()
    if "sample" in u:
        return "sample"
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
    kg = get_kg()

    # ── 1. Collect sample URIs ────────────────────────────────────────────────
    sample_uris: set[str] = set()
    try:
        df = kg.query(f"SELECT DISTINCT ?s WHERE {{ ?s a <{SAMPLE_TYPE}> . }}")
        if df is not None and "s" in df.columns:
            for val in df["s"]:
                sample_uris.add(str(val))
    except Exception:
        pass
    # Fallback to KG attribute
    try:
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

    # ── 3. Query all URI→URI triples ─────────────────────────────────────────
    sparql = """
    SELECT DISTINCT ?s ?p ?o WHERE {
        ?s ?p ?o .
        FILTER(!isLiteral(?s) && !isLiteral(?o))
    }
    LIMIT 1500
    """

    nodes_map: dict[str, dict] = {}
    links: list[dict] = []

    try:
        df = kg.query(sparql)
        if df is not None and len(df):
            for _, row in df.iterrows():
                s = str(row["s"])
                p = str(row["p"])
                o = str(row["o"])

                if _skip_pred(p):
                    continue

                for uri in (s, o):
                    if uri not in nodes_map:
                        is_sample = uri in sample_uris
                        nodes_map[uri] = {
                            "id": uri,
                            "label": sample_labels.get(uri, _local(uri)) if is_sample else _local(uri),
                            "type": "sample" if is_sample else _group(uri),
                            "group": "sample" if is_sample else _group(uri),
                        }

                links.append({"source": s, "target": o, "label": _local(p)})
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

    return {"nodes": list(nodes_map.values()), "links": links}
