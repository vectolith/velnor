import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-loopmessage-webhook-"));
process.env.VELNOR_DATA_DIR = dataDir;
process.env.LOOPMESSAGE_WEBHOOK_SECRET = "loopmessage-webhook-test-secret";

import { NextRequest } from "next/server";
import { POST } from "../src/app/api/webhooks/imessage/route";
import {
  createLoopMessageDeliveryAttempt,
  getLoopMessageDelivery,
  recordLoopMessageQueued,
} from "../src/lib/channels/imessageDeliveryStore";
import { closeSqliteDb } from "../src/lib/sqliteDb";

test("LoopMessage documented message_delivered webhook is durably reconciled before send response persistence", async () => {
  try {
    const deliveryId = createLoopMessageDeliveryAttempt({
      tenantId: "tenant-webhook", taskId: "task-webhook",
      recipient: "alex@icloud.com", senderId: "sender-id-123",
    });
    const request = new NextRequest("https://velnor.test/api/webhooks/imessage", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: process.env.LOOPMESSAGE_WEBHOOK_SECRET!,
      },
      body: JSON.stringify({
        event: "message_delivered",
        message_id: "provider-message-123",
        contact: "alex@icloud.com",
        sender: "sender-id-123",
        passthrough: deliveryId,
      }),
    });
    const response = await POST(request);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "recorded" });
    assert.equal(getLoopMessageDelivery("tenant-webhook", "task-webhook")?.status, "processing");

    recordLoopMessageQueued({
      deliveryId, providerMessageId: "provider-message-123",
      tenantId: "tenant-webhook", taskId: "task-webhook",
      recipient: "alex@icloud.com", senderId: "sender-id-123",
    });
    assert.equal(getLoopMessageDelivery("tenant-webhook", "task-webhook")?.status, "delivered");
  } finally {
    closeSqliteDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.LOOPMESSAGE_WEBHOOK_SECRET;
  }
});
