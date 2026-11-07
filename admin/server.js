// Corkathon admin — backend-for-frontend.
// Serves the dashboard and proxies to gateway (pipeline control + telemetry)
// and hospital (records). The frontend only ever talks to this origin.

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const port = process.env.PORT || 4000;
const WHOOP_URL = process.env.WHOOP_URL || "http://localhost:4001";
const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:4002";
const HOSPITAL_URL = process.env.HOSPITAL_URL || "http://localhost:4003";

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
app.get("/events", (_req, res) => passthroughGet(`${GATEWAY_URL}/events`, res));
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

// ── SSE passthrough ──
// Pipes gateway's telemetry stream through to the client. Preserves SSE
// framing bytes, so the browser EventSource sees the same events as if it
// had connected to the gateway directly.
app.get("/events/stream", (req, res) => {
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  const controller = new AbortController();
  (async () => {
    try {
      const upstream = await fetch(`${GATEWAY_URL}/events/stream`, {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      });
      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      /* upstream drop or abort */
    }
    try {
      res.end();
    } catch {}
  })();

  req.on("close", () => controller.abort());
});

app.listen(port, () => {
  console.log(`[admin] listening on http://localhost:${port}`);
  console.log(`[admin] dashboard at http://localhost:${port}/`);
});
