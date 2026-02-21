# syntax=docker/dockerfile:1
FROM mambaorg/micromamba:1.5.10

# Switch to root for system package installation and app setup
USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
 && rm -rf /var/lib/apt/lists/*

# Install conda environment (conda-forge resolves scipy and other conflicts)
# This layer is cached unless environment.yml changes
COPY environment.yml /tmp/environment.yml
RUN micromamba install -y -n base -f /tmp/environment.yml && \
    micromamba clean --all --yes

# Install git-based packages via pip (separate layer for faster rebuilds)
RUN micromamba run -n base pip install --no-cache-dir \
    "git+https://github.com/RDFLib/rdflib-sqlalchemy.git@develop" \
    "git+https://github.com/pyscal/atomRDF.git@clean_structure" \
    "git+https://github.com/OCDO/tools4RDF.git@main"

WORKDIR /app

# Copy application code
COPY app/ ./app/

# Data lives on the mounted volume — create fallback for local dev
RUN mkdir -p /data/structure_store

EXPOSE 8000

CMD ["micromamba", "run", "-n", "base", "uvicorn", "app.main:app", \
     "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
