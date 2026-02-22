/* --------------------------------------------------------
   AtomRDF Knowledge Graph — frontend
   -------------------------------------------------------- */

const API = "";   // same origin

// ── Tab routing ──────────────────────────────────────────
document.querySelectorAll("#main-nav button").forEach(btn => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll("#main-nav button").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${tab}`).classList.add("active");
    if (tab === "samples")   loadSamples();
    if (tab === "graph")     loadGraph();
    if (tab === "workflows") loadWorkflows();
  });
});

// ── Sub-tab routing (Query) ───────────────────────────────
document.querySelectorAll(".subtabs button").forEach(btn => {
  btn.addEventListener("click", () => {
    const st = btn.dataset.subtab;
    document.querySelectorAll(".subtabs button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("subtab-guided").style.display = st === "guided" ? "" : "none";
    document.getElementById("subtab-sparql").style.display = st === "sparql" ? "" : "none";
    document.getElementById("subtab-ask").style.display    = st === "ask"    ? "" : "none";
  });
});

const _SAMPLE_URI_PREFIX = "http://purls.helmholtz-metadaten.de/cmso/sample_";
const _SAMPLE_URI_PATTERN = /^sample:/;

async function _loadSampleCount() {
  try {
    const data = await apiFetch("/api/samples");
    const el = document.getElementById("hdr-sample-count");
    if (el) el.textContent = data.length;
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════
// SAMPLES
// ═══════════════════════════════════════════════════════════
let _samplesCache = [];

async function loadSamples() {
  showEl("samples-loading");
  hideEl("samples-table-wrap");
  hideEl("samples-empty");
  clearAlert("samples-alert");

  try {
    const data = await apiFetch("/api/samples");
    _samplesCache = data;
    document.getElementById("hdr-sample-count").textContent = data.length;
    hideEl("samples-loading");

    if (!data.length) {
      showEl("samples-empty");
      return;
    }
    const wrap = document.getElementById("samples-table-wrap");
    // Build table with action button column manually (escHtml-safe)
    const thead = `<thead><tr><th>Name</th><th>URI</th><th style="width:80px">View</th></tr></thead>`;
    const tbody = data.map((s, i) => {
      const name = escHtml(s.name || "—");
      const uri  = escHtml(s.id);
      const viewBtn = `<button class="btn btn-sm btn-outline" onclick="event.stopPropagation();openStructureViewer('${escAttr(s.id)}','${escAttr(s.name||s.id)}')" title="View atomic structure">🔬 View</button>`;
      return `<tr style="cursor:pointer" data-row="${i}"><td>${name}</td><td><span style="font-family:var(--mono);font-size:11px;color:var(--text-muted)">${uri}</span></td><td>${viewBtn}</td></tr>`;
    }).join("");
    wrap.innerHTML = `<table><thead><tr><th>Name</th><th>URI</th><th style="width:80px">View</th></tr></thead><tbody>${tbody}</tbody></table>`;
    wrap.querySelectorAll("tr[data-row]").forEach(tr => {
      tr.addEventListener("click", () => openSampleDetail(data[parseInt(tr.dataset.row, 10)].id, data[parseInt(tr.dataset.row, 10)].name));
    });
    showEl("samples-table-wrap");
  } catch (e) {
    hideEl("samples-loading");
    showAlert("samples-alert", "error", `Failed to load samples: ${e.message}`);
  }
}

async function openSampleDetail(sampleId, name) {
  clearAlert("samples-alert");
  const panel = document.getElementById("sample-detail");
  const grid  = document.getElementById("detail-grid");
  const title = document.getElementById("detail-title");

  title.textContent = name || sampleId;
  grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:20px"><div class="spinner"></div></div>`;
  panel.classList.add("open");
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  try {
    const d = await apiFetch(`/api/samples/${encodeURIComponent(sampleId)}`);
    grid.innerHTML = renderDetailGrid(d);
    // Show View Structure button
    document.getElementById("detail-view-btn").onclick = () => openStructureViewer(sampleId, name);
    document.getElementById("detail-view-btn").style.display = "";
  } catch (e) {
    grid.innerHTML = `<div class="alert alert-error">Could not load sample: ${e.message}</div>`;
  }
}

function closeDetail() {
  document.getElementById("sample-detail").classList.remove("open");
}

function openStructureViewer(sampleId, name) {
  const url = `/viewer.html?id=${encodeURIComponent(sampleId)}&name=${encodeURIComponent(name)}`;
  window.open(url, "_blank", "noopener");
}

const _ATOM_LEVEL_KEYS = new Set([
  "atoms", "positions", "species", "atom_species", "elements",
  "forces", "velocities", "charges", "masses", "tags",
  "magnetic_moments", "momenta", "numbers",
]);

function renderDetailGrid(obj, prefix = "") {
  let cells = "";
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (_ATOM_LEVEL_KEYS.has(k.toLowerCase())) continue;
    const label = (prefix ? `${prefix}.` : "") + k;
    if (typeof v === "object" && !Array.isArray(v)) {
      cells += renderDetailGrid(v, label);
    } else {
      const display = Array.isArray(v) ? JSON.stringify(v) : String(v);
      cells += `<div class="detail-item"><div class="key">${escHtml(label)}</div><div class="val">${escHtml(display)}</div></div>`;
    }
  }
  return cells;
}

// ═══════════════════════════════════════════════════════════
// GUIDED QUERY
// ═══════════════════════════════════════════════════════════
let _ontologyClasses = [];

async function loadOntologyClasses() {
  const sel = document.getElementById("src-class");
  const SAMPLE_URI = "http://purls.helmholtz-metadaten.de/cmso/AtomicScaleSample";
  try {
    _ontologyClasses = await apiFetch("/api/ontology/classes");
    sel.innerHTML = '<option value="">— choose a class —</option>' +
      _ontologyClasses.map(c =>
        `<option value="${escAttr(c.uri)}">${escHtml(c.namespace + ":" + c.label)}</option>`
      ).join("");
    // Pre-select AtomicScaleSample
    const opt = Array.from(sel.options).find(o => o.value === SAMPLE_URI);
    if (opt) { opt.selected = true; sel.dispatchEvent(new Event("change")); }
  } catch (e) {
    sel.innerHTML = `<option value="">Failed to load: ${e.message}</option>`;
  }
}

// Load classes when the Query tab first becomes visible
document.querySelector('[data-tab="query"]').addEventListener("click", () => {
  if (!_ontologyClasses.length) loadOntologyClasses();
}, { once: true });

let _filterCount = 0;
let _propCache = {};   // uri → [{uri, label, namespace, property_type}]

async function getPropsForClass(classUri) {
  if (!classUri) return [];
  if (_propCache[classUri]) return _propCache[classUri];
  const props = await apiFetch(`/api/ontology/properties/${encodeURIComponent(classUri)}`);
  _propCache[classUri] = props;
  return props;
}

function addFilterRow() {
  const container = document.getElementById("filter-rows");
  const id = ++_filterCount;
  const row = document.createElement("div");
  row.className = "filter-row";
  row.id = `filter-row-${id}`;
  row.innerHTML = `
    <div>
      <label>Property</label>
      <select id="filter-prop-${id}" onchange=""></select>
    </div>
    <div>
      <label>Operator</label>
      <select id="filter-op-${id}">
        <option value="">none</option>
        <option value="==">=</option>
        <option value="!=">≠</option>
        <option value=">">&gt;</option>
        <option value=">=">&ge;</option>
        <option value="<">&lt;</option>
        <option value="<=">&le;</option>
      </select>
    </div>
    <div>
      <label>Value</label>
      <input type="text" id="filter-val-${id}" placeholder="optional" />
    </div>
    <button class="remove-btn" onclick="removeFilterRow(${id})" title="Remove">✕</button>
  `;
  container.appendChild(row);
  populatePropSelect(id);
}

async function populatePropSelect(id) {
  const classUri = document.getElementById("src-class").value;
  const sel = document.getElementById(`filter-prop-${id}`);
  if (!sel) return;
  sel.innerHTML = '<option value="">— loading… —</option>';
  try {
    const props = await getPropsForClass(classUri);
    if (!props.length) {
      sel.innerHTML = '<option value="">— no properties found —</option>';
      return;
    }
    sel.innerHTML = props.map(p =>
      `<option value="${escAttr(p.uri)}">${escHtml(p.namespace + ":" + p.label)} (${p.property_type === "data_property" ? "data" : "object"})</option>`
    ).join("");
  } catch (e) {
    sel.innerHTML = `<option value="">Error: ${e.message}</option>`;
  }
}

// Repopulate all filter rows when source class changes
document.getElementById("src-class").addEventListener("change", () => {
  _propCache = {};
  document.querySelectorAll("[id^=filter-prop-]").forEach(sel => {
    const id = sel.id.replace("filter-prop-", "");
    populatePropSelect(id);
  });
});

function removeFilterRow(id) {
  const row = document.getElementById(`filter-row-${id}`);
  if (row) row.remove();
}

// ═══════════════════════════════════════════════════════════
// GRAPH
// ═══════════════════════════════════════════════════════════
// Solid accent colours (used for borders/rings)
const NODE_COLORS = {
  sample:      "#7986cb",
  structure:   "#4fc3f7",
  element:     "#66bb6a",
  material:    "#ef9a9a",
  calculation: "#ce93d8",
  potential:   "#ffb74d",
  property:    "#fff176",
  other:       "#78909c",
};
// Translucent fill versions
const NODE_FILLS = {
  sample:      "rgba(121,134,203,0.65)",
  structure:   "rgba(79,195,247,0.55)",
  element:     "rgba(102,187,106,0.55)",
  material:    "rgba(239,154,154,0.55)",
  calculation: "rgba(206,147,216,0.55)",
  potential:   "rgba(255,183,77,0.55)",
  property:    "rgba(255,241,118,0.55)",
  other:       "rgba(120,144,156,0.45)",
};

let _graphInstance = null;
let _graphLoaded   = false;

async function loadGraph() {
  if (_graphLoaded) return;
  _graphLoaded = true;

  const container = document.getElementById("graph-container");
  if (!container) return;

  // Show spinner
  container.innerHTML = '<div class="empty" style="height:500px;display:flex;align-items:center;justify-content:center"><div class="spinner" style="width:28px;height:28px;border-width:3px"></div></div>';

  try {
    const data = await apiFetch("/api/graph");

    if (!data.nodes || !data.nodes.length) {
      container.innerHTML = '<div class="empty" style="height:300px;display:flex;flex-direction:column;align-items:center;justify-content:center"><div class="icon">🕸️</div><p>No graph data yet. Push YAML files to the <code>kg_data</code> repository.</p></div>';
      return;
    }

    container.innerHTML = "";

    _graphInstance = ForceGraph()(container)
      .width(container.offsetWidth || 900)
      .height(520)
      .backgroundColor("#0d0f18")
      .nodeId("id")
      .nodeLabel(n => `${n.label} (${n.group})`)
      .nodeRelSize(5)
      .nodeVal(n => n.group === "sample" ? 2.5 : 1)
      .nodeColor(n => NODE_COLORS[n.group] || NODE_COLORS.other)
      .linkLabel(l => l.label)
      .linkColor(() => "rgba(100,110,160,0.5)")
      .linkWidth(0.8)
      .linkDirectionalArrowLength(3)
      .linkDirectionalArrowRelPos(1)
      .linkDirectionalParticles(0)
      .onNodeHover(node => {
        container.style.cursor = (node && node.group === "sample") ? "pointer" : "default";
      })
      .onNodeClick(node => {
        if (node.group === "sample") {
          openGraphSampleDetail(node.id, node.label);
        }
      })
      .cooldownTime(2000)
      .graphData(data);

    // Prevent the ForceGraph canvas from swallowing wheel events and locking
    // page scroll. Hold Ctrl to zoom instead.
    container.addEventListener('wheel', e => {
      if (!e.ctrlKey) e.stopPropagation();
    }, { capture: true, passive: true });

  } catch (e) {
    container.innerHTML = `<div class="alert alert-error" style="margin:16px">Failed to load graph: ${escHtml(e.message)}</div>`;
  }
}

async function openGraphSampleDetail(sampleId, name) {
  const panel = document.getElementById("graph-sample-detail");
  const grid  = document.getElementById("graph-detail-grid");
  const title = document.getElementById("graph-detail-title");

  title.textContent = name || sampleId;
  grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px"><div class="spinner"></div></div>';
  panel.classList.add("open");
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  try {
    const d = await apiFetch(`/api/samples/${encodeURIComponent(sampleId)}`);
    grid.innerHTML = renderDetailGrid(d);
    document.getElementById("graph-detail-view-btn").onclick = () => openStructureViewer(sampleId, name);
    document.getElementById("graph-detail-view-btn").style.display = "";
  } catch (e) {
    grid.innerHTML = `<div class="alert alert-error">Could not load sample: ${escHtml(e.message)}</div>`;
  }
}

function closeGraphDetail() {
  document.getElementById("graph-sample-detail").classList.remove("open");
}

// ═══════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════
function doExport(format) {
  window.location.href = `${API}/api/export?format=${format}`;
}

// ═══════════════════════════════════════════════════════════
// UPLOAD
// ═══════════════════════════════════════════════════════════
async function submitUpload() {
  const token = document.getElementById("upload-token-input").value.trim();
  const fileInput = document.getElementById("upload-file-input");
  const status = document.getElementById("upload-status");

  if (!token) { status.innerHTML = alertHtml("error", "Enter your upload token."); return; }
  if (!fileInput.files.length) { status.innerHTML = alertHtml("error", "Choose a YAML file first."); return; }

  const file = fileInput.files[0];
  if (!file.name.match(/\.ya?ml$/i)) {
    status.innerHTML = alertHtml("error", "Only .yaml / .yml files are accepted.");
    return;
  }

  status.innerHTML = '<div class="spinner" style="display:inline-block;width:16px;height:16px;border-width:2px;vertical-align:middle"></div> Uploading…';

  const fd = new FormData();
  fd.append("file", file);

  try {
    const res = await fetch(`${API}/api/upload`, {
      method: "POST",
      headers: { "X-Upload-Token": token },
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

    const startTime = Date.now();
    const tickerId = setInterval(() => {
      const secs = Math.floor((Date.now() - startTime) / 1000);
      status.innerHTML = `<div style="padding:8px 12px;border-left:3px solid var(--accent,#4caf50);background:var(--surface2);border-radius:4px;font-size:0.88rem;display:flex;align-items:center;gap:10px"><div class="spinner" style="width:14px;height:14px;border-width:2px;flex-shrink:0"></div><span>Rebuilding knowledge graph… <span style="opacity:0.6">${secs}s</span></span></div>`;
    }, 1000);

    fileInput.value = "";

    // Poll rebuild status every 5s
    let polls = 0;
    const poll = setInterval(async () => {
      try {
        const st = await fetch(`${API}/api/upload/status`, { headers: { "X-Upload-Token": token } }).then(r => r.json());
        if (st.status === "done") {
          clearInterval(poll);
          clearInterval(tickerId);
          const errs = st.errors?.length ? ` (${st.errors.length} file(s) had parse errors)` : "";
          const secs = Math.floor((Date.now() - startTime) / 1000);
          status.innerHTML = alertHtml("success", `✓ Done in ${secs}s — <strong>${st.samples}</strong> sample(s) in graph${errs}.`);
          _loadSampleCount();
        } else if (st.status?.startsWith("error")) {
          clearInterval(poll);
          clearInterval(tickerId);
          status.innerHTML = alertHtml("error", `Rebuild error: ${escHtml(st.status)}`);
        } else if (++polls > 60) {
          clearInterval(poll);
          clearInterval(tickerId);
          status.innerHTML = alertHtml("warn", "Rebuild is taking longer than expected — refresh the page to check sample count.");
        }
      } catch(_) {}
    }, 5000);

  } catch (e) {
    status.innerHTML = alertHtml("error", escHtml(e.message));
  }
}

function alertHtml(type, msg) {
  const colors = { success: "var(--accent,#4caf50)", error: "var(--danger,#e05555)", warn: "#e0a020" };
  return `<div style="padding:8px 12px;border-left:3px solid ${colors[type]||colors.warn};background:var(--surface2);border-radius:4px;font-size:0.88rem">${msg}</div>`;
}

// ═══════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════
async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw new Error(detail);
  }
  return res.json();
}

function escHtml(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function escAttr(str) {
  return String(str).replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function showEl(id)  { const e = document.getElementById(id); if (e) e.style.display = ""; }
function hideEl(id)  { const e = document.getElementById(id); if (e) e.style.display = "none"; }
function clearAlert(id) { const e = document.getElementById(id); if (e) e.innerHTML = ""; }
function showAlert(id, type, msg) {
  const e = document.getElementById(id);
  if (e) e.innerHTML = `<div class="alert alert-${type}">${escHtml(msg)}</div>`;
}
function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (loading) {
    btn._origText = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span> Running…';
    btn.disabled = true;
  } else {
    btn.innerHTML = btn._origText || "Run";
    btn.disabled = false;
  }
}

async function runGuidedQuery() {
  clearAlert("guided-alert");
  hideEl("guided-sparql-wrap");
  hideEl("guided-results-wrap");

  const sourceUri = document.getElementById("src-class").value;
  if (!sourceUri) {
    showAlert("guided-alert", "error", "Please select a source class.");
    return;
  }

  const destinations = [];
  document.querySelectorAll("[id^=filter-row-]").forEach(row => {
    const id = row.id.replace("filter-row-", "");
    const propSel = document.getElementById(`filter-prop-${id}`);
    const opSel   = document.getElementById(`filter-op-${id}`);
    const valIn   = document.getElementById(`filter-val-${id}`);
    if (!propSel || !propSel.value) return;
    destinations.push({
      uri: propSel.value,
      operator: opSel?.value || null,
      value: valIn?.value || null,
    });
  });

  if (!destinations.length) {
    showAlert("guided-alert", "error", "Add at least one destination property.");
    return;
  }

  setLoading("guided-run-btn", true);
  try {
    const res = await apiFetch("/api/guided-query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_uri: sourceUri, destinations }),
    });

    if (res.sparql) {
      document.getElementById("guided-sparql-text").textContent = res.sparql;
      showEl("guided-sparql-wrap");
    }

    if (res.columns && res.columns.length) {
      const rCount = res.rows.length;
      document.getElementById("guided-result-count").textContent = `(${rCount} row${rCount !== 1 ? "s" : ""})`;
      const tbl = buildTableDOM(res.columns, res.rows);
      const twrap = document.getElementById("guided-table-wrap");
      twrap.innerHTML = "";
      twrap.appendChild(tbl);
      showEl("guided-results-wrap");
    } else {
      showAlert("guided-alert", "info", "Query executed but returned no results.");
    }
  } catch (e) {
    showAlert("guided-alert", "error", e.message);
  } finally {
    setLoading("guided-run-btn", false);
  }
}

async function runSparql() {
  clearAlert("sparql-alert");
  hideEl("sparql-results-wrap");

  const query = document.getElementById("sparql-input").value.trim();
  if (!query) { showAlert("sparql-alert", "error", "Please enter a SPARQL query."); return; }

  setLoading("sparql-run-btn", true);
  try {
    const res = await apiFetch("/api/sparql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    if (res.columns && res.columns.length) {
      const rCount = res.rows.length;
      document.getElementById("sparql-result-count").textContent = `(${rCount} row${rCount !== 1 ? "s" : ""})`;
      const tbl = buildTableDOM(res.columns, res.rows);
      const twrap = document.getElementById("sparql-table-wrap");
      twrap.innerHTML = "";
      twrap.appendChild(tbl);
      showEl("sparql-results-wrap");
    } else {
      showAlert("sparql-alert", "info", "Query executed but returned no results.");
    }
  } catch (e) {
    showAlert("sparql-alert", "error", e.message);
  } finally {
    setLoading("sparql-run-btn", false);
  }
}

function buildTableDOM(columns, rows) {
  // Detect columns whose values look like AtomicScaleSample URIs
  const sampleCols = new Set();
  if (rows.length) {
    columns.forEach(c => {
      const val = String(rows[0][c] ?? "");
      if (_SAMPLE_URI_PATTERN.test(val)) sampleCols.add(c);
    });
  }

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const hrow  = document.createElement("tr");
  columns.forEach(c => {
    const th = document.createElement("th");
    th.textContent = String(c);
    hrow.appendChild(th);
  });
  if (sampleCols.size) {
    const th = document.createElement("th"); th.textContent = "View"; hrow.appendChild(th);
  }
  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach(row => {
    const tr = document.createElement("tr");
    let sampleUri = "";
    columns.forEach(c => {
      const td = document.createElement("td");
      const val = String(row[c] ?? "");
      td.textContent = val;
      td.title = val;
      tr.appendChild(td);
      if (sampleCols.has(c)) sampleUri = val;
    });
    if (sampleCols.size) {
      const td = document.createElement("td");
      if (sampleUri) {
        const btn = document.createElement("button");
        btn.className = "btn btn-sm btn-outline";
        btn.textContent = "🔬 View";
        btn.onclick = e => { e.stopPropagation(); openStructureViewer(sampleUri, sampleUri.split(":").pop()); };
        td.appendChild(btn);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

// ═══════════════════════════════════════════════════════════
// WORKFLOWS
// ═══════════════════════════════════════════════════════════
let _workflowsLoaded = false;

async function loadWorkflows() {
  if (_workflowsLoaded) return;
  _workflowsLoaded = true;
  showEl("workflows-loading");
  hideEl("workflows-table-wrap");
  hideEl("workflows-empty");
  clearAlert("workflows-alert");

  try {
    const res = await apiFetch("/api/workflows");
    const wfs = res.workflows || [];
    hideEl("workflows-loading");

    const countEl = document.getElementById("hdr-workflow-count");
    if (countEl) countEl.textContent = wfs.length;

    if (!wfs.length) { showEl("workflows-empty"); return; }

    const thead = `<thead><tr>
      <th>ID</th><th>Type</th><th>Method</th><th>Software / DOI</th><th>Potential</th><th>Output Samples</th>
    </tr></thead>`;
    const tbody = wfs.map(w => {
      const id    = `<span title="${escAttr(w.id)}" style="font-family:var(--mono);font-size:11px">${escHtml(w.id)}</span>`;
      const badge = `<span class="workflow-type-badge">${escHtml(w.type)}</span>`;
      const method = w.method ? escHtml(w.method) : '—';
      const sw    = w.software
        ? `<a href="${escAttr(w.software)}" target="_blank" rel="noopener" style="color:var(--accent-hover);font-size:11px">${escHtml(w.software.length > 50 ? w.software.slice(0,47)+'…' : w.software)}</a>`
        : '—';
      const pot = w.potential_uri
        ? `<a href="${escAttr(w.potential_uri)}" target="_blank" rel="noopener" title="${escAttr(w.potential_uri)}" style="color:var(--accent-hover);font-size:11px">${escHtml(w.potential || w.potential_uri.split('/').pop())}</a>`
        : escHtml(w.potential || '—');
      // output_samples linked via PROV.wasGeneratedBy
      const samples = w.output_samples || w.samples || [];
      const sLinks = samples.length
        ? samples.map(s => {
            const short = s.split(':').pop().slice(0, 8);
            return `<button class="btn btn-sm btn-outline" style="margin:1px" onclick="openStructureViewer('${escAttr(s)}','${escAttr(s.split(':').pop())}')">🔬 ${escHtml(short)}</button>`;
          }).join(" ")
        : '—';
      return `<tr><td>${id}</td><td>${badge}</td><td>${method}</td><td>${sw}</td><td>${pot}</td><td>${sLinks}</td></tr>`;
    }).join("");

    const wrap = document.getElementById("workflows-table-wrap");
    wrap.innerHTML = `<table>${thead}<tbody>${tbody}</tbody></table>`;
    showEl("workflows-table-wrap");
  } catch (e) {
    hideEl("workflows-loading");
    showAlert("workflows-alert", "error", `Failed to load workflows: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
// NATURAL LANGUAGE QUERY (Ask tab)
// ═══════════════════════════════════════════════════════════

async function runNLQ() {
  clearAlert("nlq-alert");
  hideEl("nlq-interpretation-wrap");
  hideEl("nlq-results-wrap");

  const question = document.getElementById("nlq-input").value.trim();
  if (!question) {
    showAlert("nlq-alert", "error", "Please enter a question.");
    return;
  }

  showEl("nlq-thinking");
  setLoading("nlq-run-btn", true);

  try {
    const res = await apiFetch("/api/nlq", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });

    // Show interpretation + SPARQL
    document.getElementById("nlq-interpretation-text").textContent =
      JSON.stringify(res.interpretation, null, 2);
    document.getElementById("nlq-sparql-text").textContent = res.sparql || "";
    showEl("nlq-interpretation-wrap");

    // Show results table
    if (res.columns && res.columns.length) {
      const rCount = res.rows.length;
      document.getElementById("nlq-result-count").textContent =
        `(${rCount} row${rCount !== 1 ? "s" : ""})`;
      const tbl = buildTableDOM(res.columns, res.rows);
      const twrap = document.getElementById("nlq-table-wrap");
      twrap.innerHTML = "";
      twrap.appendChild(tbl);
      showEl("nlq-results-wrap");
    } else {
      showAlert("nlq-alert", "info", "Query executed but returned no results.");
    }
  } catch (e) {
    showAlert("nlq-alert", "error", e.message);
  } finally {
    hideEl("nlq-thinking");
    setLoading("nlq-run-btn", false);
  }
}

// ── Theme toggle ───────────────────────────────────────────
function toggleTheme() {
  const root = document.documentElement;
  const isDark = root.dataset.theme !== "light";
  root.dataset.theme = isDark ? "light" : "dark";
  const btn = document.getElementById("theme-toggle-btn");
  if (btn) btn.textContent = isDark ? "☀️" : "🌙";
  try { localStorage.setItem("theme", isDark ? "light" : "dark"); } catch(_) {}
}
// Restore saved theme on load
try {
  const saved = localStorage.getItem("theme");
  if (saved === "light") {
    document.documentElement.dataset.theme = "light";
    const btn = document.getElementById("theme-toggle-btn");
    if (btn) btn.textContent = "☀️";
  }
} catch(_) {}

// ── Init ──────────────────────────────────────────────────
_loadSampleCount();
// loadGraph is lazy — fires on first click of the Graph tab
