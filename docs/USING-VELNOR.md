# Using VELNOR

**Status:** Product experience specification. Existing messaging and API capabilities are implemented to varying degrees; the general web workspace described below is a target experience and must not be presented as shipped until implemented and tested.

## What VELNOR is

VELNOR is a general-purpose AI platform for everyday users, students, professionals, creators, and developers. A person should be able to use it without knowing which model is running or how the backend is built.

The platform should support two complementary usage paths:

1. **Everyday use:** open a VELNOR client, start a conversation, ask for help, attach context, and receive a useful answer or completed task.
2. **Developer use:** authenticate an application, discover capabilities, submit conversations or tasks through the API, and receive structured results.

Messaging channels remain useful access points, but they are clients of the platform—not the platform itself.

## Primary user journey

1. **Create an account and sign in.** Authentication is handled by a trusted identity provider. VELNOR creates or resolves a tenant only from verified identity.
2. **Start a conversation.** Users can ask a question, describe a goal, or request a deliverable in natural language.
3. **Add context.** Users can attach files, share links, connect approved integrations, or refer to an existing project.
4. **VELNOR plans the work.** Core Prime identifies the desired outcome, asks only necessary clarifying questions, and determines whether tools or specialist capabilities are needed.
5. **Approve sensitive actions.** VELNOR explains the action, target, and consequence before requesting permission. Read-only actions may follow previously granted scopes; external writes, purchases, messages, deletion, and device-level operations require explicit policy authorization.
6. **Track execution.** Short answers return directly. Longer work appears as a task with progress, pending approvals, partial results, and cancellation where safe.
7. **Review the result.** Users receive the answer or artifact, relevant sources/evidence, and an honest account of anything that failed or remains incomplete.
8. **Continue or export.** Conversations and project context remain available across authorized clients. Users can manage memory, connected accounts, sessions, and data export.

## Main workspace

The general-purpose web client should have five clear areas:

- **Chat:** the default place to ask questions and work with VELNOR.
- **Projects:** persistent workspaces that group conversations, files, instructions, and deliverables around a goal.
- **Files and artifacts:** uploaded source material and generated outputs, with preview, download, provenance, and access controls.
- **Integrations:** connected services, granted scopes, connection status, and revocation.
- **Settings and privacy:** account/session management, memory controls, data export/deletion, device sessions, and usage information.

Do not force every user to configure models, providers, or agents before getting value. Advanced model and developer controls can be available without cluttering the default experience.

## How users should interact with VELNOR

Users can express outcomes, not internal implementation steps. Examples:

- "Explain this topic and quiz me on it."
- "Compare these options and recommend one."
- "Research this subject and cite reliable sources."
- "Help me plan this project."
- "Review this document and identify what needs attention."
- "Build and test this feature in my repository."
- "Summarize my connected calendar and help me prepare for tomorrow."

VELNOR should identify when a request is informational, creative, analytical, or action-oriented. It should ask a clarifying question only when a missing detail materially changes the result or an action cannot safely proceed.

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

Task state transitions must be server-authoritative. Clients display events and poll/reconnect as needed; they do not invent progress or mark a task complete themselves.

## Model and capability controls

The default experience should choose an eligible model automatically. Advanced users and developers may inspect model capabilities and optionally pin a specific model when the platform supports it.

If a user explicitly selects or pins a model, VELNOR must not silently route to a different model. If that exact model is unavailable, return a clear unavailable/blocked result and offer alternatives as separate, user-approved choices.

Model selection must not be confused with access permissions. A model that supports a capability cannot use it unless the authenticated user, tenant, integration, and runtime policy authorize it.

## Trust, privacy, and control

- Keep each user's conversations, files, memories, integrations, and artifacts tenant-isolated.
- Explain which integrations are connected and what permissions they grant.
- Ask before external side effects such as sending, publishing, purchasing, deleting, or changing account/device settings.
- Provide a way to inspect and revoke sessions and integration access.
- Do not train on private user content by default; any future contribution programme must be separately disclosed, opt-in, and revocable where legally and technically applicable.
- Keep secrets out of browser/mobile clients and logs.
- Show when VELNOR is uncertain, when sources are stale, and when an operation has not been verified.

## Access surfaces

| Surface | Role |
|---|---|
| Web workspace | Primary general-purpose user experience |
| Mobile app | Native interaction, voice, camera, notifications, and file handoff |
| Desktop app | Persistent workspace and user-approved local workflows |
| iMessage/SMS/Slack | Lightweight conversational entry points and notifications |
| Public API/SDK | Programmatic access for developers and products |
| Future VELNOR OS | First-party system shell and permissioned local capability host |

All surfaces must use the same identity, conversation, task, capability, and authorization contracts. A channel-specific feature may be exposed only where the channel supports it, without changing canonical task semantics.

## Current implementation versus target

The repository currently contains a headless Next.js service, messaging webhooks, Siri endpoints, a shared provider agent loop, tenant-scoped state, authentication middleware, and a Cloudflare Access identity gateway. It does not yet provide the complete general-purpose web workspace, a public developer portal, a published stable OpenAPI/SDK release, or a VELNOR OS.

Keep this distinction visible in documentation, product copy, and release notes. Do not imply that a planned surface is available merely because its architecture is described.
