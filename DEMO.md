# Corkathon — Demo script

A 3–4 minute live walkthrough. Any team member can run it from this doc.

---

## 0 · Setup (do before you go up)

1. Open four terminal tabs — or better, one terminal with the stack running and three browser tabs ready.
2. In the repo root: `npm run dev` — wait for the `[admin] listening on http://localhost:4000` line.
3. Open these three browser tabs in this order (left → right):
   1. **http://localhost:4002/** · the WatchLink patient phone app
   2. **http://localhost:4000/** · the admin dashboard
   3. **http://localhost:4000/demo/hospital-integration.html** · the clinician EHR view
4. On the admin tab: click **Sync all** once to warm the data. Then **Clear** on the Telemetry page so the demo starts from a clean log.
5. On the hospital EHR tab: scroll down to the flowsheet area so it's already visible.
6. Zoom browser to a comfortable size (⌘+ once) — the phone app looks best with a bit of extra size.

**One-liner sanity check** before you walk on stage:

```bash
curl -sf http://localhost:4000/health && echo OK
```

---

## 1 · The hook (30 seconds, before you touch anything)

> Everyone wears health trackers now. Rings, watches, chest straps — your resting heart rate, your HRV, your sleep quality. **Your GP sees none of it.** The data is scattered across five apps that don't talk to each other, and the hospital EHR has no way to accept it even if you offered.
>
> We built a consent-first gateway that fixes this. The patient controls exactly what they share — not the wearable company, not the hospital. And it arrives in the EHR in the format the clinician already uses: FHIR.

---

## 2 · Live demo (2.5 minutes)

### Beat 1 · The patient's phone (tab 1 — phone app)

> This is what Jane sees on her phone. She's signed into Cork University Hospital — real Irish patient identifiers, PPSN and IHI — and here are the five biometric metrics her WHOOP tracks.

Point at the toggle rows:
- Resting Heart Rate (58 bpm)
- HRV (42 ms)
- SpO₂ (97%)
- Sleep Duration (7.0 hrs)
- Sleep Efficiency (91%)

> She can share all of them, or none of them, or **any subset**. Watch —

**Toggle off** Sleep Duration and Sleep Efficiency. Say:

> I'm comfortable sharing my cardiovascular data with my cardiologist. I don't want them to have my sleep data. That's a reasonable boundary — and this app respects it.

---

### Beat 2 · The data journey (still tab 1)

Click **SYNC 3 METRICS WITH HOSPITAL**. The drawer slides up.

> Look at this — this is the full journey of the data, live. The WatchLink app sent three consented metrics. The Corkathon gateway translated them into three FHIR Observations — that's the format every hospital EHR speaks. Cork University Hospital received them, stored the record, and because Jane's numbers are normal, no clinical alerts fired.

Point at the timing on the right:

> Entire round trip, under a second.

---

### Beat 3 · The operator view (tab 2 — admin dashboard)

Switch to the admin dashboard tab, click **Transactions** in the sidebar.

> As a hospital operator, this is what I see. Every patient, every transaction, every observation that flowed through. We can click into any record to see exactly what was sent.

Expand the latest row.

> Three Observations under Jane's record — LOINC codes, the hospital's unit system. **Sleep metrics aren't there** because she didn't consent to share them. The consent enforcement isn't a UI thing — it's enforced at the gateway, so even if the hospital tried to pull sleep data, they couldn't.

Click **Compatibility** in the sidebar.

> And this is the "why." For every patient, we show which Whoop fields flow through and which don't — blocked by consent, no FHIR mapping, or missing from the snapshot. It's the audit trail every integration needs and nobody usually has.

---

### Beat 4 · The clinician's view (tab 3 — hospital EHR)

Switch to the hospital EHR tab.

> And here's the other end — a traditional hospital EHR, rendered to look like the systems clinicians already use every day. Legacy chrome, flowsheet layout, clinical alerts.

Scroll to the flowsheet.

> Jane's resting heart rate, HRV, and SpO₂ show up right alongside her in-clinic vitals. **Patient-generated** is clearly tagged — the clinician knows the source, knows it's not clinically validated, but it's now in the record where they actually work.

---

### Beat 5 · When it matters (back to tab 1 — phone app, or switch patients)

If time permits, run the heart-risk scenario to show alerts:

```bash
curl -s -X POST http://localhost:4000/sync/pt-002 > /dev/null
```

Switch to admin dashboard → Transactions → scroll to `Patient/pt-002`.

> Here's Rafael. Different patient, heart-risk profile. Same consent flow, same pipeline — but his resting HR is 88, HRV is 19, SpO₂ is 91. The hospital's threshold rules fire automatically: **three clinical alerts**. If his GP has a worklist of 40 patients today, Rafael jumps to the top.

---

## 3 · The close (30 seconds)

> Three things this unlocks:
>
> 1. **For patients** — one consent screen, revocable any time. Not twelve app permissions.
> 2. **For clinicians** — wearable data in the EHR workflow they already know, with alerts, not a separate dashboard they'll never open.
> 3. **For research** — every consented transaction is a FHIR-standard record. Scale it across Ireland and you have the biggest consented patient-generated dataset in Europe.
>
> We built the three services, the gateway, the AI translator (Claude Opus 4.7 for messy mappings), the patient app, the clinician view, and the ops console in a weekend. The hard part is the policy, not the tech. Thanks.

---

## 4 · If something breaks mid-demo

| Symptom | Fallback |
|---|---|
| Phone app's SYNC spins forever | Reload tab. Rule-based translator always works; if hospital is dead, say *"this is what happens when hospitals are offline — the gateway queues it, you'd see it on the ops console"* and switch tabs. |
| Journey drawer gets stuck on step 2 yellow | Say: *"The AI translator path isn't wired right now — we have the Claude Opus 4.7 integration ready but running on the deterministic fallback for this demo. The yellow is the fallback light."* |
| Admin dashboard shows no data | On the admin terminal: `npm run dev` restart. Takes ~2 s. Fire a `curl -s -X POST http://localhost:4000/sync/pt-001` to re-seed. |
| Hospital EHR shows empty flowsheet | The demo polls admin every 5 s — just wait. If still empty, reload the tab. |
| Browser doesn't open any tab | All three URLs: `http://localhost:4002/`, `http://localhost:4000/`, `http://localhost:4000/demo/hospital-integration.html` |

---

## 5 · Backup narration beats

Use these if a judge asks or you have more time:

**"Why FHIR?"**
> FHIR R4 is the hospital interoperability standard — every modern EHR speaks it. We emit transaction Bundles so the hospital doesn't need bespoke integration code; it uses the same receiver it already has for lab results and referrals.

**"Why Claude as the translator?"**
> Wearable field schemas change constantly — Whoop adds new metrics, Oura renames things, Apple releases new HealthKit types. A rule-based translator breaks every time. An LLM that knows LOINC codes and SNOMED can adapt. We run Claude Opus 4.7 with structured outputs so the Bundle shape is guaranteed valid, and we fall back to rule-based if the AI ever returns a malformed response. Reliability without brittleness.

**"What about privacy / GDPR?"**
> The gateway is the only thing that touches both sides. Consent lives at the gateway, enforced before anything reaches the hospital. Patient can revoke, we stop sending. Every transaction is logged. The system never stores wearable data it doesn't have consent to forward.

**"What's next?"**
> Three stretch targets: real Whoop OAuth (we're on their waitlist), connect Apple HealthKit and Google Health Connect as parallel sources (same gateway, same contract), and SMART-on-FHIR launch so the clinician can drill into the wearable data from inside Epic.

---

## 6 · Credits

- **Pipeline + gateway + admin** — [team name here]
- **Wearable app + hospital EHR demos** — [team name here]
- **Translator + alerts + compatibility matrix** — [team name here]

Repo: https://github.com/aran-phillips/Corkathon
