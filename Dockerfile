# syntax=docker/dockerfile:1
FROM python:3.11-slim

# System deps for graphviz, git and build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    graphviz \
    libgraphviz-dev \
    pkg-config \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps (cached layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ ./app/

# Data lives on the mounted volume — create fallback for local dev
RUN mkdir -p /data/structure_store

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
