import type { PersistedTenantState, TenantStateRecord } from "./d1TenantState";

/**
 * Async persistence boundary used by request/job services.
 *
 * Tenant identity is explicit on every operation. Implementations must preserve
 * tenant isolation and must surface revision conflicts rather than overwriting
 * concurrent mutations. Mutation callbacks must not perform external side effects.
 */
export interface TenantRepository {
  load(tenantId: string): Promise<TenantStateRecord | null>;
  update<TResult>(
    tenantId: string,
    createInitialState: () => PersistedTenantState,
    mutate: (draft: PersistedTenantState) => TResult | Promise<TResult>
  ): Promise<{ result: TResult; revision: number | null; changed: boolean }>;
  listTenantIds(): Promise<string[]>;
  aggregateUsage(): Promise<{
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    tenants: number;
  }>;
}
