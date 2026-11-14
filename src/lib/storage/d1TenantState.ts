/**
 * Cloudflare D1 persistence primitives for VELNOR tenant state.
 * Deliberately not wired into the synchronous Node store yet.
 * Payloads must already be validated and secretBox-sealed before reaching D1.
 */
export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta?: { changes?: number; last_row_id?: number; duration?: number };
  error?: string;
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Database { prepare(query: string): D1PreparedStatement; }
export interface PersistedTenantState {
  usage?: { requests?: number; inputTokens?: number; outputTokens?: number; costUsd?: number };
  [key: string]: unknown;
}
export interface TenantStateRecord {
  tenantId: string; state: PersistedTenantState; revision: number; updatedAt: string;
}
export class TenantStateTooLargeError extends Error {
  constructor(readonly tenantId: string, readonly bytes: number) {
    super("Tenant state for " + tenantId + " is " + bytes + " bytes; D1 row limit requires large collections to be partitioned or moved to R2.");
    this.name = "TenantStateTooLargeError";
  }
}
export class TenantStateConflictError extends Error {
  constructor(readonly tenantId: string, readonly expectedRevision: number | null) {
    super("Tenant state changed concurrently for " + tenantId + "; reload before retrying.");
    this.name = "TenantStateConflictError";
  }
}
function assertTenantId(tenantId: string): void {
  if (!tenantId || tenantId.length > 128 || !/^[A-Za-z0-9._@+-]+$/.test(tenantId)) {
    throw new Error("Invalid or unsanitized tenant storage identifier.");
  }
}
function parseRecord(row: {
  tenant_id: string; payload_json: string; revision: number; updated_at: string;
}): TenantStateRecord {
  let state: unknown;
  try { state = JSON.parse(row.payload_json); }
  catch { throw new Error("Persisted tenant state is invalid JSON; refusing silent reset."); }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Persisted tenant state must be a JSON object.");
  }
  return { tenantId: row.tenant_id, state: state as PersistedTenantState,
    revision: row.revision, updatedAt: row.updated_at };
}
export async function loadTenantState(db: D1Database, tenantId: string): Promise<TenantStateRecord | null> {
  assertTenantId(tenantId);
  const row = await db.prepare(
    "SELECT tenant_id, payload_json, revision, updated_at FROM tenant_state WHERE tenant_id = ?"
  ).bind(tenantId).first<{
    tenant_id: string; payload_json: string; revision: number; updated_at: string;
  }>();
  return row ? parseRecord(row) : null;
}
/** Atomic compare-and-swap. Pass null only to create a previously absent tenant. */
export async function saveTenantState(
  db: D1Database, tenantId: string, state: PersistedTenantState, expectedRevision: number | null
): Promise<number> {
  assertTenantId(tenantId);
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
    throw new Error("Expected tenant revision must be a positive safe integer or null.");
  }
  const serialized = JSON.stringify(state);
  if (typeof serialized !== "string") throw new Error("Tenant state could not be serialized.");
  const bytes = new TextEncoder().encode(serialized).byteLength;
  // Cloudflare D1 caps an individual row at 2,000,000 bytes. Keep headroom for
  // SQLite row encoding and refuse an unsafe write rather than losing state.
  if (bytes > 1_900_000) throw new TenantStateTooLargeError(tenantId, bytes);
  const usageJson = JSON.stringify(state.usage || {});
  const result = await db.prepare(`
    INSERT INTO tenant_state (tenant_id, payload_json, usage_json, revision, updated_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      usage_json = excluded.usage_json,
      revision = tenant_state.revision + 1,
      updated_at = excluded.updated_at
    WHERE tenant_state.revision = ?
  `).bind(tenantId, serialized, usageJson, new Date().toISOString(), expectedRevision ?? -1).run();
  if (!result.success) throw new Error(result.error || "D1 tenant-state write failed.");
  if (result.meta?.changes !== 1) throw new TenantStateConflictError(tenantId, expectedRevision);
  return expectedRevision === null ? 1 : expectedRevision + 1;
}
export async function listTenantStateIds(db: D1Database): Promise<string[]> {
  const result = await db.prepare("SELECT tenant_id FROM tenant_state ORDER BY tenant_id")
    .all<{ tenant_id: string }>();
  if (!result.success) throw new Error(result.error || "D1 tenant listing failed.");
  return (result.results || []).map((row) => row.tenant_id);
}
export async function aggregateTenantUsage(db: D1Database): Promise<{
  requests: number; inputTokens: number; outputTokens: number; costUsd: number; tenants: number;
}> {
  const result = await db.prepare("SELECT usage_json FROM tenant_state").all<{ usage_json: string }>();
  if (!result.success) throw new Error(result.error || "D1 usage aggregation failed.");
  const total = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, tenants: 0 };
  for (const row of result.results || []) {
    let usage: PersistedTenantState["usage"];
    try { usage = JSON.parse(row.usage_json); }
    catch { throw new Error("Persisted tenant usage is invalid JSON; refusing silent reset."); }
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
      throw new Error("Persisted tenant usage must be a JSON object.");
    }
    total.requests += Number(usage.requests) || 0;
    total.inputTokens += Number(usage.inputTokens) || 0;
    total.outputTokens += Number(usage.outputTokens) || 0;
    total.costUsd += Number(usage.costUsd) || 0;
    total.tenants++;
  }
  total.costUsd = Number(total.costUsd.toFixed(6));
  return total;
}
