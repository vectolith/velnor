# Node/SQLite tenant repository

The Node implementation of the async `TenantRepository` contract is
`src/lib/storage/nodeSqliteTenantRepository.ts`.

It intentionally delegates canonical state migration and credential handling
to the existing store. It preserves the SQLite `kv_state` rows, JSON recovery
mirror, legacy tenant adoption, canonical state validation, and secretBox
sealing. A new `kv_state_revisions` table tracks durable revisions without
rewriting existing tenant rows; pre-existing rows begin at revision zero.

## Concurrency boundary

Mutations are serialized per tenant within one adapter instance and committed
with SQLite `BEGIN IMMEDIATE` plus a durable revision compare-and-swap. Separate
adapter instances/processes that read the same revision cannot both commit:
the later writer receives an explicit conflict. Legacy `saveStore` writes also
advance the revision, so a repository writer detects a legacy write that occurs
between its read and commit.

The JSON recovery mirror is written while the SQLite writer transaction is
held, so concurrent repository commits cannot reorder their mirror writes.
Legacy direct `saveStore` callers are not themselves conflict-aware and can
still overwrite a concurrent repository commit if they mutate stale cached
state. Therefore this is not yet a multi-replica guarantee for the whole app:
all remaining legacy writers must migrate to the repository or an equivalent
CAS boundary before multi-writer deployment. The mutation callback must not
perform external side effects; conflicts are surfaced and callbacks are never
retried automatically.

## Rollout status

The adapter is additive and is not selected by the application runtime. Existing
synchronous service APIs remain the production path. The memory service now exposes repository-backed async add/list/delete operations
that take an explicit tenant ID. Its existing synchronous exports remain intact
for legacy callers; callers should be migrated one at a time after their request
or job boundary supplies an authenticated tenant ID.
