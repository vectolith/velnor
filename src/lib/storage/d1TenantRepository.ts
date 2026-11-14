import {
  aggregateTenantUsage,
  listTenantStateIds,
  loadTenantState,
  updateTenantState,
  type D1Database,
} from "./d1TenantState";
import type { CredentialCryptoEnvironment } from "../security/secretBoxWebCrypto";
import type { TenantRepository } from "./tenantRepository";

/**
 * D1 implementation of the async repository boundary.
 * The caller owns the D1 binding; this module does not provision resources.
 */
export function createD1TenantRepository(
  db: D1Database,
  cryptoEnvironment?: CredentialCryptoEnvironment,
): TenantRepository {
  return {
    load: (tenantId) => loadTenantState(db, tenantId, cryptoEnvironment),
    update: (tenantId, createInitialState, mutate) =>
      updateTenantState(db, tenantId, createInitialState, mutate, cryptoEnvironment),
    listTenantIds: () => listTenantStateIds(db),
    aggregateUsage: () => aggregateTenantUsage(db),
  };
}
