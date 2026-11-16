import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-imessage-delivery-"));
process.env.VELNOR_DATA_DIR = dataDir;

import { applyLoopMessageDeliveryEvent, getLoopMessageDelivery, markLoopMessageDeliveryUnknownIfStale, processLoopMessageCallbackPayload, recordLoopMessageQueued, updateLoopMessageProviderStatus } from "../src/lib/channels/imessageDeliveryStore";
import { closeSqliteDb, getSqliteDb } from "../src/lib/sqliteDb";

test("LoopMessage callbacks require matching message, recipient, and sender and are idempotent", () => {
  try {
    recordLoopMessageQueued({
      messageId: "loop-email-1", tenantId: "tenant-a", taskId: "task-a",
      recipient: "alex@icloud.com", senderId: "velnor-email-sender",
    });
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: "loop-email-1", recipient: "+15551234567",
      senderId: "velnor-email-sender", status: "delivered",
    }), "unmatched");
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: "loop-email-1", recipient: "alex@icloud.com",
      senderId: "another-sender", status: "delivered",
    }), "unmatched");
    assert.equal(getLoopMessageDelivery("tenant-b", "task-a"), null);
    assert.throws(() => recordLoopMessageQueued({
      messageId: "loop-email-1", tenantId: "tenant-b", taskId: "task-b",
      recipient: "alex@icloud.com", senderId: "velnor-email-sender",
    }), /already bound to a different task or identity/);
    assert.equal(getLoopMessageDelivery("tenant-a", "task-a")?.status, "queued");
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: "loop-email-1", recipient: "alex@icloud.com",
      senderId: "velnor-email-sender", status: "delivered",
    }), "applied");
    assert.equal(getLoopMessageDelivery("tenant-a", "task-a")?.status, "delivered");
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: "loop-email-1", recipient: "alex@icloud.com",
      senderId: "velnor-email-sender", status: "delivered",
    }), "duplicate");
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: "loop-email-1", recipient: "alex@icloud.com",
      senderId: "velnor-email-sender", status: "failed",
    }), "duplicate");
    recordLoopMessageQueued({
      messageId: "loop-phone-1", tenantId: "tenant-a", taskId: "task-phone",
      recipient: "+2348012345678", senderId: "velnor-email-sender",
    });
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: "loop-phone-1", recipient: "+2348012345678",
      senderId: "velnor-email-sender", status: "delivered",
    }), "applied");
    assert.equal(getLoopMessageDelivery("tenant-a", "task-phone")?.recipient, "+2348012345678");
  } finally {
    closeSqliteDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("callback received before outbound record is durably reconciled when message ID is persisted", () => {
  try {
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: "loop-race-1", recipient: "alex@icloud.com",
      senderId: "velnor-email-sender", status: "delivered",
    }), "unmatched");

    // Simulate the outbound request returning after the provider callback.
    recordLoopMessageQueued({
      messageId: "loop-race-1", tenantId: "tenant-race", taskId: "task-race",
      recipient: "alex@icloud.com", senderId: "velnor-email-sender",
    });
    assert.equal(getLoopMessageDelivery("tenant-race", "task-race")?.status, "delivered");

    // Replayed callback must not change the terminal state.
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: "loop-race-1", recipient: "alex@icloud.com",
      senderId: "velnor-email-sender", status: "delivered",
    }), "duplicate");
    assert.equal(getLoopMessageDelivery("tenant-race", "task-race")?.status, "delivered");
  } finally {
    closeSqliteDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("stale queued deliveries become ambiguous before an explicit retry", () => {
  try {
    recordLoopMessageQueued({
      messageId: "loop-stale-1", tenantId: "tenant-stale", taskId: "task-stale",
      recipient: "+2348012345678", senderId: "velnor-email-sender",
    });
    assert.equal(markLoopMessageDeliveryUnknownIfStale("tenant-stale", "task-stale", 60_000), false);
    getSqliteDb()!.prepare("UPDATE imessage_deliveries SET updated_at = ? WHERE message_id = ?")
      .run(new Date(Date.now() - 60 * 60_000).toISOString(), "loop-stale-1");
    assert.equal(markLoopMessageDeliveryUnknownIfStale("tenant-stale", "task-stale", 15 * 60_000), true);
    assert.equal(getLoopMessageDelivery("tenant-stale", "task-stale")?.status, "unknown");
    assert.equal(updateLoopMessageProviderStatus({
      messageId: "loop-stale-1", tenantId: "tenant-stale", taskId: "task-stale",
      recipient: "+2348012345678", senderId: "velnor-email-sender", status: "failed",
    }), true);
    assert.equal(updateLoopMessageProviderStatus({
      messageId: "loop-stale-1", tenantId: "tenant-stale", taskId: "task-stale",
      recipient: "+2348012345678", senderId: "velnor-email-sender", status: "processing",
    }), false, "stale processing status must not overwrite terminal failure");
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: "loop-stale-1", recipient: "+2348012345678",
      senderId: "velnor-email-sender", status: "delivered",
    }), "duplicate", "a terminal failure must not be rewritten by a conflicting callback");
    assert.equal(getLoopMessageDelivery("tenant-stale", "task-stale")?.status, "failed");
  } finally {
    closeSqliteDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("documented LoopMessage callback JSON is parsed, persisted early, and reconciled", () => {
  try {
    const deliveredPayload = {
      event: "message_delivered",
      message_id: "loop-documented-email-1",
      contact: "Alex@iCloud.com",
    };
    assert.equal(processLoopMessageCallbackPayload(deliveredPayload), "unmatched");
    recordLoopMessageQueued({
      messageId: "loop-documented-email-1", tenantId: "tenant-contract", taskId: "task-contract",
      recipient: "alex@icloud.com", senderId: "velnor-email-sender",
    });
    assert.equal(getLoopMessageDelivery("tenant-contract", "task-contract")?.status, "delivered");
    assert.equal(processLoopMessageCallbackPayload(deliveredPayload), "duplicate");

    recordLoopMessageQueued({
      messageId: "loop-documented-phone-1", tenantId: "tenant-contract", taskId: "task-phone-contract",
      recipient: "+2348012345678", senderId: "velnor-email-sender",
    });
    assert.equal(processLoopMessageCallbackPayload({
      event: "message_failed",
      message_id: "loop-documented-phone-1",
      contact: "+2348012345678",
      error_code: 42,
    }), "applied");
    assert.equal(getLoopMessageDelivery("tenant-contract", "task-phone-contract")?.status, "failed");
    assert.equal(processLoopMessageCallbackPayload({ event: "message_queued" }), null);
  } finally {
    closeSqliteDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("malformed delivery callbacks are rejected instead of falsely reported as persisted", () => {
  try {
    assert.equal(processLoopMessageCallbackPayload({
      event: "message_delivered",
      message_id: "loop-missing-contact",
    }), "invalid");
    assert.equal(processLoopMessageCallbackPayload({
      event: "message_failed",
      contact: "+15551234567",
    }), "invalid");
    assert.equal(processLoopMessageCallbackPayload({
      event: "message_delivered",
      message_id: "loop-valid-early",
      contact: "alex@icloud.com",
    }), "unmatched");
  } finally {
    closeSqliteDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
