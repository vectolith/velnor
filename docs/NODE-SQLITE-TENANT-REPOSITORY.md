# Node/SQLite tenant repository

The Node implementation of the async `TenantRepository` contract is
`src/lib/storage/nodeSqliteTenantRepository.ts`.

It intentionally delegates reads and writes to the existing
`loadUserState`/store scope and `saveStore` path. That preserves the current
SQLite `kv_state` layout, JSON recovery mirror, legacy tenant adoption,
canonical state migration, and secretBox sealing. It does not create a second
database, rewrite existing rows, or change the production storage selection.

## Concurrency boundary

Mutations are serialized per tenant within one Node process. The returned
revision is a process-local generation counter, not a durable SQLite revision.
This adapter therefore does not claim cross-process compare-and-swap safety.
Keep a single writer process for this adapter; do not use it as a multi-replica
coordination mechanism. D1 retains durable revision CAS.

The mutation callback must not perform external side effects. A write can fail
after the callback returns, and retries are not performed automatically.

## Rollout status

The adapter is additive and is not selected by the application runtime. Existing
synchronous service APIs remain the production path. Individual services can
move to the async contract behind explicit request/job tenant boundaries after
their callers are converted and concurrency requirements are verified.
