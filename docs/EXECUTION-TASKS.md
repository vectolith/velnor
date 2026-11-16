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
- POST /api/tasks with action=retry_delivery and taskId — retry only the stored iMessage result delivery. Every provider request has a durable outbound-attempt record created before the request. Definite provider rejections are eligible for explicit retry; in-flight, timed-out, transport-failed, and otherwise ambiguous attempts are blocked to avoid duplicate sends. For known provider message IDs, the API checks authoritative provider status before retrying, blocks already-delivered results, and requires the configured sender and recipient to match the original identity.

Task IDs are tenant-scoped. Looking up, cancelling, or retrying another tenant's task is not permitted.

## Operational notes

- Durable task state requires Node's built-in SQLite support and the configured persistent VELNOR_DATA_DIR; it fails closed rather than using in-memory task records.
- Task history is limited to 50 records per API response; storage retention and administrative purge remain future work.
- Cancellation is cooperative. It does not roll back an external side effect already accepted by a provider.
- Explicit task retry is opt-in because tools such as email sending or calendar creation may have external side effects.
- Delivery retry never treats HTTP acceptance as delivery. Each send attempt is written before network I/O. A worker crash leaves a stale `sending` attempt that is converted to `unknown`, not silently retried. Only a definite provider rejection or a confirmed provider `failed` status can authorize an explicit retry. A timeout, connection reset, HTTP 5xx, or accepted response without a message ID remains ambiguous and is blocked because provider-side idempotency is not assumed. Delivery states are monotonic: stale processing/unknown status cannot overwrite terminal delivered/failed outcomes.