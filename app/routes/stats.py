"""
app/routes/stats.py
-------------------
Graph-level census for the Overview tab.

Everything here is a SPARQL aggregate pushed down into Oxigraph rather than an
rdflib walk in Python: the whole set runs in about five seconds against 3.2M
triples, so there is no cache file to regenerate after a rebuild. The result is
memoised and dropped by admin.reload() along with the other route state.

Deliberately narrow: it only computes what no other endpoint already provides.
Samples per dataset comes from /api/datasets, the element histogram from
/api/samples/summary and the per-type property stats from
/api/properties/summary -- the Overview tab composes those four responses.
"""

from fastapi import APIRouter, HTTPException

from app.graph_state import get_kg

router = APIRouter(prefix="/api/stats", tags=["stats"])

_CMSO = "http://purls.helmholtz-metadaten.de/cmso/"

# Every namespace that appears in predicate position, with a human-readable
# name. Anything unlisted falls back to its namespace URI, so a new ontology
# shows up as itself rather than being silently dropped.
_VOCABS = {
    _CMSO: ("cmso", "Computational Material Sample Ontology"),
    "http://purls.helmholtz-metadaten.de/asmo/": ("asmo", "Atomistic Simulation Methods Ontology"),
    "http://purls.helmholtz-metadaten.de/cdos/pldo/": ("pldo", "Planar Defects Ontology"),
    "http://purls.helmholtz-metadaten.de/cdos/podo/": ("podo", "Point Defects Ontology"),
    "http://purls.helmholtz-metadaten.de/cdos/cdco/": ("cdco", "Crystallographic Defect Core Ontology"),
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#": ("rdf", "RDF"),
    "http://www.w3.org/2000/01/rdf-schema#": ("rdfs", "RDF Schema"),
    "http://www.w3.org/ns/prov#": ("prov", "PROV-O provenance"),
    "http://www.w3.org/ns/dcat#": ("dcat", "Data Catalog Vocabulary"),
    "http://purl.org/dc/terms/": ("dcterms", "Dublin Core Terms"),
    "https://w3id.org/mdo/calculation/": ("mdo", "Materials Design Ontology"),
    "http://xmlns.com/foaf/0.1/": ("foaf", "FOAF"),
}

_Q_TRIPLES = "SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }"
_Q_CLASSES = "SELECT ?c (COUNT(?s) AS ?n) WHERE { ?s a ?c } GROUP BY ?c ORDER BY DESC(?n)"
_Q_PREDICATES = "SELECT ?p (COUNT(*) AS ?n) WHERE { ?s ?p ?o } GROUP BY ?p"
_Q_SAMPLES = f"SELECT (COUNT(?s) AS ?n) WHERE {{ ?s a <{_CMSO}AtomicScaleSample> }}"
_Q_WITH_CELL = (
    f"SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE {{ "
    f"?s a <{_CMSO}AtomicScaleSample> ; <{_CMSO}hasSimulationCell> ?c }}"
)

_stats: dict | None = None
_present: dict | None = None


def invalidate() -> None:
    """Drop the memoised census. Called after the KG is reloaded."""
    global _stats, _present
    _stats = None
    _present = None


def present_in_data() -> dict:
    """
    URIs that actually occur in the graph: {"classes": set, "predicates": set}.

    The guided-query dropdowns are built from the ontology, which describes far
    more than this collection instantiates — 215 classes and 117 properties
    reachable from AtomicScaleSample, against 72 classes and 75 predicates in the
    data. Selecting one of the absent terms produces a valid query that matches
    nothing, which reads as the feature being broken. This is the set to filter
    against. Filtering on the destination predicate is sound for multi-hop paths
    too: a predicate that appears in no triple cannot be on a path that matches.
    """
    global _present
    if _present is None:
        g = get_kg().graph
        _present = {
            "classes": {str(row[0]) for row in g.query(_Q_CLASSES)},
            "predicates": {str(row[0]) for row in g.query(_Q_PREDICATES)},
        }
    return _present


def _local(uri: str) -> str:
    """Local name of a URI — the part after the last '/' or '#'."""
    return uri.rstrip("/").split("/")[-1].split("#")[-1]


def _namespace(uri: str) -> str:
    """Namespace of a URI, i.e. everything up to and including the last '/' or '#'."""
    cut = max(uri.rfind("/"), uri.rfind("#"))
    return uri[: cut + 1] if cut >= 0 else uri


def _scalar(g, query: str) -> int:
    for row in g.query(query):
        return int(row[0])
    return 0


def _build() -> dict:
    g = get_kg().graph

    classes = [
        {"uri": str(row[0]), "label": _local(str(row[0])), "count": int(row[1])}
        for row in g.query(_Q_CLASSES)
    ]
    classes.sort(key=lambda c: -c["count"])

    # Vocabularies are counted by predicate use. Units (QUDT) and other
    # vocabularies that only ever appear in object position are not represented
    # here, which is why the panel is labelled "predicates by vocabulary".
    by_ns: dict[str, dict] = {}
    for row in g.query(_Q_PREDICATES):
        ns = _namespace(str(row[0]))
        prefix, name = _VOCABS.get(ns, ("", ns))
        entry = by_ns.setdefault(ns, {"prefix": prefix, "name": name, "uri": ns,
                                      "triples": 0, "predicates": 0})
        entry["triples"] += int(row[1])
        entry["predicates"] += 1
    vocabularies = sorted(by_ns.values(), key=lambda v: -v["triples"])

    total_samples = _scalar(g, _Q_SAMPLES)
    with_cell = _scalar(g, _Q_WITH_CELL)

    return {
        "triples": _scalar(g, _Q_TRIPLES),
        "class_count": len(classes),
        "predicate_count": sum(v["predicates"] for v in vocabularies),
        "vocabulary_count": len(vocabularies),
        "classes": classes,
        "vocabularies": vocabularies,
        # Most published samples are property-only: the source datasets report
        # measured quantities without shipping the atomic configuration. The
        # structure viewer is only meaningful for the ones that have a cell.
        "structures": {
            "total": total_samples,
            "with_cell": with_cell,
            "without_cell": max(total_samples - with_cell, 0),
        },
    }


@router.get("")
def get_stats():
    """Census of the graph: triples, classes, vocabularies, structure coverage."""
    global _stats
    if _stats is None:
        try:
            _stats = _build()
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Could not compute stats: {exc}")
    return _stats
