import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-sendblue-"));
process.env.VELNOR_DATA_DIR = dataDir;

import { mapSendblueStatus } from "../src/lib/channels/sendblue";
import { sendTrackedSendblueMessage } from "../src/lib/channels/trackedSendblueSend";
import { normalizeE164, resolveSendblueConfig } from "../src/lib/channels/sendblueConfig";
import {
  beginLoopMessageAttempt, finishLoopMessageAttempt, getLatestLoopMessageAttempt,
} from "../src/lib/channels/imessageDeliveryAttempts";
import { applyPendingSendblueStatus, syncSendblueStatusCallback } from "../src/lib/channels/sendblueStatusStore";
import { claimInboundWebhookEvent, releaseInboundWebhookEvent } from "../src/lib/security/inboundWebhookStore";
import { closeSqliteDb } from "../src/lib/sqliteDb";

test("Sendblue numbers are normalised to E.164 or rejected", () => {
  assert.equal(normalizeE164("+1 (808) 319-9759"), "+18083199759");
  assert.equal(normalizeE164("808 319 9759"), "+18083199759");
  assert.equal(normalizeE164("18083199759"), "+18083199759");
  assert.equal(normalizeE164("0044 20 7946 0958"), "+442079460958");
  assert.equal(normalizeE164("12345"), null);
  assert.equal(normalizeE164(""), null);
  assert.equal(normalizeE164(undefined), null);
});

test("Sendblue config prefers workspace values and reports every gap", () => {
  const report = resolveSendblueConfig(
    { sendblueApiKey: "tenant-key", sendblueFromNumber: "(808) 319-9759" },
    { SENDBLUE_API_KEY: "env-key", SENDBLUE_API_SECRET: "env-secret", SENDBLUE_FROM_NUMBER: "+15550001111" } as unknown as NodeJS.ProcessEnv,
  );
  assert.equal(report.config.apiKeyId, "tenant-key");
  assert.equal(report.config.apiSecret, "env-secret");
  assert.equal(report.config.fromNumber, "+18083199759");
  assert.equal(report.configured, true);

  const empty = resolveSendblueConfig({}, {} as NodeJS.ProcessEnv);
  assert.equal(empty.configured, false);
  assert.equal(empty.issues.length, 3);

  const badNumber = resolveSendblueConfig({}, { SENDBLUE_API_KEY: "k", SENDBLUE_API_SECRET: "s", SENDBLUE_FROM_NUMBER: "abc" } as unknown as NodeJS.ProcessEnv);
  assert.equal(badNumber.configured, false);
  assert.match(badNumber.issues.join(" "), /E\.164/);
});

test("Sendblue statuses map without inventing delivery", () => {
  assert.equal(mapSendblueStatus("QUEUED"), "queued");
  assert.equal(mapSendblueStatus("SENT"), "queued");
  assert.equal(mapSendblueStatus("RECEIVED"), "processing");
  assert.equal(mapSendblueStatus("DELIVERED"), "delivered");
  assert.equal(mapSendblueStatus("ERROR"), "failed");
  assert.equal(mapSendblueStatus("DECLINED"), "failed");
  assert.equal(mapSendblueStatus("who knows"), "unknown");
});

test("Sendblue receipts update the attempt and never regress delivery", () => {
  try {
    const attempt = beginLoopMessageAttempt({
      provider: "sendblue", tenantId: "tenant-sb", taskId: "task-sb",
      recipient: "+18083199759", senderId: "+15550001111",
    });
    finishLoopMessageAttempt(attempt.attemptId, { state: "queued", messageId: "handle-1" });

    assert.equal(syncSendblueStatusCallback({ messageHandle: "handle-1", status: "DELIVERED" }), "applied");
    let latest = getLatestLoopMessageAttempt("tenant-sb", "task-sb", "sendblue");
    assert.equal(latest?.state, "delivered");

    assert.equal(syncSendblueStatusCallback({ messageHandle: "handle-1", status: "ERROR", errorDetail: "late" }), "duplicate");
    latest = getLatestLoopMessageAttempt("tenant-sb", "task-sb", "sendblue");
    assert.equal(latest?.state, "delivered");
  } finally {
    closeSqliteDb();
  }
});

test("Early Sendblue receipts are buffered then applied once the handle is stored", () => {
  try {
    assert.equal(syncSendblueStatusCallback({ messageHandle: "handle-early", status: "DELIVERED" }), "pending");
    assert.equal(applyPendingSendblueStatus("handle-early"), "pending");

    const attempt = beginLoopMessageAttempt({
      provider: "sendblue", tenantId: "tenant-sb2", taskId: "task-sb2",
      recipient: "+18083199759", senderId: "+15550001111",
    });
    finishLoopMessageAttempt(attempt.attemptId, { state: "queued", messageId: "handle-early" });
    assert.equal(applyPendingSendblueStatus("handle-early"), "applied");
    assert.equal(getLatestLoopMessageAttempt("tenant-sb2", "task-sb2", "sendblue")?.state, "delivered");
    assert.equal(applyPendingSendblueStatus("handle-early"), "duplicate");
  } finally {
    closeSqliteDb();
  }
});

test("Inbound webhook claims are durable, unique, and releasable", () => {
  try {
    assert.equal(claimInboundWebhookEvent({ provider: "sendblue", eventKey: "msg-1" }), "new");
    assert.equal(claimInboundWebhookEvent({ provider: "sendblue", eventKey: "msg-1" }), "duplicate");
    assert.equal(claimInboundWebhookEvent({ provider: "loopmessage", eventKey: "msg-1" }), "new");
    releaseInboundWebhookEvent("sendblue", "msg-1");
    assert.equal(claimInboundWebhookEvent({ provider: "sendblue", eventKey: "msg-1" }), "new");
  } finally {
    closeSqliteDb();
  }
});


test("Sendblue tracked sender blocks a second send while a prior attempt is queued", async () => {
  const queued = beginLoopMessageAttempt({
    provider: "sendblue", tenantId: "tenant-guard", taskId: "sendblue-queued",
    recipient: "+15550001", senderId: "+15550002",
  });
  finishLoopMessageAttempt(queued.attemptId, { state: "queued", messageId: "queued-sendblue" });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "second-send" }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await sendTrackedSendblueMessage({
      tenantId: "tenant-guard", taskId: "sendblue-queued", recipient: "+15550001",
      senderId: "+15550002", config: { apiKeyId: "key", apiSecret: "secret", fromNumber: "+15550002" },
      text: "must not duplicate",
    });
    assert.equal(result.result.ok, false);
    assert.match(result.result.detail || "", /pending or in progress|delivered/i);
    assert.equal(result.attempt.attemptId, queued.attemptId);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
