# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────
# APP IMAGE — thin layer on top of the pre-built base image.
# All heavy deps live in ghcr.io/fair-tools/kg_frontend_base.
# Only app/ code is copied here, so rebuilds take ~5 seconds.
# ─────────────────────────────────────────────────────────────────
FROM ghcr.io/fair-tools/kg_frontend_base:latest

USER root
WORKDIR /app

# Install Oxigraph RDFLib plugin and update atomRDF to no_local_files branch
ARG MAMBA_DOCKERFILE_ACTIVATE=1
RUN pip install --no-cache-dir oxrdflib pyoxigraph && \
    pip install --no-cache-dir --no-deps \
        "git+https://github.com/pyscal/atomRDF.git@no_local_files" \
        "git+https://github.com/OCDO/tools4RDF.git@main"

COPY app/ ./app/
RUN mkdir -p /data/rdf_structure_store

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/_entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
