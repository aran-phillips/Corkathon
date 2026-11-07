# Corkathon — Whoop → AI Gateway → Hospital

Four-service pipeline for the hackathon. The admin dashboard is its own
service that proxies to the other three, so the frontend always talks to
one origin.

```
  Patient's wearable      AI Gateway (translator)     Hospital FHIR API
  ─────────────────       ──────────────────────      ─────────────────
  whoop/   :4001  ───►    gateway/  :4002      ───►   hospital/  :4003
  Person A                Person B                    Person C
                              ▲                              ▲
                              │ proxy                        │ proxy
                              └──────────┬───────────────────┘
                                         │
                                    admin/  :4000
                                    (dashboard + BFF)
```

## Quick start

```bash
# one time
npm install
npm run install:all

# run all four services (ctrl-c stops all)
npm run dev
```

Open the **admin dashboard** at http://localhost:4000/. It shows live
service health, a visual pipeline that animates during each sync, a
compatibility matrix that flags blocked fields, per-API pages, and a
streaming telemetry log. All driven by SSE from the gateway through the
admin passthrough.

Trigger a sync (admin proxies to gateway):

```bash
# stable patient
curl -X POST http://localhost:4000/sync/pt-001 | jq

# heart-risk patient — hospital response should include alerts
curl -X POST http://localhost:4000/sync/pt-002 | jq

# see what the hospital has stored (admin proxies direct to hospital)
curl http://localhost:4000/hospital/records | jq
```

## Services

### `whoop/` — mock wearable (Person A)
- `GET /patients` — list of demo patients and their scenario label.
- `GET /patients/:id/snapshot` — latest Whoop-style JSON.
- `GET /patients/:id/history` — last five days.
- Scenarios in [`whoop/scenarios.js`](whoop/scenarios.js): `stable`, `heart-risk`, `recovering`.

### `gateway/` — translator (Person B)
- `POST /sync/:patientId` — pulls snapshot, applies consent, translates, posts bundle.
- Consent defaults in [`gateway/consent.js`](gateway/consent.js); override per-request via body `{ "consent": { "allow": [...] } }`.
- Translator in [`gateway/translate-ai.js`](gateway/translate-ai.js) calls Claude Opus 4.7 with a FHIR Bundle JSON schema (structured outputs). Set `ANTHROPIC_API_KEY` to enable it:
  ```bash
  ANTHROPIC_API_KEY=sk-ant-... npm run dev
  ```
- If the key is absent, or Claude returns a malformed/empty bundle, the gateway falls back to the rule-based translator in [`gateway/translate.js`](gateway/translate.js). The response `translator` field says which path produced the bundle.

### `hospital/` — FHIR receiver (Person C)
- `POST /fhir/Bundle` — validates, stores, returns `201` with alerts or `422` with errors.
- `GET /records`, `GET /records/:id`, `GET /patients/:ref/records` — read side for the clinician dashboard.
- Alert thresholds in [`hospital/alerts.js`](hospital/alerts.js).

### `admin/` — dashboard + backend-for-frontend
- Serves the dashboard at `/` from `admin/public/`.
- Proxies gateway endpoints (`/patients`, `/mapping`, `/compatibility/:id`, `/sync/:id`, `/events`, `/events/stream`, `/whoop/snapshot/:id`).
- Proxies hospital directly for records (`/hospital/records`, `/hospital/records/:id`, `/hospital/patients/:ref/records`).
- Aggregates health across all services at `/health/all`.
- Config via env: `WHOOP_URL`, `GATEWAY_URL`, `HOSPITAL_URL` (defaults to localhost on 4001/4002/4003).

## Contracts

See [`contracts/README.md`](contracts/README.md) for the Whoop JSON shape and
the FHIR Bundle shape. If both hold, the three services can change
independently.

## Next steps per person

- **A** — consent UI, more scenarios, real Whoop OAuth (stretch).
- **B** — implement `translateWithClaude`, compare AI output vs rule-based, retry on malformed JSON.
- **C** — clinician dashboard HTML, trend chart over `/patients/:ref/records`, pitch script.

## Reference samples

Teammate-provided wearable/FHIR examples at the repo root (`whoop-*.json`,
`oura-*.json`, `apple-healthkit-*.json`, `wearable-fhir-bundle-example.json`)
are reference material. The mock in `whoop/` uses a simplified snapshot shape
documented in [`contracts/README.md`](contracts/README.md).
