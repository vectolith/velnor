import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-imessage-delivery-"));
process.env.VELNOR_DATA_DIR = dataDir;

import { applyLoopMessageDeliveryEvent, getLoopMessageDelivery, recordLoopMessageQueued } from "../src/lib/channels/imessageDeliveryStore";
import { closeSqliteDb } from "../src/lib/sqliteDb";

test("LoopMessage delivery callbacks require matching message, recipient, and sender", () => {
  try {
    recordLoopMessageQueued({
      messageId: "loop-email-1", tenantId: "tenant-a", taskId: "task-a",
      recipient: "alex@icloud.com", senderId: "velnor-email-sender",
    });
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: "loop-email-1", recipient: "+15551234567",
      senderId: "velnor-email-sender", status: "delivered",
    }), false);
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: "loop-email-1", recipient: "alex@icloud.com",
      senderId: "another-sender", status: "delivered",
    }), false);
    assert.equal(getLoopMessageDelivery("tenant-b", "task-a"), null);
    assert.equal(getLoopMessageDelivery("tenant-a", "task-a")?.status, "queued");
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: "loop-email-1", recipient: "alex@icloud.com",
      senderId: "velnor-email-sender", status: "delivered",
    }), true);
    assert.equal(getLoopMessageDelivery("tenant-a", "task-a")?.status, "delivered");
    assert.equal(applyLoopMessageDeliveryEvent({
      messageId: "loop-email-1", recipient: "alex@icloud.com",
      senderId: "velnor-email-sender", status: "failed",
    }), false);
  } finally {
    closeSqliteDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
