from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
import io
from app.graph_state import get_kg

router = APIRouter(prefix="/api/export", tags=["export"])

FORMAT_MEDIA_TYPES = {
    "turtle": ("text/turtle", "graph.ttl"),
    "json-ld": ("application/ld+json", "graph.jsonld"),
    "xml": ("application/rdf+xml", "graph.rdf"),
}


@router.get("")
def export_graph(format: str = Query("turtle", enum=["turtle", "json-ld", "xml"])):
    """Serialize the full graph and stream it as a file download."""
    kg = get_kg()
    media_type, filename = FORMAT_MEDIA_TYPES[format]
    try:
        data = kg.graph.serialize(format=format)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    if isinstance(data, str):
        data = data.encode("utf-8")

    return StreamingResponse(
        io.BytesIO(data),
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
