// Corkathon admin console client.
// Drives sidebar nav, KPI tiles, pipeline SVG, patient table, and the
// SSE-powered telemetry log.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  patients: [],
  events: [], // newest-last; capped
  recordsCount: 0,
  busy: false,
  lastSyncByPatient: {}, // patientId -> { ts, level }
  filter: { level: "all", patient: "all" },
};

const EVENT_CAP = 500;

// ─── Section routing ────────────────────────────────────────
function go(section) {
  if (!["overview", "pipeline", "patients", "telemetry"].includes(section)) section = "overview";
  document.body.dataset.section = section;
  const titles = {
    overview: ["Overview", "Live status for the Whoop → Hospital pipeline."],
    pipeline: ["Pipeline", "Three services, one transaction. Claude Opus 4.7 maps Whoop snapshots to FHIR."],
    patients: ["Patients", "Enrolled in the Whoop mock, with per-patient consent."],
    telemetry: ["Telemetry", "Every event the gateway emits, streamed over SSE."],
  };
  const [t, s] = titles[section];
  $("#section-title").textContent = t;
  $("#section-sub").textContent = s;
  // Apply level/patient filters when entering telemetry so it reflects current state.
  if (section === "telemetry") renderLog();
  if (section === "patients") renderPatientsTable();
}

// Delegate nav clicks (sidebar + any .panel-link[data-nav])
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
  if (pipelineStatus) pipelineStatus.textContent = statusText ?? stage;

  if (pipelineStatus) {
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
  const d = new Date();
  clock.textContent = d.toLocaleTimeString("en-GB", { hour12: false });
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
    const aiLabel = h.ai.ok ? "claude opus 4.7" : "rule-based only";
    $("#ai-status").textContent = aiLabel;
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

// ─── Patients + hospital records ────────────────────────────
async function loadPatients() {
  try {
    const r = await fetch("/patients");
    if (!r.ok) throw new Error("patients fetch failed");
    state.patients = await r.json();
    renderPatientsTable();
    populateFilterOptions();
    updateKPIs();
  } catch (err) {
    const tbody = $("#patients-tbody");
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="t-empty">Whoop unreachable: ${escape(String(err))}</td></tr>`;
  }
}
async function loadHospitalCount() {
  try {
    const r = await fetch("/hospital/records");
    if (!r.ok) return;
    const records = await r.json();
    state.recordsCount = records.length;
    updateKPIs();
  } catch {
    state.recordsCount = 0;
    updateKPIs();
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

function populateFilterOptions() {
  const sel = $("#filter-patient");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="all">All</option>`;
  for (const p of state.patients) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.id} · ${p.displayName}`;
    sel.appendChild(opt);
  }
  sel.value = current && $$(`option[value='${current}']`, sel).length ? current : "all";
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
  loadHospitalCount();
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

  if (data.snapshot) {
    setStage("whoop", "ok", renderJSON(data.snapshot));
  } else if (opts.errorStage === "whoop") {
    setStage("whoop", "err", `<span class="dim">${escape(data?.body ?? data?.error ?? "unknown")}</span>`);
  }

  if (data.bundle) {
    setStage("translate", data.aiError ? "warn" : "ok", renderJSON(data.bundle));
  } else if (opts.errorStage === "translate") {
    setStage(
      "translate",
      "err",
      `<span class="dim">ai: ${escape(data?.ai ?? "n/a")}<br/>rule: ${escape(data?.rule ?? "n/a")}</span>`
    );
  }

  if (data.hospital) {
    const alerts = data.hospital.alerts?.length ?? 0;
    setStage("hospital", alerts > 0 ? "warn" : "ok", renderJSON(data.hospital));
  } else if (opts.errorStage === "hospital") {
    setStage(
      "hospital",
      "err",
      `<span class="dim">${escape(JSON.stringify(data?.body ?? data?.error ?? {}, null, 2))}</span>`
    );
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
  if (document.body.dataset.section === "patients") renderPatientsTable();
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

// Pipeline stage driven by events (live reflection in Overview view).
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
go("overview");
connectStream();
loadPatients();
loadHospitalCount();
