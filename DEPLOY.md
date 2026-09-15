# Deploying from scratch

Everything needed to stand this service up on a new host. It has moved twice
already (Google Cloud → Oracle Cloud, and `fair-workflows.org` → `pyscal.org`),
so this is written to be followed without prior context.

There is **no CI**. The image is built by hand on the host that runs it.

## What the service is

One FastAPI app behind nginx:

| | |
|---|---|
| Portal UI | `/` |
| SPARQL endpoint | `/sparql` (W3C SPARQL Protocol, read-only) |
| Entity pages / IRI resolution | `/id/{scheme}/{local-id}` |
| Graph data | `/data` on the host, bind-mounted into the container |

The knowledge graph itself is **not** in this repo. It is built from
`atomRDF_usecases_new/build_combined_kg.py` and pushed with
[`kg_data/push_data.sh`](https://github.com/FAIR-tools/kg_data).

## Current deployment

- Host: Oracle Cloud `VM.Standard.A1.Flex`, **aarch64**, Oracle Linux 9, 1 OCPU / 6 GB
- User `opc`, key `~/.ssh/atomrdf_oci`
- Reserved (static) public IP — use a reserved IP, not an ephemeral one, or DNS breaks on restart
- Hostnames: `atomkg.pyscal.org` (canonical), `matkg.pyscal.org`, `atomrdfkg.pyscal.org`

---

## 1. Provision

Any arm64 or amd64 Linux host with ~4 GB RAM and 10 GB free disk works. On Oracle
Cloud the Always Free A1 shape is sufficient.

**Open ports 80 and 443 in the cloud firewall.** On OCI this is the VCN Security
List (or an NSG) for the subnet — ingress, CIDR `0.0.0.0/0`, TCP, destination
port 80 and 443. This is separate from the host firewall below and is the usual
cause of "port unreachable" when everything on the host looks fine.

## 2. System packages

```bash
sudo dnf -y install git dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf -y --allowerasing install docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"      # log out and back in

sudo dnf -y install nginx
sudo dnf config-manager --enable ol9_developer_EPEL   # certbot lives in EPEL on OL9
sudo dnf -y install certbot python3-certbot-nginx
```

`--allowerasing` is needed because Oracle Linux ships podman/runc, which conflict
with `containerd.io`.

## 3. Host firewall and SELinux

```bash
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload

# nginx proxies to the container on 127.0.0.1:8000; SELinux blocks that by default
sudo setsebool -P httpd_can_network_connect 1
```

## 4. Data directory

```bash
sudo mkdir -p /data && sudo chown "$USER:$USER" /data

# SELinux: label /data so Docker can bind-mount it
sudo dnf -y install policycoreutils-python-utils
sudo semanage fcontext -a -t container_file_t "/data(/.*)?"
sudo restorecon -R /data
```

`/data` ends up holding `oxigraph.db`, `rdf_structure_store` and `cache`.
Budget ~2.5 GB: the swap in `push_data.sh` keeps two generations at once.

## 5. Clone and configure

```bash
cd ~ && git clone https://github.com/FAIR-tools/kg_frontend.git
cd ~ && git clone https://github.com/FAIR-tools/kg_data.git

cd ~/kg_frontend
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

- `RELOAD_TOKEN` — generate with `openssl rand -hex 32`. Also write it to
  `~/.reload_token` (mode 600); `push_data.sh` reads it from there over ssh.
  **Never hardcode it in a script** — an earlier value was committed to a public
  repo and had to be rotated.
- `KG_DATA_DIR` — path to the `kg_data` checkout (e.g. `/home/opc/kg_data`)
- `LLM_API_KEY` — Groq key for natural-language → SPARQL. Leaving it empty
  disables only that feature; browsing, guided queries and `/sparql` work fine.

## 6. Build and start

See [BUILD.md](BUILD.md). Briefly:

```bash
cd ~/kg_frontend
docker build -f Dockerfile.base -t kg_frontend_base:latest .   # ~10-15 min on 1 OCPU
export CACHE_DATE=$(date +%Y-%m-%d)
docker compose up --build -d
docker compose ps        # want: Up (healthy), allow ~3 min for start_period
```

## 7. DNS

A records for every hostname → the host's public IP. Wait for propagation
(`dig +short atomkg.pyscal.org`) **before** running certbot: a premature attempt
burns Let's Encrypt rate limit (5 failures per hostname per hour).

## 8. nginx and TLS

```bash
sudo cp ~/kg_frontend/nginx/atomrdf.conf /etc/nginx/conf.d/atomrdf.conf
sudo nginx -t && sudo systemctl enable --now nginx

sudo mkdir -p /var/www/html      # ACME challenge root

sudo certbot --nginx --cert-name atomkg.pyscal.org \
  -d atomkg.pyscal.org -d matkg.pyscal.org -d atomrdfkg.pyscal.org \
  --non-interactive --agree-tos -m <your-email> --redirect
```

One certificate covering all hostnames means one renewal to care about. To add a
hostname later: add it to **both** `server_name` lines, reload, then re-run the
above with `--expand` and the extra `-d`.

**Then enable renewal — certbot does not do this for you on Oracle Linux:**

```bash
sudo systemctl enable --now certbot-renew.timer
systemctl is-enabled certbot-renew.timer    # must print: enabled
sudo certbot renew --dry-run                # slow: certbot sleeps a random delay first
```

certbot prints "Certbot has set up a scheduled task to automatically renew this
certificate" — on the EPEL package **this is not true**, the timer ships
disabled. Left alone the certificate silently expires after 90 days.

## 9. Push the graph

From the machine holding the built graph (not the server):

```bash
cd atomRDF_usecases_new && python build_combined_kg.py

# Mint dereferenceable IRIs. Without this the published graph uses
# sample:/property:/simulation: which nothing can resolve.
python ~/kg_data/rewrite_iris.py --src combined_KG/oxigraph.db --in-place

cd ~/kg_data && ./push_data.sh
```

`rewrite_iris.py --base` must match the canonical hostname in the nginx config
and `CANONICAL_BASE` in `app/routes/resolve.py`. If the host ever changes, all
three move together and the graph must be rewritten and re-pushed.

## 10. Verify

```bash
curl -s -X POST https://atomkg.pyscal.org/sparql \
  -H 'Accept: application/sparql-results+json' \
  --data-urlencode 'query=SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }'

curl -sI https://atomkg.pyscal.org/id/sample/<any-uuid>   # 200 text/turtle
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Accept: text/html' https://atomkg.pyscal.org/id/sample/<any-uuid>   # 200 HTML

curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  https://matkg.pyscal.org/id/sample/<any-uuid>            # 301 to atomkg
```

---

## Gotchas

Each of these cost real debugging time.

**`ipv6only=on` may appear only once per address:port** across the whole nginx
config. Adding it to a second server block makes nginx refuse to start with
"duplicate listen options". nginx rejects the reload rather than applying it, so
the old config keeps serving — check `nginx -t` output, not just the site.

**`certbot-renew.timer` ships disabled** on Oracle Linux / EPEL despite certbot
claiming otherwise. See step 8.

**The cloud firewall is separate from `firewalld`.** Both must allow 80/443.
`nc -z host 443` cannot tell "blocked" from "nothing listening" — a *refused*
connection (fast) means the packet arrived and nothing was listening; a *timeout*
means it was dropped upstream.

**`pyscal3` has no linux-aarch64 conda build.** It is pip-installed from the PyPI
sdist in `Dockerfile.base`, which works on both architectures.

**Pin `pymatgen`.** 2026.x removed `StructureGraph.with_empty_graph`, which the
pinned crystal-toolkit still calls, and the app dies on import. This breaks any
architecture, not just ARM.

**The healthcheck cannot use `curl`** — it is not in the micromamba image. It also
cannot rely on `PATH`, because `docker exec` bypasses the micromamba entrypoint;
use `/opt/conda/bin/python`.

**`KnowledgeGraph.get_sample_as_structure` mangles minted IRIs.** It prepends
`sample:` unless the string already starts with it, and `URIRef` subclasses `str`,
so `https://…/id/sample/x` becomes `sample:https://…/id/sample/x`. The portal
calls `AtomicScaleSample.from_graph` directly instead (`_sample_as_structure` in
`app/routes/samples.py`). Fix upstream in atomrdf if you get the chance.

**Most samples have no structure.** Only ~8k of ~45k carry a simulation cell;
the rest are property-only datasets. `/api/samples/xyz/...` returns 422 with an
explanation for those — that is expected, not a bug.

**Inbound links must stay capped** in `app/routes/resolve.py`.
`method/MolecularStatics` is the object of 37,263 triples; rendering them all
would produce an unusable page and a huge response.

**`rewrite_iris.py` must `flush()` before `optimize()`**, or the store keeps
~1.9 GB of write-ahead logs beside ~900 MB of real data.
