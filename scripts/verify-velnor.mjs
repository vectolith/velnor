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

const BASE = process.env.VELNOR_VERIFY_BASE_URL || "http://localhost:3000";
const SHARED_SECRET = process.env.VELNOR_SHARED_SECRET || "";
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const SLACK_SECRET = process.env.SLACK_SIGNING_SECRET || "";

let failures = 0;

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
    report(name, false, err instanceof Error ? err.message : String(err));
  }
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

await check("GET /api/chat with the shared secret returns state", async () => {
  const res = await fetch(`${BASE}/api/chat`, { headers: auth });
  assert(res.status === 200, `status ${res.status}`);
  const body = await res.json();
  assert(Array.isArray(body.messages), "messages array missing");
});

await check("POST /api/chat records a turn for that user and it is readable back", async () => {
  const marker = `verify-${Date.now()}`;
  const userHeaders = { ...auth, "x-velnor-user": "verify-user" };
  const saved = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { ...userHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      channel: "imessage",
      userHandle: "verify-user",
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

await check("POST /api/webhooks/imessage with a valid Twilio signature returns TwiML", async () => {
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

await check("POST /api/webhooks/imessage without a signature is rejected", async () => {
  const res = await fetch(`${BASE}/api/webhooks/imessage`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "From=%2B15550100001&Body=ping&NumMedia=0",
  });
  assert(res.status === 401, `expected 401, got ${res.status}`);
});

await check("POST /api/webhooks/imessage accepts JSON only with the webhook secret", async () => {
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

await check("POST /api/webhooks/slack with a fresh signature returns Block Kit", async () => {
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

await check("POST /api/webhooks/slack with a stale signature is rejected", async () => {
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

await check("GET /api/vcard returns a contact card", async () => {
  const res = await fetch(`${BASE}/api/vcard`, { headers: auth });
  assert(res.status === 200, `status ${res.status}`);
  const text = await res.text();
  assert(text.includes("BEGIN:VCARD"), "not a vCard");
});

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
