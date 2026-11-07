// Claude-powered translator. Person B owns this — right now it is a stub
// that returns null so the pipeline falls back to the rule-based translator.
//
// When wiring up for real, keep this contract:
//   input: { snapshot, consent }
//   output: { bundle } on success, { error } on failure
// The gateway runs the rule-based translator in parallel and compares.

export async function translateWithClaude(_snapshot, _consent) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { bundle: null, error: "ANTHROPIC_API_KEY not set" };
  }
  // TODO Person B:
  //   1) Build a prompt that describes the Whoop snapshot + the consent list
  //      and asks Claude to emit the FHIR Bundle in the exact shape from
  //      contracts/sample-bundle.json.
  //   2) Call messages.create with response_format JSON, extract the bundle.
  //   3) Return { bundle } on success. On any parse error, return { error }.
  return { bundle: null, error: "AI translator not yet implemented" };
}
