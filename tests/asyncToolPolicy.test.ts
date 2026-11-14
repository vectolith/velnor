import assert from "node:assert/strict";
import test from "node:test";
import type { PersistedTenantState, TenantStateRecord } from "../src/lib/storage/d1TenantState";
import type { TenantRepository } from "../src/lib/storage/tenantRepository";
import { enforceToolPolicyAsync, noteUserMessageAsync } from "../src/lib/security/asyncToolPolicy";

function repository(): TenantRepository {
  const rows = new Map<string, { state: PersistedTenantState; revision: number }>();
  const locks = new Map<string, Promise<void>>();
  return {
    async load(tenantId): Promise<TenantStateRecord | null> {
      const row = rows.get(tenantId);
      return row ? {
        tenantId, state: structuredClone(row.state), revision: row.revision,
        updatedAt: new Date().toISOString(),
      } : null;
    },
    async update<TResult>(
      tenantId: string,
      createInitialState: () => PersistedTenantState,
      mutate: (draft: PersistedTenantState) => TResult | Promise<TResult>,
    ) {
      const previous = locks.get(tenantId) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      locks.set(tenantId, current);
      await previous;
      try {
        const existing = rows.get(tenantId);
        const draft = structuredClone(existing?.state ?? createInitialState());
        const before = JSON.stringify(draft);
        const result = await mutate(draft);
        const changed = JSON.stringify(draft) !== before;
        const revision = changed ? (existing?.revision ?? 0) + 1 : existing?.revision ?? null;
        if (changed) rows.set(tenantId, { state: draft, revision: revision as number });
        return { result, revision, changed };
      } finally {
        release();
        if (locks.get(tenantId) === current) locks.delete(tenantId);
      }
    },
    async listTenantIds() { return [...rows.keys()]; },
    async aggregateUsage() {
      return { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, tenants: rows.size };
    },
  };
}

test("async tool policy requires and consumes a tenant-bound exact confirmation once", async () => {
  const repo = repository();
  assert.deepEqual(await enforceToolPolicyAsync(repo, "tenant-a", "list_emails"), { allowed: true });
  const first = await enforceToolPolicyAsync(repo, "tenant-a", "draft_or_send_email", {
    to: "a@example.com", subject: "Launch", body: "Ready",
  });
  assert.equal(first.allowed, false);
  await noteUserMessageAsync(repo, "tenant-a", "yes");
  const allowed = await enforceToolPolicyAsync(repo, "tenant-a", "draft_or_send_email", {
    to: "a@example.com", subject: "Launch", body: "Ready",
  });
  assert.equal(allowed.allowed, true);
  const second = await enforceToolPolicyAsync(repo, "tenant-a", "draft_or_send_email", {
    to: "a@example.com", subject: "Launch", body: "Ready",
  });
  assert.equal(second.allowed, false);
});

test("async tool policy does not accept stale or mismatched affirmations", async () => {
  const repo = repository();
  await noteUserMessageAsync(repo, "tenant-a", "yes");
  assert.equal((await enforceToolPolicyAsync(repo, "tenant-a", "organize_email", { emailId: "e-1" })).allowed, false);
  assert.equal((await enforceToolPolicyAsync(repo, "tenant-a", "organize_email", { emailId: "e-2" })).allowed, false);
  await noteUserMessageAsync(repo, "tenant-a", "yes");
  assert.equal((await enforceToolPolicyAsync(repo, "tenant-a", "organize_email", { emailId: "e-2" })).allowed, true);
});

test("async tool policy isolates confirmation state by tenant", async () => {
  const repo = repository();
  await enforceToolPolicyAsync(repo, "tenant-a", "create_calendar_event", { title: "A" });
  await noteUserMessageAsync(repo, "tenant-b", "yes");
  assert.equal((await enforceToolPolicyAsync(repo, "tenant-a", "create_calendar_event", { title: "A" })).allowed, false);
  await noteUserMessageAsync(repo, "tenant-a", "yes");
  assert.equal((await enforceToolPolicyAsync(repo, "tenant-a", "create_calendar_event", { title: "A" })).allowed, true);
});

test("concurrent async confirmation checks cannot both consume one approval", async () => {
  const repo = repository();
  const args = { to: "a@example.com", subject: "A", body: "B" };
  await enforceToolPolicyAsync(repo, "tenant-a", "draft_or_send_email", args);
  await noteUserMessageAsync(repo, "tenant-a", "yes");
  const results = await Promise.all([
    enforceToolPolicyAsync(repo, "tenant-a", "draft_or_send_email", args),
    enforceToolPolicyAsync(repo, "tenant-a", "draft_or_send_email", args),
  ]);
  assert.equal(results.filter((result) => result.allowed).length, 1);
});
