import assert from "node:assert/strict";
import testFn from "node:test";
import type { PersistedTenantState, TenantStateRecord } from "../src/lib/storage/d1TenantState";
import type { TenantRepository } from "../src/lib/storage/tenantRepository";
import { createRepositoryDocumentStore } from "../src/lib/tools/repositoryDocumentStore";

function createMemoryRepository(): TenantRepository {
  const records = new Map<string, TenantStateRecord>();
  return {
    async load(tenantId) {
      const record = records.get(tenantId);
      return record ? structuredClone(record) : null;
    },
    async update<TResult>(tenantId: string, createInitialState: () => PersistedTenantState,
      mutate: (draft: PersistedTenantState) => TResult | Promise<TResult>) {
      const current = records.get(tenantId);
      const draft = structuredClone(current?.state ?? createInitialState());
      const before = JSON.stringify(draft);
      const result = await mutate(draft);
      const changed = JSON.stringify(draft) !== before;
      const revision = changed ? (current?.revision ?? 0) + 1 : current?.revision ?? null;
      if (changed) records.set(tenantId, {
        tenantId, state: draft, revision: revision as number, updatedAt: new Date().toISOString(),
      });
      return { result, revision, changed };
    },
    async listTenantIds() { return [...records.keys()]; },
    async aggregateUsage() {
      return { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, tenants: records.size };
    },
  };
}

const initialState = (): PersistedTenantState => ({
  documents: [], documentChunks: [], usage: { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
});

testFn("repository document store indexes and retrieves text within an explicit tenant", async () => {
  const repository = createMemoryRepository();
  const store = createRepositoryDocumentStore({ repository, tenantId: "tenant-a", createInitialState: initialState });
  const document = await store.ingest({
    name: "architecture.txt",
    content: "Tenant isolation is a core requirement. Repository writes must preserve tenant boundaries and document integrity.",
  });
  assert.equal(document.name, "architecture.txt");
  assert.equal((await store.query("tenant isolation")).documents.length, 1);
  assert.equal((await store.query("tenant isolation")).matches[0]?.docName, "architecture.txt");
  assert.deepEqual((await createRepositoryDocumentStore({
    repository, tenantId: "tenant-b", createInitialState: initialState,
  }).query("tenant isolation")), { matches: [], documents: [] });
});

testFn("repository document store rejects empty and oversized text without writing", async () => {
  const repository = createMemoryRepository();
  const store = createRepositoryDocumentStore({ repository, tenantId: "tenant-a", createInitialState: initialState });
  await assert.rejects(store.ingest({ name: "empty.txt", content: "   " }), /No readable text/);
  await assert.rejects(store.ingest({ name: "large.txt", content: "x".repeat(2_000_001) }), /2 MB/);
  assert.equal(await repository.load("tenant-a"), null);
});

testFn("repository document store rejects missing or malformed tenant identity", () => {
  for (const tenantId of ["", "tenant with spaces", "x".repeat(129)]) {
    assert.throws(() => createRepositoryDocumentStore({
      repository: createMemoryRepository(), tenantId, createInitialState: initialState,
    }), /explicit tenant ID/);
  }
});
