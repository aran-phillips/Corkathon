// Corkathon admin — backend-for-frontend.
// Serves the dashboard and proxies to gateway (pipeline control + telemetry)
// and hospital (records). The frontend only ever talks to this origin.

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
// Parse JSON bodies — accept FHIR's `application/fhir+json` too, not just
// `application/json`. Without this, FHIR POSTs arrive as undefined and the
// hospital rejects them as empty.
app.use(
  express.json({
    limit: "1mb",
    type: ["application/json", "application/*+json"],
  })
);
app.use(express.static(path.join(__dirname, "public")));
// Serve the teammate's standalone demos from the repo's /demo directory.
app.use("/demo", express.static(path.join(__dirname, "..", "demo")));

const port = process.env.PORT || 4000;
const WHOOP_URL = process.env.WHOOP_URL || "http://localhost:4001";
const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:4002";
const HOSPITAL_URL = process.env.HOSPITAL_URL || "http://localhost:4003";

// Admin's own event buffer + bus. Direct FHIR POSTs (from the wearable
// demo via /fhir/Bundle) don't flow through the gateway, so the admin
// logs them here. The /events and /events/stream endpoints merge these
// with the gateway's telemetry so the dashboard sees both sources.
const EVENT_CAP = 200;
const localEvents = [];
const localBus = new EventEmitter();
function logLocalEvent(ev) {
  const entry = { ts: new Date().toISOString(), source: "admin", ...ev };
  localEvents.push(entry);
  if (localEvents.length > EVENT_CAP) localEvents.shift();
  localBus.emit("event", entry);
  return entry;
}

app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "admin", gateway: GATEWAY_URL, hospital: HOSPITAL_URL, whoop: WHOOP_URL })
);

// Aggregate health across all services the admin knows about.
app.get("/health/all", async (_req, res) => {
  const probe = async (name, url) => {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      return { name, url, ok: r.ok };
    } catch {
      return { name, url, ok: false };
    }
  };
  const [whoop, gateway, hospital, gwHealthAll] = await Promise.all([
    probe("whoop", WHOOP_URL),
    probe("gateway", GATEWAY_URL),
    probe("hospital", HOSPITAL_URL),
    fetch(`${GATEWAY_URL}/health/all`, { signal: AbortSignal.timeout(2000) })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  res.json({
    admin: { name: "admin", url: `http://localhost:${port}`, ok: true },
    whoop,
    gateway,
    hospital,
    ai: gwHealthAll?.ai ?? { ok: false },
  });
});

// Passthrough helper for simple JSON GETs.
async function passthroughGet(upstreamUrl, res) {
  try {
    const r = await fetch(upstreamUrl);
    const body = await r.text();
    res
      .status(r.status)
      .type(r.headers.get("content-type") ?? "application/json")
      .send(body);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
}

// ── Gateway surface (pipeline + translator) ──
app.get("/patients", (_req, res) => passthroughGet(`${GATEWAY_URL}/patients`, res));
app.get("/mapping", (_req, res) => passthroughGet(`${GATEWAY_URL}/mapping`, res));
app.get("/compatibility/:id", (req, res) =>
  passthroughGet(`${GATEWAY_URL}/compatibility/${encodeURIComponent(req.params.id)}`, res)
);
app.get("/consent/:id", (req, res) =>
  passthroughGet(`${GATEWAY_URL}/consent/${encodeURIComponent(req.params.id)}`, res)
);
// Events = gateway events + admin's own local events, newest first.
app.get("/events", async (_req, res) => {
  try {
    const r = await fetch(`${GATEWAY_URL}/events`);
    const gatewayEvents = r.ok ? await r.json() : [];
    const merged = [...gatewayEvents, ...localEvents.slice().reverse()].sort(
      (a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)
    );
    res.json(merged);
  } catch {
    res.json(localEvents.slice().reverse());
  }
});
app.get("/whoop/snapshot/:id", (req, res) =>
  passthroughGet(`${GATEWAY_URL}/whoop/snapshot/${encodeURIComponent(req.params.id)}`, res)
);

app.post("/sync/:id", async (req, res) => {
  try {
    const r = await fetch(`${GATEWAY_URL}/sync/${encodeURIComponent(req.params.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    });
    const body = await r.text();
    res
      .status(r.status)
      .type(r.headers.get("content-type") ?? "application/json")
      .send(body);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ── Hospital surface (direct, not via gateway) ──
app.get("/hospital/records", (_req, res) => passthroughGet(`${HOSPITAL_URL}/records`, res));
app.get("/hospital/records/:id", (req, res) =>
  passthroughGet(`${HOSPITAL_URL}/records/${encodeURIComponent(req.params.id)}`, res)
);
app.get("/hospital/patients/:ref/records", (req, res) =>
  passthroughGet(`${HOSPITAL_URL}/patients/${encodeURIComponent(req.params.ref)}/records`, res)
);

// ── FHIR surface (direct POST + GET to hospital) ──
// This is what the wearable-app demo talks to. POSTing a transaction
// Bundle to the FHIR base (`/fhir`) is the standard pattern; we also
// accept `/fhir/Bundle` for clients that use the explicit form. Both
// forward to the hospital's /fhir/Bundle. Admin emits telemetry events
// so the dashboard reflects the inbound traffic even though it bypassed
// the gateway's /sync path.
async function handleFhirPost(req, res) {
  const bundle = req.body ?? {};
  const patientRef =
    bundle?.entry?.find?.((e) => e?.resource?.subject?.reference)?.resource?.subject?.reference ??
    bundle?.entry?.find?.((e) => e?.resource?.resourceType === "Patient")?.resource?.id ??
    "unknown";
  const patientId = String(patientRef).replace(/^Patient\//, "");
  const runId = `inbound-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  logLocalEvent({
    runId,
    patientId,
    stage: "fhir-inbound",
    level: "info",
    message: `FHIR Bundle received from wearable app`,
  });

  try {
    const r = await fetch(`${HOSPITAL_URL}/fhir/Bundle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });
    const body = await r.json();
    const alerts = body?.alerts?.length ?? 0;
    logLocalEvent({
      runId,
      patientId,
      stage: "hospital",
      level: r.ok ? (alerts > 0 ? "warn" : "ok") : "error",
      message: r.ok
        ? `hospital ${r.status} → ${body?.id ?? ""}${alerts ? ` · ${alerts} alert${alerts === 1 ? "" : "s"}` : ""}`
        : `hospital ${r.status} rejected bundle`,
    });
    res.status(r.status).json(body);
  } catch (err) {
    logLocalEvent({
      runId,
      patientId,
      stage: "hospital",
      level: "error",
      message: String(err),
    });
    res.status(502).json({ error: String(err) });
  }
}

app.post("/fhir/Bundle", handleFhirPost);
app.post("/fhir", handleFhirPost);

// Minimal FHIR GET surface for the hospital-integration demo. Right now we
// surface what the hospital store natively supports (records) via a tiny
// shim that mimics a FHIR searchset Bundle of Observations.
app.get("/fhir/Observation", async (req, res) => {
  try {
    const r = await fetch(`${HOSPITAL_URL}/records`);
    if (!r.ok) return res.status(502).json({ error: `hospital ${r.status}` });
    const records = await r.json();
    const entries = [];
    for (const rec of records) {
      for (const obs of rec.observations ?? []) {
        entries.push({
          fullUrl: `urn:hospital:${rec.id}:${obs.code}`,
          resource: {
            resourceType: "Observation",
            id: `${rec.id}-${obs.code}`,
            status: "final",
            code: { coding: [{ system: "http://loinc.org", code: obs.code }] },
            subject: { reference: rec.patientRef },
            effectiveDateTime: obs.effectiveDateTime,
            valueQuantity: {
              value: obs.value,
              unit: obs.unit,
              system: "http://unitsofmeasure.org",
              code: obs.unit,
            },
            meta: { tag: [{ system: "https://corkathon/alerts", code: (obs.alerts ?? []).map((a) => a.label).join(",") || "none" }] },
          },
          search: { mode: "match" },
        });
      }
    }
    res.json({
      resourceType: "Bundle",
      type: "searchset",
      total: entries.length,
      entry: entries,
    });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ── SSE: merged stream ──
// Fans in two sources: (1) the gateway's telemetry stream (piped through
// byte-for-byte to preserve framing), and (2) admin's own local events
// (direct FHIR POSTs that bypass the gateway). The browser EventSource
// sees a single feed.
app.get("/events/stream", (req, res) => {
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  // Hello: send recent local events alongside the gateway's hello dump.
  res.write(
    `event: hello\ndata: ${JSON.stringify({
      recent_local: localEvents.slice(-50),
    })}\n\n`
  );

  const localHandler = (ev) => res.write(`event: telemetry\ndata: ${JSON.stringify(ev)}\n\n`);
  localBus.on("event", localHandler);

  const controller = new AbortController();
  (async () => {
    try {
      const upstream = await fetch(`${GATEWAY_URL}/events/stream`, {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      });
      if (!upstream.body) return;
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      /* upstream drop or abort */
    }
  })();

  req.on("close", () => {
    localBus.off("event", localHandler);
    controller.abort();
    try {
      res.end();
    } catch {}
  });
});

app.listen(port, () => {
  console.log(`[admin] listening on http://localhost:${port}`);
  console.log(`[admin] dashboard at http://localhost:${port}/`);
});
