# Building and deploying

There is no CI. The image is built by hand on the host that runs it, which is why
the build must work from a clean clone.

## Host

`matkg.pyscal.org` — Oracle Cloud `VM.Standard.A1.Flex` (**aarch64**), Oracle Linux 9,
1 OCPU / 6 GB. nginx terminates TLS on the host and reverse-proxies to the container
on `127.0.0.1:8000`.

## Build

Two steps: a heavy base image (all conda/pip dependencies) and a thin app layer.
Rebuild the base only when `environment.yml` or `Dockerfile.base` changes.

```bash
cd ~/kg_frontend

# 1. base image — slow (~10-15 min on 1 OCPU). Only when deps change.
docker build -f Dockerfile.base -t kg_frontend_base:latest .

# 2. app layer + start — seconds
export CACHE_DATE=$(date +%Y-%m-%d)      # busts the COPY cache so app/ is refreshed
docker compose up --build -d
```

Check it came up:

```bash
docker compose ps                 # want: Up (healthy) — allow ~3 min for start_period
curl -s localhost:8000/api/samples | head -c 200
```

## Configuration

`.env` is gitignored and must exist on the host. See `.env.example`.
`RELOAD_TOKEN` gates `/api/admin/reload`; `kg_data/push_data.sh` reads it from
`~/.reload_token` on the host. Never hardcode it — an earlier value was committed
to this public repo and had to be rotated.

`LLM_API_KEY` (Groq) powers natural-language → SPARQL only. Leaving it empty
disables that one feature; browsing, guided queries and `/sparql` work without it.

## Dependency pins that matter

Both of these were found the hard way when rebuilding from scratch:

- **`pymatgen=2025.6.14`** — 2026.x removed `StructureGraph.with_empty_graph`, which
  the pinned crystal-toolkit still calls. Unpinning crashes the app on import, on
  every architecture.
- **`pyscal3` via pip, not conda** — conda-forge publishes no `linux-aarch64` build.
  The PyPI release has x86_64 wheels and an sdist, so pip covers both architectures
  (compiling from source on arm64, which needs the `build-essential`/`cmake` already
  installed in `Dockerfile.base`).

The healthcheck in `docker-compose.yml` deliberately does **not** use `curl` — it is
not installed in the micromamba image.

## Data

The graph lives on the host at `/data` (`oxigraph.db`, `rdf_structure_store`, `cache`)
and is not in this repo. Push a rebuilt graph with `kg_data/push_data.sh`.
