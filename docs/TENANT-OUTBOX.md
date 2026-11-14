# Durable tenant outbox

The outbox is a persistence primitive for external side effects. It is not yet connected to the scheduler, chat agent, webhooks, or provider integrations.

## Guarantees

- Every row belongs to one validated tenant.
- `(tenant_id, idempotency_key)` is unique. Re-enqueueing the same action returns the existing row; reusing the key for a different action or payload fails.
- A single conditional `UPDATE ... RETURNING` claims one due row for one tenant and creates a bounded lease.
- Expired leases can be reclaimed. A stale worker cannot complete or retry a lease now owned by another worker.
- Retry records a caller-selected backoff time and moves exhausted attempts to `dead`.
- Payloads are JSON objects capped at 64 KiB. Never put credentials, access tokens, or secret material in outbox payloads; include a tenant-scoped secret reference and resolve it at dispatch time. Errors are truncated before persistence.

## Dispatch contract

A dispatcher must claim an item, validate the action type and payload against an allowlist, and pass the stable idempotency key to the provider when supported. It must complete only after a provider success response. Transient failures should call retry with an explicit backoff. Permanent failures should be dead-lettered by exhausting attempts or a future explicit rejection operation.

A lease does not create exactly-once delivery. A worker can send successfully and crash before marking the row delivered. Therefore every provider adapter must use provider-side idempotency where available, or document a reconciliation/deduplication strategy. Do not mark an item delivered before the external provider confirms success.

## Current limitations

- This adapter is not wired to existing reminder dispatch or chat tool side effects.
- No D1 binding or migration has been provisioned or applied.
- No Cloudflare Queue/Cron trigger is configured.
- Retention, dead-letter inspection, operator replay, and delivery metrics still need implementation.
- The existing SQLite runtime and its behavior are unchanged.
