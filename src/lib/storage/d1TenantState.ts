import { migrateState, validateState } from "../security/stateSchema";
import {
  openCredentialRecordAsync,
  sealCredentialRecordAsync,
  type CredentialCryptoEnvironment,
} from "../security/secretBoxWebCrypto";

/**
 * Cloudflare D1 persistence primitives for VELNOR tenant state.
 * Deliberately not wired into the synchronous Node store yet.
 * State is validated before writes; credential fields are sealed with Web Crypto
 * before persistence and opened only after successful reads.
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
function normalizeTenantState(raw: unknown): PersistedTenantState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Persisted tenant state must be a JSON object.");
  }
  const migrated = migrateState(raw).value;
  const validation = validateState(migrated);
  if (!validation.ok) {
    throw new Error("Persisted tenant state failed schema validation: " + validation.issues.join("; "));
  }
  return migrated as PersistedTenantState;
}
async function parseRecord(
  row: { tenant_id: string; payload_json: string; revision: number; updated_at: string },
  cryptoEnvironment?: CredentialCryptoEnvironment,
): Promise<TenantStateRecord> {
  let state: unknown;
  try { state = JSON.parse(row.payload_json); }
  catch { throw new Error("Persisted tenant state is invalid JSON; refusing silent reset."); }
  const migrated = migrateState(state).value;
  if (migrated.config && typeof migrated.config === "object" && !Array.isArray(migrated.config)) {
    migrated.config = await openCredentialRecordAsync(
      migrated.config as Record<string, unknown>,
      cryptoEnvironment,
    );
  }
  const normalized = normalizeTenantState(migrated);
  return { tenantId: row.tenant_id, state: normalized,
    revision: row.revision, updatedAt: row.updated_at };
}
export async function loadTenantState(
  db: D1Database,
  tenantId: string,
  cryptoEnvironment?: CredentialCryptoEnvironment,
): Promise<TenantStateRecord | null> {
  assertTenantId(tenantId);
  const row = await db.prepare(
    "SELECT tenant_id, payload_json, revision, updated_at FROM tenant_state WHERE tenant_id = ?"
  ).bind(tenantId).first<{
    tenant_id: string; payload_json: string; revision: number; updated_at: string;
  }>();
  return row ? parseRecord(row, cryptoEnvironment) : null;
}
/** Atomic compare-and-swap. Pass null only to create a previously absent tenant. */
export async function saveTenantState(
  db: D1Database,
  tenantId: string,
  state: PersistedTenantState,
  expectedRevision: number | null,
  cryptoEnvironment?: CredentialCryptoEnvironment,
): Promise<number> {
  assertTenantId(tenantId);
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
    throw new Error("Expected tenant revision must be a positive safe integer or null.");
  }
  const normalized = normalizeTenantState(state);
  const persisted: PersistedTenantState = { ...normalized };
  if (persisted.config && typeof persisted.config === "object" && !Array.isArray(persisted.config)) {
    persisted.config = await sealCredentialRecordAsync(
      persisted.config as Record<string, unknown>,
      cryptoEnvironment,
    );
  }
  const serialized = JSON.stringify(persisted);
  if (typeof serialized !== "string") throw new Error("Tenant state could not be serialized.");
  const bytes = new TextEncoder().encode(serialized).byteLength;
  // Cloudflare D1 caps an individual row at 2,000,000 bytes. Keep headroom for
  // SQLite row encoding and refuse an unsafe write rather than losing state.
  if (bytes > 1_900_000) throw new TenantStateTooLargeError(tenantId, bytes);
  const usageJson = JSON.stringify(normalized.usage || {});
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

/**
 * Run a state mutation against an isolated snapshot and persist it with CAS.
 * The callback may be async, but must not perform external side effects: the
 * final compare-and-swap can fail if another request committed concurrently.
 * A conflict is surfaced to the caller; this function never silently retries
 * a callback that might not be idempotent.
 */
export async function updateTenantState<TResult>(
  db: D1Database,
  tenantId: string,
  createInitialState: () => PersistedTenantState,
  mutate: (draft: PersistedTenantState) => TResult | Promise<TResult>,
  cryptoEnvironment?: CredentialCryptoEnvironment,
): Promise<{ result: TResult; revision: number | null; changed: boolean }> {
  const current = await loadTenantState(db, tenantId, cryptoEnvironment);
  const source = current?.state ?? createInitialState();
  const serializedSource = JSON.stringify(source);
  if (typeof serializedSource !== "string") {
    throw new Error("Initial tenant state could not be serialized.");
  }
  const draft = JSON.parse(serializedSource) as PersistedTenantState;
  const result = await mutate(draft);
  const serializedDraft = JSON.stringify(draft);
  if (typeof serializedDraft !== "string") {
    throw new Error("Updated tenant state could not be serialized.");
  }
  if (serializedDraft === serializedSource) {
    return { result, revision: current?.revision ?? null, changed: false };
  }
  const revision = await saveTenantState(db, tenantId, draft, current?.revision ?? null, cryptoEnvironment);
  return { result, revision, changed: true };
}
