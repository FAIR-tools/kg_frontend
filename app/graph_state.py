"""
Singleton KnowledgeGraph instance shared across the FastAPI app.
Data is stored on the persistent disk at /data/graph.db.
Falls back to ./data/ for local development.
"""

import os
from atomrdf import KnowledgeGraph

_kg: KnowledgeGraph | None = None

# Use /data when running in Docker on GCP; fall back to ./data for local dev
_DATA_DIR = "/data" if os.path.isdir("/data") else os.path.join(os.getcwd(), "data")
_DB_PATH = os.path.join(_DATA_DIR, "graph.db")
_STORE_PATH = os.path.join(_DATA_DIR, "structure_store")


def get_kg() -> KnowledgeGraph:
    global _kg
    if _kg is None:
        os.makedirs(_STORE_PATH, exist_ok=True)
        _kg = KnowledgeGraph(
            store="SQLAlchemy",
            store_file=_DB_PATH,
            structure_store=_STORE_PATH,
        )
        # Switch to WAL mode: much more resilient to crashes/concurrent access
        try:
            import sqlalchemy
            engine = _kg.graph.store._engine  # type: ignore[attr-defined]
            with engine.connect() as conn:
                conn.execute(sqlalchemy.text("PRAGMA journal_mode=WAL"))
        except Exception:
            pass  # non-fatal; fall back to default journal mode
    return _kg


def reload_kg() -> KnowledgeGraph:
    """Close the current KG and reload from disk. Called after a graph rebuild."""
    global _kg
    if _kg is not None:
        try:
            # Dispose the SQLAlchemy engine to fully release all file descriptors.
            # Without this, the connection pool keeps the DB file open even after
            # rdflib's graph.close(), which prevents the rebuild from safely deleting it.
            engine = _kg.graph.store._engine  # type: ignore[attr-defined]
            engine.dispose()
        except Exception:
            pass
        try:
            _kg.graph.close()
        except Exception:
            pass
    _kg = None
    return get_kg()


def close_kg() -> None:
    """Close and release the KG without reopening. Used before a full DB wipe."""
    global _kg
    if _kg is not None:
        try:
            engine = _kg.graph.store._engine  # type: ignore[attr-defined]
            engine.dispose()
        except Exception:
            pass
        try:
            _kg.graph.close()
        except Exception:
            pass
    _kg = None
