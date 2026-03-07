from fastapi import APIRouter
from app.cache import read_cache

router = APIRouter(prefix="/api/datasets", tags=["datasets"])


@router.get("")
def list_datasets():
    """Return all datasets with sample counts and publication info. Served from cache."""
    cached = read_cache("datasets.json")
    if cached is not None:
        return cached
    return []
