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
    if (tab === "samples")    loadSamples();
    if (tab === "graph")      loadGraph();
    if (tab === "workflows")  loadWorkflows();
    if (tab === "properties") loadProperties();
    if (tab === "datasets")   loadDatasets();
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
// SAMPLES  —  Periodic Table Explorer
// ═══════════════════════════════════════════════════════════
let _samplesCache = [];
let _selectedElements = new Set();  // elements the user has clicked
let _datasetsMap = {};              // dataset_uri → dataset object (loaded lazily)
let _datasetsLoaded = false;

async function _ensureDatasetsLoaded() {
  if (_datasetsLoaded) return;
  try {
    const data = await apiFetch("/api/datasets");
    for (const d of (data || [])) _datasetsMap[d.uri] = d;
    _datasetsLoaded = true;  // only mark loaded on success
  } catch (_) {
    // Non-fatal: dataset enrichment is best-effort; do NOT set _datasetsLoaded
    // so the next call will retry
  }
}

// Standard 18-column periodic table positions: [symbol, row, col, category-class]
// Rows 9-10 = lanthanides / actinides (with a blank row 8 as spacer)
const _PT_ELEMENTS = [
  // Period 1
  ["H",  1, 1,  "pt-nonmetal"],  ["He", 1, 18, "pt-noble"],
  // Period 2
  ["Li", 2, 1,  "pt-alkali"],    ["Be", 2, 2,  "pt-alkaline"],
  ["B",  2, 13, "pt-metalloid"], ["C",  2, 14, "pt-nonmetal"],
  ["N",  2, 15, "pt-nonmetal"],  ["O",  2, 16, "pt-nonmetal"],
  ["F",  2, 17, "pt-halogen"],   ["Ne", 2, 18, "pt-noble"],
  // Period 3
  ["Na", 3, 1,  "pt-alkali"],    ["Mg", 3, 2,  "pt-alkaline"],
  ["Al", 3, 13, "pt-post-trans"],["Si", 3, 14, "pt-metalloid"],
  ["P",  3, 15, "pt-nonmetal"],  ["S",  3, 16, "pt-nonmetal"],
  ["Cl", 3, 17, "pt-halogen"],   ["Ar", 3, 18, "pt-noble"],
  // Period 4
  ["K",  4, 1,  "pt-alkali"],    ["Ca", 4, 2,  "pt-alkaline"],
  ["Sc", 4, 3,  "pt-transition"],["Ti", 4, 4,  "pt-transition"],
  ["V",  4, 5,  "pt-transition"],["Cr", 4, 6,  "pt-transition"],
  ["Mn", 4, 7,  "pt-transition"],["Fe", 4, 8,  "pt-transition"],
  ["Co", 4, 9,  "pt-transition"],["Ni", 4, 10, "pt-transition"],
  ["Cu", 4, 11, "pt-transition"],["Zn", 4, 12, "pt-transition"],
  ["Ga", 4, 13, "pt-post-trans"],["Ge", 4, 14, "pt-metalloid"],
  ["As", 4, 15, "pt-metalloid"], ["Se", 4, 16, "pt-nonmetal"],
  ["Br", 4, 17, "pt-halogen"],   ["Kr", 4, 18, "pt-noble"],
  // Period 5
  ["Rb", 5, 1,  "pt-alkali"],    ["Sr", 5, 2,  "pt-alkaline"],
  ["Y",  5, 3,  "pt-transition"],["Zr", 5, 4,  "pt-transition"],
  ["Nb", 5, 5,  "pt-transition"],["Mo", 5, 6,  "pt-transition"],
  ["Tc", 5, 7,  "pt-transition"],["Ru", 5, 8,  "pt-transition"],
  ["Rh", 5, 9,  "pt-transition"],["Pd", 5, 10, "pt-transition"],
  ["Ag", 5, 11, "pt-transition"],["Cd", 5, 12, "pt-transition"],
  ["In", 5, 13, "pt-post-trans"],["Sn", 5, 14, "pt-post-trans"],
  ["Sb", 5, 15, "pt-metalloid"], ["Te", 5, 16, "pt-metalloid"],
  ["I",  5, 17, "pt-halogen"],   ["Xe", 5, 18, "pt-noble"],
  // Period 6
  ["Cs", 6, 1,  "pt-alkali"],    ["Ba", 6, 2,  "pt-alkaline"],
  ["Hf", 6, 4,  "pt-transition"],["Ta", 6, 5,  "pt-transition"],
  ["W",  6, 6,  "pt-transition"],["Re", 6, 7,  "pt-transition"],
  ["Os", 6, 8,  "pt-transition"],["Ir", 6, 9,  "pt-transition"],
  ["Pt", 6, 10, "pt-transition"],["Au", 6, 11, "pt-transition"],
  ["Hg", 6, 12, "pt-transition"],["Tl", 6, 13, "pt-post-trans"],
  ["Pb", 6, 14, "pt-post-trans"],["Bi", 6, 15, "pt-post-trans"],
  ["Po", 6, 16, "pt-post-trans"],["At", 6, 17, "pt-halogen"],
  ["Rn", 6, 18, "pt-noble"],
  // Period 7
  ["Fr", 7, 1,  "pt-alkali"],    ["Ra", 7, 2,  "pt-alkaline"],
  ["Rf", 7, 4,  "pt-transition"],["Db", 7, 5,  "pt-transition"],
  ["Sg", 7, 6,  "pt-transition"],["Bh", 7, 7,  "pt-transition"],
  ["Hs", 7, 8,  "pt-transition"],["Mt", 7, 9,  "pt-transition"],
  ["Ds", 7, 10, "pt-transition"],["Rg", 7, 11, "pt-transition"],
  ["Cn", 7, 12, "pt-transition"],["Nh", 7, 13, "pt-post-trans"],
  ["Fl", 7, 14, "pt-post-trans"],["Mc", 7, 15, "pt-post-trans"],
  ["Lv", 7, 16, "pt-post-trans"],["Ts", 7, 17, "pt-halogen"],
  ["Og", 7, 18, "pt-noble"],
  // Row 9 — Lanthanides (row 8 is a visual gap)
  ["La", 9, 3,  "pt-lanthanide"],["Ce", 9, 4,  "pt-lanthanide"],
  ["Pr", 9, 5,  "pt-lanthanide"],["Nd", 9, 6,  "pt-lanthanide"],
  ["Pm", 9, 7,  "pt-lanthanide"],["Sm", 9, 8,  "pt-lanthanide"],
  ["Eu", 9, 9,  "pt-lanthanide"],["Gd", 9, 10, "pt-lanthanide"],
  ["Tb", 9, 11, "pt-lanthanide"],["Dy", 9, 12, "pt-lanthanide"],
  ["Ho", 9, 13, "pt-lanthanide"],["Er", 9, 14, "pt-lanthanide"],
  ["Tm", 9, 15, "pt-lanthanide"],["Yb", 9, 16, "pt-lanthanide"],
  ["Lu", 9, 17, "pt-lanthanide"],
  // Row 10 — Actinides
  ["Ac", 10, 3,  "pt-actinide"], ["Th", 10, 4,  "pt-actinide"],
  ["Pa", 10, 5,  "pt-actinide"], ["U",  10, 6,  "pt-actinide"],
  ["Np", 10, 7,  "pt-actinide"], ["Pu", 10, 8,  "pt-actinide"],
  ["Am", 10, 9,  "pt-actinide"], ["Cm", 10, 10, "pt-actinide"],
  ["Bk", 10, 11, "pt-actinide"], ["Cf", 10, 12, "pt-actinide"],
  ["Es", 10, 13, "pt-actinide"], ["Fm", 10, 14, "pt-actinide"],
  ["Md", 10, 15, "pt-actinide"], ["No", 10, 16, "pt-actinide"],
  ["Lr", 10, 17, "pt-actinide"],
];

async function loadSamples() {
  showEl("samples-loading");
  showEl("ptable-loading");
  hideEl("samples-table-wrap");
  hideEl("ptable-wrap");
  hideEl("samples-empty");
  clearAlert("samples-alert");

  // Pre-load datasets for detail enrichment (non-blocking)
  _ensureDatasetsLoaded();

  try {
    const data = await apiFetch("/api/samples");
    _samplesCache = data;
    document.getElementById("hdr-sample-count").textContent = data.length;
    hideEl("samples-loading");
    hideEl("ptable-loading");

    if (!data.length) {
      showEl("samples-empty");
      return;
    }

    _renderPeriodicTable();
    showEl("ptable-wrap");
    _renderFilteredSamples();
    showEl("samples-table-wrap");
  } catch (e) {
    hideEl("samples-loading");
    hideEl("ptable-loading");
    showAlert("samples-alert", "error", `Failed to load samples: ${e.message}`);
  }
}

function _renderPeriodicTable() {
  // Build element → count map
  const countMap = {};
  for (const s of _samplesCache) {
    for (const el of (s.elements || [])) {
      countMap[el] = (countMap[el] || 0) + 1;
    }
  }

  const wrap = document.getElementById("ptable-wrap");
  const divs = [];
  for (const [sym, row, col, cat] of _PT_ELEMENTS) {
    const cnt = countMap[sym] || 0;
    const present = cnt > 0;
    const selected = _selectedElements.has(sym);
    const dimmed = _selectedElements.size > 0 && present && !selected;
    const stateClass = selected ? "pt-selected" : (dimmed ? "pt-dimmed" : (present ? "pt-present" : "pt-absent"));
    const cntLabel = present ? `<span class="pt-cell-cnt">${cnt}</span>` : "";
    const style = `grid-row:${row};grid-column:${col};`;
    const title = present
      ? `${sym} — ${cnt} sample${cnt > 1 ? "s" : ""}`
      : sym;
    divs.push(
      `<div class="pt-cell ${cat} ${stateClass}" style="${style}" data-sym="${escAttr(sym)}" ` +
      `title="${escAttr(title)}" ` +
      `${present ? `onclick="toggleElemSelection('${escAttr(sym)}')"` : ""}` +
      `><span class="pt-cell-sym">${escHtml(sym)}</span>${cntLabel}</div>`
    );
  }

  wrap.innerHTML = `<div class="ptable">${divs.join("")}</div>`;
}

function toggleElemSelection(sym) {
  // Plain click always toggles — click again on the same element to deselect,
  // click additional elements to add them (AND filter).
  if (_selectedElements.has(sym)) {
    _selectedElements.delete(sym);
  } else {
    _selectedElements.add(sym);
  }
  _updatePTableHighlights();
  _updateSelectionChips();
  _renderFilteredSamples();
}

function _updatePTableHighlights() {
  const countMap = {};
  for (const s of _samplesCache) {
    for (const el of (s.elements || [])) countMap[el] = (countMap[el] || 0) + 1;
  }
  document.querySelectorAll(".pt-cell[data-sym]").forEach(cell => {
    const sym = cell.dataset.sym;
    const cnt = countMap[sym] || 0;
    const present = cnt > 0;
    const selected = _selectedElements.has(sym);
    const dimmed = _selectedElements.size > 0 && present && !selected;
    cell.classList.remove("pt-present", "pt-selected", "pt-dimmed", "pt-absent");
    if (selected)       cell.classList.add("pt-selected");
    else if (dimmed)    cell.classList.add("pt-dimmed");
    else if (present)   cell.classList.add("pt-present");
    else                cell.classList.add("pt-absent");
  });
}

function _updateSelectionChips() {
  const chips = document.getElementById("elem-selection-chips");
  const clearBtn = document.getElementById("elem-clear-btn");
  if (_selectedElements.size === 0) {
    chips.innerHTML = "";
    clearBtn.style.display = "none";
  } else {
    chips.innerHTML = [..._selectedElements].sort()
      .map(el => `<span class="elem-chip">${escHtml(el)}</span>`)
      .join("");
    clearBtn.style.display = "";
  }
}

function clearElemSelection() {
  _selectedElements.clear();
  document.getElementById("elem-text-filter").value = "";
  _updatePTableHighlights();
  _updateSelectionChips();
  _renderFilteredSamples();
}

function filterSamples() {
  _renderFilteredSamples();
}

function _renderFilteredSamples() {
  const textQ = (document.getElementById("elem-text-filter")?.value || "").trim().toLowerCase();

  let filtered = _samplesCache;

  // Apply text filter first (by element symbol or sample name)
  if (textQ) {
    filtered = filtered.filter(s => {
      if ((s.name || "").toLowerCase().includes(textQ)) return true;
      if ((s.formula || "").toLowerCase().includes(textQ)) return true;
      return (s.elements || []).some(el => el.toLowerCase().startsWith(textQ));
    });
  }

  // Apply element selection filter: sample must contain ALL selected elements
  if (_selectedElements.size > 0) {
    filtered = filtered.filter(s => {
      const elSet = new Set(s.elements || []);
      return [..._selectedElements].every(el => elSet.has(el));
    });
  }

  // Update count chip
  const el = document.getElementById("samples-result-count");
  if (el) el.textContent = `${filtered.length} / ${_samplesCache.length} samples`;

  const wrap = document.getElementById("samples-table-wrap");
  if (!wrap) return;

  if (!filtered.length) {
    wrap.innerHTML = "";
    hideEl("samples-table-wrap");
    showEl("samples-empty");
    return;
  }
  hideEl("samples-empty");

  const tbody = filtered.map((s, i) => {
    const formula = escHtml(s.formula || s.name || "—");
    const name    = escHtml(s.name || "—");
    const shortId = escHtml(s.id.split(':').pop().split('/').pop().slice(0, 8));
    const viewBtn = `<button class="btn btn-sm btn-outline" onclick="event.stopPropagation();openStructureViewer('${escAttr(s.id)}','${escAttr(s.name||s.id)}')" title="View atomic structure">🔬</button>`;
    return `<tr style="cursor:pointer" data-sid="${escAttr(s.id)}" data-sname="${escAttr(s.name||'')}">` +
      `<td><span class="sample-formula">${formula}</span></td>` +
      `<td>${name}</td>` +
      `<td><span title="${escAttr(s.id)}" style="font-family:var(--mono);font-size:11px;color:var(--text-muted)">${shortId}…</span></td>` +
      `<td style="width:48px">${viewBtn}</td>` +
      `</tr>`;
  }).join("");

  wrap.innerHTML = `<table>
    <thead><tr><th>Formula</th><th>Name</th><th>ID</th><th style="width:48px"></th></tr></thead>
    <tbody>${tbody}</tbody>
  </table>`;

  wrap.querySelectorAll("tr[data-sid]").forEach(tr => {
    tr.addEventListener("click", () => openSampleDetail(tr.dataset.sid, tr.dataset.sname));
  });

  showEl("samples-table-wrap");
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

    // Enrich with dataset / publication info
    await _ensureDatasetsLoaded();
    const cached = _samplesCache.find(s => s.id === sampleId);
    const datasetUri = cached?.dataset_uri || d.isPartOf || "";
    const ds = datasetUri ? _datasetsMap[datasetUri] : null;
    if (ds) {
      d._dataset = {
        title: ds.title || "",
        data_link: ds.identifier || ds.uri || "",
        publication_title: ds.publication_title || "",
        publication_doi: ds.publication_doi || "",
        authors: (ds.authors || []).join(", "),
      };
    }

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

    // Special section: _dataset → show as a styled card with links
    if (k === "_dataset" && !prefix) {
      cells += `<div class="detail-item detail-item-full"><div class="key">Dataset</div>` +
        `<div class="val">` +
        (v.title ? `<div><strong>${escHtml(v.title)}</strong></div>` : "") +
        (v.data_link ? `<div><a href="${escAttr(v.data_link)}" target="_blank" rel="noopener" style="color:var(--accent-hover);font-size:12px">🗂 Data: ${escHtml(v.data_link)}</a></div>` : "") +
        (v.publication_title ? `<div style="margin-top:4px">${escHtml(v.publication_title)}</div>` : "") +
        (v.publication_doi ? `<div><a href="${escAttr(v.publication_doi)}" target="_blank" rel="noopener" style="color:var(--accent-hover);font-size:12px">📄 Publication: ${escHtml(v.publication_doi)}</a></div>` : "") +
        (v.authors ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">${escHtml(v.authors)}</div>` : "") +
        `</div></div>`;
      continue;
    }

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

    // Show a note if only a subset of samples is visualised
    const totalSamples = data.total_samples || data.nodes.filter(n => n.group === "sample").length;
    const shownSamples = data.shown_samples || data.nodes.filter(n => n.group === "sample").length;
    if (shownSamples < totalSamples) {
      const note = document.createElement("p");
      note.style.cssText = "margin:4px 0 8px;font-size:12px;color:var(--text-muted)";
      note.textContent = `Showing ${shownSamples} of ${totalSamples} samples (evenly sampled across datasets). Use the Samples tab to browse all.`;
      container.parentNode.insertBefore(note, container);
    }

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
    _graphLoaded = false; // allow retry on next tab click
    const retryMsg = e.message.startsWith("HTTP 5") ? " The app may still be starting — please try again in a moment." : "";
    container.innerHTML = `<div class="alert alert-error" style="margin:16px">Failed to load graph: ${escHtml(e.message)}.${retryMsg}</div>`;
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
      const idShort = escHtml(w.id.split(':').pop().slice(0, 8));
      const id    = `<span title="${escAttr(w.id)}" style="font-family:var(--mono);font-size:11px">${idShort}…</span>`;
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
    _workflowsLoaded = false; // allow retry on next tab click
    hideEl("workflows-loading");
    const retryMsg = e.message.startsWith("HTTP 5") ? " The app may still be starting — please try again in a moment." : "";
    showAlert("workflows-alert", "error", `Failed to load workflows: ${e.message}.${retryMsg}`);
  }
}

// ═══════════════════════════════════════════════════════════
// PROPERTIES
// ═══════════════════════════════════════════════════════════
let _propertiesCache = [];
let _propertiesLoaded = false;

async function loadProperties() {
  if (_propertiesLoaded) return;
  _propertiesLoaded = true;
  showEl("properties-loading");
  hideEl("properties-table-wrap");
  hideEl("properties-empty");
  clearAlert("properties-alert");

  try {
    const data = await apiFetch("/api/properties");
    _propertiesCache = data;
    hideEl("properties-loading");

    const scalarCount = data.filter(p => !p.value_is_array).length;
    const countEl = document.getElementById("hdr-prop-count");
    if (countEl) countEl.textContent = scalarCount;
    document.getElementById("prop-result-count").textContent = `${scalarCount} scalar, ${data.length - scalarCount} array`;

    if (!data.length) { showEl("properties-empty"); return; }
    renderPropertiesTable(data);
  } catch (e) {
    _propertiesLoaded = false;
    hideEl("properties-loading");
    const retryMsg = e.message.startsWith("HTTP 5") ? " The app may still be starting — please try again in a moment." : "";
    showAlert("properties-alert", "error", `Failed to load properties: ${e.message}.${retryMsg}`);
  }
}

function renderPropertiesTable(data) {
  const showArrays = document.getElementById("prop-show-arrays")?.checked ?? false;
  const filter     = (document.getElementById("prop-filter")?.value ?? "").trim().toLowerCase();

  const filtered = data.filter(p => {
    if (!showArrays && p.value_is_array) return false;
    if (filter) {
      const hay = (p.type + " " + p.label).toLowerCase();
      if (!hay.includes(filter)) return false;
    }
    return true;
  });

  const countEl = document.getElementById("prop-result-count");
  if (countEl) countEl.textContent = `${filtered.length} shown`;

  if (!filtered.length) {
    const wrap = document.getElementById("properties-table-wrap");
    wrap.innerHTML = `<div class="empty" style="padding:24px"><p>No properties match your filter.</p></div>`;
    showEl("properties-table-wrap");
    return;
  }

  const thead = `<thead><tr>
    <th>Type</th><th>Label</th><th style="text-align:right">Value</th><th>Unit</th><th>Sample(s)</th>
  </tr></thead>`;

  const tbody = filtered.map(p => {
    const type  = escHtml(p.type);
    const label = escHtml(p.label || p.type);

    let valCell;
    if (p.value_is_array) {
      valCell = `<span style="color:var(--text-muted);font-size:11px">[array]</span>`;
    } else if (p.value !== null && p.value !== undefined) {
      const fmt = typeof p.value === "number" ? p.value.toPrecision(6) : escHtml(String(p.value));
      valCell = `<span style="font-family:var(--mono);font-size:12px">${escHtml(fmt)}</span>`;
    } else {
      valCell = `—`;
    }

    const unit = p.unit
      ? (p.unit_uri
          ? `<a href="${escAttr(p.unit_uri)}" target="_blank" rel="noopener" style="color:var(--accent-hover);font-size:11px">${escHtml(p.unit)}</a>`
          : `<span style="font-size:11px">${escHtml(p.unit)}</span>`)
      : `—`;

    const samples = p.sample_ids || [];
    const sLinks = samples.length
      ? samples.slice(0, 3).map(s => {
          const short = s.split(":").pop().slice(0, 8);
          return `<button class="btn btn-sm btn-outline" style="margin:1px" onclick="openStructureViewer('${escAttr(s)}','${escAttr(s.split(':').pop())}')">🔬 ${escHtml(short)}</button>`;
        }).join(" ") + (samples.length > 3 ? ` <span style="font-size:11px;color:var(--text-muted)">+${samples.length - 3} more</span>` : "")
      : `—`;

    return `<tr><td><span class="workflow-type-badge">${type}</span></td><td>${label}</td><td style="text-align:right">${valCell}</td><td>${unit}</td><td>${sLinks}</td></tr>`;
  }).join("");

  const wrap = document.getElementById("properties-table-wrap");
  wrap.innerHTML = `<table>${thead}<tbody>${tbody}</tbody></table>`;
  showEl("properties-table-wrap");
}

function filterProperties() {
  if (_propertiesCache.length) renderPropertiesTable(_propertiesCache);
}

// ═══════════════════════════════════════════════════════════
// DATASETS
// ═══════════════════════════════════════════════════════════
async function loadDatasets() {
  showEl("datasets-loading");
  hideEl("datasets-table-wrap");
  hideEl("datasets-empty");
  clearAlert("datasets-alert");

  try {
    // Always do a fresh fetch for the Datasets tab so stale/empty cache is bypassed
    const fetched = await apiFetch("/api/datasets");
    _datasetsMap = {};
    for (const d of (fetched || [])) _datasetsMap[d.uri] = d;
    _datasetsLoaded = true;
    const data = Object.values(_datasetsMap);
    hideEl("datasets-loading");

    if (!data.length) { showEl("datasets-empty"); return; }

    // Sort by sample count descending (they come pre-sorted from cache, but just in case)
    data.sort((a, b) => (b.sample_count || 0) - (a.sample_count || 0));

    const rows = data.map(ds => {
      const title = ds.title
        ? `<span title="${escAttr(ds.uri)}">${escHtml(ds.title)}</span>`
        : `<span style="font-family:var(--mono);font-size:11px;color:var(--text-muted)">${escHtml(ds.uri.slice(0, 60))}</span>`;

      const dataLink = ds.identifier
        ? `<a href="${escAttr(ds.identifier)}" target="_blank" rel="noopener" style="color:var(--accent-hover);font-size:11px">${escHtml(ds.identifier.length > 50 ? ds.identifier.slice(0,48)+'…' : ds.identifier)}</a>`
        : '—';

      const pub = ds.publication_doi
        ? `<a href="${escAttr(ds.publication_doi)}" target="_blank" rel="noopener" style="color:var(--accent-hover);font-size:11px" title="${escAttr(ds.publication_title || ds.publication_doi)}">${escHtml(ds.publication_title ? (ds.publication_title.length > 60 ? ds.publication_title.slice(0,58)+'…' : ds.publication_title) : ds.publication_doi)}</a>`
        : '—';

      const authors = ds.authors && ds.authors.length
        ? `<span style="font-size:11px;color:var(--text-muted)">${escHtml(ds.authors.join(', '))}</span>`
        : '—';

      return `<tr>
        <td>${title}</td>
        <td style="text-align:right;font-family:var(--mono)">${ds.sample_count || 0}</td>
        <td>${dataLink}</td>
        <td>${pub}</td>
        <td>${authors}</td>
      </tr>`;
    }).join("");

    const wrap = document.getElementById("datasets-table-wrap");
    wrap.innerHTML = `<table>
      <thead><tr>
        <th>Dataset</th>
        <th style="text-align:right">Samples</th>
        <th>Data Link</th>
        <th>Publication</th>
        <th>Authors</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
    showEl("datasets-table-wrap");
  } catch (e) {
    hideEl("datasets-loading");
    showAlert("datasets-alert", "error", `Failed to load datasets: ${e.message}`);
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
loadGraph();     // pre-load in background so Graph tab is instant
