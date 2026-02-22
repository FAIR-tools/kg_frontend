"""
/api/workflows — lists all computational simulation workflows in the knowledge graph.

Workflow types (as written by atomRDF Simulation.to_graph):
  asmo:EnergyCalculation  — MolecularStatics, MolecularDynamics, DensityFunctionalTheory
  asmo:Simulation         — TensileTest, CompressionTest, and other generic simulations

Instead of SPARQL, all lookups use the atomRDF KnowledgeGraph triple API
(kg.graph.triples / kg.graph.value) which hits the rdflib index directly and is
significantly faster than SPARQL when the workflow or sample URI is already known.
"""
from fastapi import APIRouter, HTTPException
from urllib.parse import unquote
from rdflib import URIRef, RDF, RDFS

from app.graph_state import get_kg

router = APIRouter(prefix="/api/workflows", tags=["workflows"])

# ── namespace constants (plain URIRef — no SPARQL overhead) ───────────────────
_ASMO         = "http://purls.helmholtz-metadaten.de/asmo/"
_PROV         = "http://www.w3.org/ns/prov#"
_CMSO         = "http://purls.helmholtz-metadaten.de/cmso/"

_ENERGY_CALC  = URIRef(f"{_ASMO}EnergyCalculation")
_SIMULATION   = URIRef(f"{_ASMO}Simulation")

_PROV_ASSOC   = URIRef(f"{_PROV}wasAssociatedWith")
_PROV_GEN_BY  = URIRef(f"{_PROV}wasGeneratedBy")
_PROV_DERIVED = URIRef(f"{_PROV}wasDerivedFrom")

_ASMO_POT     = URIRef(f"{_ASMO}hasInteratomicPotential")
_ASMO_METHOD  = URIRef(f"{_ASMO}hasComputationalMethod")
_CMSO_PATH    = URIRef(f"{_CMSO}hasPath")

_WORKFLOW_TYPES = {
    str(_ENERGY_CALC): "Energy Calculation",
    str(_SIMULATION):  "Simulation",
}


def _local(uri: str) -> str:
    """Extract the local name from a URI (last path segment or fragment)."""
    return uri.rstrip("/").split("/")[-1].split("#")[-1]


def _build_record(g, wf_uri: URIRef, type_name: str, type_uri: str) -> dict:
    """
    Build a workflow record from the KG using direct triple lookups (no SPARQL).

    Mirrors the pattern used inside atomRDF's Simulation.from_graph() but reads
    into a plain dict so it is thread-safe for concurrent ASGI requests.
    """
    # Software: PROV.wasAssociatedWith objects that are plain HTTP URIs (DOIs)
    software_uris = [
        str(o)
        for _, _, o in g.triples((wf_uri, _PROV_ASSOC, None))
        if str(o).startswith("http")
    ]
    software = software_uris[0] if software_uris else ""

    # Interatomic potential — label + publication URI (CMSO.hasReference) + type
    _CMSO_REF = URIRef(f"{_CMSO}hasReference")
    pot_node = g.value(wf_uri, _ASMO_POT)
    potential = ""
    potential_uri = ""
    if pot_node:
        pot_label  = g.value(pot_node, RDFS.label)
        pot_ref    = g.value(pot_node, _CMSO_REF)   # publication / DOI URI
        pot_type   = g.value(pot_node, RDF.type)
        if pot_ref:
            potential_uri = str(pot_ref)
        if pot_label:
            potential = str(pot_label)
        elif pot_type:
            potential = _local(str(pot_type))
        else:
            potential = _local(str(pot_node))

    # Computational method sub-type — look up rdf:type of the method node
    # (e.g. asmo:MolecularDynamics, asmo:MolecularStatics, asmo:DensityFunctionalTheory)
    method_node = g.value(wf_uri, _ASMO_METHOD)
    method = ""
    if method_node:
        method_type = g.value(method_node, RDF.type)
        method = _local(str(method_type)) if method_type else _local(str(method_node))

    # Only expose samples that actually exist as AtomicScaleSample nodes in the KG
    _CMSO_SAMPLE = URIRef(f"{_CMSO}AtomicScaleSample")
    def _exists_as_sample(node) -> bool:
        if node is None:
            return False
        try:
            uri = str(node)
        except Exception:
            return False
        return any(True for _ in g.triples((URIRef(uri), RDF.type, _CMSO_SAMPLE)))

    # Output samples: sample_uri  PROV.wasGeneratedBy  workflow_uri
    output_samples = [
        str(s) for s, _, _ in g.triples((None, _PROV_GEN_BY, wf_uri))
        if s is not None and _exists_as_sample(s)
    ]

    # Input samples: output samples that were PROV.wasDerivedFrom something
    input_set: set[str] = set()
    for out_s in output_samples:
        for _, _, in_s in g.triples((URIRef(out_s), _PROV_DERIVED, None)):
            if in_s is not None and _exists_as_sample(in_s):
                input_set.add(str(in_s))
    input_samples = sorted(input_set)

    # Filesystem / archive path
    path_lit = g.value(wf_uri, _CMSO_PATH)
    path = str(path_lit) if path_lit else ""

    return {
        "id":             str(wf_uri),
        "type":           type_name,
        "type_uri":       type_uri,
        "method":         method,
        "software":       software,
        "potential":      potential,
        "potential_uri":  potential_uri,
        "path":           path,
        "input_samples":  input_samples,
        "output_samples": output_samples,
        # "samples" kept for backward-compat with the JS View-button logic
        "samples":        output_samples,
    }


@router.get("")
def list_workflows():
    """Return all workflow instances with metadata using direct triple lookups."""
    kg = get_kg()
    g  = kg.graph  # rdflib ConjunctiveGraph

    records: list[dict] = []
    for type_ref, type_label in (
        (_ENERGY_CALC, "Energy Calculation"),
        (_SIMULATION,  "Simulation"),
    ):
        for wf_uri, _, _ in g.triples((None, RDF.type, type_ref)):
            records.append(_build_record(g, wf_uri, type_label, str(type_ref)))

    records.sort(key=lambda r: r["id"])
    return {"workflows": records, "total": len(records)}


@router.get("/{workflow_id:path}")
def get_workflow(workflow_id: str):
    """
    Return detailed info for a single workflow by ID.

    Uses direct triple lookups equivalent to Simulation.from_graph() but
    without mutating class-level state (which is not safe in concurrent ASGI).
    """
    workflow_id = unquote(workflow_id)
    kg  = get_kg()
    g   = kg.graph
    wf_uri = URIRef(workflow_id)

    wf_type = g.value(wf_uri, RDF.type)
    if wf_type is None or str(wf_type) not in _WORKFLOW_TYPES:
        raise HTTPException(status_code=404, detail=f"Workflow not found: {workflow_id}")

    return _build_record(g, wf_uri, _WORKFLOW_TYPES[str(wf_type)], str(wf_type))
