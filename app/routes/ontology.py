"""
Ontology-backed dropdowns for the guided query builder.

Both listings are filtered to terms that actually occur in the graph (see
stats.present_in_data). Pass ?all=true to get the unfiltered ontology, which is
useful for checking what a term would be called but will offer choices that
return no rows.
"""

from urllib.parse import unquote

from fastapi import APIRouter

from app.ontology_state import get_class_list, get_properties_for_class
from app.routes.stats import present_in_data

router = APIRouter(prefix="/api/ontology", tags=["ontology"])


@router.get("/classes")
def list_classes(all: bool = False):
    """OWL classes in the loaded ontology that have at least one instance."""
    classes = get_class_list()
    if all:
        return classes
    present = present_in_data()["classes"]
    return [c for c in classes if c["uri"] in present]


@router.get("/properties/{class_uri:path}")
def list_properties(class_uri: str, all: bool = False):
    """Data/object properties reachable from a class and used in the data."""
    props = get_properties_for_class(unquote(class_uri))
    if all:
        return props
    present = present_in_data()["predicates"]
    return [p for p in props if p["uri"] in present]
