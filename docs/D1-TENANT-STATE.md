# D1 tenant-state adapter

The first D1 persistence slice is additive. It does not replace src/lib/store.ts, SQLite, or the JSON recovery mirror.

## Apply the schema

The migration at migrations/d1/0001_tenant_state.sql creates one tenant-owned record per sanitized tenant storage ID. Apply it to a newly created D1 database only after provisioning and configuring the Worker binding:

```sh
wrangler d1 migrations apply <database-name> --remote
```

Do not point this schema at production traffic until the async store migration, data export/import, parity checks, backup/restore rehearsal, and rollback plan have passed.

## Adapter contract

src/lib/storage/d1TenantState.ts provides async load, compare-and-swap save, tenant listing, and usage aggregation primitives. Save requires the revision returned by the preceding load. A concurrent write produces TenantStateConflictError; callers must reload and reconcile rather than silently overwriting another request. updateTenantState() supplies an async mutation boundary: it loads an isolated JSON snapshot, awaits a mutation callback, and commits only if the snapshot changed. Mutation callbacks must not perform external side effects because the final compare-and-swap may reject a stale snapshot; conflicts are surfaced and are never automatically retried.

Every read and write passes through VELNOR's existing stateSchema migration and validation functions; invalid collection/config shapes fail explicitly instead of being silently coerced. Legacy supported payloads are migrated in memory and become schema version 2. The adapter validates state before writes and seals credential fields before persistence. It rejects snapshots above 1.9 MB because Cloudflare D1 enforces a 2,000,000-byte maximum row size; large message/document collections must be partitioned or moved to private R2 before production cutover. Usage totals are stored separately so health aggregation does not scan full tenant snapshots. Credential fields in the tenant config are sealed before persistence and opened only after load by `secretBoxWebCrypto.ts`. This Workers-compatible Web Crypto implementation preserves the existing Node secretBox v1/v2 envelope formats, AES-256-GCM parameters, v2 AAD, key IDs, and keyring semantics. Supply `VELNOR_SECRET_KEY` or `VELNOR_SECRET_KEYRING_JSON` to `createD1TenantRepository(db, cryptoEnvironment)`; missing keys, unknown key IDs, and authentication failures fail closed. Non-credential fields such as the connected email address remain readable.

## Not yet implemented

- Async request-scoped store API and migration of all synchronous call sites (tracked in docs/ASYNC-STORE-MIGRATION.md).
- D1 binding configuration, database provisioning, or remote migration.
- Export/import tooling and per-tenant parity verification.
- R2 document/attachment storage.
- Queue/Cron reminder delivery and idempotency.
- Production routing or data cutover.

The current Node/SQLite path remains the active persistence implementation.
