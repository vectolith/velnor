# Cloudflare Workers migration assessment

Status: assessment and compatibility gate only. No production resources are created or changed by this branch.

## Decision

Evaluate Cloudflare Workers with vinext as the application runtime, Cloudflare D1 as the durable tenant-state database, R2 for user-uploaded objects and recoverable exports, and the existing identity gateway as a separately deployed Worker. Use Workers Cron Triggers and Queues for scheduled reminder dispatch once the current scheduler contract has been mapped.

This is a staged migration, not a drop-in redeployment. Keep the current Node.js/SQLite deployment and its data intact until the Workers implementation passes parity and migration tests. See [the async store migration design](./ASYNC-STORE-MIGRATION.md) for the full call-site inventory and required transaction/outbox architecture.

## Repository evidence

- The application is Next.js 15 with React 19 and next.config.ts configured for standalone Node output.
- src/lib/sqliteDb.ts opens node:sqlite synchronously, enables WAL/FULL synchronous writes, and stores a serialized state document per tenant in kv_state.
- src/lib/store.ts exposes synchronous getStore() and saveStore() over filesystem/SQLite state, with AsyncLocalStorage tenant scoping and JSON recovery mirrors.
- src/lib/security/secretBox.ts uses Node crypto AES-256-GCM with authenticated additional data and a keyring. Ciphertext must remain decryptable across the migration; keys must not be rotated or discarded as part of deployment.
- API handlers include explicit runtime = "nodejs" declarations and Node built-in imports. These require runtime compatibility checks and route-by-route testing.
- OAuth state is tenant-bound and one-time; the Google callback is public and must remain reachable without interactive Access login.
- Slack, Twilio, Sendblue, and LoopMessage callbacks perform provider-specific authentication. Those checks must remain at the origin and must not be bypassed by gateway routing.
- The identity gateway currently mints short-lived tenant identity tokens and provisions tenants through a separate provisioning secret. The Cloudflare implementation must preserve those separate trust boundaries.

## Main migration blockers

1. Runtime compatibility: run the pinned vinext compatibility scanner and production build against this exact application. vinext is actively developed; a successful scanner is not proof of runtime parity.
2. Persistence contract: D1 is asynchronous, while the current store API is synchronous. Introduce an explicit async tenant-store boundary and migrate callers in controlled groups. Do not replace SQLite with an in-memory map or Workers virtual filesystem.
3. Tenant isolation and concurrency: persist tenant identity in the database key/row and enforce tenant scope in every read/write. Define atomic update semantics and race tests before moving state.
4. Credential continuity: preserve the existing AES-GCM envelope format, AAD, key IDs, and keyring semantics. Add round-trip tests using existing v1 and v2 fixtures before changing storage.
5. Files and attachments: inventory all filesystem-backed document and attachment paths; move durable objects to private R2 buckets with tenant-scoped object keys and authorization checks.
6. Background work: replace process-local scheduling with Cron Triggers plus a durable queue/dispatch contract. Preserve idempotency and retry behavior.
7. Webhook and OAuth ingress: keep callback paths public where providers require them, but retain provider signature checks, OAuth state verification, and the gateway/origin perimeter secret.
8. Operational readiness: define D1 migrations, backups/exports, restore drills, observability, rate limits, and free-tier quota alerts before production cutover.

## Migration sequence

1. Run vinext check and a separate vinext production build in CI; record all warnings and failures.
2. Add an async storage interface and D1 schema while retaining the existing SQLite adapter for Node deployments.
3. Add tenant isolation, concurrency, credential compatibility, and data import/export tests.
4. Move filesystem-backed uploads/documents to private R2 with tenant-scoped access.
5. Port scheduled work to Cron Triggers and Queues; test retries and idempotency.
6. Run the full API, OAuth, webhook, and browser regression suite on a Cloudflare preview deployment.
7. Only after parity, configure production bindings/secrets, deploy the Workers application and gateway, and perform a verified data migration with rollback.

## Explicit non-goals for this stage

- Do not delete or rewrite the existing SQLite store.
- Do not remove the existing Node/OCI deployment configuration.
- Do not change the main branch or merge the existing gateway PR.
- Do not create Cloudflare databases, buckets, DNS records, routes, or secrets during the compatibility assessment.
- Do not deploy or switch production traffic.
