# Contracts

Two shapes. If they hold, Person A / B / C work in parallel without blocking each other.

## 1. Whoop JSON — input to the gateway

The mock Whoop API (`/whoop`) returns one `WhoopSnapshot` object per patient, with optional history. Fields are nullable; the gateway must handle any of them being absent.

```jsonc
{
  "patient": { "id": "pt-001", "displayName": "Jane Doe" },
  "takenAt": "2026-11-07T08:00:00Z",
  "recovery": {
    "score": 68,                // 0..100
    "restingHeartRate": 58,     // bpm
    "hrvMs": 42,                // ms
    "spo2": 97                  // %
  },
  "sleep": {
    "durationMs": 25200000,     // 7h
    "efficiency": 0.91,          // 0..1
    "disturbances": 3
  },
  "cycle": {
    "strain": 12.4,              // Whoop 0..21 scale
    "averageHeartRate": 72,
    "maxHeartRate": 148
  }
}
```

`WhoopHistory` is an array of snapshots sorted oldest→newest.

See `sample-whoop.json` for a worked example.

## 2. FHIR Bundle — output of the gateway, input to the hospital

A minimal `transaction` Bundle of `Observation` resources. Every Observation must have:

- `code` (LOINC)
- `valueQuantity` with `value` + `unit`
- `subject.reference` → `Patient/<id>`
- `effectiveDateTime`

LOINC codes used in this pipeline:

| Metric             | LOINC      | Unit   |
| ------------------ | ---------- | ------ |
| Resting heart rate | `40443-4`  | `/min` |
| HRV (SDNN)         | `80404-7`  | `ms`   |
| SpO2               | `59408-5`  | `%`    |
| Sleep duration     | `93832-4`  | `h`    |
| Sleep efficiency   | `93829-0`  | `%`    |

See `sample-bundle.json` for a worked example.

The hospital endpoint returns:

- `201 Created` with a receipt id on success,
- `422 Unprocessable Entity` with a list of validation errors otherwise.

## 3. Consent

The gateway only translates fields that appear in the patient's consent list:

```json
{
  "patientId": "pt-001",
  "allow": ["restingHeartRate", "hrvMs", "spo2", "sleepDurationMs", "sleepEfficiency"]
}
```

Anything missing from `allow` is dropped before translation. The receipt from the hospital names exactly which Observations were accepted, so the patient can see what was shared.
