// Trivial rule-based alerts. Person C can expand.
// Thresholds chosen to light up the "heart-risk" scenario.

const RULES = [
  { code: "40443-4", label: "Resting HR high", test: (v) => v >= 80 },
  { code: "80404-7", label: "HRV very low", test: (v) => v <= 25 },
  { code: "59408-5", label: "SpO2 low", test: (v) => v <= 92 },
  { code: "93829-0", label: "Sleep efficiency low", test: (v) => v <= 75 },
];

export function alertsFor(observation) {
  const hits = [];
  for (const rule of RULES) {
    if (rule.code === observation.code && rule.test(observation.value)) {
      hits.push({ severity: "warning", label: rule.label, value: observation.value, unit: observation.unit });
    }
  }
  return hits;
}
