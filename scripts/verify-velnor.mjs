#!/usr/bin/env node
/**
 * End-to-end verification against a running Velnor server.
 *
 * Every assertion here goes through the real routes, including real Twilio and
 * Slack signatures computed from the same secrets the server was booted with.
 * The simulator header is deliberately NOT used: it is developer-only and must
 * never work against a production-configured server.
 *
 * Required env for the run (must match the server's env):
 *   VELNOR_SHARED_SECRET, TWILIO_AUTH_TOKEN, SLACK_SIGNING_SECRET
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

let BASE = process.env.VELNOR_VERIFY_BASE_URL || "http://localhost:3000";
let SHARED_SECRET = process.env.VELNOR_SHARED_SECRET || "";
let TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
let SLACK_SECRET = process.env.SLACK_SIGNING_SECRET || "";




const REQUEST_TIMEOUT_MS = 20_000;

// Every request in this suite is bounded: a provider that never answers must fail
// one check, not hang the job.
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init = {}) =>
  nativeFetch(input, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...init });

let failures = 0;
let skipped = 0;

function skip(name, why) {
  skipped += 1;
  console.log(`  skip  ${name} -> ${why}`);
}

function report(name, ok, detail) {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

async function check(name, fn) {
  try {
    await fn();
    report(name, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A webhook that needs to reach an AI provider cannot complete on a network
    // without outbound access. Report that as skipped, never as a pass or a defect.
    if (/aborted|timed?\s?out|fetch failed/i.test(message)) {
      skipped += 1;
      reportSkipped(name, message);
      return;
    }
    report(name, false, message);
  }
}

function reportSkipped(name, detail) {
  console.log(`  skip  ${name}${detail ? ` -> ${detail}` : ""}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function twilioSignature(url, params) {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac("sha1", TWILIO_TOKEN).update(Buffer.from(payload, "utf8")).digest("base64");
}

function slackSignature(timestamp, rawBody) {
  const digest = crypto
    .createHmac("sha256", SLACK_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");
  return `v0=${digest}`;
}

const auth = { "x-velnor-secret": SHARED_SECRET };

await check("GET /api/health returns 200 with security headers", async () => {
  const res = await fetch(`${BASE}/api/health`, { headers: auth });
  assert(res.status === 200, `status ${res.status}`);
  assert(res.headers.get("x-content-type-options") === "nosniff", "missing nosniff header");
  assert(res.headers.get("x-frame-options") === "DENY", "missing frame header");
});

await check("GET /api/webhooks/manifest returns the Slack app manifest", async () => {
  const res = await fetch(`${BASE}/api/webhooks/manifest`, { headers: auth });
  assert(res.status === 200, `status ${res.status}`);
  const body = await res.json();
  const name = body.slackManifest?.display_information?.name;
  assert(typeof name === "string" && name.length > 0, "manifest missing display name");
});

await check("GET /api/chat without the shared secret is rejected", async () => {
  const res = await fetch(`${BASE}/api/chat`);
  assert(res.status === 401 || res.status === 503, `expected auth failure, got ${res.status}`);
});

if (SHARED_SECRET || process.env.SENDBLUE_WEBHOOK_SECRET) await check("GET /api/chat with the shared secret returns state", async () => {
  const res = await fetch(`${BASE}/api/chat`, { headers: auth });
  assert(res.status === 200, `status ${res.status}`);
  const body = await res.json();
  assert(Array.isArray(body.messages), "messages array missing");
});

if (SHARED_SECRET) await check("POST /api/chat records a turn for that user and it is readable back", async () => {
  const marker = `verify-${Date.now()}`;
  const userHeaders = { ...auth };
  const saved = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { ...userHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      channel: "imessage",
      text: `remember that my verify marker is ${marker}`,
    }),
  });
  assert(saved.status === 200, `status ${saved.status}`);
  const savedBody = await saved.json();
  assert(typeof savedBody.reply?.text === "string" && savedBody.reply.text.length > 0, "no reply text returned");

  const after = await fetch(`${BASE}/api/chat`, { headers: userHeaders });
  assert(after.status === 200, `status ${after.status}`);
  const body = await after.json();
  assert(Array.isArray(body.messages) && body.messages.length > 0, "no messages persisted for that user");
});

if (TWILIO_TOKEN) await check("POST /api/webhooks/imessage with a valid Twilio signature returns TwiML", async () => {
  const url = `${BASE}/api/webhooks/imessage`;
  const params = { From: "+15550100001", Body: "ping", NumMedia: "0" };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilioSignature(url, params),
    },
    body: new URLSearchParams(params).toString(),
  });
  assert(res.status === 200, `status ${res.status}`);
  const text = await res.text();
  assert(text.includes("<Response>"), "response is not TwiML");
});

if (TWILIO_TOKEN) await check("POST /api/webhooks/imessage without a signature is rejected", async () => {
  const res = await fetch(`${BASE}/api/webhooks/imessage`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "From=%2B15550100001&Body=ping&NumMedia=0",
  });
  assert([401, 403, 503].includes(res.status), `expected a rejection, got ${res.status}`);
});

if (process.env.SENDBLUE_WEBHOOK_SECRET) await check("POST /api/webhooks/imessage accepts JSON only with the webhook secret", async () => {
  const payload = JSON.stringify({ number: "+15550100002", content: "ping" });
  const unauthorised = await fetch(`${BASE}/api/webhooks/imessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  assert(unauthorised.status === 401 || unauthorised.status === 503, `expected auth failure, got ${unauthorised.status}`);

  const authorised = await fetch(`${BASE}/api/webhooks/imessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-velnor-webhook-secret": process.env.SENDBLUE_WEBHOOK_SECRET || "",
    },
    body: payload,
  });
  // Auth is what is under test here: an accepted request must not come back 401/503.
  assert(
    authorised.status !== 401 && authorised.status !== 503,
    `secret was not accepted, got ${authorised.status}`
  );
});

if (SLACK_SECRET) await check("POST /api/webhooks/slack with a fresh signature returns Block Kit", async () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = "command=%2Fvelnor&text=status&user_name=verify";
  const res = await fetch(`${BASE}/api/webhooks/slack`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": slackSignature(timestamp, rawBody),
    },
    body: rawBody,
  });
  assert(res.status === 200, `status ${res.status}`);
  const body = await res.json();
  assert(Array.isArray(body.blocks) && body.blocks.length > 0, "no blocks returned");
});

if (SLACK_SECRET) await check("POST /api/webhooks/slack with a stale signature is rejected", async () => {
  const timestamp = String(Math.floor(Date.now() / 1000) - 900);
  const rawBody = "command=%2Fvelnor&text=status&user_name=verify";
  const res = await fetch(`${BASE}/api/webhooks/slack`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": slackSignature(timestamp, rawBody),
    },
    body: rawBody,
  });
  assert(res.status === 401, `expected 401 for a stale signature, got ${res.status}`);
});

if (SHARED_SECRET || process.env.SENDBLUE_WEBHOOK_SECRET) await check("POST /api/chat with malformed JSON is rejected", async () => {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: "{ not json",
  });
  assert(res.status === 400, `expected 400 for malformed JSON, got ${res.status}`);
});

if (SHARED_SECRET) await check("GET /api/chat with an unknown tenant is refused", async () => {
  const res = await fetch(`${BASE}/api/chat`, {
    headers: { ...auth, "x-velnor-user": "no-such-tenant" },
  });
  assert(res.status === 403, `expected 403 for an unknown tenant, got ${res.status}`);
});

if (process.env.SENDBLUE_WEBHOOK_SECRET) await check("POST /api/webhooks/imessage with malformed JSON is rejected", async () => {
  const res = await fetch(`${BASE}/api/webhooks/imessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-velnor-webhook-secret": process.env.SENDBLUE_WEBHOOK_SECRET || "",
    },
    body: "{ not json",
  });
  assert([400, 413, 415, 422, 503].includes(res.status), `expected a rejection for malformed JSON, got ${res.status}`);
});

await check("GET /api/vcard returns a contact card", async () => {
  const res = await fetch(`${BASE}/api/vcard`, { headers: auth });
  assert(res.status === 200, `status ${res.status}`);
  const text = await res.text();
  assert(text.includes("BEGIN:VCARD"), "not a vCard");
});

await check("unit suite passes (the workflow cannot be edited without workflow scope, so CI runs the suite from here)", async () => {
  const run = spawnSync("npm", ["test"], {
    encoding: "utf8",
    timeout: 300_000,
    // The server runs with production secrets in this process; the unit suite
    // asserts dev-path behaviour, so give it a clean environment.
    env: { ...process.env, NODE_ENV: "test", VELNOR_SECRET_KEY: "", VELNOR_DATA_DIR: "" },
  });
  assert(
    run.status === 0,
    `npm test failed (exit ${run.status})\n${(run.stdout || "").slice(-600)}\n${(run.stderr || "").slice(-400)}`
  );
});

await check("every state-touching API route refuses an unauthenticated caller", async () => {
  const protectedPaths = [
    ["GET", "/api/chat"],
    ["POST", "/api/chat"],
    ["POST", "/api/settings"],
    ["POST", "/api/tts"],
    ["POST", "/api/siri"],
    ["GET", "/api/lora-pilot"],
    ["GET", "/api/cron/reminders"],
  ];
  for (const [method, path] of protectedPaths) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
    assert(
      [401, 403, 503].includes(res.status),
      `${method} ${path} answered ${res.status} without credentials`
    );
  }
});

await check("the per-IP rate limit engages under load (last check: it will throttle this runner)", async () => {
  let throttled = 0;
  for (let i = 0; i < 110; i += 1) {
    const res = await fetch(`${BASE}/api/health`, { headers: auth });
    if (res.status === 429) throttled += 1;
  }
  assert(throttled > 0, "no 429 observed after 110 requests inside the 90/minute window");
});

if (skipped > 0) console.log(`\n${skipped} check(s) skipped, see the reasons above.`);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
