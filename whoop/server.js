import express from "express";
import { scenarios, latestFor, historyFor } from "./scenarios.js";

const app = express();
const port = process.env.PORT || 4001;

app.get("/health", (_req, res) => res.json({ ok: true, service: "whoop" }));

app.get("/patients", (_req, res) => {
  res.json(
    Object.values(scenarios).map((s) => ({
      ...s.patient,
      label: s.label,
    }))
  );
});

app.get("/patients/:id/snapshot", (req, res) => {
  const snap = latestFor(req.params.id);
  if (!snap) return res.status(404).json({ error: "unknown patient" });
  res.json(snap);
});

app.get("/patients/:id/history", (req, res) => {
  const hist = historyFor(req.params.id);
  if (!hist) return res.status(404).json({ error: "unknown patient" });
  res.json(hist);
});

// Convenience endpoints matching the "stages of the pipeline" naming.
app.get("/patients/:id/recovery", (req, res) => {
  const snap = latestFor(req.params.id);
  if (!snap) return res.status(404).json({ error: "unknown patient" });
  res.json({ patient: snap.patient, takenAt: snap.takenAt, recovery: snap.recovery });
});

app.get("/patients/:id/sleep", (req, res) => {
  const snap = latestFor(req.params.id);
  if (!snap) return res.status(404).json({ error: "unknown patient" });
  res.json({ patient: snap.patient, takenAt: snap.takenAt, sleep: snap.sleep });
});

app.get("/patients/:id/cycle", (req, res) => {
  const snap = latestFor(req.params.id);
  if (!snap) return res.status(404).json({ error: "unknown patient" });
  res.json({ patient: snap.patient, takenAt: snap.takenAt, cycle: snap.cycle });
});

app.listen(port, () => {
  console.log(`[whoop] mock API listening on http://localhost:${port}`);
});
