// Scenarios the mock Whoop API can return. Keyed by patientId.
// Each scenario is a list of snapshots, oldest -> newest.

const base = (overrides = {}) => ({
  recovery: { score: 70, restingHeartRate: 58, hrvMs: 48, spo2: 97, ...(overrides.recovery || {}) },
  sleep: { durationMs: 25200000, efficiency: 0.91, disturbances: 3, ...(overrides.sleep || {}) },
  cycle: { strain: 11.2, averageHeartRate: 70, maxHeartRate: 145, ...(overrides.cycle || {}) },
});

const daysAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(8, 0, 0, 0);
  return d.toISOString();
};

export const scenarios = {
  "pt-001": {
    patient: { id: "pt-001", displayName: "Jane Doe" },
    label: "stable",
    history: [
      { takenAt: daysAgo(4), ...base() },
      { takenAt: daysAgo(3), ...base({ recovery: { score: 72 } }) },
      { takenAt: daysAgo(2), ...base({ recovery: { score: 65 } }) },
      { takenAt: daysAgo(1), ...base({ recovery: { score: 68 } }) },
      { takenAt: daysAgo(0), ...base({ recovery: { score: 68, restingHeartRate: 58, hrvMs: 42 } }) },
    ],
  },
  "pt-002": {
    patient: { id: "pt-002", displayName: "Rafael Oduya" },
    label: "heart-risk",
    history: [
      { takenAt: daysAgo(4), ...base({ recovery: { restingHeartRate: 62, hrvMs: 40 } }) },
      { takenAt: daysAgo(3), ...base({ recovery: { restingHeartRate: 68, hrvMs: 35 } }) },
      { takenAt: daysAgo(2), ...base({ recovery: { restingHeartRate: 74, hrvMs: 30 }, sleep: { efficiency: 0.78 } }) },
      { takenAt: daysAgo(1), ...base({ recovery: { restingHeartRate: 81, hrvMs: 24, spo2: 93 }, sleep: { efficiency: 0.72 } }) },
      { takenAt: daysAgo(0), ...base({ recovery: { score: 28, restingHeartRate: 88, hrvMs: 19, spo2: 91 }, sleep: { durationMs: 18000000, efficiency: 0.68 } }) },
    ],
  },
  "pt-003": {
    patient: { id: "pt-003", displayName: "Maeve Lin" },
    label: "recovering",
    history: [
      { takenAt: daysAgo(4), ...base({ recovery: { score: 45, restingHeartRate: 72 } }) },
      { takenAt: daysAgo(3), ...base({ recovery: { score: 52, restingHeartRate: 68 } }) },
      { takenAt: daysAgo(2), ...base({ recovery: { score: 60, restingHeartRate: 64 } }) },
      { takenAt: daysAgo(1), ...base({ recovery: { score: 66, restingHeartRate: 61 } }) },
      { takenAt: daysAgo(0), ...base({ recovery: { score: 71, restingHeartRate: 59 } }) },
    ],
  },
};

export const latestFor = (patientId) => {
  const s = scenarios[patientId];
  if (!s) return null;
  const snap = s.history[s.history.length - 1];
  return { patient: s.patient, ...snap };
};

export const historyFor = (patientId) => {
  const s = scenarios[patientId];
  if (!s) return null;
  return s.history.map((h) => ({ patient: s.patient, ...h }));
};
