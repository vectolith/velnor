import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-imessage-delivery-"));
process.env.VELNOR_DATA_DIR = dataDir;

import {
  applyLoopMessageDeliveryEvent,
  createLoopMessageDeliveryAttempt,
  getLoopMessageDelivery,
  recordLoopMessageQueued,
  recordLoopMessageSendFailure,
} from "../src/lib/channels/imessageDeliveryStore";
import { closeSqliteDb } from "../src/lib/sqliteDb";

test("documented LoopMessage callback arriving before send response is durably reconciled", () => {
  try {
    const deliveryId = createLoopMessageDeliveryAttempt({
      tenantId: "tenant-a", taskId: "task-email", recipient: "alex@icloud.com",
      senderId: "velnor-email-sender",
    });
    // Documented provider callback shape: event, message_id, contact, sender.
    const callback = {
      event: "message_delivered",
      message_id: "provider-email-1",
      contact: "alex@icloud.com",
      sender: "velnor-email-sender",
    };
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: callback.message_id,
      recipient: callback.contact,
      senderId: callback.sender,
      status: callback.event === "message_delivered" ? "delivered" : "failed",
    }), true);
    assert.equal(getLoopMessageDelivery("tenant-a", "task-email")?.status, "processing");

    recordLoopMessageQueued({
      deliveryId, providerMessageId: callback.message_id, tenantId: "tenant-a",
      taskId: "task-email", recipient: callback.contact, senderId: callback.sender,
    });
    const delivery = getLoopMessageDelivery("tenant-a", "task-email");
    assert.equal(delivery?.status, "delivered");
    assert.equal(delivery?.providerMessageId, "provider-email-1");

    // Duplicate callback is idempotent and cannot regress a terminal state.
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: callback.message_id, recipient: callback.contact,
      senderId: callback.sender, status: "delivered",
    }), true);
    assert.equal(getLoopMessageDelivery("tenant-a", "task-email")?.status, "delivered");
  } finally {
    closeSqliteDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("phone delivery callbacks are tenant-bound and mismatched identities never update records", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-imessage-phone-"));
  process.env.VELNOR_DATA_DIR = directory;
  closeSqliteDb();
  try {
    const deliveryId = createLoopMessageDeliveryAttempt({
      tenantId: "tenant-a", taskId: "task-phone", recipient: "+2348012345678",
      senderId: "velnor-email-sender",
    });
    recordLoopMessageQueued({
      deliveryId, providerMessageId: "provider-phone-1", tenantId: "tenant-a",
      taskId: "task-phone", recipient: "+2348012345678", senderId: "velnor-email-sender",
    });
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: "provider-phone-1", recipient: "+2348099999999",
      senderId: "velnor-email-sender", status: "delivered",
    }), true); // retained as an unmatched callback, never applied to this task
    assert.equal(getLoopMessageDelivery("tenant-a", "task-phone")?.status, "queued");
    assert.equal(getLoopMessageDelivery("tenant-b", "task-phone"), null);
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: "provider-phone-1", recipient: "+2348012345678",
      senderId: "another-sender", status: "delivered",
    }), true);
    assert.equal(getLoopMessageDelivery("tenant-a", "task-phone")?.status, "queued");
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: "provider-phone-1", recipient: "+2348012345678",
      senderId: "velnor-email-sender", status: "delivered",
    }), true);
    assert.equal(getLoopMessageDelivery("tenant-a", "task-phone")?.status, "delivered");
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: "provider-phone-1", recipient: "+2348012345678",
      senderId: "velnor-email-sender", status: "failed",
    }), true);
    assert.equal(getLoopMessageDelivery("tenant-a", "task-phone")?.status, "delivered");
  } finally {
    closeSqliteDb();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("ambiguous send failures are retained as unknown and not silently retryable", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-imessage-unknown-"));
  process.env.VELNOR_DATA_DIR = directory;
  closeSqliteDb();
  try {
    const deliveryId = createLoopMessageDeliveryAttempt({
      tenantId: "tenant-a", taskId: "task-unknown", recipient: "alex@icloud.com",
      senderId: "velnor-email-sender",
    });
    recordLoopMessageSendFailure({ deliveryId, status: "unknown" });
    assert.equal(getLoopMessageDelivery("tenant-a", "task-unknown")?.status, "unknown");
    assert.throws(() => recordLoopMessageSendFailure({ deliveryId, status: "failed" }), /not in a retryable/);
  } finally {
    closeSqliteDb();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
