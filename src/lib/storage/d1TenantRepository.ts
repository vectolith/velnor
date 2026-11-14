import {
  aggregateTenantUsage,
  listTenantStateIds,
  loadTenantState,
  updateTenantState,
  type D1Database,
} from "./d1TenantState";
import type { TenantRepository } from "./tenantRepository";

/**
 * D1 implementation of the async repository boundary.
 * The caller owns the D1 binding; this module does not provision resources.
 */
export function createD1TenantRepository(db: D1Database): TenantRepository {
  return {
    load: (tenantId) => loadTenantState(db, tenantId),
    update: (tenantId, createInitialState, mutate) =>
      updateTenantState(db, tenantId, createInitialState, mutate),
    listTenantIds: () => listTenantStateIds(db),
    aggregateUsage: () => aggregateTenantUsage(db),
  };
}
