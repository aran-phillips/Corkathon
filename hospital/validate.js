// Minimal FHIR Bundle validator. Not spec-complete; checks the fields the
// gateway is expected to produce. Returns { ok, errors, accepted }.

const REQUIRED_OBSERVATION_FIELDS = ["status", "code", "subject", "effectiveDateTime", "valueQuantity"];

export function validateBundle(bundle) {
  const errors = [];
  const accepted = [];

  if (!bundle || typeof bundle !== "object") {
    return { ok: false, errors: ["body is not an object"], accepted };
  }
  if (bundle.resourceType !== "Bundle") {
    errors.push(`resourceType must be "Bundle", got ${bundle.resourceType}`);
  }
  if (bundle.type !== "transaction") {
    errors.push(`Bundle.type must be "transaction", got ${bundle.type}`);
  }
  if (!Array.isArray(bundle.entry) || bundle.entry.length === 0) {
    errors.push("Bundle.entry must be a non-empty array");
    return { ok: false, errors, accepted };
  }

  bundle.entry.forEach((entry, i) => {
    const r = entry?.resource;
    const path = `entry[${i}]`;
    if (!r || r.resourceType !== "Observation") {
      errors.push(`${path}: only Observation resources are accepted`);
      return;
    }
    for (const f of REQUIRED_OBSERVATION_FIELDS) {
      if (r[f] === undefined) errors.push(`${path}.${f} is missing`);
    }
    const code = r.code?.coding?.[0]?.code;
    const subject = r.subject?.reference;
    const value = r.valueQuantity?.value;
    const unit = r.valueQuantity?.unit;
    if (!code) errors.push(`${path}.code.coding[0].code missing`);
    if (!subject?.startsWith("Patient/")) errors.push(`${path}.subject.reference must start with "Patient/"`);
    if (typeof value !== "number" || Number.isNaN(value)) errors.push(`${path}.valueQuantity.value must be a number`);
    if (!unit) errors.push(`${path}.valueQuantity.unit missing`);
    if (code && subject && typeof value === "number") {
      accepted.push({ code, subject, value, unit, effectiveDateTime: r.effectiveDateTime });
    }
  });

  return { ok: errors.length === 0, errors, accepted };
}
