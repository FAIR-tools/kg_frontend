from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.graph_state import get_kg
from app.ontology_state import get_onto, _find_term_by_uri
from app import units
import pandas as pd
import copy

router = APIRouter(prefix="/api/guided-query", tags=["guided"])

OPERATOR_MAP = {
    "==": "__eq__",
    "!=": "__ne__",
    ">": "__gt__",
    ">=": "__ge__",
    "<": "__lt__",
    "<=": "__le__",
}


class DestinationItem(BaseModel):
    uri: str
    operator: Optional[str] = None   # ==, !=, >, >=, <, <=
    value: Optional[str] = None      # filter value (string; will be cast if numeric)


class GuidedQueryRequest(BaseModel):
    source_uri: str
    destinations: list[DestinationItem]


@router.post("")
def run_guided_query(req: GuidedQueryRequest):
    """
    Build a SPARQL query via tools4RDF ontology paths and execute it.
    Returns both the generated SPARQL string and the result rows.
    """
    onto = get_onto()
    kg = get_kg()

    source_term = _find_term_by_uri(req.source_uri)
    if source_term is None:
        raise HTTPException(status_code=400, detail=f"Source URI not found: {req.source_uri}")

    dest_terms = []
    for d in req.destinations:
        term = _find_term_by_uri(d.uri)
        if term is None:
            raise HTTPException(status_code=400, detail=f"Destination URI not found: {d.uri}")

        if d.operator and d.value is not None:
            # Apply the filter operator
            op_method = OPERATOR_MAP.get(d.operator)
            if op_method is None:
                raise HTTPException(status_code=400, detail=f"Unknown operator: {d.operator}")
            # tools4rdf only turns an operator into a FILTER for data properties.
            # For anything else Term.__eq__ falls through to `self.name == val.name`
            # and raises AttributeError on a plain string, surfacing as a 500.
            # Reject it here with something the caller can act on.
            if getattr(term, "node_type", None) != "data_property":
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Cannot filter on {d.uri}: it is a "
                        f"{getattr(term, 'node_type', 'non-data')} term, not a data property. "
                        "Filters apply to properties that hold a literal value."
                    ),
                )

            # Cast value to number if possible
            val: str | float | int = d.value
            try:
                val = int(d.value)
            except ValueError:
                try:
                    val = float(d.value)
                except ValueError:
                    pass
            term = getattr(copy.copy(term), op_method)(val)
        dest_terms.append(term)

    # Generate the SPARQL string first so we can return it.
    # IMPORTANT: onto.create_query() calls refresh() on dest_terms at the end,
    # resetting _condition to None.  Deep-copy so the originals stay intact for onto.query().
    import copy as _copy
    try:
        sparql_string = onto.create_query(source_term, _copy.deepcopy(dest_terms))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Query generation failed: {exc}")

    # Execute
    try:
        result = onto.query(kg.graph, source_term, destinations=dest_terms, return_df=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Query execution failed: {exc}")

    if result is None:
        return {"sparql": sparql_string, "columns": [], "rows": []}

    if isinstance(result, pd.DataFrame):
        df = result
    else:
        df = pd.DataFrame(result)

    df = df.fillna("")
    return {
        "sparql": sparql_string,
        "columns": list(df.columns),
        "rows": df.to_dict(orient="records"),
    }


# ══════════════════════════════════════════════════════════════════════════════
# FILTER BY CALCULATED PROPERTY
# ══════════════════════════════════════════════════════════════════════════════
# The ontology-path builder above cannot express "samples whose grain boundary
# energy exceeds X". atomrdf stores a measured quantity as its own node:
#
#     ?sample asmo:hasCalculatedProperty ?p .
#     ?p a asmo:GrainBoundaryEnergy ; asmo:hasValue 0.899 ; asmo:hasUnit qudt:J-PER-M2 .
#
# tools4rdf will not walk that two-hop path -- asked for asmo:hasValue it emits
# `?AtomicScaleSample asmo:hasValue ?v`, hanging the value straight off the
# sample, which matches nothing -- and pldo:hasGrainBoundaryEnergy, which the
# ontology does define, appears in zero triples. So the pattern is written out
# here instead.
#
# Units are handled inside the query rather than around it: a type published in
# more than one unit gets a BIND that rescales to the canonical one before the
# FILTER applies, so the comparison means the same thing on every row. The
# generated SPARQL is returned and shown in the UI, so that is inspectable.

_RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
_CMSO_NS = "http://purls.helmholtz-metadaten.de/cmso/"
_ASMO_NS = "http://purls.helmholtz-metadaten.de/asmo/"
_SAMPLE_CLASS = _CMSO_NS + "AtomicScaleSample"

_Q_PROPERTY_TYPES = """
SELECT ?t ?u (COUNT(*) AS ?n) WHERE {
  ?s <%shasCalculatedProperty> ?p .
  ?p <%stype> ?t ; <%shasValue> ?v .
  OPTIONAL { ?p <%shasUnit> ?u }
} GROUP BY ?t ?u
""" % (_ASMO_NS, _RDF, _ASMO_NS, _ASMO_NS)

_COMPARATORS = {"==": "=", "!=": "!=", ">": ">", ">=": ">=", "<": "<", "<=": "<="}

_property_types = None


def invalidate() -> None:
    """Drop the memoised property-type list. Called after the KG is reloaded."""
    global _property_types
    _property_types = None


def _local(uri: str) -> str:
    return uri.rstrip("/").split("/")[-1].split("#")[-1]


def _load_property_types() -> list:
    """Selectable property types, with the units each one was published in."""
    global _property_types
    if _property_types is not None:
        return _property_types

    acc: dict = {}
    for row in get_kg().graph.query(_Q_PROPERTY_TYPES):
        t_uri = str(row[0])
        unit_uri = str(row[1]) if row[1] is not None else ""
        n = int(row[2])
        entry = acc.setdefault(t_uri, {
            "type_uri": t_uri, "type": _local(t_uri), "count": 0, "_units": {},
        })
        entry["count"] += n
        if unit_uri:
            entry["_units"][unit_uri] = entry["_units"].get(unit_uri, 0) + n

    out = []
    for entry in acc.values():
        unit_uris = entry.pop("_units")
        by_name = {units.local_name(u): (u, n) for u, n in unit_uris.items()}
        canonical = units.canonical_unit([(name, n) for name, (_, n) in by_name.items()])
        entry["unit"] = canonical
        entry["unit_uri"] = by_name.get(canonical, ("", 0))[0]
        entry["units_seen"] = [
            {"unit": name, "unit_uri": uri, "count": n}
            for name, (uri, n) in sorted(by_name.items(), key=lambda kv: -kv[1][1])
        ]
        out.append(entry)
    _property_types = sorted(out, key=lambda e: e["type"])
    return _property_types


@router.get("/properties")
def list_property_types():
    """Calculated-property types that can be filtered on, and their units."""
    return _load_property_types()


class PropertyFilter(BaseModel):
    type_uri: str
    operator: Optional[str] = None
    value: Optional[str] = None


class PropertyQueryRequest(BaseModel):
    filters: list[PropertyFilter]
    limit: int = 500


def _var(name: str) -> str:
    """Type name -> a safe SPARQL variable name."""
    safe = "".join(ch if (ch.isalnum() or ch == "_") else "_" for ch in name)
    return safe if safe and not safe[0].isdigit() else "p_" + safe


def _unit_bind(raw_var: str, unit_var: str, out_var: str, entry: dict) -> str:
    """
    BIND expression rescaling every unit of a type onto its canonical one.

    Nested IFs on the unit IRI. A row with no unit, or one that cannot be
    converted, falls through unchanged -- right for these types, where a missing
    unit means the source simply did not state one.
    """
    canonical = entry["unit"]
    others = [u for u in entry["units_seen"]
              if u["unit"] != canonical and u["unit_uri"]
              and units.convertible(u["unit_uri"], canonical)]
    expr = "?" + raw_var
    for u in others:
        factor = units.convert(1.0, u["unit_uri"], canonical)
        expr = "IF(?%s = <%s>, ?%s * %g, %s)" % (unit_var, u["unit_uri"], raw_var, factor, expr)
    return "    BIND(%s AS ?%s)" % (expr, out_var)


def _run_select(sparql: str):
    """Run a SELECT and return (columns, rows-as-dicts)."""
    res = get_kg().graph.query(sparql)
    columns = [str(v) for v in res.vars]
    rows = [
        {c: ("" if row[i] is None else str(row[i])) for i, c in enumerate(columns)}
        for row in res
    ]
    return columns, rows


@router.post("/properties")
def query_by_property(req: PropertyQueryRequest):
    """
    Samples selected by the value of one or more calculated properties.

    Every filter must hold at once, so adding filters narrows the result.
    """
    if not req.filters:
        raise HTTPException(status_code=400, detail="Add at least one property filter.")

    by_uri = {e["type_uri"]: e for e in _load_property_types()}
    limit = max(1, min(req.limit, 5000))

    prefixes = [
        "PREFIX rdf: <%s>" % _RDF,
        "PREFIX asmo: <%s>" % _ASMO_NS,
    ]
    select_vars = ["?sample"]
    patterns = ["    ?sample rdf:type <%s> ." % _SAMPLE_CLASS]

    for i, f in enumerate(req.filters):
        entry = by_uri.get(f.type_uri)
        if entry is None:
            raise HTTPException(
                status_code=400,
                detail="Not a filterable calculated property: %s" % f.type_uri)

        base = _var(entry["type"])
        value_var, unit_var = base, base + "_unit"
        pub_var, pub_unit_var = base + "_asPublished", base + "_publishedUnit"
        node = "prop%d" % i

        patterns.append("    ?sample asmo:hasCalculatedProperty ?%s ." % node)
        patterns.append("    ?%s rdf:type <%s> ." % (node, entry["type_uri"]))

        multi = len([u for u in entry["units_seen"] if u["unit_uri"]]) > 1
        if multi:
            # Converted and as-published are kept as separate columns. Showing a
            # rescaled number beside the unit its source stated would read as a
            # 1000x error rather than as a conversion.
            patterns.append("    ?%s asmo:hasValue ?%s ." % (node, pub_var))
            patterns.append("    OPTIONAL { ?%s asmo:hasUnit ?%s }" % (node, pub_unit_var))
            patterns.append(_unit_bind(pub_var, pub_unit_var, value_var, entry))
            patterns.append('    BIND("%s" AS ?%s)' % (entry["unit"], unit_var))
            select_vars += ["?" + value_var, "?" + unit_var,
                            "?" + pub_var, "?" + pub_unit_var]
        else:
            patterns.append("    ?%s asmo:hasValue ?%s ." % (node, value_var))
            patterns.append("    OPTIONAL { ?%s asmo:hasUnit ?%s }" % (node, unit_var))
            select_vars += ["?" + value_var, "?" + unit_var]

        if f.operator and f.value not in (None, ""):
            comparator = _COMPARATORS.get(f.operator)
            if comparator is None:
                raise HTTPException(status_code=400, detail="Unknown operator: %s" % f.operator)
            try:
                number = float(f.value)
            except (TypeError, ValueError):
                raise HTTPException(
                    status_code=400,
                    detail="'%s' is not a number -- property filters compare values." % f.value)
            patterns.append("    FILTER(?%s %s %g)" % (value_var, comparator, number))

    sparql = "\n".join(prefixes) + "\nSELECT DISTINCT " + " ".join(select_vars) \
        + "\nWHERE {\n" + "\n".join(patterns) + "\n}\nLIMIT %d" % limit

    try:
        columns, rows = _run_select(sparql)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Query execution failed: %s" % exc)

    return {"sparql": sparql, "columns": columns, "rows": rows}
