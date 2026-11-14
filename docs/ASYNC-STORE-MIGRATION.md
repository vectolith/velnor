# Async tenant-store migration design

## Current synchronous boundary

The current runtime exposes synchronous `getStore()` and `saveStore()` functions backed by `AsyncLocalStorage`, Node's `node:sqlite`, and a JSON recovery mirror. `withVelnorUser()` loads a tenant synchronously and establishes the request scope. This API cannot be used directly on Workers with D1 because D1 operations are asynchronous and Workers do not provide durable local SQLite/filesystem storage.

Do not replace `saveStore()` with fire-and-forget promises, hide D1 writes in `waitUntil()`, or persist a full snapshot only after arbitrary business callbacks. Those approaches can acknowledge lost writes, race with concurrent requests, or commit after an external action has already happened.

## Call-site inventory

### Request and scheduled entry points

- `src/app/api/chat/route.ts` — tenant-scoped settings/snapshot reads, message handling, memory/reminder mutations, reactions, and tool execution.
- `src/app/api/settings/route.ts` — tenant configuration reads and writes.
- `src/app/api/auth/google/route.ts` and `src/app/api/auth/google/callback/route.ts` — tenant OAuth setup, one-time state/nonce consumption, token exchange, and credential persistence.
- `src/app/api/siri/route.ts` and `src/app/api/tts/route.ts` — tenant-scoped AI and speech processing.
- `src/app/api/webhooks/slack/route.ts` and `src/app/api/webhooks/imessage/route.ts` — signed inbound events, tenant resolution, AI processing, and outbound provider delivery. Their public provider callback routes must not be blanket-protected by Cloudflare Access.
- `src/app/api/cron/reminders/route.ts` and `src/lib/scheduler.ts` — cross-tenant enumeration, due-reminder selection, external message delivery, and completion updates.
- `src/app/api/internal/tenants/provision/route.ts` — tenant creation and listing.
- `src/app/api/internal/maintenance/reseal-credentials/route.ts` — cross-tenant credential migration.
- `src/app/api/vcard/route.ts` — currently reads the root store directly and needs an explicit tenant or public-profile policy before Worker migration.

### Synchronous store consumers

- `src/lib/ai/agent.ts` — appends inbound/outbound messages and invokes model/tool providers.
- `src/lib/auth/googleToken.ts` — reads OAuth credentials, refreshes access tokens over the network, and saves rotated tokens.
- `src/lib/tools/workspaceService.ts` — Gmail and Calendar API calls plus local mirrors for emails, events, and reminders.
- `src/lib/tools/documentStore.ts` — document chunk/embedding generation and local index persistence.
- `src/lib/tools/memoryStore.ts` — local memory mutations.
- `src/lib/tools/multimodal.ts` — reads provider configuration for image generation.
- `src/lib/scheduler.ts` — updates reminder state after Slack/SMS/iMessage delivery.

The list above is a migration inventory, not proof that these modules are Worker-compatible. Search for every remaining `getStore()`, `saveStore()`, `loadUserState()`, `listUserIds()`, and `aggregateUsage()` reference again before removing the Node adapter.

## Required async architecture

1. Introduce an explicit asynchronous tenant repository contract for load, compare-and-swap update, list, and usage aggregation. Keep Node/SQLite as a separate implementation until parity is proven.
2. Make tenant identity an explicit argument at request and job boundaries. Do not use a process-global default tenant for authenticated Worker requests.
3. Split large collections from the single D1 snapshot. Keep bounded tenant configuration and metadata in D1; move binary attachments and generated media to private R2. Store document chunks in a tenant-keyed table or a separately indexed store rather than embedding an unbounded array in the state row.
4. Convert each leaf operation to explicit async reads/writes before changing route handlers. Remove hidden synchronous access from the agent, tools, OAuth helper, and scheduler.
5. Introduce a durable, idempotent outbox for outbound provider actions. Persist the intended action and state transition before dispatch; workers deliver with retries and deduplication. Do not wrap callbacks that send email/messages or mutate Google resources in a retryable D1 mutation callback.
6. Use Queues for dispatch and Cron Triggers only to enqueue due work. Preserve webhook signature verification, replay protection, OAuth one-time state, tenant-bound identity tokens, and the separate provisioning secret.
7. Export existing SQLite tenant records without decrypting/resealing credentials; verify that every credential field is already sealed before export. Import into a staging D1 database, compare per-tenant counts and checksums, then rehearse restore and rollback before any production cutover.

## Acceptance gates

- No reachable Worker module imports `node:sqlite`, `fs`, or `path` for durable state.
- Concurrent same-tenant mutations cannot silently overwrite one another; cross-tenant reads/writes are denied.
- External side effects are outbox-backed or have a documented idempotency strategy; no automatic retry replays a non-idempotent action.
- OAuth callbacks remain reachable and preserve state/nonce verification; webhook signature and replay tests remain green.
- R2 object reads compare bytes, size, content type, and SHA-256 against the independent reference stored in D1; buckets remain private.
- Data export/import, per-tenant checksum comparison, backup/restore, and rollback drills pass before routing traffic to Workers.
- Node/SQLite remains available as the rollback path until the production cutover is explicitly approved.

## Current status

The D1 and R2 modules in this branch are isolated persistence primitives with contract tests. They are not connected to route handlers, no Cloudflare resources have been provisioned, and no production data has moved. This branch does not claim the application is deployable on Workers yet.

## Repository contract introduced

The branch now defines `TenantRepository` in `src/lib/storage/tenantRepository.ts` with explicit asynchronous operations for tenant load, mutation, tenant listing, and usage aggregation. `createD1TenantRepository()` adapts the existing D1 primitives to that contract. Its mutation callback inherits the D1 compare-and-swap rule: it must be limited to in-memory state changes and must not perform external side effects.

This is an interface boundary, not a completed runtime migration. The current synchronous `getStore()`/`saveStore()` API and Node/SQLite implementation remain unchanged. No request handler or service has been switched to the new contract. A Node repository implementation and service-level call-site migration are still required before the boundary can be adopted safely.

