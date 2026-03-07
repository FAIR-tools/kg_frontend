from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import os

from app.routes import (
    sparql,
    guided,
    ontology,
    samples,
    export,
    admin,
    graph,
    nlq,
    workflows,
    upload,
    properties,
)

app = FastAPI(
    title="AtomRDF Knowledge Graph",
    description="Web frontend for atomRDF knowledge graphs — query, explore, and export.",
    version="0.1.0",
)

# Allow localhost dev tools to call the API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routes
app.include_router(sparql.router)
app.include_router(guided.router)
app.include_router(ontology.router)
app.include_router(samples.router)
app.include_router(export.router)
app.include_router(admin.router)
app.include_router(graph.router)
app.include_router(nlq.router)
app.include_router(workflows.router)
app.include_router(upload.router)
app.include_router(properties.router)

# Crystal Toolkit structure viewer (Dash WSGI sub-app) — loaded lazily
# so the app still starts if crystal-toolkit isn't installed yet.
try:
    from starlette.middleware.wsgi import WSGIMiddleware
    from app.viewer_dash import viewer_wsgi

    app.mount("/viewer", WSGIMiddleware(viewer_wsgi))
except ImportError:
    pass  # crystal-toolkit not yet installed; /viewer unavailable until base image rebuild

# Serve the static frontend at /
# Must be mounted AFTER routes so /api/* is not intercepted
static_dir = os.path.join(os.path.dirname(__file__), "static")
app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
