# Olly-inspired VELNOR capability consolidation

**Decision:** adopt the practical capability set advertised by Olly as the VELNOR product direction, while replacing over-engineered architecture with a small, modular core. This is a product specification, not a claim that every capability is shipped.

## User experience
VELNOR should be an agent the user can invoke through messaging, voice, API, and companion surfaces—not a collection of disconnected utilities. It should proactively deliver requested reminders, monitoring alerts, and task results, while keeping dashboard/mobile surfaces focused on activity, connections, permissions, approvals, and system controls.

## Capability set
- **Research:** web search, source retrieval, comparison, synthesis, and citations.
- **Personal productivity:** email search/triage/summarization, draft/reply, calendar planning, task lists, and reminders; sending, booking, or destructive changes require explicit approval.
- **Documents and media:** upload and inspect PDFs/files/URLs, summarize and search personal documents; understand photos/screenshots; voice-note transcription and responses; image generation when supported.
- **Browser and computer agent:** operate isolated browser sessions for multi-step sites and tasks; keep secrets and session data isolated and require approval for consequential actions.
- **Monitoring:** user-defined watches for price changes, availability, replies, deadlines, status changes, and other observable conditions; send bounded notifications and provide controls to pause/delete watches.
- **Planning and travel:** itinerary planning, local research, translation, and booking-provider links; actual bookings remain approval-gated.
- **Shopping:** compare products, track price/availability, and prepare purchase flows; purchases are approval-gated.
- **Group and shared workflows:** assist in supported group conversations and collaborative planning without exposing private personal context to other members.
- **Memory:** scoped, inspectable, editable, exportable, and deletable user memory; use only relevant context and respect opt-outs.
- **Proactive assistant:** scheduled briefings, reminders, recurring reports, and task-completion notifications. No unsolicited activity outside user-defined or explicitly enabled policies.

## Simplified architecture (replace layered complexity where it does not add measurable value)
1. **Channel/client adapters:** messaging, web/mobile control centre, voice, and API; adapters normalize requests and deliver responses.
2. **One agent runtime:** a single durable task loop with planning, tool selection, execution, verification, and response. Avoid separate agent frameworks or orchestration services for every capability.
3. **Small tool registry:** research, files, browser, messaging, email/calendar, reminders/monitoring, and media tools. Tools are capability-scoped and typed.
4. **Task/automation service:** one durable lifecycle for foreground tasks, scheduled jobs, and monitoring triggers; cancellation, retry policy, idempotency and task history.
5. **Memory and artifacts:** tenant-scoped persistence; separate personal memory, task state, documents, and generated artifacts. Avoid redundant stores unless measured needs justify them.
6. **Policy boundary:** permissions, approvals, tenancy, credential storage, audit, quotas, and secret handling enforced outside the model.

Keep this modular monolith unless a component demonstrably needs separate deployment. Do not add microservices, multiple planner layers, elaborate event-bus abstractions, or parallel state systems without an operational reason.

## Default permission policy
- Read-only research and analysis: execute under granted permissions.
- Drafts and proposed changes: prepare, then show the user.
- Sending messages, publishing, purchases, bookings, deleting data, account changes, and external sharing: obtain explicit approval before execution.
- Browser sessions, integrations, memory, artifacts and jobs: tenant isolation, minimum scopes, revocation, and auditability.
- Monitor/schedule: require user-defined target, condition, frequency, notification channel and stop controls; enforce reasonable polling/rate limits.
- Do not expose personal memory or private content in group conversations without the owner's explicit instruction.

## Delivery priorities
**P0 — foundation:** unified task lifecycle, channel normalization, scoped memory, approval policy, task history, cancel/retry, security controls.

**P1 — everyday agent:** grounded research, files/URLs, reminders/scheduling, calendar/email integration adapters, image/voice handling.

**P2 — action agent:** isolated browser/computer execution, monitoring/watch jobs, travel/shopping workflows, group-context safety.

**P3 — polish:** proactive briefings, companion control-centre views, capability health, export/delete UX, and end-to-end evaluations.

## Acceptance criteria
Every capability has a documented status, owner, permission contract, success verification, bounded retries, cancellation where applicable, tests, and a clear failure report. No feature is advertised as implemented until verified. Preserve VELNOR's standalone boundary and OS-neutral scope.