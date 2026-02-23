from fastapi import APIRouter, HTTPException
from app.graph_state import get_kg
from app.cache import read_cache

router = APIRouter(prefix="/api/samples", tags=["samples"])

# Fields that contain per-atom arrays — too large and not useful in the detail panel
_ATOM_LEVEL_KEYS = {
    "atoms", "positions", "species", "atom_species", "elements",
    "forces", "velocities", "charges", "masses", "tags",
    "magnetic_moments", "momenta", "numbers",
}


def _uri_to_str(val):
    """Convert rdflib URIRef / Literal to plain Python string."""
    if val is None:
        return None
    try:
        return val.toPython()
    except Exception:
        return str(val)


def _safe_serialize(obj, depth=0):
    """Recursively convert an arbitrary object to a JSON-safe value."""
    if obj is None:
        return None
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, (int, float, str)):
        return obj
    # rdflib types
    try:
        from rdflib import URIRef, Literal
        if isinstance(obj, (URIRef, Literal)):
            try:
                return obj.toPython()
            except Exception:
                return str(obj)
    except ImportError:
        pass
    # numpy scalars / arrays
    try:
        import numpy as np
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
    except ImportError:
        pass
    # pydantic models
    try:
        from pydantic import BaseModel
        if isinstance(obj, BaseModel):
            return _safe_serialize(obj.model_dump(), depth)
    except ImportError:
        pass
    # dicts
    if isinstance(obj, dict):
        result = {}
        for k, v in obj.items():
            if v is None:
                continue
            if str(k).lower() in _ATOM_LEVEL_KEYS:
                continue
            serialized = _safe_serialize(v, depth + 1)
            if serialized is not None:
                result[str(k)] = serialized
        return result or None
    # lists / tuples — only keep if short or depth is shallow
    if isinstance(obj, (list, tuple)):
        items = [_safe_serialize(i, depth + 1) for i in obj]
        items = [i for i in items if i is not None]
        if not items:
            return None
        # Drop large flat lists of numbers (atom-level)
        if depth > 0 and len(items) > 50 and all(isinstance(i, (int, float)) for i in items):
            return f"[{len(items)} values]"
        return items
    # fallback
    try:
        return str(obj)
    except Exception:
        return None


@router.get("")
def list_samples():
    """Return a list of all samples in the graph. Served from cache when available."""
    cached = read_cache("samples.json")
    if cached is not None:
        return cached

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


@router.get("/xyz/{sample_id:path}")
def get_sample_xyz(sample_id: str):
    """Return the sample structure as an XYZ string for 3Dmol.js rendering."""
    import io
    from ase.io import write as ase_write
    from fastapi.responses import Response as FastResponse
    from urllib.parse import unquote
    from rdflib import URIRef

    sample_id = unquote(sample_id)
    kg = get_kg()
    sample_uri = URIRef(sample_id)

    try:
        sample = kg.get_sample_as_structure(sample_uri)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    if sample is None:
        raise HTTPException(status_code=404, detail="Sample not found")

    try:
        atoms = sample.to_structure(format="ase")
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"No atomic structure available for this sample ({exc})")

    if atoms is None:
        raise HTTPException(status_code=422, detail="No atomic structure available for this sample")

    try:
        buf = io.StringIO()
        ase_write(buf, atoms, format="extxyz")
        return FastResponse(content=buf.getvalue(), media_type="text/plain")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not serialise structure: {exc}")


@router.get("/{sample_id:path}")
def get_sample(sample_id: str):
    """Return detailed info for a single sample."""
    from urllib.parse import unquote
    sample_id = unquote(sample_id)
    kg = get_kg()

    from rdflib import URIRef
    sample_uri = URIRef(sample_id)

    sample = None
    deserialize_error = None
    try:
        sample = kg.get_sample_as_structure(sample_uri)
    except Exception as exc:
        deserialize_error = str(exc)

    if sample is not None:
        try:
            raw = sample.model_dump()
        except Exception:
            raw = vars(sample) if hasattr(sample, "__dict__") else {}
        result = _safe_serialize(raw)
        if result:
            return result

    # Fallback: return whatever basic triples the KG has for this URI
    fallback: dict = {"id": sample_id}
    if deserialize_error:
        fallback["_warning"] = f"Partial data only: {deserialize_error}"
    try:
        for p, o in kg.graph.predicate_objects(sample_uri):
            key = str(p).split("/")[-1].split("#")[-1]
            val = _uri_to_str(o) if o is not None else None
            if val is not None and key not in _ATOM_LEVEL_KEYS:
                fallback[key] = val
    except Exception:
        pass
    return fallback
