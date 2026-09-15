# kg_frontend

Web frontend, SPARQL endpoint and Linked Data resolver for the
[atomRDF](https://github.com/pyscal/atomRDF) knowledge graph of atomistic
simulation data.

Live at **https://atomkg.pyscal.org** (also `matkg.pyscal.org`,
`atomrdfkg.pyscal.org`).

| | |
|---|---|
| Portal UI | `/` — browse samples, workflows, properties, datasets |
| SPARQL | `/sparql` — W3C SPARQL Protocol, read-only |
| Entity pages | `/id/{scheme}/{local-id}` — HTML for browsers, RDF for machines |

Every entity in the graph has a dereferenceable IRI. Following one returns an
HTML page in a browser and Turtle/JSON-LD/N-Triples to anything else, and every
IRI on a page links to its own page, so the graph can be walked by hand.

```bash
curl -H 'Accept: text/turtle' https://atomkg.pyscal.org/id/sample/<uuid>
```

## Documentation

- **[DEPLOY.md](DEPLOY.md)** — standing the service up on a fresh host, and the
  gotchas that cost real debugging time
- **[BUILD.md](BUILD.md)** — building the image, the dependency pins that matter,
  and publishing a rebuilt graph

The graph data is built and pushed from
[FAIR-tools/kg_data](https://github.com/FAIR-tools/kg_data).
