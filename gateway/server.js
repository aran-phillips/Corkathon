import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";
import { consentFor } from "./consent.js";
import { translateRuleBased, LOINC_MAPPING, UNMAPPED_WHOOP_FIELDS } from "./translate.js";
import { translateWithClaude } from "./translate-ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));
// Gateway operator dashboard — served from gateway/public so the folder
// is self-contained in the repo.
app.use(express.static(path.join(__dirname, "public")));

const port = process.env.PORT || 4002;
const WHOOP_URL = process.env.WHOOP_URL || "http://localhost:4001";
const HOSPITAL_URL = process.env.HOSPITAL_URL || "http://localhost:4003";

// In-memory ring buffer + event bus so the dashboard can show live telemetry.
const EVENT_CAP = 500;
const events = [];
const bus = new EventEmitter();
function logEvent(ev) {
  const entry = { ts: new Date().toISOString(), ...ev };
  events.push(entry);
  if (events.length > EVENT_CAP) events.shift();
  bus.emit("event", entry);
  return entry;
}

app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "gateway", whoop: WHOOP_URL, hospital: HOSPITAL_URL })
);

// Dashboard support endpoints.
app.get("/health/all", async (_req, res) => {
  const probe = async (name, url) => {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      return { name, url, ok: r.ok };
    } catch {
      return { name, url, ok: false };
    }
  };
  const [whoop, hospital] = await Promise.all([
    probe("whoop", WHOOP_URL),
    probe("hospital", HOSPITAL_URL),
  ]);
  res.json({
    whoop,
    hospital,
    gateway: { name: "gateway", url: `http://localhost:${port}`, ok: true },
    ai: { ok: Boolean(process.env.ANTHROPIC_API_KEY) },
  });
});

app.get("/patients", async (_req, res) => {
  try {
    const r = await fetch(`${WHOOP_URL}/patients`);
    if (!r.ok) return res.status(502).json({ error: `whoop ${r.status}` });
    const patients = await r.json();
    res.json(patients.map((p) => ({ ...p, consent: consentFor(p.id) })));
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.get("/consent/:patientId", (req, res) => {
  res.json(consentFor(req.params.patientId));
});

// Proxy the Whoop snapshot so the dashboard (served by the gateway) can
// inspect raw data without needing CORS from port 4001.
app.get("/whoop/snapshot/:patientId", async (req, res) => {
  try {
    const r = await fetch(`${WHOOP_URL}/patients/${req.params.patientId}/snapshot`);
    const body = await r.json();
    res.status(r.status).json(body);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.get("/hospital/records", async (_req, res) => {
  try {
    const r = await fetch(`${HOSPITAL_URL}/records`);
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// Expose the static LOINC + unmapped tables so the dashboard can render the
// "Mapping" view without duplicating the schema.
app.get("/mapping", (_req, res) => {
  res.json({ loinc: LOINC_MAPPING, unmapped: UNMAPPED_WHOOP_FIELDS });
});

// Compatibility — for one patient, work out which Whoop fields flow through
// to the hospital vs get blocked, and WHY. This is the "tell me how we're
// blocked" surface the dashboard uses.
function getByPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

app.get("/compatibility/:patientId", async (req, res) => {
  const { patientId } = req.params;
  let snapshot;
  try {
    const r = await fetch(`${WHOOP_URL}/patients/${patientId}/snapshot`);
    if (!r.ok) return res.status(502).json({ error: `whoop ${r.status}` });
    snapshot = await r.json();
  } catch (err) {
    return res.status(502).json({ error: String(err) });
  }

  const consent = consentFor(patientId);
  const allow = new Set(consent.allow || []);

  const fields = Object.entries(LOINC_MAPPING).map(([field, m]) => {
    const value = getByPath(snapshot, m.source);
    const present = value !== undefined && value !== null;
    const consented = allow.has(field);
    let status, reason;
    if (!present) {
      status = "missing";
      reason = `Whoop snapshot did not include ${m.source}.`;
    } else if (!consented) {
      status = "blocked-by-consent";
      reason = `Patient has not consented to share "${field}". Add it to consent.allow to flow through.`;
    } else {
      status = "ok";
      reason = `Flows through consent + translator + hospital.`;
    }
    return {
      field,
      source: m.source,
      loinc: m.code,
      display: m.display,
      unit: m.unit,
      value: present ? value : null,
      present,
      consented,
      mappable: true,
      status,
      reason,
    };
  });

  const unmapped = UNMAPPED_WHOOP_FIELDS.map((f) => {
    const value = getByPath(snapshot, f.source);
    const present = value !== undefined && value !== null;
    return {
      source: f.source,
      value: present ? value : null,
      present,
      mappable: false,
      status: "no-mapping",
      reason: f.reason,
    };
  }).filter((f) => f.present);

  const blockers = [
    ...fields.filter((f) => f.status !== "ok"),
    ...unmapped,
  ];

  res.json({
    patient: snapshot.patient,
    takenAt: snapshot.takenAt,
    consent,
    fields,
    unmapped,
    summary: {
      total: fields.length + unmapped.length,
      flowing: fields.filter((f) => f.status === "ok").length,
      blockedByConsent: fields.filter((f) => f.status === "blocked-by-consent").length,
      missing: fields.filter((f) => f.status === "missing").length,
      noMapping: unmapped.length,
      hasBlockers: blockers.length > 0,
    },
  });
});

app.get("/events", (_req, res) => {
  res.json(events.slice().reverse());
});

// Server-Sent Events — the dashboard subscribes and gets live stage updates.
app.get("/events/stream", (req, res) => {
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();
  res.write(`event: hello\ndata: ${JSON.stringify({ recent: events.slice(-50) })}\n\n`);

  const handler = (ev) => res.write(`event: telemetry\ndata: ${JSON.stringify(ev)}\n\n`);
  bus.on("event", handler);
  const heartbeat = setInterval(() => res.write(`event: heartbeat\ndata: {}\n\n`), 15000);

  req.on("close", () => {
    bus.off("event", handler);
    clearInterval(heartbeat);
  });
});

// POST /sync/:patientId
//   Pulls the latest snapshot from whoop, applies consent, translates,
//   posts to the hospital. Emits telemetry events at each stage so the
//   dashboard can animate the pipeline live.
app.post("/sync/:patientId", async (req, res) => {
  const { patientId } = req.params;
  const consent = req.body?.consent || consentFor(patientId);
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  logEvent({ runId, patientId, stage: "start", level: "info", message: `sync kicked off for ${patientId}` });

  // 1) Pull from Whoop
  let snapshot;
  try {
    const r = await fetch(`${WHOOP_URL}/patients/${patientId}/snapshot`);
    if (!r.ok) {
      const text = await r.text();
      logEvent({ runId, patientId, stage: "whoop", level: "error", message: `whoop ${r.status}: ${text}` });
      return res.status(502).json({ runId, stage: "whoop", status: r.status, body: text });
    }
    snapshot = await r.json();
    logEvent({
      runId,
      patientId,
      stage: "whoop",
      level: "ok",
      message: `snapshot ${snapshot.takenAt}`,
    });
  } catch (err) {
    logEvent({ runId, patientId, stage: "whoop", level: "error", message: String(err) });
    return res.status(502).json({ runId, stage: "whoop", error: String(err) });
  }

  // 2) Translate: try AI, fall back to rules.
  const [aiResult, ruleResult] = await Promise.all([
    translateWithClaude(snapshot, consent),
    Promise.resolve(translateRuleBased(snapshot, consent)),
  ]);
  const used = aiResult.bundle ? "ai" : "rule-based";
  const bundle = aiResult.bundle || ruleResult.bundle;

  if (!bundle) {
    logEvent({
      runId,
      patientId,
      stage: "translate",
      level: "error",
      message: `translation failed — ai: ${aiResult.error ?? "n/a"}; rule: ${ruleResult.error ?? "n/a"}`,
    });
    return res.status(422).json({ runId, stage: "translate", ai: aiResult.error, rule: ruleResult.error, consent });
  }
  if (aiResult.error) {
    logEvent({
      runId,
      patientId,
      stage: "translate",
      level: "warn",
      message: `ai path unavailable (${aiResult.error}); using rule-based`,
    });
  }
  logEvent({
    runId,
    patientId,
    stage: "translate",
    level: "ok",
    message: `${used} translator → ${bundle.entry.length} observations`,
  });

  // 3) POST to hospital
  let hospitalResp;
  try {
    const r = await fetch(`${HOSPITAL_URL}/fhir/Bundle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });
    hospitalResp = { status: r.status, body: await r.json() };
    const alertCount = hospitalResp.body?.alerts?.length ?? 0;
    if (r.ok) {
      logEvent({
        runId,
        patientId,
        stage: "hospital",
        level: alertCount > 0 ? "warn" : "ok",
        message: `hospital ${r.status} → ${hospitalResp.body.id}${alertCount ? ` · ${alertCount} alert${alertCount === 1 ? "" : "s"}` : ""}`,
      });
    } else {
      logEvent({
        runId,
        patientId,
        stage: "hospital",
        level: "error",
        message: `hospital ${r.status} rejected bundle: ${JSON.stringify(hospitalResp.body?.errors ?? hospitalResp.body)}`,
      });
    }
  } catch (err) {
    logEvent({ runId, patientId, stage: "hospital", level: "error", message: String(err) });
    return res.status(502).json({ runId, stage: "hospital", error: String(err) });
  }

  res.status(hospitalResp.status).json({
    runId,
    stage: "complete",
    translator: used,
    aiError: aiResult.error ?? null,
    consent,
    snapshot,
    bundle,
    hospital: hospitalResp.body,
  });
});

app.listen(port, () => {
  console.log(`[gateway] translator API listening on http://localhost:${port}`);
  console.log(`[gateway] operator dashboard at http://localhost:${port}/`);
});
