import { requireCurrentUserId } from "../store";
import { createNodeSqliteTenantRepository } from "./nodeSqliteTenantRepository";

/** Shared Node adapter for request-scoped services that require explicit tenant identity. */
const repository = createNodeSqliteTenantRepository();

export function getNodeTenantRepositoryContext() {
  return {
    repository,
    tenantId: requireCurrentUserId(),
  };
}
