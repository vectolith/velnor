/**
 * The deploy script and the preflight tell operators two different stories unless
 * something ties them together: preflight can demand a variable that the script
 * then declines to forward, and the deployed service quietly loses that feature.
 * SLACK_BOT_TOKEN shipped that way once, which is why this exists.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../deploy-cloudrun.ps1", import.meta.url), "utf8");
const preflight = readFileSync(new URL("../scripts/preflight-deploy.mjs", import.meta.url), "utf8");

/** Names in the REQUIRED and RECOMMENDED tables: the operator's checklist. */
function contractVariables(source: string): string[] {
  return [...source.matchAll(/^\s*\["([A-Z0-9_]+)",/gm)].map((m) => m[1]);
}

test("every variable the preflight asks for is forwarded by the deploy script", () => {
  const wanted = contractVariables(preflight);
  assert.ok(wanted.length >= 6, `expected a real checklist, saw ${wanted.join(", ")}`);
  // Required secrets ride in as $envPairs entries ("NAME=$env:NAME"), the rest through
  // the optional loop, so match the name rather than one particular spelling.
  const missing = wanted.filter((name) => !new RegExp(`\\b${name}\\b`).test(script));
  assert.deepEqual(missing, [], `deploy-cloudrun.ps1 never passes: ${missing.join(", ")}`);
});

test("the Slack credentials that make the installed app work are both forwarded", () => {
  for (const name of ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "SLACK_CHANNEL"]) {
    assert.ok(new RegExp(`"${name}"`).test(script), `${name} is not forwarded to Cloud Run`);
  }
});

test("the deploy fails closed before it builds anything", () => {
  const preflightCall = script.indexOf("node scripts/preflight-deploy.mjs");
  const deploy = script.indexOf('"run", "deploy"');
  assert.ok(preflightCall > 0, "the script does not run the preflight at all");
  assert.ok(preflightCall < deploy, "the preflight must run before gcloud deploy");
  assert.match(script, /exit 1/, "a failed preflight has to stop the deploy");
});
