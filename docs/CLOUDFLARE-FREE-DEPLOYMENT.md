# Cloudflare free-tier deployment migration

## Status

Planning and compatibility gate only. This document does not claim that Velnor has
been ported or deployed to Cloudflare. The existing OCI deployment remains the
documented deployment of record until a replacement passes the release gates below.

## Target

Use a Cloudflare Workers `workers.dev` hostname so Velnor can be brought up without
buying `velnor.ai` or provisioning an OCI virtual machine. Keep the deployment
within Cloudflare's free allowances where possible. Verify current plan limits and
usage before enabling public traffic; do not assume every product or feature is free.

Cloudflare's current Next.js guidance recommends **vinext** for new Workers
deployments. Start with its compatibility check and non-destructive initializer.
Do not adopt OpenNext or add a second framework adapter unless a documented
vinext compatibility gap requires it.

## Current repository constraints

The current application is not a static Next.js export. It has server route handlers,
middleware, provider webhooks, scheduled reminder work, and tenant-scoped state.

The current persistence implementation is Node-oriented:

- `src/lib/sqliteDb.ts` imports `fs`, `os`, and `path`, and opens the Node 22
  `node:sqlite` synchronous database.
- `src/lib/store.ts` uses `node:async_hooks`, `node:crypto`, filesystem JSON
  mirrors, and synchronous store APIs.
- Other modules use Node APIs for file, buffer, crypto, and document processing.

Workers do not provide a durable writable local filesystem or a persistent
`node:sqlite` database. Node compatibility flags do not turn a Worker filesystem
into a durable disk. The existing SQLite/JSON store therefore cannot be treated as
production persistence on Workers.

## Proposed Cloudflare architecture

| Concern | Target | Notes |
| --- | --- | --- |
| Next.js application and API | Cloudflare Workers using vinext | Compatibility check must pass for required routes and middleware |
| Public hostname | Account's `workers.dev` subdomain | No purchased domain required |
| Tenant application state | D1 | Tenant key must be part of every read/write predicate and unique key |
| Uploaded documents and large objects | R2, only if needed | Store object metadata and tenant ownership in D1 |
| Runtime credentials | Worker secrets | Never commit credentials or expose them to client bundles |
| Scheduled reminders | Cron Triggers | Must preserve tenant scope, idempotency, and provider auth |
| Identity gateway | Separate Worker or carefully integrated middleware | Preserve Access JWT validation and the private shared-secret boundary |

Do not create a database or deploy a Worker until the compatibility and schema
design have been reviewed. D1 operations are asynchronous; the store API currently
assumes synchronous reads and writes. Convert persistence call paths to explicit
async operations rather than hiding asynchronous D1 calls behind synchronous
functions or introducing an unsafe in-memory-only fallback.

## Required migration work

1. Run `npx vinext check` against the repository and record every unsupported API,
   route, middleware, and build feature. Initialize vinext non-destructively only
   after reviewing the report.
2. Inventory all persistence call sites. Design a D1 schema for tenants, state,
   credentials, documents, reminders, and migration metadata. Use explicit tenant
   ownership constraints and indexes. Do not store all users in one unscoped blob.
3. Replace the synchronous store contract with an asynchronous repository layer.
   Update every caller and test that depends on synchronous `getStore()` or
   `saveStore()`. Preserve the existing tenant identity derivation and reject
   caller-controlled tenant IDs.
4. Preserve AES-256-GCM credential encryption. Use Web Crypto APIs supported by
   Workers or a reviewed compatible implementation; define key versioning and
   rotation before moving production credentials. Never silently downgrade to
   plaintext if a secret is missing.
5. Port filesystem-dependent document ingestion to bounded request bodies and R2
   object storage where persistence is required. Keep SSRF protections on URL
   ingestion and validate MIME type and actual file signatures.
6. Port cron/reminder dispatch with tenant isolation, retry safety, and idempotency.
   Do not expose an unauthenticated maintenance or scheduler endpoint.
7. Port the identity gateway to the chosen public hostname. Validate Cloudflare
   Access JWT issuer, audience, signature, and expiry; strip caller-supplied
   identity headers; inject the private gateway secret only after successful
   authentication. Ensure no direct origin bypass exists.
8. Add migration tests, tenant-isolation tests, concurrency tests, encryption
   round-trip/rotation tests, route-level tests, and Worker-runtime integration
   tests using the Cloudflare local runtime.
9. Verify backups and export/restore procedures for D1 and R2 before production use.

## Release gates

A free-tier deployment is not production-ready until all of these are true:

- vinext compatibility is demonstrated for the full required application surface.
- No required route depends on unsupported Node APIs or ephemeral local storage.
- All tenant data access is scoped and covered by adversarial isolation tests.
- Secrets are encrypted at rest with a documented rotation and recovery process.
- Authentication, webhook signatures, cron authorization, rate limits, and request
  size limits are verified in the deployed Worker environment.
- D1/R2 backup and restore are tested.
- CI builds the Worker artifact and runs tests against the Worker runtime.
- A staging deployment passes smoke tests before public traffic is enabled.
- Actual Cloudflare plan quotas and usage alerts are checked; the deployment must
  fail safely when a quota or provider dependency is unavailable.

## Safety constraints

- Do not merge this migration into `main` until its CI and review gates pass.
- Do not deploy to production as part of a compatibility experiment.
- Do not delete, rewrite, or migrate existing user data without a verified backup
  and tested rollback.
- Do not claim production readiness merely because `workers.dev` serves a page.
- Keep the current OCI deployment instructions intact as a recovery reference
  until the Cloudflare deployment is proven and explicitly promoted.
