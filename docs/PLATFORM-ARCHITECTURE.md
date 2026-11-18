# VELNOR platform architecture

**Status:** Target architecture and implementation contract. This document distinguishes existing repository capabilities from planned platform capabilities; a design statement is not evidence that a feature is deployed.

## Product decision

Build VELNOR as an independent, general-purpose AI platform. Operating-system development is outside VELNOR's current product scope; the platform remains client- and operating-system-neutral.

VELNOR is not a model wrapper and must not be coupled to one model family, inference provider, cloud vendor, or client application. Models by vectolith is the preferred first-party model family, but the platform must be able to register and route to other explicitly approved model backends.

## Architectural invariants

1. **Platform first:** business logic, identity, orchestration, memory, tools, and policy live behind stable platform contracts. The web dashboard and mobile app are companion control-centre clients; messaging and other approved channels are interaction/invocation surfaces.
2. **Model neutrality:** the orchestration layer uses a provider/model adapter contract. No client calls a model provider directly, and no model is allowed to grant itself capabilities.
3. **Platform independence:** core services must not be coupled to a particular client, hosting provider, or model provider. Operating-system architecture, compatibility layers, kernel integration, and OS planning are outside VELNOR's scope.
4. **Security outside the model:** authentication, tenant isolation, authorization, approvals, quotas, and audit decisions are enforced by trusted services. Model-generated text or tool arguments are untrusted input.
5. **Portable identity and data:** stable user, tenant, conversation, task, artifact, and capability identifiers are independent of a device or channel. Users must be able to export their data through documented formats.
6. **Versioned contracts:** public APIs and internal service contracts are versioned. Breaking changes require an explicit migration path.
7. **Honest capability discovery:** a registered model or tool is not necessarily available, healthy, enabled, or authorized for a particular user. Discovery must report these states separately.
8. **Graceful degradation:** unavailable model backends, integrations, or client features must fail clearly without silently substituting a different model, provider, account, or action.

## Logical architecture

```text
 Web dashboard   Mobile companion   Messaging / invocation channels
      \            |              |                 |                    /
       +------------+--------------+-----------------+-------------------+
                                    |
                         Client / API boundary
                                    |
                 Identity, sessions, tenant resolution
                                    |
                  Platform API and conversation service
                                    |
              Task orchestration / Core Prime / delegation
                         /                 \
              Model gateway             Tool runtime
             /     |      \            /     |      \
          VELNOR  approved  local     search  files  integrations
           models providers runtimes  and data  and actions
                         |
             Memory, artifacts, events, audit
                         |
              Durable storage and observability
```

This is a logical view, not a claim that every box is currently a separate deployable service. Keep the initial deployment modular and operationally simple; split services only when isolation, scaling, reliability, or ownership justifies it.

## Platform layers and responsibilities

### 1. Client adapters

Clients render the experience and translate platform contracts into their native interaction patterns. They may include:
- Mobile applications: native notifications, camera, and file handoff.
- Desktop application: chat plus approved local-file and application workflows.
- Messaging adapters: iMessage/SMS, Slack, and future channels.
- Messaging and other supported invocation channels: channel-specific interaction and notifications.

Clients must not own model routing, provider credentials, tenant authorization, tool policy, or canonical conversation state. A client may cache presentation data but the platform remains authoritative.

### 2. Identity and access

The identity boundary authenticates a person or service, resolves the tenant, and issues short-lived scoped credentials. Every request is bound to a verified principal and tenant. Device identity is a separate attribute, never a replacement for user identity.

Authorization is evaluated for each resource and action. Support least-privilege scopes, revocation, session expiry, and explicit consent for sensitive integrations. Never accept a tenant ID, role, permission, or account identity merely because a client supplied it.

### 3. Platform API

The platform API provides versioned, channel-independent operations for:
- creating and listing conversations;
- sending a message and receiving a response or task status;
- listing models and capabilities available to the caller;
- managing files and generated artifacts;
- reading/updating permitted memory and user preferences;
- connecting, inspecting, and revoking integrations;
- reviewing approvals, task history, and audit events.

Use asynchronous task resources for long-running work. Return a stable task ID and lifecycle state rather than holding a request open indefinitely. Support cancellation where safe and report partial completion explicitly.

### 4. Orchestration and intelligence

Core Prime is the default general-purpose orchestrator and user-facing intelligence. It interprets intent, clarifies missing requirements, plans, selects capabilities, and synthesizes verified results. Specialist models may be delegated work through a shared task contract; they do not become independent authorities over user permissions.

The orchestrator must:
- preserve user intent and relevant context across delegation;
- select only models that are available and eligible for the task;
- preserve exact model identity where a model is explicitly selected or pinned;
- never silently substitute a requested model or tool;
- treat retrieved content and tool outputs as untrusted data;
- verify consequential actions and distinguish attempted, completed, and failed work;
- return provenance and evidence when appropriate.

### 5. Model gateway and registry

A model gateway normalizes requests and responses across approved inference backends. The registry describes model identity, immutable revision, owner, modality, context limits, supported operations, tool-call format, status, deployment location, license/provenance evidence, and evaluation evidence.

Separate these states: registered, evaluated, approved, deployed, healthy, available, and selected. A model must not appear as usable merely because its metadata exists. Provider adapters and local runtimes are replaceable implementations behind the same contract.

### 6. Tool and integration runtime

Tools are declared with schemas, descriptions, risk classes, required scopes, timeout limits, and execution policies. The runtime validates arguments, checks authorization, obtains required user approval, executes with bounded resources, and records the outcome. The model can request an action; only the runtime can authorize and execute it.

Connected services and approved device integrations must be represented as explicit tools with narrow scopes and visible permission prompts. No general-purpose unrestricted shell or implicit device access is granted to the model.

### 7. Memory, files, and artifacts

Keep conversation history, user-approved memory, project state, uploaded files, and generated artifacts as distinct resource types with separate retention and access rules. Memory must be inspectable, correctable, and deletable under documented policy. Files and artifacts need ownership, provenance, content type, size limits, and access checks.

Use portable formats and stable IDs so data can move between supported clients and deployments. Avoid making a device-local database the only copy of a user's canonical data.

### 8. Events, audit, and observability

Publish typed events for task lifecycle, tool invocation, approval requests, artifact creation, integration changes, and model routing. Keep user-facing activity history separate from security audit records. Record correlation IDs, actor, tenant, action, target, policy decision, result, and timestamps without logging secrets or unnecessary sensitive payloads.

## Canonical resource model

The platform should converge on these resource identities:

| Resource | Purpose |
|---|---|
| Principal | Authenticated user, service, or device identity |
| Tenant | Security and data-isolation boundary |
| Client | Registered app, channel, or device installation |
| Conversation | Durable user-facing interaction thread |
| Message | Typed input, output, or tool result |
| Task | Long-running unit of work with status and cancellation |
| Model | Exact model identity and deployment/evaluation metadata |
| Capability | A discoverable operation a model or tool can perform |
| Integration | User-authorized connection to an external service |
| Approval | Explicit authorization for a sensitive operation |
| Artifact | File or other durable output produced or supplied |
| Event | Lifecycle signal; audit events have stricter retention/access |

A resource ID must not encode personal information. All tenant-owned resources are checked against the authenticated tenant on every access.

## API and protocol direction

- Expose a documented, versioned HTTPS API under `/api/v1` for public platform operations.
- Use JSON request/response schemas and a documented error envelope.
- Use server-sent events or WebSocket transport for streaming; transport choice must not change task or conversation semantics.
- Use idempotency keys for retriable mutations and stable task IDs for asynchronous work.
- Keep provider-specific payloads inside adapters; do not expose them as the public contract.
- Publish an OpenAPI specification and generated SDKs only after routes and schemas are implemented and tested.
- Keep internal service calls behind typed interfaces so the initial modular monolith can later be split without changing clients.

The existing repository has API routes, an agent loop, provider adapters, tenant-scoped persistence, authentication, messaging webhooks, and a Cloudflare identity gateway. These are foundations to evolve, not proof that the complete public `/api/v1` contract or general web-chat product already exists.

## Client and deployment boundaries

- The platform is independent of any particular operating system or client runtime.
- Web and mobile companions are control-centre interfaces for integrations, activity monitoring, approvals, administration, permissions, security, and system controls.
- Messaging and other supported channels provide interaction and task invocation; they are not the companion dashboard.
- No operating-system architecture, shell, kernel, device broker, or OS roadmap is part of VELNOR.

## Delivery sequence

These are workstreams, not approval gates. Work can proceed concurrently when dependencies allow, and every implementation claim must be verified.

1. **Contract foundation:** document resource schemas, API versioning, errors, task lifecycle, model/capability registry, and auth scopes.
2. **Usable platform surface:** deliver a responsive web client against platform APIs; preserve messaging adapters as additional clients.
3. **Developer access:** publish OpenAPI, API keys or OAuth client credentials with scoped access, SDKs, examples, rate limits, and usage visibility.
4. **User workspace:** conversations, projects, files, artifacts, memory controls, integrations, and approvals.
5. **Reliable execution:** streaming, asynchronous tasks, cancellation, event delivery, retries, idempotency, observability, and audit.
6. **Native clients:** mobile and desktop clients consume the same contracts and may add device capabilities through permissioned adapters.
7. **Companion control surfaces:** implement the web dashboard and mobile companion against the same versioned platform contracts.

## Non-goals for the current phase

- Do not add chat interfaces to the web dashboard or mobile companion.
- Do not couple the platform to a selected foundation model before comparative evaluation is complete.
- Do not make a paid inference provider or cloud service a hidden mandatory dependency.
- Do not expose provider credentials or long-lived platform secrets to clients.
- Do not grant a model unrestricted access to a user's files, accounts, or connected services.
- Do not split the modular monolith into microservices merely for architectural appearance.

## Definition of done for the platform foundation

- A client can authenticate and use VELNOR without knowing which model provider serves a request.
- Web, mobile, desktop, and messaging clients can share conversations and tasks under the same tenant policy.
- Model discovery reports exact identity, capabilities, deployment health, and eligibility separately.
- Long-running tasks have stable IDs, observable states, and safe cancellation semantics.
- Every tool action is schema-validated, permission-checked, and auditable.
- Data export and deletion do not depend on a specific client.
- A new client can be added without changing the public task contract or moving business logic into the client.
