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
    if (tab === "samples") loadSamples();
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
  });
});

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
    wrap.innerHTML = renderTable(
      ["Name", "URI"],
      data.map(s => [
        s.name || "—",
        `<span class="wrap" style="font-family:var(--mono);font-size:11px;color:var(--text-muted)">${s.id}</span>`
      ]),
      (i) => openSampleDetail(data[i].id, data[i].name)
    );
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
  } catch (e) {
    grid.innerHTML = `<div class="alert alert-error">Could not load sample: ${e.message}</div>`;
  }
}

function closeDetail() {
  document.getElementById("sample-detail").classList.remove("open");
}

function renderDetailGrid(obj, prefix = "") {
  let cells = "";
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
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
  try {
    _ontologyClasses = await apiFetch("/api/ontology/classes");
    sel.innerHTML = '<option value="">— choose a class —</option>' +
      _ontologyClasses.map(c =>
        `<option value="${escAttr(c.uri)}">${escHtml(c.namespace + ":" + c.label)}</option>`
      ).join("");
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
  let rowId = 1;
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

    // Show generated SPARQL
    if (res.sparql) {
      document.getElementById("guided-sparql-text").textContent = res.sparql;
      showEl("guided-sparql-wrap");
    }

    // Show results
    if (res.columns && res.columns.length) {
      const rCount = res.rows.length;
      document.getElementById("guided-result-count").textContent = `(${rCount} row${rCount !== 1 ? "s" : ""})`;
      document.getElementById("guided-table-wrap").innerHTML = renderTable(
        res.columns,
        res.rows.map(r => res.columns.map(c => r[c] ?? ""))
      );
      showEl("guided-results-wrap");
    } else {
      showAlert("guided-alert", "info", "Query ran but returned no results.");
    }
  } catch (e) {
    showAlert("guided-alert", "error", e.message);
  } finally {
    setLoading("guided-run-btn", false);
  }
}

// ═══════════════════════════════════════════════════════════
// RAW SPARQL
// ═══════════════════════════════════════════════════════════
async function runSparql() {
  clearAlert("sparql-alert");
  hideEl("sparql-results-wrap");

  const query = document.getElementById("sparql-input").value.trim();
  if (!query) {
    showAlert("sparql-alert", "error", "Please enter a SPARQL query.");
    return;
  }

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
      document.getElementById("sparql-table-wrap").innerHTML = renderTable(
        res.columns,
        res.rows.map(r => res.columns.map(c => r[c] ?? ""))
      );
      showEl("sparql-results-wrap");
    } else {
      showAlert("sparql-alert", "info", "Query ran but returned no results.");
    }
  } catch (e) {
    showAlert("sparql-alert", "error", e.message);
  } finally {
    setLoading("sparql-run-btn", false);
  }
}

// ═══════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════
function doExport(format) {
  window.location.href = `${API}/api/export?format=${format}`;
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

function renderTable(columns, rows, onRowClick) {
  if (!rows.length) return '<p style="color:var(--text-muted);padding:14px;text-align:center">No results</p>';
  const thead = `<thead><tr>${columns.map(c => `<th>${escHtml(String(c))}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map((row, i) =>
    `<tr ${onRowClick ? `onclick="(${onRowClick.toString()})(${i})"` : ""}>` +
    row.map(cell => `<td title="${escAttr(String(cell))}">${escHtml(String(cell))}</td>`).join("") +
    `</tr>`
  ).join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

function renderTable(columns, rows, onRowClick) {
  if (!rows.length) return '<p style="color:var(--text-muted);padding:14px;text-align:center;font-size:13px">No results</p>';
  const theadCells = columns.map(c => `<th>${escHtml(String(c))}</th>`).join("");
  const tbodyRows = rows.map((row, i) => {
    const tds = row.map(cell => `<td title="${escAttr(String(cell))}">${escHtml(String(cell))}</td>`).join("");
    const click = onRowClick ? `style="cursor:pointer" data-row="${i}"` : "";
    return `<tr ${click}>${tds}</tr>`;
  }).join("");
  const tableHtml = `<table><thead><tr>${theadCells}</tr></thead><tbody>${tbodyRows}</tbody></table>`;

  // Attach row-click after parse (caller's callback is an index-based fn)
  if (!onRowClick) return tableHtml;
  const wrap = document.createElement("div");
  wrap.innerHTML = tableHtml;
  wrap.querySelectorAll("tr[data-row]").forEach(tr => {
    tr.addEventListener("click", () => onRowClick(parseInt(tr.dataset.row, 10)));
  });
  return wrap;
}

// renderTable returns either a string or DOM node
function setInnerContent(el, content) {
  if (typeof content === "string") el.innerHTML = content;
  else { el.innerHTML = ""; el.appendChild(content); }
}

// Patch calls that do innerHTML to use setInnerContent
function patchedRenderTable(columns, rows, onRowClick) {
  return renderTable(columns, rows, onRowClick);
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

// ── Inline table fix ──────────────────────────────────────
// Use DOM-based rendering for tables with row click handlers
// to avoid eval-like onclick strings.
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
    const table = document.createElement("table");
    table.innerHTML = `<thead><tr><th>Name</th><th>URI</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    data.forEach((s, i) => {
      const tr = document.createElement("tr");
      tr.style.cursor = "pointer";
      tr.innerHTML = `<td>${escHtml(s.name || "—")}</td><td style="font-family:var(--mono);font-size:11px;color:var(--text-muted)">${escHtml(s.id)}</td>`;
      tr.addEventListener("click", () => openSampleDetail(s.id, s.name));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    wrap.innerHTML = "";
    const tableWrap = document.createElement("div");
    tableWrap.className = "table-wrap";
    tableWrap.appendChild(table);
    wrap.appendChild(tableWrap);
    showEl("samples-table-wrap");
  } catch (e) {
    hideEl("samples-loading");
    showAlert("samples-alert", "error", `Failed to load samples: ${e.message}`);
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
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const hrow  = document.createElement("tr");
  columns.forEach(c => {
    const th = document.createElement("th");
    th.textContent = String(c);
    hrow.appendChild(th);
  });
  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach(row => {
    const tr = document.createElement("tr");
    columns.forEach(c => {
      const td = document.createElement("td");
      const val = String(row[c] ?? "");
      td.textContent = val;
      td.title = val;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

// ── Init ──────────────────────────────────────────────────
loadSamples();
