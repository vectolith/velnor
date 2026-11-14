import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateTenantUsage,
  listTenantStateIds,
  loadTenantState,
  saveTenantState,
  TenantStateConflictError,
  TenantStateTooLargeError,
  type D1Database,
  type D1PreparedStatement,
  type D1Result,
} from "../src/lib/storage/d1TenantState";

type Row = { tenant_id: string; payload_json: string; revision: number; updated_at: string };
class FakeD1 implements D1Database {
  rows = new Map<string, Row>();
  prepare(query: string): D1PreparedStatement {
    const db = this;
    let values: unknown[] = [];
    return {
      bind(...args: unknown[]) { values = args; return this; },
      async first<T>() {
        const row = db.rows.get(String(values[0]));
        return (row ? { ...row } : null) as T | null;
      },
      async all<T>(): Promise<D1Result<T>> {
        if (query.includes("SELECT tenant_id")) {
          return { success: true, results: [...db.rows.keys()].sort().map((tenant_id) => ({ tenant_id }) as unknown as T) };
        }
        return { success: true, results: [...db.rows.values()].map((row) => ({ usage_json: row.usage_json }) as unknown as T) };
      },
      async run(): Promise<D1Result> {
        const [tenantIdValue, payloadValue, usageValue, updatedAtValue, expectedValue] = values;
        const tenantId = String(tenantIdValue);
        const existing = db.rows.get(tenantId);
        const expected = Number(expectedValue);
        if (!existing && expected === -1) {
          db.rows.set(tenantId, { tenant_id: tenantId, payload_json: String(payloadValue), usage_json: String(usageValue), revision: 1, updated_at: String(updatedAtValue) });
          return { success: true, meta: { changes: 1 } };
        }
        if (existing && existing.revision === expected) {
          db.rows.set(tenantId, { tenant_id: tenantId, payload_json: String(payloadValue), usage_json: String(usageValue), revision: existing.revision + 1, updated_at: String(updatedAtValue) });
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      },
    };
  }
}

test("D1 adapter creates, loads, and compare-and-swap updates tenant state", async () => {
  const db = new FakeD1();
  const first = await saveTenantState(db, "v2_imessage_x3a_15550001", { memories: [], usage: { requests: 2 } }, null);
  assert.equal(first, 1);
  const loaded = await loadTenantState(db, "v2_imessage_x3a_15550001");
  assert.equal(loaded?.revision, 1);
  assert.equal(loaded?.state.usage?.requests, 2);

  const second = await saveTenantState(db, "v2_imessage_x3a_15550001", { memories: ["one"], usage: { requests: 3 } }, 1);
  assert.equal(second, 2);
  await assert.rejects(
    () => saveTenantState(db, "v2_imessage_x3a_15550001", { memories: [] }, 1),
    TenantStateConflictError
  );
  assert.equal((await loadTenantState(db, "v2_imessage_x3a_15550001"))?.revision, 2);
});

test("D1 adapter keeps tenant records isolated and aggregates usage", async () => {
  const db = new FakeD1();
  await saveTenantState(db, "tenant_a", { usage: { requests: 2, inputTokens: 10, outputTokens: 4, costUsd: 0.25 } }, null);
  await saveTenantState(db, "tenant_b", { usage: { requests: 3, inputTokens: 5, outputTokens: 7, costUsd: 0.5 } }, null);
  assert.deepEqual(await listTenantStateIds(db), ["tenant_a", "tenant_b"]);
  assert.deepEqual(await aggregateTenantUsage(db), {
    requests: 5, inputTokens: 15, outputTokens: 11, costUsd: 0.75, tenants: 2
  });
});

test("D1 adapter rejects malformed tenant IDs and corrupt persisted JSON", async () => {
  const db = new FakeD1();
  await assert.rejects(() => loadTenantState(db, "tenant id with spaces"), /unsanitized/);
  db.rows.set("tenant_bad", { tenant_id: "tenant_bad", payload_json: "{", usage_json: "{}", revision: 1, updated_at: "" });
  await assert.rejects(() => loadTenantState(db, "tenant_bad"), /invalid JSON/);
});

test("D1 adapter refuses tenant snapshots that exceed the safe row-size ceiling", async () => {
  const db = new FakeD1();
  await assert.rejects(
    () => saveTenantState(db, "tenant_large", { blob: "x".repeat(1_900_001) }, null),
    TenantStateTooLargeError
  );
  assert.equal(db.rows.has("tenant_large"), false);
});
