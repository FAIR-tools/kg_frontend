# syntax=docker/dockerfile:1
FROM mambaorg/micromamba:1.5.10

# Install system deps as root
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
 && rm -rf /var/lib/apt/lists/*

# Switch back to mamba user for all env operations
USER $MAMBA_USER

# Install conda packages (heavy layer — cached unless environment.yml changes)
COPY --chown=$MAMBA_USER:$MAMBA_USER environment.yml /tmp/environment.yml
RUN micromamba install -y -n base -f /tmp/environment.yml && \
    micromamba clean --all --yes

# Activate base env for subsequent RUN commands
ARG MAMBA_DOCKERFILE_ACTIVATE=1

# Install git-based packages via pip (separate layer for faster rebuilds)
RUN pip install --no-cache-dir \
    "git+https://github.com/RDFLib/rdflib-sqlalchemy.git@develop" \
    "git+https://github.com/pyscal/atomRDF.git@clean_structure" \
    "git+https://github.com/OCDO/tools4RDF.git@main"

# App code (cheapest layer — rebuilt on every deploy)
USER root
WORKDIR /app
COPY app/ ./app/
RUN mkdir -p /data/structure_store

EXPOSE 8000

# _entrypoint.sh activates the base conda env before running CMD
ENTRYPOINT ["/usr/local/bin/_entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
