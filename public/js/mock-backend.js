// HealthConnect static demo — client-side mock of the four services.
// Intercepts fetch() and EventSource() so the admin / operator / phone
// pages run against a canned pipeline when deployed to Vercel.

(function () {
  "use strict";

  // ─── Scenarios (ported from whoop/scenarios.js) ──────────────
  const daysAgo = (n) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    d.setUTCHours(8, 0, 0, 0);
    return d.toISOString();
  };
  const base = (o = {}) => ({
    recovery: { score: 70, restingHeartRate: 58, hrvMs: 48, spo2: 97, ...(o.recovery || {}) },
    sleep: { durationMs: 25200000, efficiency: 0.91, disturbances: 3, ...(o.sleep || {}) },
    cycle: { strain: 11.2, averageHeartRate: 70, maxHeartRate: 145, ...(o.cycle || {}) },
  });

  const SCENARIOS = {
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
  const latestFor = (id) => {
    const s = SCENARIOS[id];
    return s ? { patient: s.patient, ...s.history[s.history.length - 1] } : null;
  };
  const historyFor = (id) => {
    const s = SCENARIOS[id];
    return s ? s.history.map((h) => ({ patient: s.patient, ...h })) : null;
  };

  // ─── LOINC mapping + unmapped (ported from gateway/translate.js) ─
  const LOINC_MAPPING = {
    restingHeartRate: { source: "recovery.restingHeartRate", code: "40443-4", display: "Resting heart rate", unit: "/min" },
    hrvMs:            { source: "recovery.hrvMs",            code: "80404-7", display: "Heart rate variability SDNN", unit: "ms" },
    spo2:             { source: "recovery.spo2",             code: "59408-5", display: "Oxygen saturation", unit: "%" },
    sleepDurationMs:  { source: "sleep.durationMs",          code: "93832-4", display: "Sleep duration", unit: "h" },
    sleepEfficiency:  { source: "sleep.efficiency",          code: "93829-0", display: "Sleep efficiency", unit: "%" },
  };
  const UNMAPPED_WHOOP_FIELDS = [
    { source: "recovery.score",         reason: "Proprietary Whoop composite score — no FHIR equivalent." },
    { source: "sleep.disturbances",     reason: "No stable FHIR concept for Whoop's disturbance count." },
    { source: "cycle.strain",           reason: "Proprietary Whoop strain score — no FHIR equivalent." },
    { source: "cycle.averageHeartRate", reason: "Could map to LOINC 8867-4 (heart rate) — not wired into the gateway yet." },
    { source: "cycle.maxHeartRate",     reason: "Could map to LOINC 8867-4 max variant — not wired." },
  ];

  // ─── Alert rules (ported from hospital/alerts.js) ────────────
  const ALERT_RULES = [
    { code: "40443-4", label: "Resting HR high", test: (v) => v >= 80 },
    { code: "80404-7", label: "HRV very low",    test: (v) => v <= 25 },
    { code: "59408-5", label: "SpO2 low",        test: (v) => v <= 92 },
    { code: "93829-0", label: "Sleep efficiency low", test: (v) => v <= 75 },
  ];
  function alertsFor(obs) {
    return ALERT_RULES
      .filter((r) => r.code === obs.code && r.test(obs.value))
      .map((r) => ({ severity: "warning", label: r.label, value: obs.value, unit: obs.unit }));
  }

  // ─── Consent (defaults + localStorage override) ──────────────
  const DEFAULT_CONSENT = {
    "pt-001": { allow: ["restingHeartRate", "hrvMs", "spo2", "sleepDurationMs", "sleepEfficiency"] },
    "pt-002": { allow: ["restingHeartRate", "hrvMs", "spo2", "sleepEfficiency"] },
    "pt-003": { allow: ["restingHeartRate", "sleepDurationMs"] },
  };
  const ALL_METRICS = Object.keys(LOINC_MAPPING);
  const LS_CONSENT = "hc-consent";
  const LS_RECORDS = "hc-records";
  const LS_EVENTS  = "hc-events";

  function consentFor(id) {
    try {
      const all = JSON.parse(localStorage.getItem(LS_CONSENT) || "{}");
      if (all[id]) return all[id];
    } catch {}
    return DEFAULT_CONSENT[id] || { allow: [] };
  }
  function setConsentFor(id, allow) {
    const valid = Array.isArray(allow) ? allow.filter((f) => ALL_METRICS.includes(f)) : [];
    let all = {};
    try { all = JSON.parse(localStorage.getItem(LS_CONSENT) || "{}"); } catch {}
    all[id] = { allow: valid };
    try { localStorage.setItem(LS_CONSENT, JSON.stringify(all)); } catch {}
    return all[id];
  }
  function getRecords() {
    try { return JSON.parse(localStorage.getItem(LS_RECORDS) || "[]"); } catch { return []; }
  }
  function setRecords(xs) {
    try { localStorage.setItem(LS_RECORDS, JSON.stringify(xs)); } catch {}
  }
  function getEvents() {
    try { return JSON.parse(localStorage.getItem(LS_EVENTS) || "[]"); } catch { return []; }
  }
  function pushEvent(ev) {
    const xs = getEvents();
    const entry = { ts: new Date().toISOString(), ...ev };
    xs.push(entry);
    while (xs.length > 200) xs.shift();
    try { localStorage.setItem(LS_EVENTS, JSON.stringify(xs)); } catch {}
    // Notify any live EventSource mocks on this page.
    sseBus.dispatchEvent(new MessageEvent("telemetry", { data: JSON.stringify(entry) }));
    return entry;
  }

  // ─── Rule-based translator (ported from gateway/translate.js) ─
  function getByPath(obj, p) { return p.split(".").reduce((o, k) => (o == null ? o : o[k]), obj); }
  function observation(patientId, takenAt, field, raw) {
    const m = LOINC_MAPPING[field];
    if (!m) return null;
    let value = raw;
    if (field === "sleepDurationMs") value = raw / 3_600_000;
    if (field === "sleepEfficiency") value = raw * 100;
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
  }
  function translateRuleBased(snapshot, consent) {
    const patientId = snapshot.patient?.id;
    const takenAt = snapshot.takenAt;
    if (!patientId || !takenAt) return { bundle: null, error: "snapshot missing patient.id or takenAt" };
    const r = snapshot.recovery || {}, s = snapshot.sleep || {};
    const map = {
      restingHeartRate: r.restingHeartRate,
      hrvMs: r.hrvMs,
      spo2: r.spo2,
      sleepDurationMs: s.durationMs,
      sleepEfficiency: s.efficiency,
    };
    const entries = (consent.allow || [])
      .map((f) => (map[f] != null ? observation(patientId, takenAt, f, map[f]) : null))
      .filter(Boolean);
    if (entries.length === 0) return { bundle: null, error: "consent blocked all fields" };
    return {
      bundle: {
        resourceType: "Bundle",
        type: "transaction",
        entry: entries,
      },
      error: null,
    };
  }

  // ─── Compatibility (ported from gateway/server.js) ───────────
  function compatibilityFor(id) {
    const snap = latestFor(id);
    if (!snap) return null;
    const consent = consentFor(id);
    const allow = new Set(consent.allow || []);
    const fields = Object.entries(LOINC_MAPPING).map(([field, m]) => {
      const value = getByPath(snap, m.source);
      const present = value != null;
      const consented = allow.has(field);
      let status, reason;
      if (!present) { status = "missing"; reason = `Whoop snapshot did not include ${m.source}.`; }
      else if (!consented) { status = "blocked-by-consent"; reason = `Patient has not consented to share "${field}". Add it to consent.allow to flow through.`; }
      else { status = "ok"; reason = "Flows through consent + translator + hospital."; }
      return { field, source: m.source, loinc: m.code, display: m.display, unit: m.unit, value: present ? value : null, present, consented, mappable: true, status, reason };
    });
    const unmapped = UNMAPPED_WHOOP_FIELDS.map((f) => {
      const value = getByPath(snap, f.source);
      const present = value != null;
      return { source: f.source, value: present ? value : null, present, mappable: false, status: "no-mapping", reason: f.reason };
    }).filter((f) => f.present);
    const blockers = [...fields.filter((f) => f.status !== "ok"), ...unmapped];
    return {
      patient: snap.patient,
      takenAt: snap.takenAt,
      consent,
      fields,
      unmapped,
      summary: {
        total: fields.length + unmapped.length,
        flowing: fields.filter((f) => f.status === "ok").length,
        blockedByConsent: fields.filter((f) => f.status === "blocked-by-consent").length,
        missing: fields.filter((f) => f.status === "missing").length,
        noMapping: unmapped.length,
        hasBlockers: blockers.length > 0,
      },
    };
  }

  // ─── Sync (the full pipeline) ────────────────────────────────
  async function runSync(patientId, body) {
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    if (body?.consent?.allow && Array.isArray(body.consent.allow)) {
      setConsentFor(patientId, body.consent.allow);
    }
    const consent = body?.consent || consentFor(patientId);

    pushEvent({ runId, patientId, stage: "start", level: "info", message: `sync kicked off for ${patientId}` });

    const snapshot = latestFor(patientId);
    if (!snapshot) {
      pushEvent({ runId, patientId, stage: "whoop", level: "error", message: "unknown patient" });
      return { status: 502, body: { runId, stage: "whoop", error: "unknown patient" } };
    }
    await sleep(80);
    pushEvent({ runId, patientId, stage: "whoop", level: "ok", message: `snapshot ${snapshot.takenAt}` });

    await sleep(180);
    const { bundle, error } = translateRuleBased(snapshot, consent);
    if (!bundle) {
      pushEvent({ runId, patientId, stage: "translate", level: "error", message: error });
      return { status: 422, body: { runId, stage: "translate", error, consent } };
    }
    pushEvent({ runId, patientId, stage: "translate", level: "ok", message: `rule-based translator → ${bundle.entry.length} observations` });

    await sleep(120);
    const all = getRecords();
    const nextId = `rec-${all.length + 1}`;
    const accepted = [];
    const alerts = [];
    for (const e of bundle.entry) {
      const obs = e.resource;
      accepted.push({
        id: obs.code.coding[0].code,
        code: obs.code.coding[0].code,
        display: obs.code.coding[0].display,
        value: obs.valueQuantity.value,
        unit: obs.valueQuantity.unit,
        effectiveDateTime: obs.effectiveDateTime,
      });
      for (const a of alertsFor({ code: obs.code.coding[0].code, value: obs.valueQuantity.value, unit: obs.valueQuantity.unit })) {
        alerts.push({ ...a, code: obs.code.coding[0].code, display: obs.code.coding[0].display });
      }
    }
    const record = {
      id: nextId,
      patient: snapshot.patient,
      receivedAt: new Date().toISOString(),
      accepted,
      alerts,
      bundle,
    };
    all.push(record);
    setRecords(all);
    pushEvent({
      runId, patientId, stage: "hospital",
      level: alerts.length > 0 ? "warn" : "ok",
      message: `hospital 201 → ${nextId}${alerts.length ? ` · ${alerts.length} alert${alerts.length === 1 ? "" : "s"}` : ""}`,
    });

    return {
      status: 201,
      body: {
        runId, stage: "complete", translator: "rule-based", aiError: null,
        consent, snapshot, bundle,
        hospital: { id: nextId, accepted, alerts, status: "ok" },
      },
    };
  }

  // ─── Fake SSE bus — EventSource interception ─────────────────
  const sseBus = new EventTarget();
  const OriginalEventSource = window.EventSource;
  class MockEventSource extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      this.CONNECTING = 0; this.OPEN = 1; this.CLOSED = 2;
      // Send a "hello" burst with recent events.
      queueMicrotask(() => {
        this._fire("hello", JSON.stringify({ recent: getEvents().slice(-50) }));
        if (this.onopen) try { this.onopen({ type: "open" }); } catch {}
      });
      // Pipe real-time events from the bus.
      this._handler = (e) => this._fire("telemetry", e.data);
      sseBus.addEventListener("telemetry", this._handler);
    }
    _fire(type, data) {
      const ev = new MessageEvent(type, { data });
      // onmessage only fires for unnamed events; named events use addEventListener.
      if (type === "message" && this.onmessage) try { this.onmessage(ev); } catch {}
      this.dispatchEvent(ev);
    }
    close() {
      this.readyState = 2;
      sseBus.removeEventListener("telemetry", this._handler);
    }
    // onmessage/onerror/onopen are supported as properties too.
  }
  window.EventSource = MockEventSource;

  // ─── Fetch interception ─────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const json = (body, init = {}) => new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });

  const routes = [
    // Health
    { m: "GET",  r: /^\/health$/,                          h: () => json({ ok: true, service: "mock" }) },
    { m: "GET",  r: /^\/health\/all$/,                     h: () => json({
      whoop:    { name: "whoop", url: "(mocked)", ok: true },
      gateway:  { name: "gateway", url: "(mocked)", ok: true },
      hospital: { name: "hospital", url: "(mocked)", ok: true },
      admin:    { name: "admin", url: "(mocked)", ok: true },
      ai:       { ok: false },
    }) },

    // Patients + consent
    { m: "GET",  r: /^\/patients$/,                        h: () => json(Object.values(SCENARIOS).map((s) => ({ ...s.patient, label: s.label, consent: consentFor(s.patient.id) }))) },
    { m: "GET",  r: /^\/patients\/([^/]+)\/snapshot$/,     h: (_, id) => { const s = latestFor(id); return s ? json(s) : json({ error: "unknown patient" }, { status: 404 }); } },
    { m: "GET",  r: /^\/patients\/([^/]+)\/history$/,      h: (_, id) => { const h = historyFor(id); return h ? json(h) : json({ error: "unknown patient" }, { status: 404 }); } },
    { m: "GET",  r: /^\/whoop\/snapshot\/([^/]+)$/,        h: (_, id) => { const s = latestFor(id); return s ? json(s) : json({ error: "unknown patient" }, { status: 404 }); } },
    { m: "GET",  r: /^\/whoop\/history\/([^/]+)$/,         h: (_, id) => { const h = historyFor(id); return h ? json(h) : json({ error: "unknown patient" }, { status: 404 }); } },
    { m: "GET",  r: /^\/consent\/([^/]+)$/,                h: (_, id) => json(consentFor(id)) },
    { m: "PUT",  r: /^\/consent\/([^/]+)$/,                h: async (req, id) => { const b = await req.json().catch(() => ({})); return json(setConsentFor(id, b?.allow ?? [])); } },

    // Pipeline
    { m: "POST", r: /^\/sync\/([^/]+)$/,                   h: async (req, id) => { const b = await req.json().catch(() => ({})); const { status, body } = await runSync(id, b); return json(body, { status }); } },
    { m: "GET",  r: /^\/mapping$/,                         h: () => json({ loinc: LOINC_MAPPING, unmapped: UNMAPPED_WHOOP_FIELDS }) },
    { m: "GET",  r: /^\/compatibility\/([^/]+)$/,          h: (_, id) => { const c = compatibilityFor(id); return c ? json(c) : json({ error: "unknown patient" }, { status: 404 }); } },

    // Hospital read side
    { m: "GET",  r: /^\/hospital\/records$/,               h: () => json(getRecords()) },
    { m: "GET",  r: /^\/hospital\/records\/([^/]+)$/,      h: (_, id) => { const r = getRecords().find((x) => x.id === id); return r ? json(r) : json({ error: "not found" }, { status: 404 }); } },
    { m: "GET",  r: /^\/hospital\/patients\/([^/]+)\/records$/, h: (_, ref) => json(getRecords().filter((r) => r.patient?.id === ref || `Patient/${r.patient?.id}` === ref)) },

    // Events (SSE handled separately; /events returns the ring buffer)
    { m: "GET",  r: /^\/events$/,                          h: () => json(getEvents().slice().reverse()) },

    // FHIR read for the hospital-integration demo page
    { m: "GET",  r: /^\/fhir\/Observation$/,               h: () => {
      const records = getRecords();
      const entries = records.flatMap((r) => (r.bundle?.entry || []).map((e, i) => ({
        resource: { ...e.resource, id: `${r.id}-${i}`, meta: { versionId: "1", lastUpdated: e.resource.effectiveDateTime } },
      })));
      return json({ resourceType: "Bundle", type: "searchset", entry: entries });
    } },
  ];

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function mockFetch(input, init) {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method || (typeof input === "object" ? input.method : null) || "GET").toUpperCase();
    let pathname;
    try { pathname = new URL(url, window.location.origin).pathname; }
    catch { return originalFetch(input, init); }

    for (const route of routes) {
      if (route.m !== method) continue;
      const m = pathname.match(route.r);
      if (!m) continue;
      // Build a lightweight req shim so handlers can call req.json() without
      // needing a full Request object (which rejects relative URLs in Node).
      const req = {
        async json() {
          if (typeof input === "object" && typeof input.json === "function") return input.json();
          const body = init?.body;
          if (body == null) return {};
          if (typeof body === "string") { try { return JSON.parse(body); } catch { return {}; } }
          return body;
        },
      };
      try {
        return await route.h(req, ...m.slice(1));
      } catch (err) {
        return json({ error: String(err) }, { status: 500 });
      }
    }
    // Not a mocked route — pass through (e.g. fonts, assets).
    return originalFetch(input, init);
  };

  // Seed a bit of activity so first-page loads aren't blank.
  if (getRecords().length === 0 && getEvents().length === 0) {
    pushEvent({ patientId: "pt-001", stage: "info", level: "info", message: "demo backend ready · hit SYNC on the phone to see the pipeline" });
  }
})();
