# Outbound delivery guarantees and retry policy

## Attempt lifecycle


The SQLite attempt ledger serializes creation with an immediate write transaction. A second send for the same tenant/task/provider is blocked while the previous attempt is pending, queued, processing or delivered. This prevents overlapping scheduler workers from creating duplicate sends for the same task.

## Ambiguous outcomes


- Automatic retries are blocked for ambiguous outcomes.
- An explicit retry path must reconcile provider status first and pass the explicit retry authorization flag.
- Any retry after an ambiguous result remains marked with duplicate risk.

## Delivery semantics and limitations

These controls provide durable attempt attribution and prevent concurrent duplicate sends within the shared SQLite ledger. They do not create true exactly-once delivery across external providers: a process can fail after a provider accepts a send but before Velnor persists the provider response or terminal state. The provider may deliver that message while Velnor retains an ambiguous attempt. Recovery must not silently resend it.

Provider-specific idempotency keys and reconciliation are required before any stronger exactly-once claim. If the provider does not support idempotent submission or authoritative status lookup, ambiguous attempts require an explicit user decision and must retain duplicate-risk disclosure.

## Product boundary

