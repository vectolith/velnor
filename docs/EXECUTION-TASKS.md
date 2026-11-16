# Durable execution tasks

Every processUserMessage request creates a durable, tenant-scoped execution record in Node SQLite. The task table stores identity metadata and lifecycle state, not the user's prompt or credentials. The original user message remains in tenant conversation history and is linked by interactionId.

## Lifecycle

queued -> running -> succeeded | failed

A running task can transition to cancel_requested, then cancelled at the next cooperative execution checkpoint. A queued task can be cancelled immediately. Tool execution checks cancellation before invoking a tool. Provider calls already in progress are not forcibly interrupted; cancellation takes effect at the next checkpoint.

If a worker disappears and its 15-minute lease expires, task history marks the task interrupted. This is an interruption record, not an automatic replay: replaying an agent request can repeat external side effects.

## API

All endpoints require the same short-lived tenant bearer token used by /api/chat. In production, requests must also pass through the identity gateway and include its x-velnor-secret perimeter header.

- GET /api/tasks — list the latest 50 tasks for the authenticated tenant.
- POST /api/tasks with action=cancel and taskId — request cancellation.
- POST /api/tasks with action=retry and taskId — explicitly re-run the original request for a failed or interrupted task, if its inbound conversation message is still retained. A retry creates a new task record and preserves the original channel and recipient handle.
- POST /api/tasks with action=retry_delivery and taskId — retry only the stored iMessage result delivery. The API checks the provider's status for queued/processing/unknown attempts before sending again, blocks already-delivered results, and requires the currently configured Sendblue sender number to match the original attempt. Each response reports the durable attempt (attemptId, attemptNumber, state) and a duplicateRisk flag.

## Durable outbound attempt ledger

Every Sendblue send writes a row to imessage_delivery_attempts before the provider request is made, scoped to tenant, task, recipient and sender line. The existing table and helper names are retained for migration compatibility; the ledger ensures a send that never returns a message handle is still recoverable and attributable.

States: pending_send -> queued | failed | unconfirmed, then queued -> processing | delivered | failed | unknown from Sendblue status/callbacks. Only DELIVERED with service=iMessage and no downgrade counts as delivered.

- pending_send: committed before the request. If the worker dies, the row is recovered to unconfirmed after 15 minutes; it is never treated as delivered or as a definite failure.
- unconfirmed: the request left the process but the outcome is unknown (timeout, 5xx, 2xx without message_handle, or an abandoned pending attempt). A retry is allowed and reported with duplicateRisk=true because provider-side idempotency is not established.
- failed: the provider explicitly refused the request. A retry is safe only for a definite rejection. Sendblue SMS fallback is also recorded as failed for the iMessage channel, but the message may have reached the recipient by SMS; the reason is retained and automatic retry is blocked. An explicit retry reports duplicateRisk=true.
- queued / processing: the provider holds the message. retry_delivery blocks until provider status reconciliation resolves it.

A task that finished without any outbound attempt has nothing provably sent, so retry_delivery is permitted as a first, safe attempt instead of being blocked. Only one send may be in flight per task; a second concurrent attempt is rejected.

Delivery records (imessage_deliveries) remain the provider-facing truth for callbacks; the attempt ledger records intent, attempt number, and the identity used, and is backfilled from existing delivery records on migration.

Task IDs are tenant-scoped. Looking up, cancelling, or retrying another tenant's task is not permitted.

## Operational notes

- Durable task state requires Node's built-in SQLite support and the configured persistent VELNOR_DATA_DIR; it fails closed rather than using in-memory task records.
- Task history is limited to 50 records per API response; storage retention and administrative purge remain future work.
- Cancellation is cooperative. It does not roll back an external side effect already accepted by a provider.
- Explicit task retry is opt-in because tools such as email sending or calendar creation may have external side effects.
- Delivery retry never treats HTTP acceptance as delivery. If a provider message ID exists, its status is reconciled before retry; if an attempt is unconfirmed without an ID, an explicit retry is allowed only with duplicateRisk=true because provider-side idempotency is not assumed. A changed sender identity always blocks retry.
- Reminder notifications use the same attempt ledger with task IDs of the form reminder_<reminderId>.
- GET /api/tasks returns deliveryAttempts for each iMessage task so recovery evidence (attempt number, state, message ID, duplicate risk) is inspectable per task.