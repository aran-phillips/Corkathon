// Default consent per patient. In a real build this would live in a DB
// and be edited from the patient consent UI.

export const ALL_METRICS = [
  "restingHeartRate",
  "hrvMs",
  "spo2",
  "sleepDurationMs",
  "sleepEfficiency",
];

export const consentByPatient = {
  "pt-001": { allow: ["restingHeartRate", "hrvMs", "spo2", "sleepDurationMs", "sleepEfficiency"] },
  "pt-002": { allow: ["restingHeartRate", "hrvMs", "spo2", "sleepEfficiency"] },
  "pt-003": { allow: ["restingHeartRate", "sleepDurationMs"] },
};

export function consentFor(patientId) {
  return consentByPatient[patientId] ?? { allow: [] };
}

export function setConsentFor(patientId, allow) {
  const validAllow = Array.isArray(allow)
    ? allow.filter((field) => ALL_METRICS.includes(field))
    : [];
  consentByPatient[patientId] = { allow: validAllow };
  return consentByPatient[patientId];
}
