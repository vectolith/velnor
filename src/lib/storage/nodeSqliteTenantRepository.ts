import {
  aggregateUsage,
  getStore,
  listUserIds,
  sanitizeUserId,
  saveStore,
  withVelnorUser,
  type VelnorState,
} from "../store";
import type { PersistedTenantState, TenantStateRecord } from "./d1TenantState";
import type { TenantRepository } from "./tenantRepository";

/**
 * Node/SQLite implementation of the async repository contract.
 *
 * It deliberately delegates persistence to the existing store so SQLite,
 * JSON recovery mirrors, credential sealing, schema migration, and legacy
 * tenant adoption remain unchanged. Updates are serialized per tenant within
 * this Node process. This is not a cross-process compare-and-swap primitive;
 * deployments with multiple writers must retain single-writer routing until
 * SQLite-level transactional revisions are introduced.
 */
export function createNodeSqliteTenantRepository(): TenantRepository {
  const revisions = new Map<string, number>();
  const locks = new Map<string, Promise<void>>();

  async function serialized<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(tenantId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    locks.set(tenantId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(tenantId) === current) locks.delete(tenantId);
    }
  }

  function storageId(tenantId: string): string {
    if (!tenantId || tenantId.length > 128) throw new Error("Invalid tenant identifier.");
    return sanitizeUserId(tenantId);
  }

  return {
    async load(tenantId: string): Promise<TenantStateRecord | null> {
      const id = storageId(tenantId);
      if (!listUserIds().includes(id)) return null;
      return withVelnorUser(id, () => {
        const state = structuredClone(getStore()) as VelnorState & { persistedAt?: string };
        return {
          tenantId,
          state: state as unknown as PersistedTenantState,
          revision: revisions.get(id) ?? 0,
          updatedAt: state.persistedAt ?? new Date(0).toISOString(),
        };
      });
    },

    async update<TResult>(
      tenantId: string,
      createInitialState: () => PersistedTenantState,
      mutate: (draft: PersistedTenantState) => TResult | Promise<TResult>,
    ): Promise<{ result: TResult; revision: number | null; changed: boolean }> {
      const id = storageId(tenantId);
      const exists = listUserIds().includes(id);
      return serialized(id, () => withVelnorUser(id, async () => {
        const source = exists
          ? structuredClone(getStore()) as unknown as PersistedTenantState
          : structuredClone(createInitialState());
        const before = JSON.stringify(source);
        if (typeof before !== "string") throw new Error("Initial tenant state could not be serialized.");
        const draft = JSON.parse(before) as PersistedTenantState;
        const result = await mutate(draft);
        const after = JSON.stringify(draft);
        if (typeof after !== "string") throw new Error("Updated tenant state could not be serialized.");
        if (after === before) return { result, revision: revisions.get(id) ?? 0, changed: false };

        saveStore(draft as unknown as VelnorState);
        const revision = (revisions.get(id) ?? 0) + 1;
        revisions.set(id, revision);
        return { result, revision, changed: true };
      }));
    },

    async listTenantIds(): Promise<string[]> {
      return listUserIds();
    },

    async aggregateUsage() {
      return aggregateUsage();
    },
  };
}
