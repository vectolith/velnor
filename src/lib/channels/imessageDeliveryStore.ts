import { createHash, randomUUID } from "node:crypto";
import { getSqliteDb } from "../sqliteDb";

export type LoopMessageDeliveryStatus = "processing" | "queued" | "delivered" | "failed" | "unknown";

export interface LoopMessageDelivery {
  messageId: string;
  providerMessageId: string | null;
  tenantId: string;
  taskId: string;
  recipient: string;
  senderId: string;
  status: LoopMessageDeliveryStatus;
  errorCode: number | null;
  createdAt: string;
  updatedAt: string;
}

function db() {
  const database = getSqliteDb();
  if (!database) throw new Error("LoopMessage delivery tracking requires durable SQLite storage.");
  const columns = database.prepare("PRAGMA table_info(imessage_deliveries)").all() as Array<{ name: string }>;
  if (columns.length && !columns.some((column) => column.name === "provider_message_id")) {
    database.exec("ALTER TABLE imessage_deliveries ADD COLUMN provider_message_id TEXT");
  }
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS imessage_deliveries_provider_message ON imessage_deliveries(provider_message_id) WHERE provider_message_id IS NOT NULL");
  database.exec(`CREATE TABLE IF NOT EXISTS imessage_delivery_events (
    event_fingerprint TEXT PRIMARY KEY,
    provider_message_id TEXT NOT NULL,
    delivery_id TEXT,
    recipient TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('delivered', 'failed')),
    error_code INTEGER,
    created_at TEXT NOT NULL,
    applied_at TEXT
  )`);
  const eventColumns = database.prepare("PRAGMA table_info(imessage_delivery_events)").all() as Array<{ name: string }>;
  if (eventColumns.length && !eventColumns.some((column) => column.name === "delivery_id")) {
    database.exec("ALTER TABLE imessage_delivery_events ADD COLUMN delivery_id TEXT");
  }
  database.exec("CREATE INDEX IF NOT EXISTS imessage_delivery_events_pending ON imessage_delivery_events(provider_message_id, applied_at)");
  database.exec("CREATE INDEX IF NOT EXISTS imessage_delivery_events_delivery ON imessage_delivery_events(delivery_id, applied_at)");
  return database;
}

export function createLoopMessageDeliveryAttempt(input: {
  tenantId: string; taskId: string; recipient: string; senderId: string;
}): string {
  if (!input.tenantId || !input.taskId || !input.recipient || !input.senderId) {
    throw new Error("LoopMessage delivery attempt is missing a required identity.");
  }
  const database = db();
  const deliveryId = randomUUID();
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO imessage_deliveries
      (message_id, provider_message_id, tenant_id, task_id, recipient, sender_id, status, error_code, created_at, updated_at)
    VALUES (?, NULL, ?, ?, ?, ?, 'processing', NULL, ?, ?)
  `).run(deliveryId, input.tenantId, input.taskId, input.recipient, input.senderId, now, now);
  return deliveryId;
}

function applyPendingEvents(database: ReturnType<typeof db>, providerMessageId: string, deliveryId?: string): void {
  const events = database.prepare(`
    SELECT event_fingerprint, delivery_id, recipient, sender_id, status, error_code
    FROM imessage_delivery_events
    WHERE (provider_message_id = ? OR delivery_id = ?) AND applied_at IS NULL
    ORDER BY created_at ASC, event_fingerprint ASC
  `).all(providerMessageId, deliveryId || providerMessageId) as Array<{
    event_fingerprint: string; delivery_id: string | null; recipient: string; sender_id: string;
    status: "delivered" | "failed"; error_code: number | null;
  }>;
  for (const event of events) {
    const changed = database.prepare(`
      UPDATE imessage_deliveries
      SET provider_message_id = COALESCE(provider_message_id, ?),
          status = ?, error_code = ?, updated_at = ?
      WHERE (provider_message_id = ? OR message_id = ?)
        AND recipient = ? AND sender_id = ?
        AND status IN ('processing', 'queued', 'unknown')
    `).run(providerMessageId, event.status, event.error_code, new Date().toISOString(),
      providerMessageId, event.delivery_id || deliveryId || "", event.recipient, event.sender_id) as { changes?: number };
    const matching = database.prepare(`
      SELECT 1 FROM imessage_deliveries
      WHERE (provider_message_id = ? OR message_id = ?)
        AND recipient = ? AND sender_id = ?
    `).get(providerMessageId, event.delivery_id || deliveryId || "", event.recipient, event.sender_id);
    if (matching || Number(changed.changes) === 1) {
      database.prepare("UPDATE imessage_delivery_events SET applied_at = ? WHERE event_fingerprint = ?")
        .run(new Date().toISOString(), event.event_fingerprint);
    }
  }
}

export function recordLoopMessageQueued(input: {
  deliveryId: string; providerMessageId: string;
  tenantId: string; taskId: string; recipient: string; senderId: string;
}): void {
  if (!input.deliveryId || !input.providerMessageId || !input.tenantId || !input.taskId || !input.recipient || !input.senderId) {
    throw new Error("LoopMessage accepted-send record is missing a required identity.");
  }
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare(`
      SELECT tenant_id, task_id, recipient, sender_id, provider_message_id
      FROM imessage_deliveries WHERE message_id = ?
    `).get(input.deliveryId) as {
      tenant_id: string; task_id: string; recipient: string; sender_id: string; provider_message_id: string | null;
    } | undefined;
    if (!row || row.tenant_id !== input.tenantId || row.task_id !== input.taskId ||
        row.recipient !== input.recipient || row.sender_id !== input.senderId) {
      throw new Error("LoopMessage delivery attempt does not match its original tenant, task, or identity.");
    }
    if (row.provider_message_id && row.provider_message_id !== input.providerMessageId) {
      throw new Error("LoopMessage delivery attempt is already bound to another provider message ID.");
    }
    database.prepare(`
      UPDATE imessage_deliveries SET provider_message_id = ?, status = CASE WHEN status = 'processing' THEN 'queued' ELSE status END, updated_at = ?
      WHERE message_id = ? AND provider_message_id IS NULL
    `).run(input.providerMessageId, new Date().toISOString(), input.deliveryId);
    applyPendingEvents(database, input.providerMessageId, input.deliveryId);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function recordLoopMessageSendFailure(input: {
  deliveryId: string; status: "failed" | "unknown"; errorCode?: number;
}): void {
  const result = db().prepare(`
    UPDATE imessage_deliveries SET status = ?, error_code = ?, updated_at = ?
    WHERE message_id = ? AND status = 'processing'
  `).run(input.status, input.errorCode ?? null, new Date().toISOString(), input.deliveryId) as { changes?: number };
  if (Number(result.changes) !== 1) {
    throw new Error("LoopMessage delivery attempt was not in a retryable pre-acceptance state.");
  }
}

export function applyLoopMessageDeliveryEvent(input: {
  messageId: string; recipient: string; senderId: string; deliveryId?: string;
  status: "delivered" | "failed"; errorCode?: number;
}): boolean {
  if (!input.messageId || !input.recipient || !input.senderId) return false;
  const database = db();
  const normalized = {
    messageId: input.messageId.trim(),
    recipient: input.recipient.trim(),
    senderId: input.senderId.trim(),
    deliveryId: input.deliveryId?.trim() || null,
    status: input.status,
    errorCode: input.errorCode ?? null,
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      INSERT INTO imessage_delivery_events
        (event_fingerprint, provider_message_id, delivery_id, recipient, sender_id, status, error_code, created_at, applied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(event_fingerprint) DO NOTHING
    `).run(fingerprint, normalized.messageId, normalized.deliveryId, normalized.recipient,
      normalized.senderId, normalized.status, normalized.errorCode, now);
    const match = normalized.deliveryId
      ? database.prepare(`
          SELECT message_id FROM imessage_deliveries
          WHERE message_id = ? AND recipient = ? AND sender_id = ?
        `).get(normalized.deliveryId, normalized.recipient, normalized.senderId)
      : database.prepare(`
          SELECT message_id FROM imessage_deliveries
          WHERE provider_message_id = ? AND recipient = ? AND sender_id = ?
        `).get(normalized.messageId, normalized.recipient, normalized.senderId);
    if (match) {
      if (normalized.deliveryId) {
        database.prepare(`
          UPDATE imessage_deliveries SET provider_message_id = COALESCE(provider_message_id, ?)
          WHERE message_id = ? AND recipient = ? AND sender_id = ?
        `).run(normalized.messageId, normalized.deliveryId, normalized.recipient, normalized.senderId);
      }
      applyPendingEvents(database, normalized.messageId, normalized.deliveryId || normalized.messageId);
    }
    database.exec("COMMIT");
    return true; // persisted, whether matched now or awaiting the send response
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function applyLoopMessageProviderStatus(input: {
  providerMessageId: string; recipient: string;
  status: "processing" | "failed" | "delivered" | "unknown"; errorCode?: number;
}): boolean {
  if (!input.providerMessageId || !input.recipient) return false;
  const result = db().prepare(`
    UPDATE imessage_deliveries SET status = ?, error_code = ?, updated_at = ?
    WHERE provider_message_id = ? AND recipient = ?
      AND status IN ('processing', 'queued', 'unknown')
  `).run(input.status, input.errorCode ?? null, new Date().toISOString(),
    input.providerMessageId, input.recipient) as { changes?: number };
  return Number(result.changes) === 1;
}

export function getLoopMessageDelivery(tenantId: string, taskId: string): LoopMessageDelivery | null {
  const row = db().prepare(`
    SELECT message_id, provider_message_id, tenant_id, task_id, recipient, sender_id,
      status, error_code, created_at, updated_at
    FROM imessage_deliveries
    WHERE tenant_id = ? AND task_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(tenantId, taskId) as {
    message_id: string; provider_message_id: string | null; tenant_id: string; task_id: string;
    recipient: string; sender_id: string; status: LoopMessageDeliveryStatus;
    error_code: number | null; created_at: string; updated_at: string;
  } | undefined;
  return row ? {
    messageId: row.message_id, providerMessageId: row.provider_message_id,
    tenantId: row.tenant_id, taskId: row.task_id, recipient: row.recipient,
    senderId: row.sender_id, status: row.status, errorCode: row.error_code,
    createdAt: row.created_at, updatedAt: row.updated_at,
  } : null;
}
