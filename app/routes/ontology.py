from fastapi import APIRouter
from app.ontology_state import get_class_list, get_properties_for_class
from urllib.parse import unquote

router = APIRouter(prefix="/api/ontology", tags=["ontology"])


@router.get("/classes")
def list_classes():
    """Return all OWL classes in the loaded ontology."""
    return get_class_list()


@router.get("/properties/{class_uri:path}")
def list_properties(class_uri: str):
    """Return all data/object properties reachable from a given class URI."""
    class_uri = unquote(class_uri)
    return get_properties_for_class(class_uri)
