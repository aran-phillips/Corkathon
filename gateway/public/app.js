// Corkathon admin dashboard client.
// Drives the pipeline SVG + telemetry log from gateway SSE events.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  patients: [],
  currentRunId: null,
  busy: false,
};

// ── Pipeline control ────────────────────────────────────────
const svg = $("#pipeline-svg");
const pipelineStatus = $("#pipeline-status");

// Packet positions: whoop(80) → gateway(500) → hospital(920).
const PACKET_X = { idle: 80, whoop: 290, translate: 500, hospital: 710, complete: 920 };

function setPipelineStage(stage, statusText) {
  svg.dataset.stage = stage;
  pipelineStatus.textContent = statusText ?? stage;

  if (stage === "idle") {
    pipelineStatus.dataset.state = "";
  } else if (stage === "complete") {
    pipelineStatus.dataset.state = "ok";
  } else if (stage.startsWith("error")) {
    pipelineStatus.dataset.state = "err";
  } else {
    pipelineStatus.dataset.state = "running";
  }

  const xBase = stage.startsWith("error")
    ? PACKET_X[stage.replace("error-", "")] ?? PACKET_X.idle
    : PACKET_X[stage] ?? PACKET_X.idle;

  $$(".packet-group", svg).forEach((g, i) => {
    const offset = i * 12;
    g.setAttribute("transform", `translate(${xBase - 80 - offset},0)`);
  });
}

setPipelineStage("idle", "Idle");

// ── Clock ───────────────────────────────────────────────────
const clock = $("#clock");
function tickClock() {
  const d = new Date();
  clock.textContent = d.toLocaleTimeString("en-GB", { hour12: false });
}
setInterval(tickClock, 1000);
tickClock();

// ── Health polling ──────────────────────────────────────────
async function pollHealth() {
  try {
    const r = await fetch("/health/all");
    if (!r.ok) return;
    const h = await r.json();
    setHealth("whoop", h.whoop.ok);
    setHealth("gateway", h.gateway.ok);
    setHealth("hospital", h.hospital.ok);
    $("[data-metric='gateway-ai']").textContent = h.ai.ok ? "claude opus 4.7" : "rule-based only";
  } catch {
    setHealth("whoop", false);
    setHealth("hospital", false);
  }
}
function setHealth(node, ok) {
  const dot = $(`.dot[data-health='${node}']`);
  const station = $(`.station[data-node='${node}']`);
  if (dot) dot.dataset.ok = String(ok);
  if (station) station.dataset.status = ok ? "ok" : "err";
}
pollHealth();
setInterval(pollHealth, 5000);

// ── Load patients + records count ───────────────────────────
async function loadPatients() {
  try {
    const r = await fetch("/patients");
    if (!r.ok) throw new Error("patients fetch failed");
    state.patients = await r.json();
    renderRoster();
    $("[data-metric='whoop-patients']").textContent = state.patients.length;
  } catch (err) {
    const list = $("#patients");
    list.innerHTML = `<li class="roster-empty">whoop unreachable: ${err}</li>`;
  }
}
async function loadHospitalCount() {
  try {
    const r = await fetch("/hospital/records");
    if (!r.ok) return;
    const records = await r.json();
    $("[data-metric='hospital-records']").textContent = records.length;
  } catch {
    $("[data-metric='hospital-records']").textContent = "—";
  }
}

function renderRoster() {
  const list = $("#patients");
  list.innerHTML = "";
  for (const p of state.patients) {
    const li = document.createElement("li");
    li.className = "roster-item";
    li.innerHTML = `
      <div class="roster-row">
        <span class="r-left">
          <span class="r-id">${p.id}</span>
          <span class="r-name">${p.displayName ?? ""}</span>
        </span>
        <span class="r-tag" data-tag="${p.label}">${p.label}</span>
      </div>
      <div class="r-consent">
        ${(p.consent?.allow ?? []).map((f) => `<span>${f}</span>`).join("")}
      </div>
      <div class="roster-row">
        <span></span>
        <button class="r-run" data-sync="${p.id}">Sync</button>
      </div>
    `;
    list.appendChild(li);
  }
  $$(".r-run").forEach((btn) =>
    btn.addEventListener("click", () => runSync(btn.dataset.sync))
  );
}

// ── Run sync ────────────────────────────────────────────────
async function runSync(patientId) {
  if (state.busy) return;
  state.busy = true;
  setAllRunButtons(true);
  setPipelineStage("whoop", `Syncing ${patientId}…`);

  let r;
  try {
    r = await fetch(`/sync/${patientId}`, { method: "POST" });
  } catch (err) {
    setPipelineStage("error-whoop", `network error: ${err.message}`);
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
  } else {
    setPipelineStage("complete", "Complete");
    paintTrace(data);
  }

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

// ── Trace painting ──────────────────────────────────────────
function paintTrace(data, opts = {}) {
  if (!data) return;
  const traceMeta = $("#trace-meta");
  traceMeta.textContent = data.runId
    ? `${data.runId} · ${data.translator ?? "—"}`
    : "n/a";

  const setStage = (stage, level, body) => {
    const badge = $(`.trace-badge[data-badge='${stage}']`);
    if (badge) {
      badge.textContent = level;
      badge.dataset.level = level;
    }
    const pre = $(`.trace-body[data-trace='${stage === "translate" ? "bundle" : stage === "whoop" ? "snapshot" : "hospital"}']`);
    if (pre) pre.innerHTML = body;
  };

  // Snapshot
  if (data.snapshot) {
    setStage("whoop", "ok", renderJSON(data.snapshot));
  } else if (opts.errorStage === "whoop") {
    setStage("whoop", "err", `<span class="dim">${escape(data?.body ?? data?.error ?? "unknown")}</span>`);
  }

  // Bundle
  if (data.bundle) {
    const level = data.aiError ? "warn" : "ok";
    setStage("translate", level, renderJSON(data.bundle));
  } else if (opts.errorStage === "translate") {
    setStage(
      "translate",
      "err",
      `<span class="dim">ai: ${escape(data?.ai ?? "n/a")}<br/>rule: ${escape(data?.rule ?? "n/a")}</span>`
    );
  }

  // Hospital
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
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Telemetry stream (SSE) ──────────────────────────────────
const log = $("#log");
let logEmptyShown = true;

function appendLogRow(ev) {
  if (logEmptyShown) {
    log.innerHTML = "";
    logEmptyShown = false;
  }
  const row = document.createElement("div");
  row.className = "log-row";
  row.innerHTML = `
    <span class="log-ts">${new Date(ev.ts).toLocaleTimeString("en-GB", { hour12: false })}</span>
    <span class="log-level" data-level="${ev.level ?? "info"}">${ev.level ?? "info"}</span>
    <span class="log-stage">${ev.stage ?? ""}</span>
    <span class="log-pid">${ev.patientId ?? ""}</span>
    <span class="log-msg">${escape(ev.message ?? "")}</span>
  `;
  // flex-direction: column-reverse → insert at top of DOM to appear at bottom visually,
  // or we can just prepend as the newest log so most-recent is visible.
  log.insertBefore(row, log.firstChild);

  // Drive pipeline stage from events too (lets other clients see the animation).
  if (ev.runId && ev.level === "ok") {
    if (ev.stage === "whoop") setPipelineStage("translate", "Translating…");
    else if (ev.stage === "translate") setPipelineStage("hospital", "Posting bundle…");
  }
  if (ev.level === "error" && ev.stage) {
    setPipelineStage(`error-${ev.stage}`, `Error at ${ev.stage}`);
  }

  // Keep log bounded in DOM.
  while (log.children.length > 200) log.removeChild(log.lastChild);
}

function connectStream() {
  const es = new EventSource("/events/stream");
  es.addEventListener("hello", (msg) => {
    try {
      const data = JSON.parse(msg.data);
      (data.recent || []).forEach(appendLogRow);
    } catch {}
  });
  es.addEventListener("telemetry", (msg) => {
    try {
      appendLogRow(JSON.parse(msg.data));
    } catch {}
  });
  es.onerror = () => {
    // EventSource auto-reconnects. Note it transiently.
    pipelineStatus.textContent = "Stream reconnecting…";
  };
}

connectStream();
loadPatients();
loadHospitalCount();
