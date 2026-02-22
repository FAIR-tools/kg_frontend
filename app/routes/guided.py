from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.graph_state import get_kg
from app.ontology_state import get_onto, _find_term_by_uri
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
