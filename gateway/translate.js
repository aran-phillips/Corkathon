// Rule-based Whoop -> FHIR translator. The AI prompt in translate-ai.js
// should return the same shape; this fallback is what runs if the AI
// is unavailable or produces an invalid bundle.

// Field -> LOINC mapping. Keep in sync with contracts/README.md.
// `source` is the dot-path into a Whoop snapshot; consumers use this to
// show the mapping in the dashboard's compatibility matrix.
export const LOINC_MAPPING = {
  restingHeartRate: { source: "recovery.restingHeartRate", code: "40443-4", display: "Resting heart rate",            unit: "/min" },
  hrvMs:            { source: "recovery.hrvMs",            code: "80404-7", display: "Heart rate variability SDNN",   unit: "ms"   },
  spo2:             { source: "recovery.spo2",             code: "59408-5", display: "Oxygen saturation",             unit: "%"    },
  sleepDurationMs:  { source: "sleep.durationMs",          code: "93832-4", display: "Sleep duration",                unit: "h"    },
  sleepEfficiency:  { source: "sleep.efficiency",          code: "93829-0", display: "Sleep efficiency",              unit: "%"    },
};
const LOINC = LOINC_MAPPING; // local alias

// Fields the Whoop mock emits but the gateway deliberately doesn't translate.
// Used by the compatibility matrix to explain *why* data isn't reaching the hospital.
export const UNMAPPED_WHOOP_FIELDS = [
  { source: "recovery.score",         reason: "Proprietary Whoop composite score — no FHIR equivalent." },
  { source: "sleep.disturbances",     reason: "No stable FHIR concept for Whoop's disturbance count." },
  { source: "cycle.strain",           reason: "Proprietary Whoop strain score — no FHIR equivalent." },
  { source: "cycle.averageHeartRate", reason: "Could map to LOINC 8867-4 (heart rate) — not wired into the gateway yet." },
  { source: "cycle.maxHeartRate",     reason: "Could map to LOINC 8867-4 max variant — not wired." },
];

const observation = (patientId, takenAt, field, rawValue) => {
  const m = LOINC[field];
  if (!m) return null;
  let value = rawValue;
  // Unit conversions so the number in valueQuantity matches the unit string.
  if (field === "sleepDurationMs") value = rawValue / 3_600_000; // ms -> hours
  if (field === "sleepEfficiency") value = rawValue * 100;       // 0..1 -> %
  return {
    resource: {
      resourceType: "Observation",
      status: "final",
      code: { coding: [{ system: "http://loinc.org", code: m.code, display: m.display }] },
      subject: { reference: `Patient/${patientId}` },
      effectiveDateTime: takenAt,
      valueQuantity: { value: Number(value.toFixed(2)), unit: m.unit, system: "http://unitsofmeasure.org", code: m.unit },
    },
    request: { method: "POST", url: "Observation" },
  };
};

// Flatten a Whoop snapshot into { field: value } for allowed fields only.
function allowedValues(snapshot, allow) {
  const out = {};
  const r = snapshot.recovery || {};
  const s = snapshot.sleep || {};
  const map = {
    restingHeartRate: r.restingHeartRate,
    hrvMs: r.hrvMs,
    spo2: r.spo2,
    sleepDurationMs: s.durationMs,
    sleepEfficiency: s.efficiency,
  };
  for (const f of allow) {
    if (map[f] !== undefined && map[f] !== null) out[f] = map[f];
  }
  return out;
}

export function translateRuleBased(snapshot, consent) {
  const patientId = snapshot.patient?.id;
  const takenAt = snapshot.takenAt;
  if (!patientId || !takenAt) {
    return { bundle: null, error: "snapshot missing patient.id or takenAt" };
  }
  const values = allowedValues(snapshot, consent.allow || []);
  const entries = Object.entries(values)
    .map(([field, v]) => observation(patientId, takenAt, field, v))
    .filter(Boolean);

  if (entries.length === 0) {
    return { bundle: null, error: "consent blocked all fields, or none were present" };
  }

  return {
    bundle: {
      resourceType: "Bundle",
      type: "transaction",
      entry: entries,
    },
  };
}
