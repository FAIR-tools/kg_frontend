from fastapi import APIRouter, HTTPException
from app.graph_state import get_kg
from app.cache import read_cache

router = APIRouter(prefix="/api/samples", tags=["samples"])

# Fields that contain per-atom arrays — too large and not useful in the detail panel
_ATOM_LEVEL_KEYS = {
    "atoms",
    "positions",
    "species",
    "atom_species",
    "elements",
    "forces",
    "velocities",
    "charges",
    "masses",
    "tags",
    "magnetic_moments",
    "momenta",
    "numbers",
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
        if (
            depth > 0
            and len(items) > 50
            and all(isinstance(i, (int, float)) for i in items)
        ):
            return f"[{len(items)} values]"
        return items
    # fallback
    try:
        return str(obj)
    except Exception:
        return None


# ── Memoised access ─────────────────────────────────────────────────────────
# 55k+ records. Load once and derive the element histogram from it, rather than
# re-reading the cache file (16.5 MB) on every request.

_records: list | None = None
_summary: dict | None = None


def invalidate() -> None:
    """Drop the memoised records/summary. Called after the KG is reloaded."""
    global _records, _summary
    _records = None
    _summary = None


def _load() -> list:
    global _records
    if _records is None:
        _records = read_cache("samples.json") or _build_samples_live()
    return _records


def _get_summary() -> dict:
    """Totals and the element histogram that drives the periodic table."""
    global _summary
    if _summary is None:
        counts: dict[str, int] = {}
        for r in _load():
            for el in r.get("elements") or []:
                counts[el] = counts.get(el, 0) + 1
        _summary = {
            "total": len(_load()),
            "elements": dict(sorted(counts.items(), key=lambda kv: -kv[1])),
        }
    return _summary


def _matches(rec: dict, elements: list[str], q: str) -> bool:
    if elements:
        have = set(rec.get("elements") or [])
        if not all(el in have for el in elements):
            return False
    if q:
        if q in str(rec.get("name", "")).lower():
            return True
        if q in str(rec.get("formula", "")).lower():
            return True
        return any(str(el).lower().startswith(q) for el in rec.get("elements") or [])
    return True


@router.get("/summary")
def samples_summary():
    """Sample count and per-element histogram — what the periodic table needs."""
    return _get_summary()


@router.get("")
def list_samples(
    elements: str | None = None,
    search: str | None = None,
    limit: int = 100,
    offset: int = 0,
):
    """Paginated samples, filtered server-side.

    ``elements`` is a comma-separated list; a sample must contain ALL of them,
    matching what the periodic-table selector meant when it filtered in the
    browser. Filtering has to happen here now that the client only holds a page.
    """
    limit = max(1, min(limit, 1000))
    offset = max(0, offset)
    els = [e.strip() for e in (elements or "").split(",") if e.strip()]
    q = (search or "").strip().lower()

    records = _load()
    if els or q:
        records = [r for r in records if _matches(r, els, q)]

    return {
        "items": records[offset:offset + limit],
        "total": len(records),
        "limit": limit,
        "offset": offset,
    }


def _build_samples_live():
    """Live query — used when the cache file is absent."""

    kg = get_kg()
    ids = kg.sample_ids  # list of URIRef
    names = kg.sample_names  # list of str | None

    result = []
    from rdflib import URIRef as _URIRef

    _CMSO_NS = "http://purls.helmholtz-metadaten.de/cmso/"
    _HAS_SPECIES = _URIRef(f"{_CMSO_NS}hasSpecies")
    _HAS_ELEMENT = _URIRef(f"{_CMSO_NS}hasElement")
    _HAS_SYM = _URIRef(f"{_CMSO_NS}hasChemicalSymbol")
    _HAS_ELEM_RATIO = _URIRef(f"{_CMSO_NS}hasElementRatio")

    def _element_ratio(sample_uri):
        er = {}
        species = kg.graph.value(sample_uri, _HAS_SPECIES)
        if species is not None:
            for _, _, element in kg.graph.triples((species, _HAS_ELEMENT, None)):
                sym = kg.graph.value(element, _HAS_SYM)
                ratio = kg.graph.value(element, _HAS_ELEM_RATIO)
                if sym is not None:
                    try:
                        er[str(sym)] = float(ratio) if ratio is not None else 1.0
                    except (ValueError, TypeError):
                        er[str(sym)] = 1.0
        return er

    def _formula(er):
        if not er:
            return "?"
        parts = []
        for el in sorted(er.keys()):
            r = er[el]
            if abs(r - 1.0) < 0.001:
                parts.append(el)
            else:
                r_str = f"{r:.3f}".rstrip("0").rstrip(".")
                parts.append(f"{el}{r_str}")
        return "".join(parts)

    for sid, sname in zip(ids, names):
        uri = sid if hasattr(sid, "toPython") else _URIRef(str(sid))
        er = _element_ratio(uri)
        result.append(
            {
                "id": _uri_to_str(sid),
                "name": sname or "",
                "elements": sorted(er.keys()),
                "element_ratio": er,
                "formula": _formula(er),
            }
        )
    return result


def _sample_as_structure(kg, sample_uri):
    """Load a sample by IRI, bypassing KnowledgeGraph.get_sample_as_structure.

    That wrapper normalises its argument with
    ``sample_id if sample_id.startswith("sample:") else f"sample:{sample_id}"``.
    rdflib's URIRef subclasses str, so a dereferenceable IRI such as
    https://atomkg.pyscal.org/id/sample/<uuid> does NOT start with "sample:" and
    would be mangled into "sample:https://atomkg.pyscal.org/...". Calling
    AtomicScaleSample.from_graph directly is exactly what the wrapper does after
    normalising, and it accepts the IRI unchanged.

    Worth removing once atomrdf stops assuming the short form upstream.
    """
    from atomrdf.datamodels.structure import AtomicScaleSample

    return AtomicScaleSample.from_graph(kg, sample_uri)


_CMSO = "http://purls.helmholtz-metadaten.de/cmso/"


def _has_simulation_cell(kg, sample_uri) -> bool:
    """True if the sample carries a cmso:hasSimulationCell triple."""
    from rdflib import URIRef

    return kg.value(sample_uri, URIRef(f"{_CMSO}hasSimulationCell")) is not None


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

    # Most samples in the KG are property-only: the source deposit published
    # energies and crystallography but no atom positions, so the sample has no
    # cmso:hasSimulationCell. atomrdf still tries to build a SimulationCell and
    # pydantic rejects the resulting angle=[None, None, None]. That is a missing
    # structure, not a missing sample, so report it the same way as the
    # to_structure() failure below rather than leaking the validation error.
    if not _has_simulation_cell(kg, sample_uri):
        raise HTTPException(
            status_code=422,
            detail="No atomic structure available for this sample "
                   "(property-only dataset: no simulation cell was published).",
        )

    try:
        sample = _sample_as_structure(kg, sample_uri)
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"No atomic structure available for this sample ({exc})",
        )

    if sample is None:
        raise HTTPException(status_code=404, detail="Sample not found")

    try:
        atoms = sample.to_structure(format="ase")
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"No atomic structure available for this sample ({exc})",
        )

    if atoms is None:
        raise HTTPException(
            status_code=422, detail="No atomic structure available for this sample"
        )

    try:
        buf = io.StringIO()
        ase_write(buf, atoms, format="extxyz")
        return FastResponse(content=buf.getvalue(), media_type="text/plain")
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"Could not serialise structure: {exc}"
        )


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
        sample = _sample_as_structure(kg, sample_uri)
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
