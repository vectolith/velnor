import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-imessage-attempts-"));
process.env.VELNOR_DATA_DIR = dataDir;

import {
  beginLoopMessageAttempt, getLatestLoopMessageAttempt, listLoopMessageAttempts,
  recoverStaleLoopMessageAttempts, LoopMessageAttemptInFlightError,
} from "../src/lib/channels/imessageDeliveryAttempts";
import { getLoopMessageDelivery, processLoopMessageCallbackPayload } from "../src/lib/channels/imessageDeliveryStore";
import { sendTrackedLoopMessage } from "../src/lib/channels/trackedLoopMessageSend";
import { closeSqliteDb, getSqliteDb } from "../src/lib/sqliteDb";

const originalFetch = globalThis.fetch;

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input.url);
    return handler(url, init);
  }) as typeof fetch;
}

function reset() {
  globalThis.fetch = originalFetch;
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
}

const base = {
  tenantId: "tenant-retry", taskId: "task_11111111-1111-1111-1111-111111111111",
  recipient: "ganiyu@example.com", senderId: "velnor-email-sender", authKey: "test-auth-key",
  text: "Result of your task",
};

test("a pending attempt is committed before the provider request leaves the process", async () => {
  try {
    let observedInFlight = 0;
    stubFetch(async () => {
      const row = getSqliteDb()!.prepare(
        "SELECT state FROM imessage_delivery_attempts WHERE task_id = ? ORDER BY attempt_no DESC LIMIT 1",
      ).get(base.taskId) as { state: string } | undefined;
      if (row?.state === "pending_send") observedInFlight += 1;
      return new Response(JSON.stringify({ success: true, message_id: "loop-attempt-1" }), { status: 200 });
    });

    const tracked = await sendTrackedLoopMessage(base);
    assert.equal(observedInFlight, 1, "attempt row must exist before the provider call");
    assert.equal(tracked.result.ok, true);
    assert.equal(tracked.attempt.state, "queued");
    assert.equal(tracked.attempt.messageId, "loop-attempt-1");
    assert.equal(tracked.attempt.attemptNo, 1);
    assert.equal(tracked.duplicateRisk, false);
    assert.equal(getLoopMessageDelivery(base.tenantId, base.taskId)?.status, "queued");
    assert.equal(getLatestLoopMessageAttempt(base.tenantId, base.taskId)?.attemptNo, 1);
  } finally {
    reset();
    closeSqliteDb();
  }
});


test("a callback that arrives before the send response is reconciled into the exact attempt", async () => {
  try {
    stubFetch(async () => {
      // Simulate LoopMessage calling the webhook before the outbound request
      // returns its message_id to the sender.
      assert.equal(processLoopMessageCallbackPayload({
        event: "message_delivered",
        message_id: "loop-early-callback",
        contact: base.recipient,
      }), "unmatched");
      return new Response(JSON.stringify({ success: true, message_id: "loop-early-callback" }), { status: 200 });
    });
    const tracked = await sendTrackedLoopMessage({ ...base, taskId: "task-early-callback" });
    assert.equal(tracked.result.ok, true);
    assert.equal(tracked.attempt.state, "delivered");
    assert.equal(getLatestLoopMessageAttempt(base.tenantId, "task-early-callback")?.state, "delivered");
    assert.equal(getLoopMessageDelivery(base.tenantId, "task-early-callback")?.status, "delivered");
  } finally {
    reset();
    closeSqliteDb();
  }
});

test("a send that fails without a message ID keeps a recoverable, retryable attempt", async () => {
  try {
    stubFetch(async () => { throw new Error("socket hang up"); });
    const failed = await sendTrackedLoopMessage(base);
    assert.equal(failed.result.ok, false);
    assert.equal(failed.attempt.state, "unconfirmed");
    assert.equal(failed.duplicateRisk, true);
    assert.match(String(failed.attempt.errorDetail), /socket hang up/);
    // Nothing was recorded as a delivery, but the attempt is durable and attributable.
    assert.equal(getLoopMessageDelivery(base.tenantId, base.taskId), null);
    const retained = getLatestLoopMessageAttempt(base.tenantId, base.taskId);
    assert.equal(retained?.state, "unconfirmed");
    assert.equal(retained?.recipient, base.recipient);
    assert.equal(retained?.senderId, base.senderId);

    // A retry is possible and is recorded as the next attempt number.
    stubFetch(async () => new Response(JSON.stringify({ success: true, message_id: "loop-attempt-2" }), { status: 200 }));
    const retried = await sendTrackedLoopMessage({ ...base, allowAmbiguousRetry: true });
    assert.equal(retried.result.ok, true);
    assert.equal(retried.attempt.attemptNo, 2);
    assert.equal(retried.duplicateRisk, true, "prior ambiguity must be reported so a duplicate is never silent");
    assert.equal(listLoopMessageAttempts(base.tenantId, base.taskId).length, 2);
  } finally {
    reset();
    closeSqliteDb();
  }
});

test("an explicit provider rejection is recorded as failed, not ambiguous", async () => {
  try {
    stubFetch(async () => new Response(JSON.stringify({ message: "sender not verified" }), { status: 400 }));
    const rejected = await sendTrackedLoopMessage({ ...base, taskId: "task_22222222-2222-2222-2222-222222222222" });
    assert.equal(rejected.result.ok, false);
    assert.equal(rejected.result.sendCertainty, "rejected");
    assert.equal(rejected.attempt.state, "failed");
    assert.equal(rejected.duplicateRisk, false);
    assert.equal(rejected.attempt.errorCode, 400);
  } finally {
    reset();
    closeSqliteDb();
  }
});

test("a 2xx response without a message ID is ambiguous, never accepted", async () => {
  try {
    stubFetch(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const result = await sendTrackedLoopMessage({ ...base, taskId: "task_33333333-3333-3333-3333-333333333333" });
    assert.equal(result.result.ok, false);
    assert.equal(result.result.sendCertainty, "ambiguous");
    assert.equal(result.attempt.state, "unconfirmed");
    assert.equal(getLoopMessageDelivery(base.tenantId, "task_33333333-3333-3333-3333-333333333333"), null);
  } finally {
    reset();
    closeSqliteDb();
  }
});

test("a pending attempt abandoned by a dead worker becomes unconfirmed and retryable", async () => {
  try {
    const taskId = "task_44444444-4444-4444-4444-444444444444";
    const attempt = beginLoopMessageAttempt({ ...base, taskId });
    assert.equal(attempt.state, "pending_send");
    assert.equal(recoverStaleLoopMessageAttempts(base.tenantId, taskId, 15 * 60_000), 0);
    getSqliteDb()!.prepare("UPDATE imessage_delivery_attempts SET updated_at = ? WHERE attempt_id = ?")
      .run(new Date(Date.now() - 60 * 60_000).toISOString(), attempt.attemptId);
    assert.equal(recoverStaleLoopMessageAttempts(base.tenantId, taskId, 15 * 60_000), 1);
    const recovered = getLatestLoopMessageAttempt(base.tenantId, taskId);
    assert.equal(recovered?.state, "unconfirmed");
    assert.match(String(recovered?.errorDetail), /worker stopped mid-send/);
  } finally {
    reset();
    closeSqliteDb();
  }
});

test("only one send may be in flight per task", () => {
  try {
    const taskId = "task_55555555-5555-5555-5555-555555555555";
    beginLoopMessageAttempt({ ...base, taskId });
    assert.throws(() => beginLoopMessageAttempt({ ...base, taskId }), LoopMessageAttemptInFlightError);
  } finally {
    reset();
    closeSqliteDb();
  }
});

test("attempts are tenant-scoped and never leak across tenants", () => {
  try {
    const taskId = "task_66666666-6666-6666-6666-666666666666";
    beginLoopMessageAttempt({ ...base, taskId });
    assert.equal(getLatestLoopMessageAttempt("tenant-other", taskId), null);
    assert.deepEqual(listLoopMessageAttempts("tenant-other", taskId), []);
    assert.equal(recoverStaleLoopMessageAttempts("tenant-other", taskId, 0), 0);
    assert.equal(getLatestLoopMessageAttempt(base.tenantId, taskId)?.state, "pending_send");
  } finally {
    reset();
    closeSqliteDb();
  }
});
