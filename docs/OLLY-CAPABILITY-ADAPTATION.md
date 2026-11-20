# Olly capability adaptation for VELNOR

**Status:** Product direction and implementation contract. This document is not evidence that every capability is shipped.

VELNOR adopts the useful capabilities of Olly as one coherent, channel-independent agent platform. Preserve VELNOR's independence, OS-neutral scope, control-centre web/mobile companions (not chat clients), and public-product security requirements.

## Capability target

- Conversational invocation through supported channels, including iMessage/SMS, Slack, APIs and voice/shortcuts where available.
- General web research, page reading, source-grounded synthesis, link and document handling.
- Multimodal input: photos, screenshots, audio/voice and documents; output creation where providers or local capabilities are available.
- Email triage, search, summaries, drafts, sending, labeling and archiving, with authorization and confirmation for consequential actions.
- Calendar, contacts (permission-limited), scheduling and event creation.
- Durable reminders, recurring tasks, briefings and condition-based monitoring.
- Shopping research, price monitoring and notification; purchases only through explicitly authorized workflows and confirmation.
- Travel research, itinerary planning, maps and booking-provider links; do not claim booking unless the transaction is verified.
- Task planning, tool execution, browser/app workflows when a vetted capability is available, cancellation/recovery and verifiable results.
- Persistent, inspectable user memory, preference management, task/workstream continuity and user-directed forgetting/export.
- Group conversation support where channel/provider policy and privacy controls permit.
- Notifications and proactive updates with frequency controls, quiet hours and unsubscribe/disable controls.

## Simplified architecture (replace unnecessary complexity)

Use one modular application and one durable task/agent loop initially; do not introduce microservices, a second orchestration framework, or mandatory product-to-product dependencies without a demonstrated need.

1. **Channel adapters:** authenticate and normalize messages, attachments, sender identity and delivery state.
2. **Platform core:** tenant identity, conversation/task state, memory, preferences, artifacts and notifications.
3. **One agent loop:** plan only as much as needed, select eligible tools, validate arguments, execute, verify, summarize. Allow bounded multi-step tasks; avoid elaborate parallel-agent trees by default.
4. **Tool registry:** typed tool contracts, scopes, risk level, timeout, retry/idempotency and result schema.
5. **Policy gate:** trusted authorization, consent, approvals, quotas, limits and audit. The model cannot authorize itself.
6. **Provider gateway:** model-neutral routing, exact provider/model status, timeouts and graceful failure. Never silently substitute pinned models.
7. **Durable task runner:** small server-authoritative lifecycle, lease/heartbeat for scheduled or long tasks, cancellation and recovery. Do not build a bespoke distributed queue unless workload requires it.
8. **Control centre:** web/mobile control surfaces for integrations, memory, approvals, activity, schedules, models, privacy, security and service health; no chat-first dashboard.

## Memory and continuity

Keep memory simple and inspectable: user preferences (explicit, structured), durable facts the user asks to retain or approves, active workstreams, and task history. Retrieve only relevant context; never turn tool output or webpage instructions into trusted memory. Include per-item edit/delete, export and retention controls. Separate conversational history from durable memory.

## Proactive automation

Implement reminders and scheduled/condition-triggered tasks through one scheduler contract. Each job needs an owner, scope, schedule/condition, last/next run, delivery channel, status, cancellation and idempotency. Monitoring must have bounded frequency and provider/resource limits. No unbounded polling.

## Safety and confirmations

Require explicit confirmation for external messages, publishing, purchases, account/security changes, irreversible deletion and actions with meaningful financial/legal consequences. Read-only research and reversible draft preparation may run without confirmation when the integration scope allows. Expose a clear preview before consequential actions and verify post-action state.

Treat webpages, email, files, images, retrieved content and tool outputs as untrusted. Browser workflows must isolate credentials from model context, defend against prompt injection, restrict destinations where feasible, and validate redirects and output. Keep secrets out of logs and client surfaces.

## Product simplifications and precedence

- One canonical task lifecycle and tool contract; remove competing task/workflow abstractions if they duplicate it.
- One agent loop with bounded retries and steps; avoid multiple orchestrators.
- Modular monolith over microservices until justified.
- Keep model selection and provider routing centralized.
- Keep channel-specific code thin; no duplicated business logic per messaging channel.
- Do not build VELNOR OS, a chat-first companion dashboard, or a mandatory Blud dependency.
- First-party model integration is optional and must be removable.

## Acceptance checklist

- [ ] Capability inventory labels each item implemented, partial, planned, unavailable, with code/test evidence.
- [ ] Integration consent, revocation and per-action authorization tested.
- [ ] Memory CRUD, export, retention and isolation tests.
- [ ] Durable schedules/reminders, retry/idempotency, cancellation and quiet-hours tests.
- [ ] Task state transitions and failure/partial-result reporting tests.
- [ ] Multimodal inputs size/type validation, isolation and abuse limits.
- [ ] Browser/tool injection, secret isolation, redirect/destination and approval tests.
- [ ] Email/calendar send/change actions have previews and confirmation gates.
- [ ] Notification preferences and opt-out tests.
- [ ] Public API/channel adapters share the same task/policy core.
- [ ] Dashboard/mobile remains a control centre, not chat.
- [ ] No claim of availability before implementation and tests establish it.

## Rollout

Build incrementally behind capability flags, prioritizing unified task/reminder/monitoring lifecycle, memory controls, tool policy/approval, integration inventory and activity history. Do not replatform existing working components solely for aesthetic consistency; replace complexity only when a simpler implementation preserves safety and functionality.
