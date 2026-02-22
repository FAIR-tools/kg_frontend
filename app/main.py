from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.wsgi import WSGIMiddleware
import os

from app.routes import sparql, guided, ontology, samples, export, admin, graph
from app.viewer_dash import viewer_wsgi

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

# Crystal Toolkit structure viewer (Dash WSGI sub-app)
# Must be mounted BEFORE static files so /viewer/* is not intercepted
app.mount("/viewer", WSGIMiddleware(viewer_wsgi))

# Serve the static frontend at /
# Must be mounted AFTER routes so /api/* is not intercepted
static_dir = os.path.join(os.path.dirname(__file__), "static")
app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
