# Using VELNOR

**Status:** Product experience specification. Existing messaging and API capabilities are implemented to varying degrees. The companion dashboard and mobile app described here are target experiences and must not be presented as shipped until implemented and tested.

## What VELNOR is

VELNOR is an independent, general-purpose AI platform for everyday users, students, professionals, creators, and developers. Its intelligence and execution services are accessed through supported interaction channels and managed through companion control-centre interfaces.

The web dashboard and mobile app are **not chat interfaces**. They exist to connect and manage services, inspect platform activity, monitor execution, and administer the platform.

## Product surfaces

### Web dashboard

The web dashboard is the primary administrative and operational control centre. It should provide:

- **Overview:** platform health, service status, model availability, active work, and operational alerts.
- **Integrations:** connect, configure, inspect, test, and revoke external services and accounts.
- **Activity:** inspect task lifecycle, model activity, tool invocations, execution history, failures, retries, and outcomes.
- **Approvals:** review pending permission requests and authorize or reject consequential actions.
- **Models:** inspect registered models, exact identities/revisions, capabilities, evaluation status, deployment status, and availability.
- **Administration:** manage users, tenants, roles, permissions, policies, quotas, and platform settings.
- **Security and audit:** inspect sessions, access events, security-relevant audit records, and credential/connection status without exposing secrets.
- **Diagnostics:** inspect health, latency, resource usage, queue status, and integration errors.

The dashboard must not contain a conventional chat composer, chat-first home screen, or conversational workspace.

### Mobile companion

The mobile app provides the same core control-centre capabilities in a native, mobile-appropriate form:

- integration and account connection management;
- activity and execution monitoring;
- approval notifications and permission controls;
- model and service status;
- administration and security controls appropriate to mobile;
- operational alerts and notification preferences.

It is a companion to the platform, not a chat client.

### Interaction and invocation channels

Users interact with VELNOR through explicitly supported communication and invocation channels, such as existing messaging adapters and approved APIs. These channels are separate from the dashboard and mobile companion. A channel may support conversational interaction without making chat the purpose of the companion applications.

### Developer access

A versioned public API and SDK may provide programmatic access when implemented, documented, secured, and tested. Do not describe planned API/SDK releases as shipped.

## Core platform workflow

1. A user invokes VELNOR through a supported channel or authorized API.
2. Identity and tenant context are resolved by trusted platform services.
3. The configured Velnor orchestrator interprets the request, determines the desired outcome, and plans the work.
4. The orchestration layer selects only eligible models, tools, and integrations.
5. The runtime validates permissions and obtains approval where required.
6. Work executes as a durable task with a server-authoritative lifecycle.
7. VELNOR verifies the outcome and records relevant evidence, events, and audit data.
8. The invoking channel receives the result; the dashboard and mobile companion expose operational status and history.

## Task lifecycle

Long-running work should use a consistent lifecycle:

| State | Meaning |
|---|---|
| accepted | Request validated and task created |
| planning | VELNOR is defining steps and dependencies |
| running | Work is actively executing |
| waiting_for_input | A required clarification or user decision is pending |
| waiting_for_approval | A permissioned action requires approval |
| completed | Requested outcome completed and verified to the stated level |
| partially_completed | Some work completed; remaining work is identified |
| failed | Task could not complete; cause and recovery options are reported |
| cancelled | Task stopped; completed side effects are disclosed |

Task state transitions must be server-authoritative. Companion clients display events and status; they do not invent progress or mark a task complete themselves.

## Model and capability controls

The platform should distinguish registered, evaluated, approved, deployed, healthy, available, and selected model states. Exact model identity includes the repository, family, variant, parameter size, architecture, immutable revision, tokenizer, quantization, and serving artifact where applicable.

If a model is explicitly pinned, VELNOR must not silently route to another model or artifact. If the exact model is unavailable, report a clear unavailable/blocked result. Alternatives must be separately identified and explicitly approved.

Model selection never grants access permissions. Only trusted runtime policy can authorize tools and external actions.

## Trust, privacy, and control

- Keep each user's data, integrations, tasks, and artifacts tenant-isolated.
- Explain which integrations are connected and what permissions they grant.
- Ask before external side effects such as sending, publishing, purchasing, deleting, or changing account settings.
- Provide ways to inspect and revoke sessions and integration access.
- Keep secrets out of browser/mobile clients and logs.
- Separate user-visible activity history from security audit records.
- Report attempted, completed, failed, and unverified operations accurately.
- Provide documented data export, retention, and deletion controls.

## Current implementation versus target

The repository currently contains a headless Next.js service, messaging webhooks, Siri endpoints, a shared provider agent loop, tenant-scoped state, authentication middleware, and a Cloudflare Access identity gateway. It does not yet provide the complete companion web dashboard or mobile app. Treat the surfaces and capabilities in this specification as targets until implementation and tests demonstrate otherwise.
