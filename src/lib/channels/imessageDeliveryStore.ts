import { getSqliteDb } from "../sqliteDb";

export type LoopMessageDeliveryStatus = "queued" | "processing" | "delivered" | "failed" | "unknown";

export interface LoopMessageDelivery {
  messageId: string;
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
  return database;
}

export function recordLoopMessageQueued(input: {
  messageId: string; tenantId: string; taskId: string; recipient: string; senderId: string;
}): void {
  if (!input.messageId || !input.tenantId || !input.taskId || !input.recipient || !input.senderId) {
    throw new Error("LoopMessage delivery record is missing a required identity.");
  }
  const now = new Date().toISOString();
  db().prepare(`
    INSERT INTO imessage_deliveries
      (message_id, tenant_id, task_id, recipient, sender_id, status, error_code, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'queued', NULL, ?, ?)
    ON CONFLICT(message_id) DO NOTHING
  `).run(input.messageId, input.tenantId, input.taskId, input.recipient, input.senderId, now, now);
  const row = db().prepare("SELECT tenant_id, task_id, recipient, sender_id FROM imessage_deliveries WHERE message_id = ?")
    .get(input.messageId) as {tenant_id:string;task_id:string;recipient:string;sender_id:string}|undefined;
  if (!row || row.tenant_id !== input.tenantId || row.task_id !== input.taskId ||
      row.recipient !== input.recipient || row.sender_id !== input.senderId) {
    throw new Error("LoopMessage message ID is already bound to a different task or identity.");
  }
}

export function applyLoopMessageDeliveryEvent(input: {
  messageId: string; recipient: string; senderId: string; status: "delivered" | "failed"; errorCode?: number;
}): boolean {
  if (!input.messageId || !input.recipient || !input.senderId) return false;
  const now = new Date().toISOString();
  const result = db().prepare(`
    UPDATE imessage_deliveries
    SET status = ?, error_code = ?, updated_at = ?
    WHERE message_id = ? AND recipient = ? AND sender_id = ?
      AND status IN ('queued', 'processing', 'unknown')
  `).run(input.status, input.errorCode ?? null, now, input.messageId, input.recipient, input.senderId) as {changes?:number};
  return Number(result.changes) === 1;
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
