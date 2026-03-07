"""
/api/upload  — trusted collaborator file ingestion.

Anyone with the UPLOAD_TOKEN can POST a YAML file.
It is saved immediately to the uploads directory and a background
rebuild is triggered automatically.
"""

import os
import threading
import logging
import glob
from datetime import datetime, timezone
from pathlib import Path
from fastapi import APIRouter, Header, HTTPException, UploadFile, File

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["upload"])

_UPLOAD_TOKEN = os.environ.get("UPLOAD_TOKEN", "")

_DATA_ROOT = "/data" if os.path.isdir("/data") else os.path.join(os.getcwd(), "data")
UPLOAD_DIR = os.path.join(_DATA_ROOT, "uploads")
_STORE_PATH = os.path.join(_DATA_ROOT, "structure_store")
_DB_PATH = os.path.join(_DATA_ROOT, "graph.db")
_GIT_YAML_DIR = "/kg_data/data"

os.makedirs(UPLOAD_DIR, exist_ok=True)


# ── Rebuild state & worker ───────────────────────────────────────────────────
# _rebuild_pending is set whenever a file is saved.
# The worker clears it, runs a full rebuild, then checks if it was re-set
# (a concurrent upload arrived mid-rebuild) and loops again if so.
# This guarantees N simultaneous uploads collapse into one correct final rebuild.
_rebuild_pending = threading.Event()
_rebuild_active = threading.Event()  # True while the worker thread is alive
rebuild_state: dict = {"status": "idle", "started_at": None}


def _rebuild_worker():
    global rebuild_state
    while True:
        _rebuild_pending.clear()
        rebuild_state = {
            "status": "running",
            "started_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            from pathlib import Path as _Path
            from atomrdf import KnowledgeGraph
            from atomrdf.io.workflow_parser import WorkflowParser
            from app.graph_state import get_kg, reload_kg
            import app.routes.graph as graph_mod

            yaml_files = sorted(
                glob.glob(os.path.join(UPLOAD_DIR, "**", "*.yaml"), recursive=True)
                + glob.glob(os.path.join(UPLOAD_DIR, "**", "*.yml"), recursive=True)
                + glob.glob(os.path.join(_GIT_YAML_DIR, "**", "*.yaml"), recursive=True)
                + glob.glob(os.path.join(_GIT_YAML_DIR, "**", "*.yml"), recursive=True)
            )
            log.info("[rebuild] %d YAML file(s) found", len(yaml_files))

            # Load manifest (path → mtime) to skip already-parsed files
            _manifest_path = os.path.join(_DATA_ROOT, "parsed_manifest.json")
            import json as _json

            manifest: dict = {}
            no_manifest = not os.path.exists(_manifest_path)
            if not no_manifest:
                try:
                    manifest = _json.loads(_Path(_manifest_path).read_text())
                except Exception:
                    manifest = {}
                    no_manifest = True

            # If DB exists but manifest doesn't, the DB was built by the old
            # scratch-rebuild code — re-parsing into it would create duplicates.
            # Close the app's KG first to release file descriptors, then wipe.
            if no_manifest and os.path.exists(_DB_PATH):
                log.info(
                    "[rebuild] no manifest found — closing KG and wiping DB to prevent duplicates"
                )
                from app.graph_state import close_kg

                close_kg()
                os.remove(_DB_PATH)
                if os.path.isdir(_STORE_PATH):
                    import shutil as _shutil

                    _shutil.rmtree(_STORE_PATH)
                os.makedirs(_STORE_PATH, exist_ok=True)

            to_parse = [
                (yf, os.path.getmtime(yf))
                for yf in yaml_files
                if manifest.get(yf) != os.path.getmtime(yf)
            ]

            if not to_parse:
                log.info("[rebuild] all files already up-to-date — skipping parse")
                rebuild_state = {
                    "status": "done",
                    "samples": len(get_kg().sample_ids),
                    "errors": [],
                    "started_at": rebuild_state["started_at"],
                }
                if not _rebuild_pending.is_set():
                    break
                log.info("[rebuild] new upload detected — re-checking")
                continue

            log.info("[rebuild] %d new/changed file(s) to parse", len(to_parse))

            # Open existing KG (create if absent)
            os.makedirs(_STORE_PATH, exist_ok=True)
            kg = KnowledgeGraph(
                store="SQLAlchemy", store_file=_DB_PATH, structure_store=_STORE_PATH
            )
            parser = WorkflowParser(kg=kg)
            errors = []
            import json as _json

            for yf, mtime in to_parse:
                try:
                    parser.parse(yf)
                    manifest[yf] = mtime
                except Exception as exc:
                    log.error("[rebuild] failed %s: %s", yf, exc)
                    errors.append(yf)

            # Persist manifest
            _Path(_manifest_path).write_text(_json.dumps(manifest, indent=2))

            graph_mod._graph_cache = None
            graph_mod._graph_cache_mtime = -1.0
            reload_kg()

            n = len(kg.sample_ids)
            log.info("[rebuild] done — %d sample(s), %d error(s)", n, len(errors))
            rebuild_state = {
                "status": "done",
                "samples": n,
                "errors": errors,
                "started_at": rebuild_state["started_at"],
            }
        except Exception as e:
            log.error("[rebuild] unexpected error: %s", e)
            rebuild_state["status"] = f"error: {e}"

        # Another file arrived while we were rebuilding — loop immediately
        if not _rebuild_pending.is_set():
            break
        log.info("[rebuild] new upload detected mid-rebuild — re-running")

    _rebuild_active.clear()


def _trigger_rebuild():
    _rebuild_pending.set()
    if not _rebuild_active.is_set():
        _rebuild_active.set()
        threading.Thread(target=_rebuild_worker, daemon=True).start()


# ── Upload endpoint ────────────────────────────────────────────────────────────
@router.post("/upload")
async def submit_file(
    file: UploadFile = File(...),
    x_upload_token: str = Header(...),
):
    """Upload a YAML file. Requires X-Upload-Token header. Triggers a KG rebuild immediately."""
    if not _UPLOAD_TOKEN:
        raise HTTPException(
            status_code=503, detail="Upload not configured (UPLOAD_TOKEN unset)"
        )
    if x_upload_token != _UPLOAD_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid upload token")

    name = Path(file.filename).name
    if not name.endswith((".yaml", ".yml")):
        raise HTTPException(
            status_code=400, detail="Only .yaml / .yml files are accepted"
        )

    content = await file.read()
    if len(content) > 100 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 100 MB)")

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    safe_name = f"{ts}_{name}"
    dest = os.path.join(UPLOAD_DIR, safe_name)
    with open(dest, "wb") as fh:
        fh.write(content)
    log.info("[upload] saved %s (%d bytes)", safe_name, len(content))

    _trigger_rebuild()

    return {"status": "rebuilding", "filename": safe_name, "bytes": len(content)}


@router.get("/upload/status")
def upload_status(x_upload_token: str = Header(...)):
    """Check the status of the most recent rebuild."""
    if not _UPLOAD_TOKEN or x_upload_token != _UPLOAD_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid token")
    return rebuild_state
