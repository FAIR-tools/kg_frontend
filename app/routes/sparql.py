from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.graph_state import get_kg
import pandas as pd

router = APIRouter(prefix="/api/sparql", tags=["sparql"])


class SPARQLRequest(BaseModel):
    query: str


@router.post("")
def run_sparql(req: SPARQLRequest):
    """Execute a raw SPARQL SELECT query and return results as a list of row dicts."""
    kg = get_kg()
    try:
        result = kg.query(req.query)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if result is None:
        return {"columns": [], "rows": []}

    if isinstance(result, pd.DataFrame):
        df = result
    else:
        # tools4rdf may return a list of dicts or similar
        df = pd.DataFrame(result)

    df = df.fillna("")
    return {
        "columns": list(df.columns),
        "rows": df.to_dict(orient="records"),
    }
