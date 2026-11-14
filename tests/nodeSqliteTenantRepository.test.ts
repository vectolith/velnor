import assert from "node:assert/strict";
import testCase from "node:test";
import { createNodeSqliteTenantRepository } from "../src/lib/storage/nodeSqliteTenantRepository";
import type { PersistedTenantState } from "../src/lib/storage/d1TenantState";

testCase("Node/SQLite repository serializes same-tenant async mutations", async () => {
  const repository = createNodeSqliteTenantRepository();
  const tenant = "node-repository-test-" + Date.now();
  const initial = (): PersistedTenantState => ({ counter: 0, usage: { requests: 0 } });

  await repository.update(tenant, initial, (draft) => { draft.counter = 0; });
  const results = await Promise.all(Array.from({ length: 12 }, async () =>
    repository.update(tenant, initial, async (draft) => {
      const current = Number(draft.counter ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 2));
      draft.counter = current + 1;
    })
  ));

  const loaded = await repository.load(tenant);
  assert.equal(loaded?.state.counter, 12);
  assert.equal(results.filter((item) => item.changed).length, 12);
  assert.equal(loaded?.revision, 13);
});

testCase("Node/SQLite repository keeps tenant state isolated", async () => {
  const repository = createNodeSqliteTenantRepository();
  const suffix = Date.now();
  const first = "node-isolation-a-" + suffix;
  const second = "node-isolation-b-" + suffix;
  const initial = (): PersistedTenantState => ({ value: "initial" });

  await repository.update(first, initial, (draft) => { draft.value = "first"; });
  await repository.update(second, initial, (draft) => { draft.value = "second"; });

  assert.equal((await repository.load(first))?.state.value, "first");
  assert.equal((await repository.load(second))?.state.value, "second");
});
