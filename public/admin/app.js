// Corkathon admin console — client logic.
// Routes between sections, drives the pipeline SVG, computes KPIs,
// fetches + renders per-API views (Whoop / Gateway / Hospital), and
// paints the compatibility matrix that explains blockers.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  patients: [],
  events: [], // newest-last; capped
  recordsCount: 0,
  busy: false,
  lastSyncByPatient: {},
  filter: { level: "all", patient: "all" },
  mapping: null, // { loinc, unmapped }
  compat: { patientId: null, data: null },
  whoopInspect: { patientId: null, snapshot: null },
  transactions: {
    records: [],
    filter: { patient: "all", hospital: "all" },
    openRows: new Set(),
  },
};

// Single hospital for now; keyed so adding more later is mechanical.
const HOSPITALS = [{ id: "hospital-local", name: "Hospital", port: "4003" }];

const EVENT_CAP = 500;

// ─── Section routing ────────────────────────────────────────
const SECTION_META = {
  overview:      ["Dashboard",      "Live status for the Whoop → Hospital pipeline."],
  compatibility: ["Compatibility",  "Walk every Whoop field through consent, translator, and hospital — see exactly where things stop."],
  whoop:         ["Whoop API",      "Mock wearable source. Endpoints, patients, and raw snapshot inspection."],
  gateway:       ["Gateway API",    "Consent filter and translator. Endpoints and the LOINC mapping table."],
  hospital:      ["Hospital API",   "FHIR receiver, alert rules, and stored records."],
  transactions:  ["Transactions",   "Every FHIR Bundle grouped by patient and hospital. Expand a row to see the Observations."],
  telemetry:     ["Telemetry",      "Every event the gateway emits, streamed over SSE."],
};

function go(section) {
  if (!SECTION_META[section]) section = "overview";
  document.body.dataset.section = section;
  if (location.hash.slice(1) !== section) {
    history.replaceState(null, "", `#${section}`);
  }
  const [t, s] = SECTION_META[section];
  $("#section-title").textContent = t;
  $("#section-sub").textContent = s;
  if (section === "telemetry") renderLog();
  if (section === "whoop") {
    renderPatientsTable();
    const sel = $("#whoop-patient");
    if (sel?.value && sel.value !== state.whoopInspect.patientId) loadWhoopSnapshot(sel.value);
  }
  if (section === "hospital") loadHospitalRecords();
  if (section === "gateway") loadMapping();
  if (section === "compatibility") refreshCompat();
  if (section === "transactions") loadTransactions();
}

document.addEventListener("click", (ev) => {
  const nav = ev.target.closest("[data-nav]");
  if (!nav) return;
  ev.preventDefault();
  go(nav.dataset.nav);
});

// ─── Pipeline control ───────────────────────────────────────
const svg = $("#pipeline-svg");
const pipelineStatus = $("#pipeline-status");
const PACKET_X = { idle: 90, whoop: 300, translate: 500, hospital: 700, complete: 910 };

function setPipelineStage(stage, statusText) {
  if (!svg) return;
  svg.dataset.stage = stage;
  if (pipelineStatus) {
    pipelineStatus.textContent = statusText ?? stage;
    if (stage === "idle") pipelineStatus.dataset.state = "";
    else if (stage === "complete") pipelineStatus.dataset.state = "ok";
    else if (stage.startsWith("error")) pipelineStatus.dataset.state = "err";
    else pipelineStatus.dataset.state = "running";
  }
  const xBase = stage.startsWith("error")
    ? PACKET_X[stage.replace("error-", "")] ?? PACKET_X.idle
    : PACKET_X[stage] ?? PACKET_X.idle;
  $$(".packet-group", svg).forEach((g, i) => {
    const offset = i * 12;
    g.setAttribute("transform", `translate(${xBase - 90 - offset},0)`);
  });
}
setPipelineStage("idle", "Idle");

// ─── Clock ──────────────────────────────────────────────────
const clock = $("#clock");
function tickClock() {
  clock.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
}
setInterval(tickClock, 1000);
tickClock();

// ─── Health ─────────────────────────────────────────────────
async function pollHealth() {
  try {
    const r = await fetch("/health/all");
    if (!r.ok) return;
    const h = await r.json();
    setHealth("whoop", h.whoop.ok);
    setHealth("gateway", h.gateway.ok);
    setHealth("hospital", h.hospital.ok);
    $("#ai-status").textContent = h.ai.ok ? "Claude 4.7" : "rule-based";
    $(".side-ai-dot").dataset.aiOk = String(h.ai.ok);
  } catch {
    setHealth("whoop", false);
    setHealth("hospital", false);
  }
}
function setHealth(node, ok) {
  const dot = $(`.dot[data-health='${node}']`);
  if (dot) dot.dataset.ok = String(ok);
}
pollHealth();
setInterval(pollHealth, 5000);

// ─── Patients ───────────────────────────────────────────────
async function loadPatients() {
  try {
    const r = await fetch("/patients");
    if (!r.ok) throw new Error("patients fetch failed");
    state.patients = await r.json();
    renderPatientsTable();
    populateSelectors();
    updateKPIs();
  } catch (err) {
    const tbody = $("#patients-tbody");
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="t-empty">Whoop unreachable: ${escape(String(err))}</td></tr>`;
  }
}

function populateSelectors() {
  for (const id of ["filter-patient", "compat-patient", "whoop-patient"]) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    const current = sel.value;
    const includeAll = id === "filter-patient";
    sel.innerHTML = includeAll ? `<option value="all">All</option>` : "";
    for (const p of state.patients) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.id} · ${p.displayName}`;
      sel.appendChild(opt);
    }
    sel.value = current && [...sel.options].some((o) => o.value === current)
      ? current
      : (includeAll ? "all" : state.patients[0]?.id ?? "");
  }
  // If compat has no patient yet, pick the first (makes the view useful on first load).
  if (!state.compat.patientId && state.patients[0]) {
    state.compat.patientId = state.patients[0].id;
    $("#compat-patient").value = state.patients[0].id;
  }
}

function renderPatientsTable() {
  const tbody = $("#patients-tbody");
  if (!tbody) return;
  if (state.patients.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="t-empty">No patients.</td></tr>`;
    $("#patients-count").textContent = "0";
    return;
  }
  tbody.innerHTML = "";
  for (const p of state.patients) {
    const last = state.lastSyncByPatient[p.id];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="t-id">${p.id}</span></td>
      <td><span class="t-name">${escape(p.displayName ?? "")}</span></td>
      <td><span class="t-tag" data-tag="${p.label}">${p.label}</span></td>
      <td><div class="t-consent">${(p.consent?.allow ?? []).map((f) => `<span>${f}</span>`).join("")}</div></td>
      <td>${
        last
          ? `<span class="t-last">${new Date(last.ts).toLocaleTimeString("en-GB", { hour12: false })}</span>`
          : `<span class="t-last t-last-none">never</span>`
      }</td>
      <td class="align-right"><button class="r-run" data-sync="${p.id}">Sync</button></td>
    `;
    tbody.appendChild(tr);
  }
  $("#patients-count").textContent = `${state.patients.length} patient${state.patients.length === 1 ? "" : "s"}`;
  $$(".r-run", tbody).forEach((btn) =>
    btn.addEventListener("click", () => runSync(btn.dataset.sync))
  );
}

// ─── KPIs ───────────────────────────────────────────────────
function updateKPIs() {
  const syncs = state.events.filter((e) => e.stage === "start").length;
  const alerts = state.events
    .filter((e) => e.stage === "hospital" && e.level === "warn" && /alert/i.test(e.message ?? ""))
    .length;
  $("[data-kpi='patients']").textContent = state.patients.length;
  $("[data-kpi='syncs']").textContent = syncs;
  $("[data-kpi='records']").textContent = state.recordsCount;
  $("[data-kpi='alerts']").textContent = alerts;
}

// ─── Hospital data ──────────────────────────────────────────
async function loadHospitalRecords() {
  try {
    const r = await fetch("/hospital/records");
    if (!r.ok) return;
    const records = await r.json();
    state.recordsCount = records.length;
    state.transactions.records = records;
    renderRecordsTable(records);
    updateKPIs();
    if (document.body.dataset.section === "transactions") renderTransactions();
  } catch {
    state.recordsCount = 0;
    updateKPIs();
  }
}

async function loadTransactions() {
  // Always refresh — ensures the view sees the latest records.
  await loadHospitalRecords();
  renderTransactions();
}

function renderRecordsTable(records) {
  const tbody = $("#records-tbody");
  if (!tbody) return;
  if (!records || records.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="t-empty">No records yet. Run a sync.</td></tr>`;
    $("#records-count").textContent = "0 records";
    return;
  }
  tbody.innerHTML = "";
  for (const rec of records.slice().reverse()) {
    const alerts = rec.alerts?.length ?? 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="t-id">${rec.id}</span></td>
      <td><span class="t-id">${rec.patientRef}</span></td>
      <td><span class="t-last">${new Date(rec.receivedAt).toLocaleTimeString("en-GB", { hour12: false })}</span></td>
      <td>${rec.observations?.length ?? 0}</td>
      <td>${alerts > 0 ? `<span class="t-tag" data-tag="heart-risk">${alerts} alert${alerts === 1 ? "" : "s"}</span>` : `<span class="t-last-none">none</span>`}</td>
    `;
    tbody.appendChild(tr);
  }
  $("#records-count").textContent = `${records.length} record${records.length === 1 ? "" : "s"}`;
}

// ─── Transactions ──────────────────────────────────────────
function populateTransactionFilters() {
  const pSel = $("#tx-filter-patient");
  const hSel = $("#tx-filter-hospital");
  if (!pSel || !hSel) return;

  const pCurrent = pSel.value;
  pSel.innerHTML = `<option value="all">All</option>`;
  for (const p of state.patients) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.id} · ${p.displayName}`;
    pSel.appendChild(opt);
  }
  pSel.value = [...pSel.options].some((o) => o.value === pCurrent) ? pCurrent : "all";

  const hCurrent = hSel.value;
  hSel.innerHTML = `<option value="all">All</option>`;
  for (const h of HOSPITALS) {
    const opt = document.createElement("option");
    opt.value = h.id;
    opt.textContent = `${h.name} :${h.port}`;
    hSel.appendChild(opt);
  }
  hSel.value = [...hSel.options].some((o) => o.value === hCurrent) ? hCurrent : "all";
}

function renderTransactions() {
  populateTransactionFilters();
  const list = $("#tx-list");
  const summaryEl = $("#tx-summary");
  if (!list || !summaryEl) return;

  const { filter, records, openRows } = state.transactions;
  const hospital = HOSPITALS[0]; // only one hospital for now

  // Apply filters.
  let filtered = records.slice();
  if (filter.hospital !== "all" && filter.hospital !== hospital.id) filtered = [];

  // Group by patientRef.
  const byPatient = new Map();
  for (const rec of filtered) {
    const ref = rec.patientRef ?? "Patient/unknown";
    if (!byPatient.has(ref)) byPatient.set(ref, []);
    byPatient.get(ref).push(rec);
  }

  const patientMap = Object.fromEntries(state.patients.map((p) => [p.id, p]));

  // Produce ordered groups: only patients the user cares about (or all).
  const groups = [];
  const patientsForOrder = state.patients.length > 0
    ? state.patients.map((p) => p.id)
    : [...new Set(filtered.map((r) => (r.patientRef ?? "").replace("Patient/", "")))];
  for (const id of patientsForOrder) {
    if (filter.patient !== "all" && filter.patient !== id) continue;
    const ref = `Patient/${id}`;
    const recs = byPatient.get(ref);
    if (!recs || recs.length === 0) continue;
    groups.push({ patient: patientMap[id] ?? { id, displayName: id }, records: recs });
  }

  // Summary pills.
  const totalTx = filtered.length;
  const patientsWith = groups.length;
  const totalAlerts = filtered.reduce((n, r) => n + (r.alerts?.length ?? 0), 0);
  summaryEl.innerHTML = `
    <div class="compat-pill" data-tone="ok">
      <span class="compat-pill-val">${totalTx}</span>
      <span class="compat-pill-lbl">Transactions</span>
    </div>
    <div class="compat-pill">
      <span class="compat-pill-val">${patientsWith}</span>
      <span class="compat-pill-lbl">Patients with records</span>
    </div>
    <div class="compat-pill" data-tone="${totalAlerts > 0 ? "warn" : ""}">
      <span class="compat-pill-val">${totalAlerts}</span>
      <span class="compat-pill-lbl">Total alerts</span>
    </div>
  `;

  if (groups.length === 0) {
    list.innerHTML = `<div class="tx-empty">No transactions match this filter — run a sync to populate.</div>`;
    return;
  }

  list.innerHTML = "";
  for (const g of groups) {
    const p = g.patient;
    const latestTs = g.records.reduce(
      (acc, r) => (r.receivedAt > acc ? r.receivedAt : acc),
      "0"
    );
    const totalObs = g.records.reduce((n, r) => n + (r.observations?.length ?? 0), 0);
    const totalA = g.records.reduce((n, r) => n + (r.alerts?.length ?? 0), 0);

    const group = document.createElement("div");
    group.className = "tx-group";
    group.innerHTML = `
      <div class="tx-group-head">
        <div class="tx-patient">
          <span class="tx-patient-id">${p.id}</span>
          <span class="tx-patient-name">${escape(p.displayName ?? "")}</span>
          ${p.label ? `<span class="t-tag" data-tag="${p.label}">${p.label}</span>` : ""}
          <span class="tx-hospital">${hospital.name} :${hospital.port}</span>
        </div>
        <div class="tx-counts">
          <span><span class="tx-count-val">${g.records.length}</span> txs</span>
          <span><span class="tx-count-val">${totalObs}</span> obs</span>
          <span><span class="tx-count-val">${totalA}</span> alerts</span>
          <span>Last: <span class="tx-count-val">${new Date(latestTs).toLocaleTimeString("en-GB", { hour12: false })}</span></span>
        </div>
      </div>
      <table class="tx-table">
        <thead>
          <tr>
            <th>Record</th>
            <th>Received</th>
            <th>Observations</th>
            <th>Alerts</th>
          </tr>
        </thead>
        <tbody>
          ${g.records
            .slice()
            .reverse()
            .map((rec) => renderTxRow(rec, openRows.has(rec.id)))
            .join("")}
        </tbody>
      </table>
    `;
    list.appendChild(group);
  }

  // Wire expand/collapse
  $$(".tx-row-main", list).forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.rec;
      if (!id) return;
      if (openRows.has(id)) openRows.delete(id);
      else openRows.add(id);
      renderTransactions();
    });
  });
}

function renderTxRow(rec, open) {
  const alerts = rec.alerts?.length ?? 0;
  const obsRows = (rec.observations ?? [])
    .map((o) => {
      const hasAlert = (o.alerts ?? []).length > 0;
      return `
        <tr>
          <td><span class="tx-obs-code">${o.code}</span></td>
          <td><span class="tx-obs-val">${o.value}</span> <span class="tx-obs-code">${o.unit ?? ""}</span></td>
          <td><span class="tx-obs-code">${new Date(o.effectiveDateTime).toLocaleString("en-GB", { hour12: false })}</span></td>
          <td>${hasAlert ? `<span class="tx-obs-alert">${o.alerts[0].label}</span>` : "<span class='t-last-none'>—</span>"}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <tr class="tx-row-main" data-rec="${rec.id}" data-open="${open}">
      <td>
        <span class="tx-caret">▸</span>
        <span class="t-id">${rec.id}</span>
      </td>
      <td><span class="tx-count-val">${new Date(rec.receivedAt).toLocaleString("en-GB", { hour12: false })}</span></td>
      <td>${rec.observations?.length ?? 0}</td>
      <td>${alerts > 0 ? `<span class="t-tag" data-tag="heart-risk">${alerts} alert${alerts === 1 ? "" : "s"}</span>` : `<span class="t-last-none">none</span>`}</td>
    </tr>
    ${
      open
        ? `
      <tr class="tx-detail-row">
        <td colspan="4">
          <table class="tx-obs-table">
            <thead>
              <tr><th>LOINC</th><th>Value</th><th>Taken at</th><th>Flag</th></tr>
            </thead>
            <tbody>${obsRows || `<tr><td colspan="4" class="t-empty">No observations.</td></tr>`}</tbody>
          </table>
        </td>
      </tr>
    `
        : ""
    }
  `;
}

document.addEventListener("change", (ev) => {
  if (ev.target.id === "tx-filter-patient") {
    state.transactions.filter.patient = ev.target.value;
    renderTransactions();
  } else if (ev.target.id === "tx-filter-hospital") {
    state.transactions.filter.hospital = ev.target.value;
    renderTransactions();
  }
});

// ─── Mapping (Gateway page) ─────────────────────────────────
async function loadMapping() {
  if (state.mapping) return renderMapping();
  try {
    const r = await fetch("/mapping");
    if (!r.ok) return;
    state.mapping = await r.json();
    renderMapping();
  } catch {}
}
function renderMapping() {
  const m = state.mapping;
  if (!m) return;
  const tbody = $("#mapping-tbody");
  if (tbody) {
    tbody.innerHTML = "";
    for (const [field, info] of Object.entries(m.loinc)) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="t-id">${field}</span></td>
        <td><code>${info.source}</code></td>
        <td><code>${info.loinc ?? info.code}</code></td>
        <td>${escape(info.display)}</td>
        <td><code>${info.unit}</code></td>
      `;
      tbody.appendChild(tr);
    }
  }
  const utbody = $("#unmapped-tbody");
  if (utbody) {
    utbody.innerHTML = "";
    for (const u of m.unmapped) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><code>${u.source}</code></td>
        <td><span class="compat-reason">${escape(u.reason)}</span></td>
      `;
      utbody.appendChild(tr);
    }
  }
}

// ─── Compatibility ──────────────────────────────────────────
async function refreshCompat() {
  const id = state.compat.patientId;
  if (!id) return;
  const matrix = $("#compat-matrix");
  const summary = $("#compat-summary");
  matrix.innerHTML = `<div class="activity-empty">Loading…</div>`;
  summary.innerHTML = "";
  try {
    const r = await fetch(`/compatibility/${id}`);
    if (!r.ok) throw new Error(`${r.status}`);
    const data = await r.json();
    state.compat.data = data;
    renderCompat(data);
  } catch (err) {
    matrix.innerHTML = `<div class="activity-empty">Failed: ${escape(String(err))}</div>`;
  }
}

function renderCompat(d) {
  const summary = $("#compat-summary");
  const matrix = $("#compat-matrix");
  const s = d.summary;

  summary.innerHTML = `
    <div class="compat-pill" data-tone="ok">
      <span class="compat-pill-val">${s.flowing}</span>
      <span class="compat-pill-lbl">Flowing through</span>
    </div>
    <div class="compat-pill" data-tone="${s.blockedByConsent > 0 ? "warn" : ""}">
      <span class="compat-pill-val">${s.blockedByConsent}</span>
      <span class="compat-pill-lbl">Blocked by consent</span>
    </div>
    <div class="compat-pill" data-tone="${s.missing > 0 ? "err" : ""}">
      <span class="compat-pill-val">${s.missing}</span>
      <span class="compat-pill-lbl">Missing from snapshot</span>
    </div>
    <div class="compat-pill" data-tone="${s.noMapping > 0 ? "err" : ""}">
      <span class="compat-pill-val">${s.noMapping}</span>
      <span class="compat-pill-lbl">No FHIR mapping</span>
    </div>
  `;

  matrix.innerHTML = `
    <h3 class="compat-group-title">Translatable Whoop fields</h3>
    <table class="compat-table">
      <thead>
        <tr>
          <th>Field</th>
          <th>Value</th>
          <th>LOINC</th>
          <th>Flow</th>
          <th>Status</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        ${d.fields.map(rowForField).join("")}
      </tbody>
    </table>

    ${
      d.unmapped.length > 0
        ? `
      <h3 class="compat-group-title">Unmapped fields present in snapshot</h3>
      <table class="compat-table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Value</th>
            <th>Status</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          ${d.unmapped.map(rowForUnmapped).join("")}
        </tbody>
      </table>
    `
        : ""
    }
  `;
}

function rowForField(f) {
  const ok = f.status === "ok";
  const whoopOk = f.present;
  const consentOk = f.consented;
  const translatorOk = true; // mappable fields all translate
  const hospitalOk = ok;
  return `
    <tr>
      <td>
        <div class="compat-field">${f.field}</div>
        <div class="compat-source">${f.source}</div>
      </td>
      <td>${
        f.present
          ? `<span class="compat-value">${formatValue(f.value, f.unit)}</span>`
          : `<span class="compat-value-dim">—</span>`
      }</td>
      <td><code>${f.loinc}</code></td>
      <td>
        <div class="compat-flow">
          <span class="compat-stage" data-ok="${whoopOk}" title="Whoop">A</span>
          <span class="compat-connector"></span>
          <span class="compat-stage" data-ok="${consentOk}" title="Consent">★</span>
          <span class="compat-connector"></span>
          <span class="compat-stage" data-ok="${translatorOk}" title="Translator">B</span>
          <span class="compat-connector"></span>
          <span class="compat-stage" data-ok="${hospitalOk}" title="Hospital">C</span>
        </div>
      </td>
      <td><span class="compat-status" data-status="${f.status}">${labelForStatus(f.status)}</span></td>
      <td><span class="compat-reason">${escape(f.reason)}</span></td>
    </tr>
  `;
}
function rowForUnmapped(u) {
  return `
    <tr>
      <td><code>${u.source}</code></td>
      <td>${u.present ? `<span class="compat-value">${u.value}</span>` : `<span class="compat-value-dim">—</span>`}</td>
      <td><span class="compat-status" data-status="${u.status}">${labelForStatus(u.status)}</span></td>
      <td><span class="compat-reason">${escape(u.reason)}</span></td>
    </tr>
  `;
}
function labelForStatus(s) {
  switch (s) {
    case "ok": return "Ok";
    case "blocked-by-consent": return "Blocked by consent";
    case "missing": return "Missing";
    case "no-mapping": return "No FHIR mapping";
    default: return s;
  }
}
function formatValue(v, unit) {
  if (typeof v === "number") return `${v} ${unit ?? ""}`.trim();
  return escape(String(v));
}

// Compat patient selector
document.addEventListener("change", (ev) => {
  const sel = ev.target.closest("#compat-patient");
  if (sel) {
    state.compat.patientId = sel.value;
    refreshCompat();
  }
  const wsel = ev.target.closest("#whoop-patient");
  if (wsel) loadWhoopSnapshot(wsel.value);
});

// ─── Whoop snapshot inspector ───────────────────────────────
async function loadWhoopSnapshot(patientId) {
  if (!patientId) return;
  state.whoopInspect.patientId = patientId;
  const el = $("#whoop-raw");
  el.innerHTML = `<span class="dim">Loading…</span>`;
  try {
    // Gateway doesn't proxy the Whoop snapshot directly, hit Whoop via the gateway's /sync side-effects —
    // actually easiest is to hit Whoop through the admin via a direct fetch since both services are same-origin dev.
    // But gateway serves this page, so cross-origin to :4001 would need CORS. Use the proxy /patients endpoint?
    // No, /patients only returns the list. Expose a dedicated proxy.
    const r = await fetch(`/whoop/snapshot/${encodeURIComponent(patientId)}`);
    if (!r.ok) throw new Error(`${r.status}`);
    const snap = await r.json();
    state.whoopInspect.snapshot = snap;
    el.innerHTML = renderJSON(snap);
  } catch (err) {
    el.innerHTML = `<span class="dim">Failed: ${escape(String(err))}</span>`;
  }
}

// ─── Run sync ───────────────────────────────────────────────
async function runSync(patientId) {
  if (state.busy) return;
  state.busy = true;
  setAllRunButtons(true);
  setPipelineStage("whoop", `Syncing ${patientId}…`);

  let r;
  try {
    r = await fetch(`/sync/${patientId}`, { method: "POST" });
  } catch (err) {
    setPipelineStage("error-whoop", `Network error: ${err.message}`);
    state.busy = false;
    setAllRunButtons(false);
    return;
  }

  let data;
  try {
    data = await r.json();
  } catch {
    data = null;
  }

  if (!r.ok) {
    const stage = data?.stage ?? "whoop";
    setPipelineStage(`error-${stage}`, `Failed at ${stage}`);
    paintTrace(data, { errorStage: stage });
    state.lastSyncByPatient[patientId] = { ts: new Date().toISOString(), level: "error" };
  } else {
    setPipelineStage("complete", "Complete");
    paintTrace(data);
    state.lastSyncByPatient[patientId] = { ts: new Date().toISOString(), level: "ok" };
  }

  renderPatientsTable();
  loadHospitalRecords();
  state.busy = false;
  setAllRunButtons(false);
}

function setAllRunButtons(disabled) {
  $$(".r-run").forEach((b) => (b.disabled = disabled));
  $("#syncAll").disabled = disabled;
}

$("#syncAll").addEventListener("click", async () => {
  for (const p of state.patients) {
    await runSync(p.id);
    await new Promise((res) => setTimeout(res, 400));
  }
});

// ─── Trace painting ─────────────────────────────────────────
function paintTrace(data, opts = {}) {
  if (!data) return;
  $("#trace-meta").textContent = data.runId
    ? `${data.runId} · ${data.translator ?? "—"}`
    : "n/a";

  const setStage = (stage, level, body) => {
    const badge = $(`.trace-badge[data-badge='${stage}']`);
    if (badge) {
      badge.textContent = level;
      badge.dataset.level = level;
    }
    const traceKey = stage === "translate" ? "bundle" : stage === "whoop" ? "snapshot" : "hospital";
    const pre = $(`.trace-body[data-trace='${traceKey}']`);
    if (pre) pre.innerHTML = body;
  };

  if (data.snapshot) setStage("whoop", "ok", renderJSON(data.snapshot));
  else if (opts.errorStage === "whoop") setStage("whoop", "err", `<span class="dim">${escape(data?.body ?? data?.error ?? "unknown")}</span>`);

  if (data.bundle) setStage("translate", data.aiError ? "warn" : "ok", renderJSON(data.bundle));
  else if (opts.errorStage === "translate") setStage("translate", "err", `<span class="dim">ai: ${escape(data?.ai ?? "n/a")}<br/>rule: ${escape(data?.rule ?? "n/a")}</span>`);

  if (data.hospital) {
    const alerts = data.hospital.alerts?.length ?? 0;
    setStage("hospital", alerts > 0 ? "warn" : "ok", renderJSON(data.hospital));
  } else if (opts.errorStage === "hospital") {
    setStage("hospital", "err", `<span class="dim">${escape(JSON.stringify(data?.body ?? data?.error ?? {}, null, 2))}</span>`);
  }
}

function renderJSON(obj) {
  const str = JSON.stringify(obj, null, 2);
  return escape(str)
    .replace(/"([^"]+)":/g, '<span class="k">"$1":</span>')
    .replace(/: "([^"]*)"/g, ': <span class="s">"$1"</span>')
    .replace(/: (-?\d+\.?\d*)/g, ': <span class="n">$1</span>')
    .replace(/: (true|false|null)/g, ': <span class="b">$1</span>');
}

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── Telemetry log + activity feed ──────────────────────────
function pushEvent(ev) {
  state.events.push(ev);
  if (state.events.length > EVENT_CAP) state.events.shift();
  if (ev.patientId && (ev.stage === "hospital" || ev.stage === "translate")) {
    state.lastSyncByPatient[ev.patientId] = { ts: ev.ts, level: ev.level };
  }
  updateKPIs();
  renderActivity();
  if (document.body.dataset.section === "telemetry") renderLog();
  if (document.body.dataset.section === "whoop") renderPatientsTable();
}

function renderActivity() {
  const el = $("#activity");
  if (!el) return;
  const rows = state.events.slice(-6).reverse();
  if (rows.length === 0) {
    el.innerHTML = `<div class="activity-empty">No activity yet.</div>`;
    return;
  }
  el.innerHTML = "";
  for (const ev of rows) {
    const row = document.createElement("div");
    row.className = "activity-row";
    row.innerHTML = `
      <span class="activity-ts">${new Date(ev.ts).toLocaleTimeString("en-GB", { hour12: false })}</span>
      <span class="activity-msg">${escape(ev.message ?? "")}</span>
      <span class="log-level" data-level="${ev.level ?? "info"}">${ev.level ?? "info"}</span>
    `;
    el.appendChild(row);
  }
}

function renderLog() {
  const el = $("#log");
  if (!el) return;
  const filtered = state.events
    .slice()
    .reverse()
    .filter((ev) => {
      if (state.filter.level !== "all" && ev.level !== state.filter.level) return false;
      if (state.filter.patient !== "all" && ev.patientId !== state.filter.patient) return false;
      return true;
    });
  if (filtered.length === 0) {
    el.innerHTML = `<div class="log-empty">No events match this filter.</div>`;
    return;
  }
  el.innerHTML = "";
  for (const ev of filtered) {
    const row = document.createElement("div");
    row.className = "log-row";
    row.innerHTML = `
      <span class="log-ts">${new Date(ev.ts).toLocaleTimeString("en-GB", { hour12: false })}</span>
      <span class="log-level" data-level="${ev.level ?? "info"}">${ev.level ?? "info"}</span>
      <span class="log-stage">${escape(ev.stage ?? "")}</span>
      <span class="log-pid">${escape(ev.patientId ?? "")}</span>
      <span class="log-msg">${escape(ev.message ?? "")}</span>
    `;
    el.appendChild(row);
  }
}

$("#filter-level").addEventListener("change", (e) => {
  state.filter.level = e.target.value;
  renderLog();
});
$("#filter-patient").addEventListener("change", (e) => {
  state.filter.patient = e.target.value;
  renderLog();
});
$("#clearLog").addEventListener("click", () => {
  state.events = [];
  updateKPIs();
  renderActivity();
  renderLog();
});

function reactToEventForPipeline(ev) {
  if (ev.level === "ok") {
    if (ev.stage === "whoop") setPipelineStage("translate", "Translating…");
    else if (ev.stage === "translate") setPipelineStage("hospital", "Posting bundle…");
  }
  if (ev.level === "error" && ev.stage) {
    setPipelineStage(`error-${ev.stage}`, `Error at ${ev.stage}`);
  }
}

// ─── SSE ────────────────────────────────────────────────────
function connectStream() {
  const es = new EventSource("/events/stream");
  es.addEventListener("hello", (msg) => {
    try {
      const data = JSON.parse(msg.data);
      (data.recent || []).forEach(pushEvent);
    } catch {}
  });
  es.addEventListener("telemetry", (msg) => {
    try {
      const ev = JSON.parse(msg.data);
      pushEvent(ev);
      reactToEventForPipeline(ev);
    } catch {}
  });
  es.onerror = () => {
    pipelineStatus && (pipelineStatus.textContent = "Stream reconnecting…");
  };
}

// ─── Boot ───────────────────────────────────────────────────
window.addEventListener("hashchange", () => go(location.hash.slice(1) || "overview"));
go(location.hash.slice(1) || "overview");
connectStream();
loadPatients();
loadHospitalRecords();
