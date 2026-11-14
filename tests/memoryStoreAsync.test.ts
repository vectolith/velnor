import assert from "node:assert/strict";
import testCase from "node:test";
import {
  addMemoryFactAsync,
  deleteMemoryFactAsync,
  listMemoryFactsAsync,
} from "../src/lib/tools/memoryStore";
import type { TenantRepository } from "../src/lib/storage/tenantRepository";
import type { PersistedTenantState, TenantStateRecord } from "../src/lib/storage/d1TenantState";

function memoryRepository(): TenantRepository {
  const rows = new Map<string, PersistedTenantState>();
  return {
    async load(id): Promise<TenantStateRecord | null> {
      const state = rows.get(id);
      return state ? { tenantId: id, state: structuredClone(state), revision: 1, updatedAt: new Date().toISOString() } : null;
    },
    async update(id, initial, mutate) {
      const draft = structuredClone(rows.get(id) ?? initial());
      const before = JSON.stringify(draft);
      const result = await mutate(draft);
      const changed = JSON.stringify(draft) !== before;
      if (changed) rows.set(id, draft);
      return { result, revision: changed ? 1 : null, changed };
    },
    async listTenantIds() { return [...rows.keys()]; },
    async aggregateUsage() { return { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, tenants: rows.size }; },
  };
}

testCase("async memory service uses explicit tenant repository and preserves tenant isolation", async () => {
  const repository = memoryRepository();
  const first = await addMemoryFactAsync(repository, "tenant-a", { fact: "Project meeting next week" });
  await addMemoryFactAsync(repository, "tenant-b", { fact: "Book airport hotel" });
  assert.equal(first.category, "work");
  assert.deepEqual((await listMemoryFactsAsync(repository, "tenant-a")).map((item) => item.id), [first.id]);
  assert.deepEqual(await listMemoryFactsAsync(repository, "tenant-b", "project"), []);
  assert.deepEqual(await deleteMemoryFactAsync(repository, "tenant-a", first.id), []);
});
