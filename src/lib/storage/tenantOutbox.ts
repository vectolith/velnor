import type { D1Database, D1Result } from "./d1TenantState";

export type OutboxStatus = "pending" | "processing" | "delivered" | "dead";
export interface TenantOutboxItem {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  actionType: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
interface OutboxRow {
  id: string; tenant_id: string; idempotency_key: string; action_type: string;
  payload_json: string; status: OutboxStatus; attempts: number; available_at: string;
  lease_owner: string | null; lease_until: string | null; last_error: string | null;
  created_at: string; updated_at: string;
}
const MAX_PAYLOAD_BYTES = 64 * 1024;
function assertTenantId(value: string): void {
  if (!value || value.length > 128 || !/^[A-Za-z0-9._@+-]+$/.test(value)) {
    throw new Error("Invalid or unsanitized tenant storage identifier.");
  }
}
function assertToken(value: string, label: string, max = 128): void {
  if (!value || value.length > max || !/^[A-Za-z0-9._:@+-]+$/.test(value)) {
    throw new Error("Invalid " + label + ".");
  }
}
function parsePayload(raw: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Outbox payload is invalid JSON; refusing to dispatch."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Outbox payload must be a JSON object.");
  }
  return value as Record<string, unknown>;
}
function fromRow(row: OutboxRow): TenantOutboxItem {
  return {
    id: row.id, tenantId: row.tenant_id, idempotencyKey: row.idempotency_key,
    actionType: row.action_type, payload: parsePayload(row.payload_json),
    status: row.status, attempts: row.attempts, availableAt: row.available_at,
    leaseOwner: row.lease_owner, leaseUntil: row.lease_until,
    lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at
  };
}
function assertChanged(result: D1Result, message: string): void {
  if (!result.success) throw new Error(result.error || message);
  if (result.meta?.changes !== 1) throw new Error(message);
}

/** Insert once per tenant/idempotency key; reject key reuse for a different action. */
export async function enqueueTenantAction(
  db: D1Database,
  input: {
    id: string; tenantId: string; idempotencyKey: string; actionType: string;
    payload: Record<string, unknown>; availableAt?: string;
  }
): Promise<{ item: TenantOutboxItem; inserted: boolean }> {
  assertToken(input.id, "outbox item ID");
  assertTenantId(input.tenantId);
  assertToken(input.idempotencyKey, "idempotency key", 200);
  assertToken(input.actionType, "action type", 96);
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new Error("Outbox payload must be a JSON object.");
  }
  const payloadJson = JSON.stringify(input.payload);
  if (new TextEncoder().encode(payloadJson).byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error("Outbox payload exceeds the 64 KiB limit.");
  }
  const now = new Date().toISOString();
  const availableAt = input.availableAt || now;
  if (!Number.isFinite(Date.parse(availableAt))) throw new Error("Invalid outbox availability timestamp.");
  const insert = await db.prepare(`
    INSERT INTO tenant_outbox (
      id, tenant_id, idempotency_key, action_type, payload_json, status, attempts,
      available_at, lease_owner, lease_until, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(tenant_id, idempotency_key) DO NOTHING
  `).bind(input.id, input.tenantId, input.idempotencyKey, input.actionType,
    payloadJson, availableAt, now, now).run();
  if (!insert.success) throw new Error(insert.error || "Could not enqueue tenant action.");
  const row = await db.prepare(
    "SELECT * FROM tenant_outbox WHERE tenant_id = ? AND idempotency_key = ?"
  ).bind(input.tenantId, input.idempotencyKey).first<OutboxRow>();
  if (!row) throw new Error("Outbox insert was not visible after enqueue.");
  if (row.action_type !== input.actionType || row.payload_json !== payloadJson) {
    throw new Error("Idempotency key was already used for a different tenant action.");
  }
  return { item: fromRow(row), inserted: (insert.meta?.changes || 0) === 1 };
}

/** Atomically claim one due item for a tenant using a single UPDATE ... RETURNING. */
export async function claimTenantAction(
  db: D1Database, tenantId: string, workerId: string, leaseMs = 60_000, now = new Date()
): Promise<TenantOutboxItem | null> {
  assertTenantId(tenantId);
  assertToken(workerId, "outbox worker ID");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 15 * 60_000) {
    throw new Error("Outbox lease must be between 1 second and 15 minutes.");
  }
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
  const result = await db.prepare(`
    UPDATE tenant_outbox
    SET status = 'processing', lease_owner = ?, lease_until = ?,
        attempts = attempts + 1, updated_at = ?
    WHERE tenant_id = ? AND id = (
      SELECT id FROM tenant_outbox
      WHERE tenant_id = ? AND available_at <= ?
        AND (status = 'pending' OR (status = 'processing' AND lease_until <= ?))
      ORDER BY available_at, created_at, id LIMIT 1
    )
    AND (status = 'pending' OR (status = 'processing' AND lease_until <= ?))
    RETURNING *
  `).bind(workerId, leaseUntil, nowIso, tenantId, tenantId, nowIso, nowIso, nowIso)
    .all<OutboxRow>();
  if (!result.success) throw new Error(result.error || "Could not claim tenant outbox action.");
  const row = result.results?.[0];
  return row ? fromRow(row) : null;
}

export async function completeTenantAction(
  db: D1Database, tenantId: string, itemId: string, workerId: string, now = new Date()
): Promise<void> {
  assertTenantId(tenantId); assertToken(itemId, "outbox item ID"); assertToken(workerId, "outbox worker ID");
  const result = await db.prepare(`
    UPDATE tenant_outbox SET status = 'delivered', lease_owner = NULL, lease_until = NULL,
      last_error = NULL, updated_at = ?
    WHERE tenant_id = ? AND id = ? AND status = 'processing' AND lease_owner = ?
  `).bind(now.toISOString(), tenantId, itemId, workerId).run();
  assertChanged(result, "Outbox action is not leased by this worker or has already changed.");
}

/** Retry with an explicit backoff time; exhausted attempts move to dead-letter state. */
export async function retryTenantAction(
  db: D1Database, tenantId: string, itemId: string, workerId: string,
  options: { availableAt: string; error: string; maxAttempts?: number; now?: Date }
): Promise<"pending" | "dead"> {
  assertTenantId(tenantId); assertToken(itemId, "outbox item ID"); assertToken(workerId, "outbox worker ID");
  if (!Number.isFinite(Date.parse(options.availableAt))) throw new Error("Invalid retry availability timestamp.");
  const maxAttempts = options.maxAttempts ?? 8;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error("maxAttempts must be between 1 and 100.");
  }
  const now = (options.now || new Date()).toISOString();
  const error = String(options.error || "Unknown dispatch error").slice(0, 1000);
  const result = await db.prepare(`
    UPDATE tenant_outbox
    SET status = CASE WHEN attempts >= ? THEN 'dead' ELSE 'pending' END,
        available_at = ?, lease_owner = NULL, lease_until = NULL,
        last_error = ?, updated_at = ?
    WHERE tenant_id = ? AND id = ? AND status = 'processing' AND lease_owner = ?
    RETURNING status
  `).bind(maxAttempts, options.availableAt, error, now, tenantId, itemId, workerId)
    .first<{ status: "pending" | "dead" }>();
  if (!result) throw new Error("Outbox action is not leased by this worker or has already changed.");
  return result.status;
}
