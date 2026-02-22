"""
/api/workflows — lists all computational simulation workflows in the knowledge graph.

Workflow types collected:
  asmo:EnergyCalculation
  asmo:MolecularStatics
  asmo:MolecularDynamics
"""
from fastapi import APIRouter
from app.graph_state import get_kg

router = APIRouter(prefix="/api/workflows", tags=["workflows"])

ASMO = "http://purls.helmholtz-metadaten.de/asmo/"

_WORKFLOW_TYPES = {
    f"{ASMO}EnergyCalculation": "Energy Calculation",
    f"{ASMO}MolecularStatics":  "Molecular Statics",
    f"{ASMO}MolecularDynamics": "Molecular Dynamics",
}

_SPARQL = """
SELECT DISTINCT ?wf ?wfType ?software ?potential
WHERE {
  ?wf a ?wfType .
  FILTER(?wfType IN (
    <http://purls.helmholtz-metadaten.de/asmo/EnergyCalculation>,
    <http://purls.helmholtz-metadaten.de/asmo/MolecularStatics>,
    <http://purls.helmholtz-metadaten.de/asmo/MolecularDynamics>
  ))
  OPTIONAL {
    ?wf <http://www.w3.org/ns/prov#wasAssociatedWith> ?software .
    FILTER(STRSTARTS(STR(?software), "http"))
    FILTER(!STRSTARTS(STR(?software), "software:"))
  }
  OPTIONAL {
    ?wf <http://purls.helmholtz-metadaten.de/asmo/hasInteratomicPotential> ?pot .
    ?pot <http://www.w3.org/2000/01/rdf-schema#label> ?potential .
  }
}
"""

_SAMPLE_SPARQL = """
SELECT DISTINCT ?wf ?sample
WHERE {
  ?wf a ?wfType .
  FILTER(?wfType IN (
    <http://purls.helmholtz-metadaten.de/asmo/EnergyCalculation>,
    <http://purls.helmholtz-metadaten.de/asmo/MolecularStatics>,
    <http://purls.helmholtz-metadaten.de/asmo/MolecularDynamics>
  ))
  ?sample <http://purls.helmholtz-metadaten.de/asmo/wasCalculatedBy> ?wf .
  ?sample a <http://purls.helmholtz-metadaten.de/cmso/AtomicScaleSample> .
}
"""


def _local(uri: str) -> str:
    if "#" in uri:
        return uri.split("#")[-1]
    return uri.rstrip("/").split("/")[-1]


@router.get("")
def list_workflows():
    """Return all workflow instances with key metadata."""
    kg = get_kg()

    # Main workflow query
    try:
        df = kg.query(_SPARQL)
    except Exception as exc:
        return {"error": str(exc), "workflows": []}

    if df is None or df.empty:
        return {"workflows": []}

    # Collect per-workflow info (deduplicate by wf URI)
    wf_map: dict[str, dict] = {}
    for _, row in df.iterrows():
        wf_id  = str(row.get("wf", ""))
        wf_type = str(row.get("wfType", ""))
        software = str(row.get("software", ""))
        potential = str(row.get("potential", ""))

        if not wf_id:
            continue

        if wf_id not in wf_map:
            wf_map[wf_id] = {
                "id":        wf_id,
                "type":      _WORKFLOW_TYPES.get(wf_type, _local(wf_type)),
                "type_uri":  wf_type,
                "software":  software if software and software != "None" else "",
                "potential": potential if potential and potential != "None" else "",
                "samples":   [],
            }
        else:
            # Merge additional software/potential hits
            entry = wf_map[wf_id]
            if software and software != "None" and software not in entry["software"]:
                entry["software"] = software
            if potential and potential != "None" and not entry["potential"]:
                entry["potential"] = potential

    # Resolve linked AtomicScaleSamples
    try:
        sdf = kg.query(_SAMPLE_SPARQL)
        if sdf is not None and not sdf.empty:
            for _, row in sdf.iterrows():
                wf_id  = str(row.get("wf", ""))
                sample = str(row.get("sample", ""))
                if wf_id in wf_map and sample and sample not in wf_map[wf_id]["samples"]:
                    wf_map[wf_id]["samples"].append(sample)
    except Exception:
        pass

    workflows = sorted(wf_map.values(), key=lambda w: w["id"])
    return {"workflows": workflows, "total": len(workflows)}
