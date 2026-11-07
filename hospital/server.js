import express from "express";
import { validateBundle } from "./validate.js";
import { alertsFor } from "./alerts.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const port = process.env.PORT || 4003;

// In-memory store. Fine for a hackathon demo.
const records = []; // { id, receivedAt, patientRef, observations: [...], alerts: [...] }
let nextId = 1;

app.get("/health", (_req, res) => res.json({ ok: true, service: "hospital" }));

app.post("/fhir/Bundle", (req, res) => {
  const { ok, errors, accepted } = validateBundle(req.body);
  if (!ok) {
    return res.status(422).json({ ok: false, errors });
  }

  const patientRef = accepted[0]?.subject ?? "Patient/unknown";
  const observations = accepted.map((o) => ({ ...o, alerts: alertsFor(o) }));
  const allAlerts = observations.flatMap((o) => o.alerts.map((a) => ({ ...a, code: o.code })));

  const id = `rec-${nextId++}`;
  const record = {
    id,
    receivedAt: new Date().toISOString(),
    patientRef,
    observations,
    alerts: allAlerts,
  };
  records.push(record);

  res.status(201).json({
    ok: true,
    id,
    accepted: observations.length,
    alerts: allAlerts,
  });
});

app.get("/records", (_req, res) => {
  res.json(records);
});

app.get("/records/:id", (req, res) => {
  const r = records.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  res.json(r);
});

app.get("/patients/:ref/records", (req, res) => {
  // ref expected like "Patient/pt-001" but accept bare id too.
  const wanted = req.params.ref.includes("/") ? req.params.ref : `Patient/${req.params.ref}`;
  res.json(records.filter((r) => r.patientRef === wanted));
});

app.listen(port, () => {
  console.log(`[hospital] FHIR receiver listening on http://localhost:${port}`);
});
