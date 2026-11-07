# Corkathon — Whoop → AI Gateway → Hospital

Three-service pipeline for the hackathon. One person owns each service; they
agree on the two contracts in [`contracts/`](contracts/README.md) and then
work in parallel.

```
  Patient's wearable        AI Gateway (translator)       Hospital FHIR API
  ─────────────────         ──────────────────────        ─────────────────
  whoop/   :4001    ───►    gateway/  :4002       ───►    hospital/  :4003
  Person A                  Person B                      Person C
```

## Quick start

```bash
# one time
npm install
npm run install:all

# run all three services (ctrl-c stops all)
npm run dev
```

Then trigger a sync:

```bash
# stable patient
curl -X POST http://localhost:4002/sync/pt-001 | jq

# heart-risk patient — hospital response should include alerts
curl -X POST http://localhost:4002/sync/pt-002 | jq

# see what the hospital has stored
curl http://localhost:4003/records | jq
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
- AI path in [`gateway/translate-ai.js`](gateway/translate-ai.js) is a stub — currently always falls back to the rule-based translator in [`gateway/translate.js`](gateway/translate.js).

### `hospital/` — FHIR receiver (Person C)
- `POST /fhir/Bundle` — validates, stores, returns `201` with alerts or `422` with errors.
- `GET /records`, `GET /records/:id`, `GET /patients/:ref/records` — read side for the clinician dashboard.
- Alert thresholds in [`hospital/alerts.js`](hospital/alerts.js).

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
