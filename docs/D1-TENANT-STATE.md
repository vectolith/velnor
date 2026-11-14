# D1 tenant-state adapter

The first D1 persistence slice is additive. It does not replace src/lib/store.ts, SQLite, or the JSON recovery mirror.

## Apply the schema

The migration at migrations/d1/0001_tenant_state.sql creates one tenant-owned record per sanitized tenant storage ID. Apply it to a newly created D1 database only after provisioning and configuring the Worker binding:

```sh
wrangler d1 migrations apply <database-name> --remote
```

Do not point this schema at production traffic until the async store migration, data export/import, parity checks, backup/restore rehearsal, and rollback plan have passed.

## Adapter contract

src/lib/storage/d1TenantState.ts provides async load, compare-and-swap save, tenant listing, and usage aggregation primitives. Save requires the revision returned by the preceding load. A concurrent write produces TenantStateConflictError; callers must reload and reconcile rather than silently overwriting another request.

The adapter accepts only already-migrated, validated, sealed persisted state. It does not own encryption keys and must not be given plaintext credentials. The existing secretBox AES-GCM envelope, AAD, key IDs, and keyring remain authoritative.

## Not yet implemented

- Async request-scoped store API and migration of all synchronous call sites.
- D1 binding configuration, database provisioning, or remote migration.
- Export/import tooling and per-tenant parity verification.
- R2 document/attachment storage.
- Queue/Cron reminder delivery and idempotency.
- Production routing or data cutover.

The current Node/SQLite path remains the active persistence implementation.
