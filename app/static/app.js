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
    if (tab === "overview")   loadOverview();
    if (tab === "samples")    loadSamples();
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
// Samples are identified by dereferenceable IRIs (…/id/sample/<uuid>); the bare
// "sample:<uuid>" form is still matched so older exports keep rendering.
// Local part of an identifier, for either the minted IRI form
// (…/id/sample/<uuid>) or the legacy short form (sample:<uuid>).
function _shortId(uri) {
  return String(uri).split('/').pop().split(':').pop();
}
const _SAMPLE_URI_PATTERN = /^(sample:|https?:\/\/[^/]+\/id\/sample\/)/;

// ── Entity identifiers ─────────────────────────────────────
// Every instance in the graph is minted as
//   https://atomkg.pyscal.org/id/<scheme>/<local-id>
// and that IRI is also its entity page. So an identifier is never shown as bare
// text: it is rendered as "<scheme>/<local-id>" and linked to its own page,
// which is what lets the graph be walked by hand from any table in the portal.
// Kept in step with KNOWN_SCHEMES in app/routes/resolve.py.
const ENTITY_SCHEMES = new Set([
  "sample", "property", "simulation", "person", "publication",
  "software", "method",
  "addatom", "deleteatom", "substituteatom",
  "addition", "subtraction", "multiplication", "division",
]);

// Split an identifier into {scheme, localId, href}, or null when it is not one
// of ours (an ontology term, a DOI, a plain literal). Both the minted IRI and
// the legacy "sample:<uuid>" short form are accepted.
function _entityParts(uri) {
  const s = String(uri ?? "").trim();
  if (!s) return null;
  let m = s.match(/\/id\/([A-Za-z]+)\/([^/?#]+?)\/?$/);
  if (!m) m = s.match(/^([A-Za-z]+):([^\s/]+)$/);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (!ENTITY_SCHEMES.has(scheme)) return null;
  let localId;
  try { localId = decodeURIComponent(m[2]); } catch (_) { localId = m[2]; }
  // Relative, so the link works on every hostname; the aliases 301 /id/* to the
  // canonical host at the nginx layer.
  return { scheme, localId, href: `/id/${scheme}/${encodeURIComponent(localId)}` };
}

// "<scheme>/<local-id>", with the local part clipped to `max` characters for
// dense cells. The full IRI always stays available as the link's title.
function _idLabel(parts, max) {
  const local = (max && parts.localId.length > max + 1)
    ? parts.localId.slice(0, max) + "…"
    : parts.localId;
  return `${parts.scheme}/${local}`;
}

// HTML for a linked identifier. Falls back to escaped text for anything that is
// not one of our IRIs, so it is safe to pass any cell value.
//   max          clip the local id to this many characters
//   label        show this text instead of "<scheme>/<local-id>"
//   stopRowClick emit a handler so clicking the link does not also fire the
//                surrounding row's click (sample rows open a detail panel)
function _idLink(uri, opts = {}) {
  const parts = _entityParts(uri);
  if (!parts) return escHtml(String(uri ?? ""));
  const stop = opts.stopRowClick ? ' onclick="event.stopPropagation()"' : "";
  const text = opts.label || _idLabel(parts, opts.max);
  return `<a class="entity-link" href="${escAttr(parts.href)}" target="_blank"` +
         ` rel="noopener" title="${escAttr(String(uri))}"${stop}>` +
         `${escHtml(text)}</a>`;
}

// A sample referenced from some other table: the linked identifier plus the
// structure viewer, which is the one thing the entity page cannot offer.
function _sampleCell(sid) {
  return `<span class="entity-cell">${_idLink(sid, { max: 8, stopRowClick: true })}` +
    `<button class="btn btn-sm btn-outline entity-cell-btn" title="View atomic structure"` +
    ` onclick="event.stopPropagation();openStructureViewer('${escAttr(sid)}','${escAttr(_shortId(sid))}')">🔬</button></span>`;
}

// DOM form of _idLink, for the tables that are built as elements.
function _idAnchor(uri, opts = {}) {
  const parts = _entityParts(uri);
  if (!parts) return null;
  const a = document.createElement("a");
  a.className = "entity-link";
  a.href = parts.href;
  a.target = "_blank";
  a.rel = "noopener";
  a.title = String(uri);
  a.textContent = _idLabel(parts, opts.max);
  return a;
}

async function _loadSampleCount() {
  try {
    const data = await apiFetch("/api/samples/summary");
    const el = document.getElementById("hdr-sample-count");
    if (el) el.textContent = data.total;
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════
// OVERVIEW  —  what is actually in this graph
// ═══════════════════════════════════════════════════════════
// Composed from four responses: /api/stats supplies the census that nothing
// else computes (triples, classes, vocabularies, structure coverage), and the
// three summary endpoints already serve the rest. Bars are plain CSS — the
// charts here are all ranked horizontal bars, which needs no plotting library.
let _overviewLoaded = false;

const OV_TOP_N = 12;   // rows shown before "show all"

function _ovBars(container, rows, opts = {}) {
  // rows: [{label, value, title?, href?, note?}]
  if (!rows.length) {
    container.innerHTML = `<p class="ov-empty">Nothing to show.</p>`;
    return;
  }
  const max = Math.max(...rows.map(r => r.value)) || 1;
  const topN = opts.topN ?? OV_TOP_N;

  const rowHtml = r => {
    const pct = Math.max((r.value / max) * 100, 0.6);   // keep tiny bars visible
    const label = r.href
      ? `<a href="${escAttr(r.href)}" target="_blank" rel="noopener">${escHtml(r.label)}</a>`
      : escHtml(r.label);
    return `<div class="bar-row" title="${escAttr(r.title || r.label)}">
        <div class="bar-label">${label}${r.note ? `<span class="bar-note">${escHtml(r.note)}</span>` : ""}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(2)}%"></div></div>
        <div class="bar-value">${r.value.toLocaleString()}</div>
      </div>`;
  };

  const head = rows.slice(0, topN).map(rowHtml).join("");
  const rest = rows.slice(topN).map(rowHtml).join("");
  container.innerHTML = head +
    (rest
      ? `<div class="ov-rest" hidden>${rest}</div>
         <button class="btn btn-sm btn-outline ov-more">Show all ${rows.length}</button>`
      : "");

  const btn = container.querySelector(".ov-more");
  if (btn) {
    btn.onclick = () => {
      const more = container.querySelector(".ov-rest");
      const open = !more.hidden;
      more.hidden = open;
      btn.textContent = open ? `Show all ${rows.length}` : "Show fewer";
    };
  }
}

function _ovStatCards(cards) {
  document.getElementById("ov-headline").innerHTML = cards.map(c =>
    `<div class="stat-card"${c.title ? ` title="${escAttr(c.title)}"` : ""}>
       <div class="stat-value">${c.value.toLocaleString()}</div>
       <div class="stat-label">${escHtml(c.label)}</div>
     </div>`).join("");
}

async function loadOverview() {
  if (_overviewLoaded) return;
  _overviewLoaded = true;
  showEl("overview-loading");
  hideEl("overview-body");
  clearAlert("overview-alert");

  try {
    // The census is a handful of SPARQL aggregates and is the slow one; the
    // other three are cached responses. Fetch them together.
    const [stats, samples, props, datasets] = await Promise.all([
      apiFetch("/api/stats"),
      apiFetch("/api/samples/summary"),
      apiFetch("/api/properties/summary"),
      apiFetch("/api/datasets"),
    ]);

    const simulations = _workflowsTotal ||
      (await apiFetch("/api/workflows?limit=1&offset=0")).total || 0;

    _ovStatCards([
      { label: "Triples",          value: stats.triples,         title: "Total statements in the graph" },
      { label: "Samples",          value: samples.total,         title: "cmso:AtomicScaleSample instances" },
      { label: "Simulations",      value: simulations,           title: "asmo:EnergyCalculation and asmo:Simulation instances" },
      { label: "Property records", value: props.scalar_total ?? props.total ?? 0, title: "Scalar property values" },
      { label: "Datasets",         value: (datasets || []).length, title: "Published source datasets" },
      { label: "Elements",         value: Object.keys(samples.elements || {}).length, title: "Distinct chemical elements covered" },
      { label: "Classes",          value: stats.class_count,     title: "Distinct instantiated ontology classes" },
      { label: "Vocabularies",     value: stats.vocabulary_count, title: "Namespaces appearing in predicate position" },
    ]);

    // Class labels link to the ontology term itself, which dereferences.
    document.getElementById("ov-classes-sub").textContent = `${stats.class_count} classes`;
    _ovBars(document.getElementById("ov-classes"),
      stats.classes.map(c => ({ label: c.label, value: c.count, href: c.uri, title: c.uri })));

    document.getElementById("ov-vocab-sub").textContent =
      `${stats.predicate_count} distinct predicates`;
    _ovBars(document.getElementById("ov-vocab"),
      stats.vocabularies.map(v => ({
        label: v.prefix || v.uri,
        value: v.triples,
        href: v.uri,
        note: `${v.predicates} predicate${v.predicates !== 1 ? "s" : ""}`,
        title: v.name ? `${v.name} — ${v.uri}` : v.uri,
      })), { topN: 20 });

    const ds = (datasets || []).slice().sort((a, b) => (b.sample_count || 0) - (a.sample_count || 0));
    document.getElementById("ov-datasets-sub").textContent = `${ds.length} datasets`;
    _ovBars(document.getElementById("ov-datasets"),
      ds.map(d => ({
        label: d.title || d.uri,
        value: d.sample_count || 0,
        href: d.identifier || d.uri,
        title: d.title ? `${d.title} — ${d.uri}` : d.uri,
      })));

    const pt = (props.types || []).slice().sort((a, b) => b.count - a.count);
    document.getElementById("ov-props-sub").textContent = `${pt.length} types`;
    _ovBars(document.getElementById("ov-props"),
      pt.map(t => ({
        label: t.type,
        value: t.count,
        note: t.unit || "",
        title: t.unit ? `${t.type} (${t.unit})` : t.type,
      })));

    _ovStructures(stats.structures);

    hideEl("overview-loading");
    showEl("overview-body");
  } catch (e) {
    _overviewLoaded = false;   // allow a retry on the next tab click
    hideEl("overview-loading");
    const retryMsg = e.message.startsWith("HTTP 5")
      ? " The app may still be starting — please try again in a moment." : "";
    showAlert("overview-alert", "error", `Could not load the overview: ${e.message}.${retryMsg}`);
  }
}

// Most published samples are property-only: the source datasets report measured
// quantities without shipping the atomic configuration. Saying so here is more
// useful than letting people find out from a 422 in the structure viewer.
function _ovStructures(s) {
  const el = document.getElementById("ov-structures");
  if (!el || !s || !s.total) { if (el) el.innerHTML = ""; return; }
  const pct = v => ((v / s.total) * 100).toFixed(1);
  el.innerHTML = `
    <div class="split-bar">
      <div class="split-seg split-a" style="width:${pct(s.with_cell)}%"
           title="${s.with_cell.toLocaleString()} samples with a simulation cell"></div>
      <div class="split-seg split-b" style="width:${pct(s.without_cell)}%"
           title="${s.without_cell.toLocaleString()} samples without a simulation cell"></div>
    </div>
    <div class="split-legend">
      <span><i class="dot dot-a"></i>With an atomic structure —
        <strong>${s.with_cell.toLocaleString()}</strong> (${pct(s.with_cell)}%)</span>
      <span><i class="dot dot-b"></i>Property-only —
        <strong>${s.without_cell.toLocaleString()}</strong> (${pct(s.without_cell)}%)</span>
    </div>
    <p class="ov-note">A sample is property-only when its source dataset published
      measured quantities without the atomic configuration. Those samples are fully
      queryable; only the structure viewer needs a simulation cell.</p>`;
}

// ═══════════════════════════════════════════════════════════
// SAMPLES  —  Periodic Table Explorer
// ═══════════════════════════════════════════════════════════
let _samplesCache = [];             // the CURRENT PAGE only, not every sample
let _sampleSummary = { total: 0, elements: {} };  // drives the periodic table
let _samplesTotal = 0;              // rows matching the active filter
let _samplesOffset = 0;
const SAMPLES_PAGE_SIZE = 100;
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
    // The periodic table needs per-element counts over the whole graph; the
    // table below it needs one page. Two requests, neither of them large.
    _sampleSummary = await apiFetch("/api/samples/summary");
    document.getElementById("hdr-sample-count").textContent = _sampleSummary.total;
    hideEl("samples-loading");
    hideEl("ptable-loading");

    if (!_sampleSummary.total) {
      showEl("samples-empty");
      return;
    }

    _renderPeriodicTable();
    showEl("ptable-wrap");
    await _fetchSamplePage(0);
    showEl("samples-table-wrap");
  } catch (e) {
    hideEl("samples-loading");
    hideEl("ptable-loading");
    showAlert("samples-alert", "error", `Failed to load samples: ${e.message}`);
  }
}

// Build the query for the active filters. Filtering happens server-side now:
// the browser only holds one page, so it cannot filter what it has not seen.
function _sampleQuery(offset) {
  const p = new URLSearchParams();
  const textQ = (document.getElementById("elem-text-filter")?.value || "").trim();
  if (textQ) p.set("search", textQ);
  if (_selectedElements.size) p.set("elements", [..._selectedElements].join(","));
  p.set("limit", SAMPLES_PAGE_SIZE);
  p.set("offset", offset);
  return p.toString();
}

async function _fetchSamplePage(offset, append = false) {
  const page = await apiFetch(`/api/samples?${_sampleQuery(offset)}`);
  _samplesCache = append ? _samplesCache.concat(page.items) : page.items;
  _samplesTotal = page.total;
  _samplesOffset = offset + page.items.length;
  _renderFilteredSamples();
}

async function _loadMoreSamples(btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
  try {
    await _fetchSamplePage(_samplesOffset, true);
  } catch (e) {
    showAlert("samples-alert", "error", `Could not load more: ${e.message}`);
  }
}

function _renderPeriodicTable() {
  // Counts are graph-wide, from /api/samples/summary. Deriving them from the
  // loaded rows would only ever count the current page.
  const countMap = _sampleSummary.elements || {};

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
  _fetchSamplePage(0).catch(e =>
    showAlert("samples-alert", "error", `Filter failed: ${e.message}`));
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
  _fetchSamplePage(0).catch(e =>
    showAlert("samples-alert", "error", `Filter failed: ${e.message}`));
}

let _sampleFilterTimer = null;

// Filters now cost a request, so coalesce keystrokes.
function filterSamples() {
  clearTimeout(_sampleFilterTimer);
  _sampleFilterTimer = setTimeout(() => {
    _fetchSamplePage(0).catch(e =>
      showAlert("samples-alert", "error", `Filter failed: ${e.message}`));
  }, 250);
}

function _renderFilteredSamples() {
  // Rows are already filtered and paged by the server.
  const filtered = _samplesCache;

  const el = document.getElementById("samples-result-count");
  if (el) el.textContent = `${_samplesTotal.toLocaleString()} / ${(_sampleSummary.total || 0).toLocaleString()} samples`;

  const wrap = document.getElementById("samples-table-wrap");
  if (!wrap) return;

  if (!filtered.length) {
    wrap.innerHTML = "";
    hideEl("samples-table-wrap");
    showEl("samples-empty");
    return;
  }
  hideEl("samples-empty");

  const tbody = filtered.map(s => {
    const formula = escHtml(s.formula || "—");
    // cmso:hasName repeats the identifier whenever a sample was never given a
    // label, which is every dataset published so far — showing that would just
    // duplicate the ID column, so only a real name is rendered.
    const name = (s.name && !_entityParts(s.name)) ? escHtml(s.name) : "—";
    const idCell = _idLink(s.id, { stopRowClick: true });
    const viewBtn = `<button class="btn btn-sm btn-outline" onclick="event.stopPropagation();openStructureViewer('${escAttr(s.id)}','${escAttr(s.name||s.id)}')" title="View atomic structure">🔬</button>`;
    return `<tr style="cursor:pointer" data-sid="${escAttr(s.id)}" data-sname="${escAttr(s.name||'')}">` +
      `<td><span class="sample-formula">${formula}</span></td>` +
      `<td>${name}</td>` +
      `<td>${idCell}</td>` +
      `<td style="width:48px">${viewBtn}</td>` +
      `</tr>`;
  }).join("");

  const remaining = _samplesTotal - filtered.length;
  const moreHtml = remaining > 0
    ? `<div style="padding:10px;text-align:center">
         <button class="btn btn-sm btn-outline" onclick="_loadMoreSamples(this)">Show more (${remaining.toLocaleString()} remaining)</button>
       </div>`
    : "";

  wrap.innerHTML = `<table>
    <thead><tr><th>Formula</th><th>Name</th><th>ID</th><th style="width:48px"></th></tr></thead>
    <tbody>${tbody}</tbody>
  </table>` + moreHtml;

  wrap.querySelectorAll("tr[data-sid]").forEach(tr => {
    tr.addEventListener("click", () => openSampleDetail(tr.dataset.sid, tr.dataset.sname));
  });

  showEl("samples-table-wrap");
}

// A detail panel's heading is itself an identifier, so link it to the entity
// page rather than printing the IRI as dead text.
function _setDetailTitle(el, id, name) {
  if (!el) return;
  const parts = _entityParts(id);
  const named = (name && !_entityParts(name)) ? `${escHtml(name)} ` : "";
  el.innerHTML = parts ? named + _idLink(id) : escHtml(name || String(id));
}

async function openSampleDetail(sampleId, name) {
  clearAlert("samples-alert");
  const panel = document.getElementById("sample-detail");
  const grid  = document.getElementById("detail-grid");
  const title = document.getElementById("detail-title");

  _setDetailTitle(title, sampleId, name);
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
        (v.data_link ? `<div><a href="${escAttr(v.data_link)}" target="_blank" rel="noopener" style="color:var(--link);font-size:12px">🗂 Data: ${escHtml(v.data_link)}</a></div>` : "") +
        (v.publication_title ? `<div style="margin-top:4px">${escHtml(v.publication_title)}</div>` : "") +
        (v.publication_doi ? `<div><a href="${escAttr(v.publication_doi)}" target="_blank" rel="noopener" style="color:var(--link);font-size:12px">📄 Publication: ${escHtml(v.publication_doi)}</a></div>` : "") +
        (v.authors ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">${escHtml(v.authors)}</div>` : "") +
        `</div></div>`;
      continue;
    }

    const label = (prefix ? `${prefix}.` : "") + k;
    if (typeof v === "object" && !Array.isArray(v)) {
      cells += renderDetailGrid(v, label);
    } else {
      if (Array.isArray(v) && v.length > 3) continue;
      // Values that are identifiers link to their own entity pages.
      let display;
      if (Array.isArray(v)) {
        display = (v.length && v.every(x => _entityParts(x)))
          ? v.map(x => _idLink(x)).join(", ")
          : escHtml(JSON.stringify(v));
      } else {
        display = _entityParts(v) ? _idLink(v) : escHtml(String(v));
      }
      cells += `<div class="detail-item"><div class="key">${escHtml(label)}</div><div class="val">${display}</div></div>`;
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
      .linkColor(() => "rgba(80,80,120,0.4)")
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
    // The graph no longer has a tab of its own to re-enter, so the retry has to
    // be offered here.
    _graphLoaded = false;
    const retryMsg = e.message.startsWith("HTTP 5") ? " The app may still be starting — please try again in a moment." : "";
    container.innerHTML = `<div class="alert alert-error" style="margin:16px">
      Failed to load graph: ${escHtml(e.message)}.${retryMsg}
      <button class="btn btn-sm btn-outline" style="margin-left:10px" onclick="loadGraph()">Retry</button>
    </div>`;
  }
}

async function openGraphSampleDetail(sampleId, name) {
  const panel = document.getElementById("graph-sample-detail");
  const grid  = document.getElementById("graph-detail-grid");
  const title = document.getElementById("graph-detail-title");

  _setDetailTitle(title, sampleId, name);
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

// ═══════════════════════════════════════════════════════════
// FILTER BY CALCULATED PROPERTY
// ═══════════════════════════════════════════════════════════
// The ontology-path builder above cannot ask "which samples have a grain
// boundary energy above X" — the value hangs off a property node two hops from
// the sample, and tools4rdf will not walk there. /api/guided-query/properties
// writes that pattern out directly, converting units where a property was
// published in more than one.
let _propTypes = null;
let _propFilterCount = 0;

async function _ensurePropTypes() {
  if (_propTypes) return _propTypes;
  _propTypes = await apiFetch("/api/guided-query/properties");
  return _propTypes;
}

function _propTypeLabel(t) {
  const units = (t.units_seen || []).map(u => u.unit).filter(Boolean);
  const unit = t.unit ? ` — ${t.unit}` : "";
  const mixed = units.length > 1 ? ` (converted from ${units.length} units)` : "";
  return `${t.type}${unit}${mixed} · ${t.count.toLocaleString()}`;
}

async function addPropFilterRow() {
  const container = document.getElementById("prop-filter-rows");
  const id = ++_propFilterCount;
  const row = document.createElement("div");
  row.className = "filter-row";
  row.id = `prop-filter-row-${id}`;
  row.innerHTML = `
    <div>
      <label>Property</label>
      <select id="prop-sel-${id}"><option value="">— loading… —</option></select>
    </div>
    <div>
      <label>Operator</label>
      <select id="prop-op-${id}">
        <option value="">none</option>
        <option value="==">=</option>
        <option value="!=">≠</option>
        <option value="&gt;">&gt;</option>
        <option value="&gt;=">&ge;</option>
        <option value="&lt;">&lt;</option>
        <option value="&lt;=">&le;</option>
      </select>
    </div>
    <div>
      <label>Value</label>
      <input type="text" id="prop-val-${id}" placeholder="number" />
    </div>
    <button class="remove-btn" onclick="removePropFilterRow(${id})" title="Remove">✕</button>
  `;
  container.appendChild(row);

  const sel = document.getElementById(`prop-sel-${id}`);
  try {
    const types = await _ensurePropTypes();
    sel.innerHTML = types.length
      ? types.map(t => `<option value="${escAttr(t.type_uri)}">${escHtml(_propTypeLabel(t))}</option>`).join("")
      : '<option value="">— none available —</option>';
  } catch (e) {
    sel.innerHTML = `<option value="">Error: ${escHtml(e.message)}</option>`;
  }
}

function removePropFilterRow(id) {
  const row = document.getElementById(`prop-filter-row-${id}`);
  if (row) row.remove();
}

async function runPropertyQuery() {
  clearAlert("guided-alert");
  hideEl("guided-sparql-wrap");
  hideEl("guided-results-wrap");

  const filters = [];
  document.querySelectorAll("[id^=prop-filter-row-]").forEach(row => {
    const id = row.id.replace("prop-filter-row-", "");
    const sel = document.getElementById(`prop-sel-${id}`);
    if (!sel || !sel.value) return;
    filters.push({
      type_uri: sel.value,
      operator: document.getElementById(`prop-op-${id}`)?.value || null,
      value: document.getElementById(`prop-val-${id}`)?.value || null,
    });
  });

  if (!filters.length) {
    showAlert("guided-alert", "error", "Add at least one property filter.");
    return;
  }

  setLoading("prop-run-btn", true);
  try {
    const res = await apiFetch("/api/guided-query/properties", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters, limit: 500 }),
    });

    if (res.sparql) {
      document.getElementById("guided-sparql-text").textContent = res.sparql;
      showEl("guided-sparql-wrap");
    }

    if (res.columns && res.columns.length && res.rows.length) {
      const n = res.rows.length;
      document.getElementById("guided-result-count").textContent =
        `(${n} row${n !== 1 ? "s" : ""}${n === 500 ? ", capped" : ""})`;
      const twrap = document.getElementById("guided-table-wrap");
      twrap.innerHTML = "";
      twrap.appendChild(buildTableDOM(res.columns, res.rows));
      showEl("guided-results-wrap");
    } else {
      showAlert("guided-alert", "info", "No samples matched those filters.");
    }
  } catch (e) {
    showAlert("guided-alert", "error", e.message);
  } finally {
    setLoading("prop-run-btn", false);
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
      // Query results are where IRIs show up most; any binding that names an
      // entity in the graph becomes a link to its page.
      const link = _idAnchor(val);
      if (link) td.appendChild(link); else td.textContent = val;
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
        btn.onclick = e => { e.stopPropagation(); openStructureViewer(sampleUri, _shortId(sampleUri)); };
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

const WORKFLOW_PAGE_SIZE = 100;
let _workflowsTotal  = 0;
let _workflowsOffset = 0;

// Extracted from the tab renderer so that "show more" can build rows for a
// freshly fetched page without duplicating the markup.
function _workflowRow(w) {
  const id    = _idLink(w.id);
  const badge = `<span class="workflow-type-badge">${escHtml(w.type)}</span>`;
  // The method node is an entity of its own (asmo:MolecularStatics and friends
  // are shared across tens of thousands of simulations), so link the label to it.
  const method = w.method
    ? (_entityParts(w.method_uri)
        ? _idLink(w.method_uri, { label: w.method })
        : escHtml(w.method))
    : '—';
  // Software is usually the project's own URL; when the graph holds it as an
  // instance instead, it links to that entity page.
  const sw = w.software
    ? (_entityParts(w.software)
        ? _idLink(w.software)
        : `<a href="${escAttr(w.software)}" target="_blank" rel="noopener" style="color:var(--link);font-size:11px">${escHtml(w.software.length > 50 ? w.software.slice(0,47)+'…' : w.software)}</a>`)
    : '—';
  const pot = w.potential_uri
    ? `<a href="${escAttr(w.potential_uri)}" target="_blank" rel="noopener" title="${escAttr(w.potential_uri)}" style="color:var(--link);font-size:11px">${escHtml(w.potential || w.potential_uri.split('/').pop())}</a>`
    : escHtml(w.potential || '—');
  const samples = w.output_samples || w.samples || [];
  const sLinks = samples.length ? samples.map(_sampleCell).join(" ") : '—';
  return `<tr><td>${id}</td><td>${badge}</td><td>${method}</td><td>${sw}</td><td>${pot}</td><td>${sLinks}</td></tr>`;
}

function _workflowMoreHtml() {
  const remaining = _workflowsTotal - _workflowsOffset;
  if (remaining <= 0) return "";
  return `<div class="wf-load-more" style="padding:10px;text-align:center">
    <button class="btn btn-sm btn-outline" onclick="_loadMoreWorkflows(this)">Show more (${remaining.toLocaleString()} remaining)</button>
  </div>`;
}

async function _loadMoreWorkflows(btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
  try {
    const res = await apiFetch(`/api/workflows?limit=${WORKFLOW_PAGE_SIZE}&offset=${_workflowsOffset}`);
    const wfs = res.workflows || [];
    _workflowsOffset += wfs.length;
    const wrap = document.getElementById("workflows-table-wrap");
    wrap.querySelector("tbody").insertAdjacentHTML("beforeend", wfs.map(_workflowRow).join(""));
    const more = wrap.querySelector(".wf-load-more");
    if (more) more.outerHTML = _workflowMoreHtml();
  } catch (e) {
    showAlert("workflows-alert", "error", `Could not load more: ${e.message}`);
  }
}

async function loadWorkflows() {
  if (_workflowsLoaded) return;
  _workflowsLoaded = true;
  showEl("workflows-loading");
  hideEl("workflows-table-wrap");
  hideEl("workflows-empty");
  clearAlert("workflows-alert");

  try {
    const res = await apiFetch(`/api/workflows?limit=${WORKFLOW_PAGE_SIZE}&offset=0`);
    const wfs = res.workflows || [];
    _workflowsTotal = res.total ?? wfs.length;
    _workflowsOffset = wfs.length;
    hideEl("workflows-loading");

    const countEl = document.getElementById("hdr-workflow-count");
    if (countEl) countEl.textContent = _workflowsTotal;

    if (!wfs.length) { showEl("workflows-empty"); return; }

    const thead = `<thead><tr>
      <th>ID</th><th>Type</th><th>Method</th><th>Software / DOI</th><th>Potential</th><th>Output Samples</th>
    </tr></thead>`;
    const tbody = wfs.map(_workflowRow).join("");

    const wrap = document.getElementById("workflows-table-wrap");
    wrap.innerHTML = `<table>${thead}<tbody>${tbody}</tbody></table>` + _workflowMoreHtml();
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
let _propertiesLoaded = false;

async function loadProperties() {
  if (_propertiesLoaded) return;
  _propertiesLoaded = true;
  showEl("properties-loading");
  hideEl("properties-cards");
  hideEl("properties-empty");
  clearAlert("properties-alert");

  try {
    // Aggregates only — a couple of kB. The individual records are fetched per
    // type when a card is expanded; there are >100k of them.
    const data = await apiFetch("/api/properties/summary");
    hideEl("properties-loading");

    const countEl = document.getElementById("hdr-prop-count");
    if (countEl) countEl.textContent = data.scalar_total ?? "";

    if (!data.types || !data.types.length) { showEl("properties-empty"); return; }
    renderPropertyCards(data.types);
  } catch (e) {
    _propertiesLoaded = false;
    hideEl("properties-loading");
    const retryMsg = e.message.startsWith("HTTP 5") ? " The app may still be starting — please try again in a moment." : "";
    showAlert("properties-alert", "error", `Failed to load properties: ${e.message}.${retryMsg}`);
  }
}

function renderPropertyCards(types) {
  const container = document.getElementById("properties-cards");
  container.innerHTML = "";

  for (const t of types) {
    const typeName    = t.type || "Unknown";
    const displayName = typeName.replace(/([a-z])([A-Z])/g, "$1 $2");
    const unit        = t.unit || "";

    let statsHtml = "";
    if (t.mean !== null && t.mean !== undefined) {
      statsHtml = `<div style="display:flex;gap:16px;margin-top:6px;font-size:12px;color:var(--text-muted)">
        <span>min: <strong style="color:var(--text)">${t.min.toPrecision(4)}</strong></span>
        <span>max: <strong style="color:var(--text)">${t.max.toPrecision(4)}</strong></span>
        <span>mean: <strong style="color:var(--text)">${t.mean.toPrecision(4)}</strong></span>
      </div>`;
    }

    const tableId = `prop-table-${typeName}`;
    const card = document.createElement("div");
    card.className = "card";
    card.style.cssText = "margin-bottom:12px;cursor:pointer;transition:box-shadow 0.2s";
    card.innerHTML = `
      <div style="padding:16px 20px" onclick="togglePropertyTable('${tableId}', this)">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <h3 style="margin:0;font-size:16px;font-weight:600">${escHtml(displayName)}</h3>
            <span style="font-size:13px;color:var(--text-muted)">${t.scalar_count.toLocaleString()} scalar${t.array_count ? `, ${t.array_count.toLocaleString()} array` : ""} record${t.count !== 1 ? "s" : ""}${unit ? ` · ${escHtml(unit)}` : ""}</span>
          </div>
          <span class="prop-chevron" style="font-size:18px;color:var(--text-muted);transition:transform 0.2s">▶</span>
        </div>
        ${statsHtml}
      </div>
      <div id="${tableId}" style="display:none;border-top:1px solid var(--border);max-height:500px;overflow-y:auto"></div>
    `;
    container.appendChild(card);
  }

  showEl("properties-cards");
}

const PROP_PAGE_SIZE = 100;

async function togglePropertyTable(tableId, headerEl) {
  const tableDiv = document.getElementById(tableId);
  const chevron  = headerEl.querySelector(".prop-chevron");
  const isOpen   = tableDiv.style.display !== "none";

  if (isOpen) {
    tableDiv.style.display = "none";
    if (chevron) chevron.style.transform = "rotate(0deg)";
    return;
  }

  tableDiv.style.display = "block";
  if (chevron) chevron.style.transform = "rotate(90deg)";

  // Records are fetched per type on first open, not held in the browser.
  if (tableDiv.innerHTML) return;

  const typeName = tableId.replace("prop-table-", "");
  tableDiv.innerHTML = `<div style="padding:20px;text-align:center"><div class="spinner"></div></div>`;
  try {
    const page = await apiFetch(
      `/api/properties?type=${encodeURIComponent(typeName)}&limit=${PROP_PAGE_SIZE}&offset=0`);
    tableDiv.innerHTML = "";
    buildPropertySubTable(tableDiv, page.items, page.total, typeName);
  } catch (e) {
    tableDiv.innerHTML =
      `<div class="alert alert-error" style="margin:12px">Could not load records: ${escHtml(e.message)}</div>`;
  }
}

function buildPropertySubTable(container, items, total, typeName) {
  let shown = 0;
  let loading = false;

  function renderRows(batch) {
    const rows = batch.map(p => {
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

      const samples = p.sample_ids || [];
      const sLinks = samples.length
        ? samples.slice(0, 2).map(_sampleCell).join(" ")
          + (samples.length > 2 ? ` <span style="font-size:11px;color:var(--text-muted)">+${samples.length - 2}</span>` : "")
        : `—`;

      return `<tr><td>${label}</td><td>${_idLink(p.id)}</td>` +
        `<td style="text-align:right">${valCell}</td><td>${sLinks}</td></tr>`;
    }).join("");
    return rows;
  }

  function appendBatch(batch) {
    const rows = renderRows(batch);
    if (!shown) {
      container.innerHTML = `<table style="font-size:13px">
        <thead><tr><th>Label</th><th>ID</th><th style="text-align:right">Value</th><th>Sample(s)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table><div class="prop-load-more" style="padding:8px 16px;text-align:center"></div>`;
    } else {
      container.querySelector("tbody").insertAdjacentHTML("beforeend", rows);
    }
    shown += batch.length;
    updateMore();
  }

  function updateMore() {
    const more = container.querySelector(".prop-load-more");
    if (!more) return;
    const remaining = total - shown;
    if (remaining <= 0) { more.remove(); return; }
    more.innerHTML =
      `<button class="btn btn-sm btn-outline">Show more (${remaining.toLocaleString()} remaining)</button>`;
    more.querySelector("button").onclick = loadMore;
  }

  // Each click fetches the next page rather than revealing already-downloaded
  // rows, so the browser only ever holds what has actually been looked at.
  async function loadMore() {
    if (loading) return;
    loading = true;
    const btn = container.querySelector(".prop-load-more button");
    if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
    try {
      const page = await apiFetch(
        `/api/properties?type=${encodeURIComponent(typeName)}&limit=${PROP_PAGE_SIZE}&offset=${shown}`);
      appendBatch(page.items);
    } catch (e) {
      const more = container.querySelector(".prop-load-more");
      if (more) more.innerHTML =
        `<span style="color:var(--error);font-size:12px">Could not load more: ${escHtml(e.message)}</span>`;
    } finally {
      loading = false;
    }
  }

  appendBatch(items);
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
        : `<a class="entity-link" href="${escAttr(ds.uri)}" target="_blank" rel="noopener" title="${escAttr(ds.uri)}">${escHtml(ds.uri.length > 60 ? ds.uri.slice(0, 58) + "…" : ds.uri)}</a>`;

      const dataLink = ds.identifier
        ? `<a href="${escAttr(ds.identifier)}" target="_blank" rel="noopener" style="color:var(--link);font-size:11px">${escHtml(ds.identifier.length > 50 ? ds.identifier.slice(0,48)+'…' : ds.identifier)}</a>`
        : '—';

      const pub = ds.publication_doi
        ? `<a href="${escAttr(ds.publication_doi)}" target="_blank" rel="noopener" style="color:var(--link);font-size:11px" title="${escAttr(ds.publication_title || '')}">${escHtml(ds.publication_doi)}</a>`
        : '—';

      const authorFmt = ds.authors && ds.authors.length
        ? (ds.authors.length === 1 ? ds.authors[0] : ds.authors[0] + ' et al.')
        : '—';
      const authors = `<span style="font-size:11px;color:var(--text-muted)" title="${escAttr((ds.authors||[]).join(', '))}">${escHtml(authorFmt)}</span>`;

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

// ── Deep links ────────────────────────────────────────────
// Resolving an instance IRI in a browser lands here as /?sample=<iri>
// (see app/routes/resolve.py). Open that sample's detail view directly,
// otherwise the IRI just dumps the visitor on the front page.
async function _openDeepLink() {
  let sampleId;
  try {
    sampleId = new URLSearchParams(window.location.search).get("sample");
  } catch (_) {
    return;
  }
  if (!sampleId) return;

  // Switch to the Samples tab so the detail panel is visible.
  const btn = document.querySelector('[data-tab="samples"]');
  if (btn) btn.click();

  // The list populates the name and the dataset enrichment, but the detail
  // view works without it, so a slow or failed load must not block the link.
  try { await loadSamples(); } catch (_) {}

  const cached = _samplesCache.find(s => s.id === sampleId);
  openSampleDetail(sampleId, cached?.name || "");
}

// ── Init ──────────────────────────────────────────────────
// Both halves of the landing tab. The graph is measured from its container's
// width, so it has to be laid out — which it is, Overview being the active tab.
_loadSampleCount();
loadOverview();
loadGraph();
_openDeepLink();
