import assert from "node:assert/strict";
import testCase from "node:test";
import { createD1TenantRepository } from "../src/lib/storage/d1TenantRepository";
import type { D1Database, D1PreparedStatement, D1Result } from "../src/lib/storage/d1TenantState";

class RepositoryD1 implements D1Database {
  private rows = new Map<string, { tenant_id: string; payload_json: string; usage_json: string; revision: number; updated_at: string }>();
  prepare(query: string): D1PreparedStatement {
    let values: unknown[] = [];
    const db = this;
    return {
      bind(...args: unknown[]) { values = args; return this; },
      async first<T>() {
        if (query.includes("SELECT tenant_id, payload_json")) {
          return (db.rows.get(String(values[0])) ?? null) as unknown as T | null;
        }
        return null;
      },
      async all<T>(): Promise<D1Result<T>> {
        if (query.includes("SELECT tenant_id")) {
          return { success: true, results: [...db.rows.keys()].sort().map((tenant_id) => ({ tenant_id }) as unknown as T) };
        }
        return { success: true, results: [...db.rows.values()].map((row) => ({ usage_json: row.usage_json }) as unknown as T) };
      },
      async run(): Promise<D1Result> {
        const [tenant, payload, usage, updatedAt, expected] = values;
        const id = String(tenant);
        const current = db.rows.get(id);
        const revision = Number(expected);
        if ((!current && revision === -1) || (current && current.revision === revision)) {
          db.rows.set(id, {
            tenant_id: id, payload_json: String(payload), usage_json: String(usage),
            revision: current ? current.revision + 1 : 1, updated_at: String(updatedAt),
          });
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      },
    };
  }
}

testCase("D1 repository exposes explicit tenant load, update, listing and usage operations", async () => {
  const repository = createD1TenantRepository(new RepositoryD1());
  const initial = await repository.load("repo_tenant");
  assert.equal(initial, null);

  const saved = await repository.update("repo_tenant", () => ({ memories: [], usage: { requests: 0 } }), (draft) => {
    draft.memories = ["repository-contract"];
    draft.usage = { requests: 2, inputTokens: 3, outputTokens: 4, costUsd: 0.5 };
    return "committed";
  });
  assert.deepEqual(saved, { result: "committed", revision: 1, changed: true });
  assert.deepEqual((await repository.load("repo_tenant"))?.state.memories, ["repository-contract"]);
  assert.deepEqual(await repository.listTenantIds(), ["repo_tenant"]);
  assert.deepEqual(await repository.aggregateUsage(), {
    requests: 2, inputTokens: 3, outputTokens: 4, costUsd: 0.5, tenants: 1,
  });
});
