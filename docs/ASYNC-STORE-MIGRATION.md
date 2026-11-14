# Async tenant-store migration design

## Current synchronous boundary

The Node runtime still exposes synchronous `getStore()` and `saveStore()` functions backed by `AsyncLocalStorage`, Node's `node:sqlite`, and a JSON recovery mirror. `withVelnorUser()` loads a tenant and establishes the request scope. This API cannot be used directly on Workers with D1 because D1 operations are asynchronous and Workers do not provide durable local SQLite/filesystem storage.

Do not replace `saveStore()` with fire-and-forget promises, hide D1 writes in `waitUntil()`, or persist a full snapshot only after arbitrary business callbacks. Those approaches can acknowledge lost writes, race with concurrent requests, or commit after an external action has already happened.

## Call-site inventory

### Request and scheduled entry points

- `src/app/api/chat/route.ts` — authenticated tenant scope; snapshot GET, document ingestion, memory add/list/delete, sensitive-action confirmation state, and reminder create/list/toggle now use the async repository. Message processing, reactions, calendar/email actions, and other POST state changes still include synchronous store paths.
- `src/app/api/settings/route.ts` — GET/POST now use the async tenant repository through a tenant-only scope; this route no longer synchronously loads or saves the Node store.
- `src/app/api/auth/google/route.ts` and `src/app/api/auth/google/callback/route.ts` — tenant OAuth setup, one-time state/nonce consumption, token exchange, and credential persistence remain synchronous.
- `src/app/api/siri/route.ts` and `src/app/api/tts/route.ts` — tenant-scoped AI and speech processing; inspect each request path for remaining synchronous state access.
- `src/app/api/webhooks/slack/route.ts` and `src/app/api/webhooks/imessage/route.ts` — signed inbound events, tenant resolution, AI processing, and outbound provider delivery. Their public provider callback routes must not be blanket-protected by Cloudflare Access.
- `src/app/api/cron/reminders/route.ts` and `src/lib/scheduler.ts` — cross-tenant enumeration, due-reminder selection, external message delivery, and completion updates remain synchronous and are not yet outbox-backed.
- `src/app/api/internal/tenants/provision/route.ts` — tenant creation and listing.
- `src/app/api/internal/maintenance/reseal-credentials/route.ts` — cross-tenant credential migration.
- `src/app/api/vcard/route.ts` — currently reads the root store directly and needs an explicit tenant or public-profile policy before Worker migration.

### Synchronous store consumers still requiring migration

- `src/lib/ai/agent.ts` — appends inbound/outbound messages, records usage, and invokes model/tool providers.
- `src/lib/auth/googleToken.ts` — legacy synchronous token refresh remains for non-migrated callers.
- `src/lib/auth/googleTokenAsync.ts` — Workers-compatible async token refresh reads and persists tenant OAuth credentials through `TenantRepository`; workspace Gmail/Calendar calls now use this path. Runtime bindings should pass Google client credentials explicitly rather than relying on Node process globals.
- `src/lib/tools/workspaceService.ts` — Gmail and Calendar API calls use the async OAuth token helper and local email/event/reminder persistence and list/toggle operations use the async repository. The module still has Node-specific compatibility code for the legacy synchronous reminder scheduler and is not yet a Workers entrypoint. External Gmail/Calendar mutations are not outbox-backed and must not be retried automatically. Legacy synchronous reminder helpers remain for scheduler compatibility.
- `src/lib/tools/memoryStore.ts` — legacy synchronous exports remain, but audited chat and agent add/list/delete callers now use the async repository.
- `src/lib/security/toolPolicy.ts` — legacy in-memory confirmation maps remain for tests/compatibility; active agent and chat routes now use a tenant-persisted async confirmation policy with Web Crypto fingerprints and atomic one-time consumption.
- `src/lib/tools/documentStore.ts` — document metadata/chunks are now persisted through the async repository. PDF extraction, URL fetching, and embedding generation remain in the Node boundary.
- `src/lib/tools/multimodal.ts` — reads provider configuration.
- `src/lib/scheduler.ts` — still uses the synchronous store while dispatching Slack/SMS/iMessage reminders. Do not move its state transition into a retryable callback; dispatch and completion must be coordinated through the durable outbox.

The list above is a migration inventory, not proof that these modules are Worker-compatible. Search for every remaining `getStore()`, `saveStore()`, `loadUserState()`, `listUserIds()`, and `aggregateUsage()` reference again before removing the Node adapter.

## Implemented repository boundary

- `TenantRepository` defines explicit asynchronous tenant load, mutation, listing, and usage aggregation.
- `createD1TenantRepository()` adapts D1 state primitives with durable revision compare-and-swap.
- `createNodeSqliteTenantRepository()` adapts the existing Node state store. It uses SQLite `BEGIN IMMEDIATE`, a durable `kv_state_revisions` table, and compare-and-swap writes across repository instances/processes. Existing rows begin at revision zero.
- The Node repository bypasses the process cache for fresh reads and checks revisions around the read. Same-tenant nested scopes are refreshed after repository updates so the request sees its committed state.
- Document ingestion/retrieval, chat/agent memory add/list/delete, sensitive-action confirmation state, workspace local email/event/reminder operations, and settings GET/POST now use the async repository through a shared Node repository context. The context requires an authenticated tenant scope; it does not silently fall back to the root profile.
- `withVelnorTenantScope()` establishes an authenticated tenant identity without synchronously loading Node storage. The settings route uses this entry boundary and then reads or mutates through the repository.
- Sensitive-action confirmations are stored per tenant, bound to exact JSON arguments, expire after five minutes, and are consumed atomically. The async policy uses Web Crypto and contains no Node-only crypto dependency.
- Legacy direct `saveStore()` writers still advance the durable revision but do not participate in compare-and-swap. They can still race with repository writers if they mutate stale cached state. Whole-application multi-writer safety is therefore not established until remaining writers are migrated.

This is a partial service migration, not a completed runtime migration. The Node adapter remains the active backend for the current application. The D1 adapter is not wired to request handlers, and no Worker deployment or production data cutover has occurred.

## Required async architecture

1. Keep an explicit asynchronous tenant repository contract for load, compare-and-swap update, list, and usage aggregation. Keep Node/SQLite as a separate implementation until parity is proven.
2. Make tenant identity an explicit argument at request and job boundaries. Do not use a process-global default tenant for authenticated Worker requests.
3. Split large collections from the single D1 snapshot. Keep bounded tenant configuration and metadata in D1; move binary attachments and generated media to private R2. Store document chunks in a tenant-keyed table or separately indexed store rather than embedding an unbounded array in the state row.
4. Convert each leaf operation to explicit async reads/writes before changing route handlers. Remove hidden synchronous access from the agent, tools, OAuth helper, and scheduler.
5. Integrate the durable, idempotent outbox for outbound provider actions. Persist the intended action and state transition before dispatch; workers deliver with retries and deduplication. Do not wrap callbacks that send email/messages or mutate Google resources in a retryable D1 mutation callback.
6. Use Queues for dispatch and Cron Triggers only to enqueue due work. Preserve webhook signature verification, replay protection, OAuth one-time state, tenant-bound identity tokens, and the separate provisioning secret.
7. Export existing SQLite tenant records without decrypting/resealing credentials; verify every credential field is already sealed before export. Import into a staging D1 database, compare per-tenant counts and checksums, then rehearse restore and rollback before any production cutover.

## Acceptance gates

- No reachable Worker module imports `node:sqlite`, `fs`, or `path` for durable state.
- Concurrent same-tenant mutations cannot silently overwrite one another; cross-tenant reads/writes are denied.
- External side effects are outbox-backed or have a documented idempotency strategy; no automatic retry replays a non-idempotent action.
- OAuth callbacks remain reachable and preserve state/nonce verification; webhook signature and replay tests remain green.
- R2 object reads compare bytes, size, content type, and SHA-256 against the independent reference stored in D1; buckets remain private.
- Data export/import, per-tenant checksum comparison, backup/restore, and rollback drills pass before routing traffic to Workers.
- Node/SQLite remains available as the rollback path until the production cutover is explicitly approved.

## Current deployment status

The D1, R2, and outbox modules remain isolated persistence primitives. No Cloudflare resources have been provisioned, no production secrets or routes have been changed, no DNS has been cut over, and no production data has moved. The branch does not claim the application is deployable on Workers yet.
