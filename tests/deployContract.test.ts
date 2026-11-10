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

// The Oracle Cloud bundle is the deployment these files describe, so it has to
// honour the same contract as the Cloud Run script rather than drift from it.
const oci = (name: string) =>
  readFileSync(new URL(`../deploy/oci/${name}`, import.meta.url), "utf8");

/** One service's block, so an assertion cannot accidentally read a neighbour's keys. */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${name}:`);
  assert.ok(start >= 0, `${name} is not a service in the compose file`);
  const after = lines.slice(start + 1).findIndex((line) => /^  [a-z]/.test(line));
  return lines.slice(start, after < 0 ? undefined : start + 1 + after).join("\n");
}

test("the OCI stack keeps the app off the public internet", () => {
  const compose = oci("docker-compose.yml");
  const published = compose.split("\n").filter((line) => line.includes("8080:8080"));
  assert.equal(published.length, 1, "the app port is published more than once");
  assert.match(published[0], /127\.0\.0\.1:8080:8080/, "the app port must bind to loopback");
  assert.match(compose, /velnor-data:\/app\/\.data/, "state needs the named volume");
  assert.match(compose, /"80:80"/);
  assert.match(compose, /"443:443"/);
});

test("Caddy fronts the app and only learns the hostname", () => {
  const caddyfile = oci("Caddyfile");
  const compose = oci("docker-compose.yml");
  assert.match(caddyfile, /reverse_proxy velnor:8080/);
  assert.match(caddyfile, /Strict-Transport-Security/);
  // secrets belong to the app, not to the proxy
  const caddyService = serviceBlock(compose, "caddy");
  assert.doesNotMatch(caddyService, /env_file/, "Caddy must not load the whole .env");
  assert.match(caddyService, /VELNOR_HOST/);
});

test("the VM env template can satisfy the preflight", () => {
  const template = oci(".env.example");
  const wanted = contractVariables(preflight);
  const missing = wanted.filter((name) => !new RegExp(`^${name}=`, "m").test(template));
  assert.deepEqual(missing, [], `.env.example never mentions: ${missing.join(", ")}`);
  assert.match(template, /^SLACK_CHANNEL=C0CFWLMSP9V$/m);
});
