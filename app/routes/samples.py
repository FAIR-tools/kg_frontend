from fastapi import APIRouter, HTTPException
from app.graph_state import get_kg

router = APIRouter(prefix="/api/samples", tags=["samples"])


def _uri_to_str(val):
    """Convert rdflib URIRef / Literal to plain Python string."""
    try:
        return val.toPython()
    except Exception:
        return str(val)


@router.get("")
def list_samples():
    """Return a list of all samples in the graph."""
    kg = get_kg()
    ids = kg.sample_ids          # list of URIRef
    names = kg.sample_names      # list of str | None

    result = []
    for sid, sname in zip(ids, names):
        result.append({
            "id": _uri_to_str(sid),
            "name": sname or "",
        })
    return result


@router.get("/{sample_id:path}")
def get_sample(sample_id: str):
    """Return detailed info for a single sample."""
    from urllib.parse import unquote
    sample_id = unquote(sample_id)
    kg = get_kg()

    # Find the matching URIRef
    from rdflib import URIRef
    sample_uri = URIRef(sample_id)

    try:
        sample = kg.get_sample_as_structure(sample_uri)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    if sample is None:
        raise HTTPException(status_code=404, detail="Sample not found")

    # sample is an AtomicScaleSample pydantic model — serialize it
    try:
        return sample.model_dump(mode="json")
    except Exception:
        return {"id": sample_id, "error": "Could not serialize sample"}
