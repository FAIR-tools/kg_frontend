from fastapi import APIRouter, Depends, HTTPException, Header
from app.graph_state import reload_kg
import os

router = APIRouter(prefix="/api/admin", tags=["admin"])

RELOAD_TOKEN = os.environ.get("RELOAD_TOKEN", "changeme")


@router.post("/reload")
def reload(x_reload_token: str = Header(...)):
    """
    Reload the KnowledgeGraph singleton from disk.
    Called by the GitHub Actions deploy workflow after rebuild_graph.py runs.
    Protected by a shared secret passed as the X-Reload-Token header.
    """
    if x_reload_token != RELOAD_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid token")
    kg = reload_kg()
    return {"status": "reloaded", "n_samples": len(kg.sample_ids)}
