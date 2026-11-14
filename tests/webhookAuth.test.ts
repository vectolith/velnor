import { authorizeGatewayRequest } from "../src/lib/security/gatewayAuth";
import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import {
  authorizeCronRequest,
  authorizeJsonWebhook,
  authorizeSlackRequest,
  authorizeTwilioRequest,
  computeSlackSignature,
  computeTwilioSignature,
  isSimulatorAllowed,
  publicRequestUrl,
  verifySlackSignature,
  verifyTwilioSignature,
} from "../src/lib/security/webhookAuth";

// NODE_ENV is typed read-only by Next's types; these tests need to flip it.
const mutableEnv = process.env as Record<string, string | undefined>;

const TWILIO_TOKEN = "test-twilio-token";
const SLACK_SECRET = "test-slack-signing-secret";
const URL_PATH = "https://example.test/api/webhooks/imessage";

const twilioParams = { From: "+15550100000", Body: "hello", NumMedia: "0" };

test("twilio: a correctly signed request is accepted", () => {
  const signature = computeTwilioSignature(TWILIO_TOKEN, URL_PATH, twilioParams);
  const decision = authorizeTwilioRequest({
    authToken: TWILIO_TOKEN,
    signature,
    url: URL_PATH,
    params: twilioParams,
    simulator: false,
  });
  assert.deepEqual(decision, { ok: true });
});

test("twilio: a signature over different params is rejected", () => {
  const signature = computeTwilioSignature(TWILIO_TOKEN, URL_PATH, {
    ...twilioParams,
    Body: "tampered",
  });
  const decision = authorizeTwilioRequest({
    authToken: TWILIO_TOKEN,
    signature,
    url: URL_PATH,
    params: twilioParams,
    simulator: false,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 401);
});

test("twilio: a missing signature is rejected, not ignored", () => {
  const decision = authorizeTwilioRequest({
    authToken: TWILIO_TOKEN,
    signature: null,
    url: URL_PATH,
    params: twilioParams,
    simulator: false,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 401);
  assert.match(String(decision.error), /Missing X-Twilio-Signature/);
});

test("twilio: an unconfigured token fails closed with 503", () => {
  const decision = authorizeTwilioRequest({
    authToken: undefined,
    signature: computeTwilioSignature(TWILIO_TOKEN, URL_PATH, twilioParams),
    url: URL_PATH,
    params: twilioParams,
    simulator: false,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 503);
});

test("slack: a fresh, correctly signed request is accepted", () => {
  const now = 1_700_000_000_000;
  const timestamp = String(Math.floor(now / 1000));
  const rawBody = JSON.stringify({ type: "event_callback", event: {} });
  const signature = computeSlackSignature(SLACK_SECRET, timestamp, rawBody);
  const decision = authorizeSlackRequest({
    signingSecret: SLACK_SECRET,
    rawBody,
    timestamp,
    signature,
    simulator: false,
    nowMs: now,
  });
  assert.deepEqual(decision, { ok: true });
});

test("slack: a stale timestamp is rejected even with a valid signature", () => {
  const now = 1_700_000_000_000;
  const timestamp = String(Math.floor(now / 1000) - 600);
  const rawBody = "{}";
  const signature = computeSlackSignature(SLACK_SECRET, timestamp, rawBody);
  assert.equal(verifySlackSignature(rawBody, timestamp, signature, SLACK_SECRET, now), false);
  const decision = authorizeSlackRequest({
    signingSecret: SLACK_SECRET,
    rawBody,
    timestamp,
    signature,
    simulator: false,
    nowMs: now,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 401);
});

test("slack: a timestamp from the future is rejected", () => {
  const now = 1_700_000_000_000;
  const timestamp = String(Math.floor(now / 1000) + 900);
  const rawBody = "{}";
  const signature = computeSlackSignature(SLACK_SECRET, timestamp, rawBody);
  assert.equal(verifySlackSignature(rawBody, timestamp, signature, SLACK_SECRET, now), false);
});

test("slack: missing signature or timestamp is rejected", () => {
  assert.equal(verifySlackSignature("{}", null, "v0=abc", SLACK_SECRET), false);
  assert.equal(verifySlackSignature("{}", "1700000000", null, SLACK_SECRET), false);
  const decision = authorizeSlackRequest({
    signingSecret: SLACK_SECRET,
    rawBody: "{}",
    timestamp: null,
    signature: null,
    simulator: false,
  });
  assert.equal(decision.status, 401);
});

test("slack: an unconfigured signing secret fails closed with 503", () => {
  const decision = authorizeSlackRequest({
    signingSecret: undefined,
    rawBody: "{}",
    timestamp: String(Math.floor(Date.now() / 1000)),
    signature: "v0=deadbeef",
    simulator: false,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 503);
});

test("json webhooks: matching secret is accepted, mismatch and absence are rejected", () => {
  const ok = authorizeJsonWebhook({ secrets: ["s3cret"], provided: "s3cret", simulator: false });
  assert.deepEqual(ok, { ok: true });

  const wrong = authorizeJsonWebhook({ secrets: ["s3cret"], provided: "nope", simulator: false });
  assert.equal(wrong.status, 401);

  const missing = authorizeJsonWebhook({ secrets: ["s3cret"], provided: null, simulator: false });
  assert.equal(missing.status, 401);
});

test("json webhooks: no configured secret fails closed in production, allowed in development", () => {
  const originalEnv = process.env.NODE_ENV;
  try {
    mutableEnv.NODE_ENV = "production";
    const prod = authorizeJsonWebhook({ secrets: [undefined], provided: "anything", simulator: false });
    assert.equal(prod.status, 503);

    mutableEnv.NODE_ENV = "development";
    const dev = authorizeJsonWebhook({ secrets: [undefined], provided: null, simulator: false });
    assert.deepEqual(dev, { ok: true });
  } finally {
    mutableEnv.NODE_ENV = originalEnv;
  }
});

test("simulator header cannot bypass auth in production", () => {
  const originalEnv = process.env.NODE_ENV;
  const originalFlag = process.env.VELNOR_ALLOW_SIMULATOR;
  try {
    mutableEnv.NODE_ENV = "production";
    process.env.VELNOR_ALLOW_SIMULATOR = "1";
    assert.equal(isSimulatorAllowed("true"), false);

    const decision = authorizeTwilioRequest({
      authToken: TWILIO_TOKEN,
      signature: null,
      url: URL_PATH,
      params: twilioParams,
      simulator: isSimulatorAllowed("true"),
    });
    assert.equal(decision.ok, false);

    mutableEnv.NODE_ENV = "development";
    assert.equal(isSimulatorAllowed("true"), true);
    process.env.VELNOR_ALLOW_SIMULATOR = "0";
    assert.equal(isSimulatorAllowed("true"), false);
  } finally {
    mutableEnv.NODE_ENV = originalEnv;
    if (originalFlag === undefined) delete process.env.VELNOR_ALLOW_SIMULATOR;
    else process.env.VELNOR_ALLOW_SIMULATOR = originalFlag;
  }
});

test("twilio signature implements the documented algorithm", () => {
  // Independent reimplementation of Twilio's documented HMAC-SHA1 scheme.
  const params = { a: "1", b: "2" };
  const expected = crypto
    .createHmac("sha1", "token")
    .update(URL_PATH + "a" + params.a + "b" + params.b)
    .digest("base64");
  assert.equal(computeTwilioSignature("token", URL_PATH, params), expected);
});

test("gateway perimeter requires its dedicated strong secret", () => {
  const secret = "dedicated-gateway-secret-with-at-least-32-characters";
  assert.equal(authorizeGatewayRequest(undefined, secret).status, 503);
  assert.equal(authorizeGatewayRequest("short", "short").status, 503);
  assert.equal(authorizeGatewayRequest(secret, "admin-token").status, 401);
  assert.equal(authorizeGatewayRequest(secret, secret).ok, true);
});

test("cron endpoints fail closed without a strong secret and reject mismatches", () => {
  assert.equal(authorizeCronRequest(undefined, "anything").status, 503);
  assert.equal(authorizeCronRequest("x".repeat(31), "x".repeat(31)).status, 503);
  assert.equal(authorizeCronRequest("x".repeat(32), "wrong").status, 401);
  assert.deepEqual(authorizeCronRequest("x".repeat(32), "x".repeat(32)), { ok: true });
});

test("Twilio signature URL ignores spoofable forwarded and Host headers", () => {
  const originalEnv = process.env.VELNOR_PUBLIC_URL;
  const originalNodeEnv = process.env.NODE_ENV;
  try {
    mutableEnv.NODE_ENV = "production";
    mutableEnv.VELNOR_PUBLIC_URL = "https://api.velnor.ai";
    const url = publicRequestUrl({
      nextUrl: {
        origin: "http://attacker.example",
        pathname: "/api/webhooks/imessage",
        search: "?x=1",
      },
    });
    assert.equal(url, "https://api.velnor.ai/api/webhooks/imessage?x=1");
  } finally {
    mutableEnv.NODE_ENV = originalNodeEnv;
    if (originalEnv === undefined) delete process.env.VELNOR_PUBLIC_URL;
    else process.env.VELNOR_PUBLIC_URL = originalEnv;
  }
});
