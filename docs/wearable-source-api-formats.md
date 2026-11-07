# Wearable source API formats

What the data looks like when we **pull it from the wearable**, and how each field maps to the FHIR format we **send to the hospital** (see `examples/wearable-fhir-bundle-example.json`).

> Field names below come from the vendors' docs and published examples as of Nov 2026. Check each against the official docs before building:
> WHOOP: https://developer.whoop.com · Oura: https://cloud.ouraring.com/v2/docs · Apple: https://developer.apple.com/documentation/healthkit

| Source | Access | Auth | Raw HR stream? |
|---|---|---|---|
| WHOOP | Cloud REST API v2 (`https://api.prod.whoop.com/developer/v2`) | OAuth 2.0 (+ `offline` scope for refresh token) | No: summaries only |
| Oura | Cloud REST API v2 (`https://api.ouraring.com/v2/usercollection`) | OAuth 2.0 Bearer token | Yes: `/heartrate` |
| Apple Health | **No cloud API.** Read on-device with HealthKit in an iOS app, or parse the user's `export.xml` | iOS permission prompt | Yes |

---

## 1. WHOOP API v2

Read-only. Scopes: `read:recovery`, `read:cycles`, `read:sleep`, `read:workout`, `read:body_measurement`, `read:profile`, `offline`.

| Endpoint | Returns |
|---|---|
| `GET /v2/cycle` | Physiological days (strain, avg/max HR) |
| `GET /v2/cycle/{cycleId}/recovery` | Recovery for one cycle |
| `GET /v2/recovery` | All recoveries (paginated) |
| `GET /v2/activity/sleep` | Sleeps and naps |
| `GET /v2/activity/workout` | Workouts |
| `GET /v2/user/measurement/body` | Height, weight, max HR |

Lists are paginated: `?limit=25&start=...&end=...&nextToken=...`, and responses look like `{ "records": [...], "next_token": "..." }`.

### Recovery (`GET /v2/cycle/{cycleId}/recovery`)

```json
{
  "cycle_id": 93845,
  "sleep_id": "123e4567-e89b-12d3-a456-426614174000",
  "user_id": 10129,
  "created_at": "2022-04-24T11:25:44.774Z",
  "updated_at": "2022-04-24T14:25:44.774Z",
  "score_state": "SCORED",
  "score": {
    "user_calibrating": false,
    "recovery_score": 75.4,
    "resting_heart_rate": 52.0,
    "hrv_rmssd_milli": 68.2,
    "spo2_percentage": 97.5,
    "skin_temp_celsius": 33.8
  }
}
```

### Sleep (`GET /v2/activity/sleep`)

```json
{
  "id": "ecfc6a15-4661-442f-a9a4-f160dd7afae8",
  "cycle_id": 93845,
  "user_id": 10129,
  "start": "2022-04-24T02:25:44.774Z",
  "end": "2022-04-24T10:25:44.774Z",
  "timezone_offset": "+01:00",
  "nap": false,
  "score_state": "SCORED",
  "score": {
    "stage_summary": {
      "total_in_bed_time_milli": 30272735,
      "total_awake_time_milli": 1403507,
      "total_light_sleep_time_milli": 14905851,
      "total_slow_wave_sleep_time_milli": 6630370,
      "total_rem_sleep_time_milli": 5879573,
      "sleep_cycle_count": 3,
      "disturbance_count": 12
    },
    "respiratory_rate": 16.11,
    "sleep_performance_percentage": 98,
    "sleep_consistency_percentage": 90,
    "sleep_efficiency_percentage": 91.7
  }
}
```

**Gotchas**
- Only use records with `score_state: "SCORED"`. `PENDING_SCORE` = try later, `UNSCORABLE` = never.
- Durations ending `_milli` are milliseconds.
- `spo2_percentage` / `skin_temp_celsius` can be missing on older straps.
- No raw heart-rate stream, ECG or journal via the API.

---

## 2. Oura API v2

Scopes: `email`, `personal`, `daily`, `heartrate`, plus others. Refresh tokens are single-use: always store the new one.

| Endpoint | Returns |
|---|---|
| `GET /v2/usercollection/heartrate?start_datetime=&end_datetime=` | HR time series |
| `GET /v2/usercollection/daily_readiness?start_date=&end_date=` | Readiness score + contributors |
| `GET /v2/usercollection/daily_sleep` | Sleep score + contributors |
| `GET /v2/usercollection/sleep` | Detailed sleep periods (HR, HRV, stages) |
| `GET /v2/usercollection/daily_spo2` | Nightly SpO2 average |
| `GET /v2/usercollection/daily_activity` | Steps, calories |

All responses: `{ "data": [...], "next_token": null }`.

### Heart rate

```json
{
  "data": [
    { "bpm": 76, "source": "awake", "timestamp": "2026-07-30T04:03:19+00:00" },
    { "bpm": 58, "source": "rest",  "timestamp": "2026-07-30T04:08:19+00:00" }
  ],
  "next_token": null
}
```

### Daily readiness

```json
{
  "data": [
    {
      "id": "8f9a5221-639e-4a85-81cb-4065ef23f979",
      "day": "2026-11-06",
      "score": 82,
      "temperature_deviation": -0.1,
      "temperature_trend_deviation": 0.05,
      "timestamp": "2026-11-06T00:00:00+00:00",
      "contributors": {
        "activity_balance": 80, "body_temperature": 98, "hrv_balance": 75,
        "previous_day_activity": 85, "previous_night": 78, "recovery_index": 90,
        "resting_heart_rate": 88, "sleep_balance": 81
      }
    }
  ],
  "next_token": null
}
```

Note: `contributors` are 0–100 **scores**, not measurements. Resting HR in bpm comes from `/sleep` (`lowest_heart_rate`), not from here.

---

## 3. Apple Health (HealthKit)

There is no web API. Two routes:

**A. iOS companion app (recommended).** Request read permission, then query `HKQuantitySample`s. Each sample has a type, a value + unit, a start/end date and a source:

```json
{
  "type": "HKQuantityTypeIdentifierHeartRate",
  "value": 72,
  "unit": "count/min",
  "startDate": "2026-11-06T10:00:00Z",
  "endDate": "2026-11-06T10:00:00Z",
  "sourceName": "Apple Watch"
}
```

**B. User exports the file.** Health app → profile → *Export All Health Data* → `export.zip` → `export.xml` (often hundreds of MB; undocumented schema):

```xml
<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch"
        unit="count/min" creationDate="2026-11-06 10:00:05 +0000"
        startDate="2026-11-06 10:00:00 +0000" endDate="2026-11-06 10:00:00 +0000"
        value="72"/>
```

Useful type identifiers: `HeartRate`, `RestingHeartRate`, `HeartRateVariabilitySDNN`, `OxygenSaturation`, `RespiratoryRate`, `StepCount`, `HKCategoryTypeIdentifierSleepAnalysis`, `HKCategoryTypeIdentifierIrregularHeartRhythmEvent`.

---

## 4. Mapping to FHIR (what the hospital receives)

| Measurement | WHOOP field | Oura field | Apple type | FHIR LOINC | UCUM unit |
|---|---|---|---|---|---|
| Heart rate | – (not exposed) | `heartrate.bpm` | `HeartRate` | 8867-4 | `/min` |
| Resting HR | `recovery.score.resting_heart_rate` | `sleep.lowest_heart_rate` | `RestingHeartRate` | 40443-4 | `/min` |
| HRV (SDNN) | – | – | `HeartRateVariabilitySDNN` | 80404-7 | `ms` |
| HRV (RMSSD) | `recovery.score.hrv_rmssd_milli` | `sleep.average_hrv` | – | *look up RMSSD code: not 80404-7* | `ms` |
| SpO2 | `recovery.score.spo2_percentage` | `daily_spo2.spo2_percentage.average` | `OxygenSaturation` (0–1 → ×100) | 59408-5 | `%` |
| Respiratory rate | `sleep.score.respiratory_rate` | `sleep.average_breath` | `RespiratoryRate` | 9279-1 | `/min` |
| Sleep duration | `in_bed − awake` (ms → h) | `sleep.total_sleep_duration` (s → h) | `SleepAnalysis` (sum asleep stages) | 93832-4 | `h` |
| Steps | – | `daily_activity.steps` | `StepCount` | 55423-8 | `{steps}` |
| Irregular rhythm | – | – | `IrregularHeartRhythmEvent` | 8884-9 | – |
| Recovery / readiness / strain | proprietary | proprietary | – | **no standard code: don't send as clinical data** | – |

**Rules for the converter**
1. Send underlying measurements, not proprietary scores.
2. HRV: WHOOP and Oura report **RMSSD**, Apple reports **SDNN**. They are different metrics and must use different codes.
3. Convert units: WHOOP ms → h, Oura s → h, Apple SpO2 fraction → %.
4. Tag every Observation with a `Device` reference so the hospital knows it is patient-generated, consumer-grade data.
