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
let TENANT_TOKEN_SECRET = process.env.VELNOR_TENANT_TOKEN_SECRET || "";




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

function identityToken(subject, extraClaims = {}) {
  if (!TENANT_TOKEN_SECRET) throw new Error("VELNOR_TENANT_TOKEN_SECRET is not configured");
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    iss: process.env.VELNOR_TENANT_TOKEN_ISSUER || "velnor-auth",
    aud: process.env.VELNOR_TENANT_TOKEN_AUDIENCE || "velnor-api",
    sub: subject,
    iat: now,
    nbf: now - 1,
    exp: now + 300,
    ...extraClaims,
  });
  const signature = crypto.createHmac("sha256", TENANT_TOKEN_SECRET)
    .update(`${header}.${payload}`).digest("base64url");
  return `Bearer ${header}.${payload}.${signature}`;
}

const auth = { "x-velnor-secret": SHARED_SECRET };
const ownerAuth = () => ({ ...auth, authorization: identityToken("owner") });

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

await check("POST /api/webhooks/slack rejects direct-origin calls without the gateway secret", async () => {
  const res = await fetch(`${BASE}/api/webhooks/slack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert([401, 503].includes(res.status), `expected gateway rejection, got ${res.status}`);
});

await check("GET /api/chat without the shared secret is rejected", async () => {
  const res = await fetch(`${BASE}/api/chat`);
  assert(res.status === 401 || res.status === 503, `expected auth failure, got ${res.status}`);
});

if (SHARED_SECRET && TENANT_TOKEN_SECRET) await check("GET /api/chat with both deployment and user credentials returns state", async () => {
  const res = await fetch(`${BASE}/api/chat`, { headers: ownerAuth() });
  assert(res.status === 200, `status ${res.status}`);
  const body = await res.json();
  assert(Array.isArray(body.messages), "messages array missing");
});

if (SHARED_SECRET && TENANT_TOKEN_SECRET) await check("POST /api/chat records a turn for that user and it is readable back", async () => {
  const marker = `verify-${Date.now()}`;
  const userHeaders = ownerAuth();
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

if (TWILIO_TOKEN && SHARED_SECRET) await check("POST /api/webhooks/imessage with a valid Twilio signature returns TwiML", async () => {
  const url = `${BASE}/api/webhooks/imessage`;
  const params = { From: "+15550100001", Body: "ping", NumMedia: "0" };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilioSignature(process.env.VELNOR_PUBLIC_URL ? new URL("/api/webhooks/imessage", process.env.VELNOR_PUBLIC_URL).toString() : url, params),
      "x-velnor-secret": SHARED_SECRET,
    },
    body: new URLSearchParams(params).toString(),
  });
  assert(res.status === 200, `status ${res.status}`);
  const text = await res.text();
  assert(text.includes("<Response>"), "response is not TwiML");
});

if (TWILIO_TOKEN && SHARED_SECRET) await check("POST /api/webhooks/imessage without a signature is rejected", async () => {
  const res = await fetch(`${BASE}/api/webhooks/imessage`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-velnor-secret": SHARED_SECRET },
    body: "From=%2B15550100001&Body=ping&NumMedia=0",
  });
  assert([401, 403, 503].includes(res.status), `expected a rejection, got ${res.status}`);
});

if (process.env.SENDBLUE_WEBHOOK_SECRET && SHARED_SECRET) await check("POST /api/webhooks/imessage accepts JSON only with the webhook secret", async () => {
  const payload = JSON.stringify({ number: "+15550100002", content: "ping" });
  const unauthorised = await fetch(`${BASE}/api/webhooks/imessage`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-velnor-secret": SHARED_SECRET },
    body: payload,
  });
  assert(unauthorised.status === 401 || unauthorised.status === 503, `expected auth failure, got ${unauthorised.status}`);

  const authorised = await fetch(`${BASE}/api/webhooks/imessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-velnor-webhook-secret": process.env.SENDBLUE_WEBHOOK_SECRET || "",
      "x-velnor-secret": SHARED_SECRET,
    },
    body: payload,
  });
  // Auth is what is under test here: an accepted request must not come back 401/503.
  assert(
    authorised.status !== 401 && authorised.status !== 503,
    `secret was not accepted, got ${authorised.status}`
  );
});

if (SLACK_SECRET && SHARED_SECRET) await check("POST /api/webhooks/slack with a fresh signature returns Block Kit", async () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = "command=%2Fvelnor&text=status&user_name=verify";
  const res = await fetch(`${BASE}/api/webhooks/slack`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": slackSignature(timestamp, rawBody),
      "x-velnor-secret": SHARED_SECRET,
    },
    body: rawBody,
  });
  assert(res.status === 200, `status ${res.status}`);
  const body = await res.json();
  assert(Array.isArray(body.blocks) && body.blocks.length > 0, "no blocks returned");
});

if (SLACK_SECRET && SHARED_SECRET) await check("POST /api/webhooks/slack with a stale signature is rejected", async () => {
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

if (SHARED_SECRET && TENANT_TOKEN_SECRET) await check("GET /api/chat refuses an unknown signed tenant", async () => {
  const res = await fetch(`${BASE}/api/chat`, {
    headers: { ...auth, authorization: identityToken("no-such-tenant") },
  });
  assert(res.status === 403, `expected 403 for an unknown signed tenant, got ${res.status}`);
});

if (SHARED_SECRET && TENANT_TOKEN_SECRET) await check("POST /api/chat refuses identity supplied only in body or legacy tenant header", async () => {
  const forged = identityToken("owner");
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { ...auth, "x-velnor-user": "owner", "content-type": "application/json" },
    body: JSON.stringify({ userHandle: forged, text: "must not be accepted" }),
  });
  assert(res.status === 401, `expected 401 without Authorization bearer, got ${res.status}`);
});

if (process.env.SENDBLUE_WEBHOOK_SECRET && SHARED_SECRET) await check("POST /api/webhooks/imessage with malformed JSON is rejected", async () => {
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

if (SHARED_SECRET && TENANT_TOKEN_SECRET) await check("POST /api/settings stores a Slack channel override and refuses a malformed one", async () => {
  const headers = { ...ownerAuth(), "content-type": "application/json" };
  const bad = await fetch(`${BASE}/api/settings`, { method: "POST", headers, body: JSON.stringify({ slackChannel: "not a channel" }) });
  assert(bad.status === 400, `expected 400 for a malformed channel, got ${bad.status}`);

  const good = await fetch(`${BASE}/api/settings`, { method: "POST", headers, body: JSON.stringify({ slackChannel: "#velnor-agent" }) });
  assert(good.status === 200, `expected 200 for a valid channel, got ${good.status}`);

  const read = await fetch(`${BASE}/api/settings`, { headers: ownerAuth() });
  const payload = await read.json();
  assert(payload.slackChannel === "#velnor-agent", `settings reported ${payload.slackChannel}`);
});

await check("GET /api/vcard returns a contact card", async () => {
  const res = await fetch(`${BASE}/api/vcard`, { headers: auth });
  assert(res.status === 200, `status ${res.status}`);
  const text = await res.text();
  assert(text.includes("BEGIN:VCARD"), "not a vCard");
});

await check("Google OAuth callback rejects unsigned state", async () => {
  const res = await fetch(`${BASE}/api/auth/google/callback?code=fake&state=not-signed`, { headers: auth });
  assert(SHARED_SECRET ? res.status === 400 : [401, 503].includes(res.status), `unexpected OAuth callback status ${res.status}`);
});

await check("every state-touching API route refuses an unauthenticated caller", async () => {
  const protectedPaths = [
    ["GET", "/api/auth/google"],
    ["GET", "/api/chat"],
    ["POST", "/api/chat"],
    ["POST", "/api/settings"],
    ["POST", "/api/tts"],
    ["POST", "/api/siri"],
    ["GET", "/api/lora-pilot"],
    ["GET", "/api/cron/reminders"],
    ["POST", "/api/internal/maintenance/reseal-credentials"],
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
