import {
  aggregateUsage,
  getStore,
  getUserStateRevision,
  listUserIds,
  loadUserStateFresh,
  sanitizeUserId,
  saveStoreIfRevision,
  withVelnorUserState,
  type VelnorState,
} from "../store";
import type { PersistedTenantState, TenantStateRecord } from "./d1TenantState";
import type { TenantRepository } from "./tenantRepository";

/**
 * Node/SQLite implementation of the async repository contract.
 *
 * It deliberately delegates persistence to the existing store so SQLite,
 * JSON recovery mirrors, credential sealing, schema migration, and legacy
 * tenant adoption remain unchanged. Repository writes use SQLite BEGIN IMMEDIATE
 * transactions and durable revision compare-and-swap across processes. Legacy
 * direct saveStore callers still need migration to receive the same conflict
 * contract and can otherwise race with repository writes.
 */
export function createNodeSqliteTenantRepository(): TenantRepository {
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

  function loadSnapshot(id: string): { state: VelnorState; revision: number } {
    // Complete any one-time migration first, then detect writes racing the fresh read.
    loadUserStateFresh(id);
    const before = getUserStateRevision(id);
    const state = loadUserStateFresh(id);
    const after = getUserStateRevision(id);
    if (before !== after) throw new Error("Tenant state changed while loading; reload before retrying.");
    return { state, revision: after };
  }

  return {
    async load(tenantId: string): Promise<TenantStateRecord | null> {
      const id = storageId(tenantId);
      if (!listUserIds().includes(id)) return null;
      const snapshot = loadSnapshot(id);
      return withVelnorUserState(id, snapshot.state, () => {
        const state = structuredClone(getStore()) as VelnorState & { persistedAt?: string };
        return {
          tenantId,
          state: state as unknown as PersistedTenantState,
          revision: snapshot.revision,
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
      return serialized(id, async () => {
        const exists = listUserIds().includes(id);
        const snapshot = exists ? loadSnapshot(id) : null;
        const expectedRevision = snapshot?.revision ?? getUserStateRevision(id);
        const initial = snapshot?.state ?? createInitialState() as unknown as VelnorState;
        return withVelnorUserState(id, initial, async () => {
          const source = structuredClone(getStore()) as unknown as PersistedTenantState;
          const before = JSON.stringify(source);
          if (typeof before !== "string") throw new Error("Initial tenant state could not be serialized.");
          const draft = JSON.parse(before) as PersistedTenantState;
          const result = await mutate(draft);
          const after = JSON.stringify(draft);
          if (typeof after !== "string") throw new Error("Updated tenant state could not be serialized.");
          if (after === before) return { result, revision: expectedRevision, changed: false };

          const revision = saveStoreIfRevision(draft as unknown as VelnorState, expectedRevision);
          return { result, revision, changed: true };
        });
      });
    },

    async listTenantIds(): Promise<string[]> {
      return listUserIds();
    },

    async aggregateUsage() {
      return aggregateUsage();
    },
  };
}
