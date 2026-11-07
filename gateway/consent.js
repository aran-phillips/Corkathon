// Default consent per patient. In a real build this would live in a DB
// and be edited from Person A's consent UI.

export const consentByPatient = {
  "pt-001": { allow: ["restingHeartRate", "hrvMs", "spo2", "sleepDurationMs", "sleepEfficiency"] },
  "pt-002": { allow: ["restingHeartRate", "hrvMs", "spo2", "sleepEfficiency"] },
  "pt-003": { allow: ["restingHeartRate", "sleepDurationMs"] },
};

export function consentFor(patientId) {
  return consentByPatient[patientId] ?? { allow: [] };
}
