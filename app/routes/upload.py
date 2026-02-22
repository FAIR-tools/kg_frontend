"""
/api/upload  — collaborator file submission and admin approval queue.

Flow:
  1. Collaborator POSTs a YAML file with their UPLOAD_TOKEN.
     → saved to PENDING_DIR (/data/pending/)
  2. Admin lists pending files via GET /api/admin/pending (RELOAD_TOKEN).
  3. Admin approves via POST /api/admin/approve/{filename}.
     → file moved to APPROVED_DIR (/data/approved/)
     → rebuild runs in a background thread, then the KG singleton is reloaded.
  4. Admin rejects via DELETE /api/admin/reject/{filename}.
     → pending file is deleted.
"""

import os
import shutil
import threading
import logging
import glob
from datetime import datetime, timezone
from pathlib import Path
from fastapi import APIRouter, Header, HTTPException, UploadFile, File

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["upload"])

# ── Tokens ────────────────────────────────────────────────────────────────────
_UPLOAD_TOKEN = os.environ.get("UPLOAD_TOKEN", "")
_RELOAD_TOKEN = os.environ.get("RELOAD_TOKEN", "changeme")

# ── Directories (all on the persistent /data disk) ───────────────────────────
_DATA_ROOT    = "/data" if os.path.isdir("/data") else os.path.join(os.getcwd(), "data")
PENDING_DIR   = os.path.join(_DATA_ROOT, "pending")
APPROVED_DIR  = os.path.join(_DATA_ROOT, "approved")
_STORE_PATH   = os.path.join(_DATA_ROOT, "structure_store")
_DB_PATH      = os.path.join(_DATA_ROOT, "graph.db")

# git-sourced YAMLs still scanned during rebuild (backward compat)
_GIT_YAML_DIR = "/kg_data/data"

os.makedirs(PENDING_DIR,  exist_ok=True)
os.makedirs(APPROVED_DIR, exist_ok=True)


# ── Auth helpers ─────────────────────────────────────────────────────────────
def _require_upload(token: str):
    if not _UPLOAD_TOKEN:
        raise HTTPException(status_code=503, detail="Upload not configured (UPLOAD_TOKEN unset)")
    if token != _UPLOAD_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid upload token")


def _require_admin(token: str):
    if token != _RELOAD_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid admin token")


# ── Rebuild helper (mirrors rebuild_graph.py logic) ──────────────────────────
def _run_rebuild():
    """Wipe and rebuild the KG from approved + git-sourced YAMLs."""
    try:
        from atomrdf import KnowledgeGraph
        from atomrdf.io.workflow_parser import WorkflowParser
        from app.graph_state import reload_kg
        from app.routes.graph import _graph_cache, _graph_cache_mtime

        # Collect all YAML files: approved uploads + git data
        yaml_files = sorted(
            glob.glob(os.path.join(APPROVED_DIR, "**", "*.yaml"), recursive=True) +
            glob.glob(os.path.join(APPROVED_DIR, "**", "*.yml"),  recursive=True) +
            glob.glob(os.path.join(_GIT_YAML_DIR, "**", "*.yaml"), recursive=True) +
            glob.glob(os.path.join(_GIT_YAML_DIR, "**", "*.yml"),  recursive=True)
        )
        log.info("[rebuild] %d YAML file(s) found", len(yaml_files))

        # Wipe existing graph
        if os.path.exists(_DB_PATH):
            os.remove(_DB_PATH)
        if os.path.isdir(_STORE_PATH):
            shutil.rmtree(_STORE_PATH)
        os.makedirs(_STORE_PATH, exist_ok=True)

        kg = KnowledgeGraph(store="SQLAlchemy", store_file=_DB_PATH, structure_store=_STORE_PATH)
        parser = WorkflowParser(kg=kg)

        for yf in yaml_files:
            log.info("[rebuild] parsing %s", yf)
            try:
                parser.parse(yf)
            except Exception as exc:
                log.error("[rebuild] failed %s: %s", yf, exc)

        log.info("[rebuild] done — %d sample(s)", len(kg.sample_ids))

        # Invalidate graph.py's in-memory cache then reload singleton
        import app.routes.graph as graph_mod
        graph_mod._graph_cache = None
        graph_mod._graph_cache_mtime = -1.0

        reload_kg()
        log.info("[rebuild] KG singleton reloaded")
    except Exception as e:
        log.error("[rebuild] unexpected error: %s", e)


# ── Rebuild state (simple in-memory flag) ────────────────────────────────────
_rebuild_state: dict = {"status": "idle", "started_at": None}


def _rebuild_in_background():
    global _rebuild_state
    _rebuild_state = {"status": "running", "started_at": datetime.now(timezone.utc).isoformat()}
    try:
        _run_rebuild()
        _rebuild_state["status"] = "done"
    except Exception as e:
        _rebuild_state["status"] = f"error: {e}"


# ════════════════════════════════════════════════════════════════════════════
# Collaborator endpoints
# ════════════════════════════════════════════════════════════════════════════

@router.post("/upload")
async def submit_file(
    file: UploadFile = File(...),
    x_upload_token: str = Header(...),
):
    """
    Submit a YAML file for admin review.
    Requires X-Upload-Token header.
    """
    _require_upload(x_upload_token)

    name = Path(file.filename).name  # strip any path components
    if not name.endswith((".yaml", ".yml")):
        raise HTTPException(status_code=400, detail="Only .yaml / .yml files are accepted")

    # Prefix with timestamp to avoid collisions
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    safe_name = f"{ts}_{name}"
    dest = os.path.join(PENDING_DIR, safe_name)

    content = await file.read()
    if len(content) > 100 * 1024 * 1024:  # 100 MB hard cap
        raise HTTPException(status_code=413, detail="File too large (max 100 MB)")

    with open(dest, "wb") as fh:
        fh.write(content)

    log.info("[upload] received %s (%d bytes) → %s", name, len(content), dest)
    return {"status": "pending", "filename": safe_name, "bytes": len(content)}


# ════════════════════════════════════════════════════════════════════════════
# Admin endpoints  (all require X-Reload-Token)
# ════════════════════════════════════════════════════════════════════════════

@router.get("/admin/pending")
def list_pending(x_reload_token: str = Header(...)):
    """List all files waiting for approval."""
    _require_admin(x_reload_token)
    files = []
    for p in sorted(Path(PENDING_DIR).iterdir()):
        if p.is_file() and p.suffix in (".yaml", ".yml"):
            stat = p.stat()
            files.append({
                "filename": p.name,
                "bytes": stat.st_size,
                "submitted_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
            })
    return {"pending": files}


@router.post("/admin/approve/{filename}")
def approve(filename: str, x_reload_token: str = Header(...)):
    """Approve a pending file and trigger a KG rebuild."""
    _require_admin(x_reload_token)

    src = Path(PENDING_DIR) / filename
    if not src.is_file():
        raise HTTPException(status_code=404, detail="Pending file not found")

    dst = Path(APPROVED_DIR) / filename
    shutil.move(str(src), str(dst))
    log.info("[admin] approved %s → %s", src, dst)

    if _rebuild_state.get("status") == "running":
        return {"status": "approved", "rebuild": "already running — will pick up on next rebuild"}

    t = threading.Thread(target=_rebuild_in_background, daemon=True)
    t.start()
    return {"status": "approved", "filename": filename, "rebuild": "started"}


@router.delete("/admin/reject/{filename}")
def reject(filename: str, x_reload_token: str = Header(...)):
    """Reject and delete a pending file."""
    _require_admin(x_reload_token)

    p = Path(PENDING_DIR) / filename
    if not p.is_file():
        raise HTTPException(status_code=404, detail="Pending file not found")

    p.unlink()
    log.info("[admin] rejected and deleted %s", filename)
    return {"status": "rejected", "filename": filename}


@router.get("/admin/rebuild-status")
def rebuild_status(x_reload_token: str = Header(...)):
    """Check the status of the most recent background rebuild."""
    _require_admin(x_reload_token)
    return _rebuild_state
