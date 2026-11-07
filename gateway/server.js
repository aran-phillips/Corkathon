import express from "express";
import { consentFor } from "./consent.js";
import { translateRuleBased } from "./translate.js";
import { translateWithClaude } from "./translate-ai.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const port = process.env.PORT || 4002;
const WHOOP_URL = process.env.WHOOP_URL || "http://localhost:4001";
const HOSPITAL_URL = process.env.HOSPITAL_URL || "http://localhost:4003";

app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "gateway", whoop: WHOOP_URL, hospital: HOSPITAL_URL })
);

// POST /sync/:patientId
//   Pulls the latest snapshot from whoop, applies consent, translates,
//   posts to the hospital. Returns the full trace so the dashboard can
//   show what happened at each stage.
app.post("/sync/:patientId", async (req, res) => {
  const { patientId } = req.params;
  const consent = req.body?.consent || consentFor(patientId);

  // 1) Pull from Whoop
  let snapshot;
  try {
    const r = await fetch(`${WHOOP_URL}/patients/${patientId}/snapshot`);
    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ stage: "whoop", status: r.status, body: text });
    }
    snapshot = await r.json();
  } catch (err) {
    return res.status(502).json({ stage: "whoop", error: String(err) });
  }

  // 2) Translate: try AI, fall back to rules.
  const aiResult = await translateWithClaude(snapshot, consent);
  const ruleResult = translateRuleBased(snapshot, consent);
  const used = aiResult.bundle ? "ai" : "rule-based";
  const bundle = aiResult.bundle || ruleResult.bundle;

  if (!bundle) {
    return res.status(422).json({
      stage: "translate",
      ai: aiResult.error,
      rule: ruleResult.error,
      consent,
    });
  }

  // 3) POST to hospital
  let hospitalResp;
  try {
    const r = await fetch(`${HOSPITAL_URL}/fhir/Bundle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });
    hospitalResp = { status: r.status, body: await r.json() };
  } catch (err) {
    return res.status(502).json({ stage: "hospital", error: String(err) });
  }

  res.status(hospitalResp.status).json({
    stage: "complete",
    translator: used,
    consent,
    snapshot,
    bundle,
    hospital: hospitalResp.body,
  });
});

app.listen(port, () => {
  console.log(`[gateway] translator listening on http://localhost:${port}`);
});
