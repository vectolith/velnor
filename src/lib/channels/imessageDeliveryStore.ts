import { getSqliteDb } from "../sqliteDb";

export type LoopMessageDeliveryStatus = "queued" | "processing" | "delivered" | "failed" | "unknown";
export interface LoopMessageDelivery {
  messageId: string; tenantId: string; taskId: string; recipient: string; senderId: string;
  status: LoopMessageDeliveryStatus; errorCode: number | null; createdAt: string; updatedAt: string;
}
export type DeliveryEventResult = "applied" | "duplicate" | "unmatched";

function db() {
  const database = getSqliteDb();
  if (!database) throw new Error("LoopMessage delivery tracking requires durable SQLite storage.");
  return database;
}

function applyMatchedEvent(input: {
  messageId: string; recipient: string; senderId: string; status: "delivered" | "failed"; errorCode?: number;
}): boolean {
  const now = new Date().toISOString();
  const result = db().prepare(`
    UPDATE imessage_deliveries SET status = ?, error_code = ?, updated_at = ?
    WHERE message_id = ? AND recipient = ? AND sender_id = ?
      AND status IN ('queued', 'processing', 'unknown')
  `).run(input.status, input.errorCode ?? null, now, input.messageId, input.recipient, input.senderId) as {changes?:number};
  return Number(result.changes) === 1;
}

/** Persist an early callback before trying to correlate it with an outbound send. */
function persistCallback(input: {
  messageId: string; recipient: string; senderId: string; status: "delivered" | "failed"; errorCode?: number;
}): boolean {
  const now = new Date().toISOString();
  const inserted = db().prepare(`
    INSERT INTO imessage_delivery_events
      (message_id, recipient, sender_id, event_status, error_code, received_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id, recipient, sender_id, event_status) DO NOTHING
  `).run(input.messageId, input.recipient, input.senderId, input.status, input.errorCode ?? null, now) as {changes?:number};
  return Number(inserted.changes) === 1;
}

function reconcilePending(messageId: string, recipient: string, senderId: string): void {
  const events = db().prepare(`
    SELECT event_status, error_code FROM imessage_delivery_events
    WHERE message_id = ? AND recipient = ? AND sender_id = ? ORDER BY received_at ASC
  `).all(messageId, recipient, senderId) as Array<{event_status:"delivered"|"failed";error_code:number|null}>;
  for (const event of events) {
    applyMatchedEvent({ messageId, recipient, senderId, status: event.event_status, errorCode: event.error_code ?? undefined });
  }
  db().prepare(`
    DELETE FROM imessage_delivery_events WHERE message_id = ? AND recipient = ? AND sender_id = ?
  `).run(messageId, recipient, senderId);
}

export function recordLoopMessageQueued(input: {
  messageId: string; tenantId: string; taskId: string; recipient: string; senderId: string;
}): void {
  if (!input.messageId || !input.tenantId || !input.taskId || !input.recipient || !input.senderId) {
    throw new Error("LoopMessage delivery record is missing a required identity.");
  }
  const database = db();
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      INSERT INTO imessage_deliveries
        (message_id, tenant_id, task_id, recipient, sender_id, status, error_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', NULL, ?, ?)
      ON CONFLICT(message_id) DO NOTHING
    `).run(input.messageId, input.tenantId, input.taskId, input.recipient, input.senderId, now, now);
    const row = database.prepare("SELECT tenant_id, task_id, recipient, sender_id FROM imessage_deliveries WHERE message_id = ?")
      .get(input.messageId) as {tenant_id:string;task_id:string;recipient:string;sender_id:string}|undefined;
    if (!row || row.tenant_id !== input.tenantId || row.task_id !== input.taskId ||
        row.recipient !== input.recipient || row.sender_id !== input.senderId) {
      throw new Error("LoopMessage message ID is already bound to a different task or identity.");
    }
    reconcilePending(input.messageId, input.recipient, input.senderId);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

/**
 * Callback handling is idempotent. Unknown message IDs are durably retained and
 * reconciled when the send response is later persisted by the outbound worker.
 */
export function applyLoopMessageDeliveryEvent(input: {
  messageId: string; recipient: string; senderId: string; status: "delivered" | "failed"; errorCode?: number;
}): DeliveryEventResult {
  if (!input.messageId || !input.recipient || !input.senderId) return "unmatched";
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = database.prepare(`
      SELECT status FROM imessage_deliveries
      WHERE message_id = ? AND recipient = ? AND sender_id = ?
    `).get(input.messageId, input.recipient, input.senderId) as {status:LoopMessageDeliveryStatus}|undefined;
    if (existing) {
      if (existing.status === input.status) {
        database.exec("COMMIT");
        return "duplicate";
      }
      const changed = applyMatchedEvent(input);
      database.exec("COMMIT");
      return changed ? "applied" : "duplicate";
    }
    const inserted = persistCallback(input);
    database.exec("COMMIT");
    return inserted ? "unmatched" : "duplicate";
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function getLoopMessageDelivery(tenantId: string, taskId: string): LoopMessageDelivery | null {
  const row = db().prepare(`
    SELECT message_id, tenant_id, task_id, recipient, sender_id, status, error_code, created_at, updated_at
    FROM imessage_deliveries WHERE tenant_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(tenantId, taskId) as {
    message_id:string;tenant_id:string;task_id:string;recipient:string;sender_id:string;
    status:LoopMessageDeliveryStatus;error_code:number|null;created_at:string;updated_at:string;
  }|undefined;
  return row ? {
    messageId:row.message_id,tenantId:row.tenant_id,taskId:row.task_id,recipient:row.recipient,
    senderId:row.sender_id,status:row.status,errorCode:row.error_code,createdAt:row.created_at,updatedAt:row.updated_at,
  } : null;
}
