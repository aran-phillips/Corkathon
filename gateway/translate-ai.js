import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-4-7";

const SYSTEM_PROMPT = `You translate Whoop wearable snapshots into FHIR R4 transaction Bundles for a hospital system.

LOINC codes and units to use (field -> code, display, unit):
- restingHeartRate -> 40443-4 "Resting heart rate", unit "/min"
- hrvMs            -> 80404-7 "Heart rate variability SDNN", unit "ms"
- spo2             -> 59408-5 "Oxygen saturation", unit "%"
- sleepDurationMs  -> 93832-4 "Sleep duration", unit "h" (convert ms to hours: value / 3600000)
- sleepEfficiency  -> 93829-0 "Sleep efficiency", unit "%" (convert 0..1 fraction to percent: value * 100)

Hard rules:
1. Only emit an Observation for a field that (a) appears in consent.allow AND (b) is present (not null/undefined) in the snapshot.
2. Each Observation resource must have:
   - resourceType: "Observation"
   - status: "final"
   - code.coding[0]: { system: "http://loinc.org", code, display } from the table above
   - subject.reference: "Patient/<snapshot.patient.id>"
   - effectiveDateTime: snapshot.takenAt verbatim
   - valueQuantity: { value, unit, system: "http://unitsofmeasure.org", code: unit }
3. Wrap each resource as { resource, request: { method: "POST", url: "Observation" } }.
4. Return Bundle: { resourceType: "Bundle", type: "transaction", entry: [...] }.
5. Round valueQuantity.value to 2 decimal places.
6. Do not invent fields or codes. If no field is both consented and present, return an empty entry array.`;

const codingItem = {
  type: "object",
  additionalProperties: false,
  properties: {
    system: { type: "string" },
    code: { type: "string" },
    display: { type: "string" },
  },
  required: ["system", "code", "display"],
};

const observationEntry = {
  type: "object",
  additionalProperties: false,
  properties: {
    resource: {
      type: "object",
      additionalProperties: false,
      properties: {
        resourceType: { type: "string", enum: ["Observation"] },
        status: { type: "string", enum: ["final"] },
        code: {
          type: "object",
          additionalProperties: false,
          properties: { coding: { type: "array", items: codingItem } },
          required: ["coding"],
        },
        subject: {
          type: "object",
          additionalProperties: false,
          properties: { reference: { type: "string" } },
          required: ["reference"],
        },
        effectiveDateTime: { type: "string" },
        valueQuantity: {
          type: "object",
          additionalProperties: false,
          properties: {
            value: { type: "number" },
            unit: { type: "string" },
            system: { type: "string" },
            code: { type: "string" },
          },
          required: ["value", "unit", "system", "code"],
        },
      },
      required: [
        "resourceType",
        "status",
        "code",
        "subject",
        "effectiveDateTime",
        "valueQuantity",
      ],
    },
    request: {
      type: "object",
      additionalProperties: false,
      properties: {
        method: { type: "string", enum: ["POST"] },
        url: { type: "string", enum: ["Observation"] },
      },
      required: ["method", "url"],
    },
  },
  required: ["resource", "request"],
};

const BUNDLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    resourceType: { type: "string", enum: ["Bundle"] },
    type: { type: "string", enum: ["transaction"] },
    entry: { type: "array", items: observationEntry },
  },
  required: ["resourceType", "type", "entry"],
};

let client;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

function sanityCheck(bundle) {
  if (!bundle || typeof bundle !== "object") return "not an object";
  if (bundle.resourceType !== "Bundle") return "resourceType must be Bundle";
  if (bundle.type !== "transaction") return "type must be transaction";
  if (!Array.isArray(bundle.entry)) return "entry must be an array";
  if (bundle.entry.length === 0) return "entry is empty";
  for (let i = 0; i < bundle.entry.length; i++) {
    const r = bundle.entry[i]?.resource;
    if (!r || r.resourceType !== "Observation") return `entry[${i}] not an Observation`;
    if (!r.code?.coding?.[0]?.code) return `entry[${i}].code missing`;
    if (!r.subject?.reference?.startsWith("Patient/")) return `entry[${i}].subject invalid`;
    if (typeof r.valueQuantity?.value !== "number") return `entry[${i}].valueQuantity.value not a number`;
  }
  return null;
}

export async function translateWithClaude(snapshot, consent) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { bundle: null, error: "ANTHROPIC_API_KEY not set" };
  }

  let response;
  try {
    response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 4096,
      output_config: {
        format: { type: "json_schema", schema: BUNDLE_SCHEMA },
      },
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: `Snapshot:\n${JSON.stringify(snapshot)}\n\nConsent:\n${JSON.stringify(consent)}\n\nReturn the Bundle.`,
        },
      ],
    });
  } catch (err) {
    return { bundle: null, error: `claude call failed: ${err.message}` };
  }

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text) return { bundle: null, error: "no text in response" };

  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch (err) {
    return { bundle: null, error: `json parse failed: ${err.message}` };
  }

  const problem = sanityCheck(bundle);
  if (problem) return { bundle: null, error: `sanity check failed: ${problem}` };

  return { bundle };
}
