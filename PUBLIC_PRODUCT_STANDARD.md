# Public Product Readiness Standard

**Applies to:** This repository and every product, service, model, API, client, integration, and release maintained here.  
**Owner:** Vectolith  
**Status:** Engineering baseline; implementation must be verified per project.

## Product principle

Vectolith products are built for use by their intended public audiences. They are not assumed to be private prototypes or internal-only tools. Public consumption does not, by itself, mean that a source repository, service endpoint, dataset, or operational system must be publicly exposed. Repository visibility and deployment exposure must be deliberate security decisions.

Velnor is an independent product. It owns its application runtime, identity, authorization, storage, secrets, integrations, deployment and release lifecycle. It must remain buildable and useful without another Vectolith product. Optional integrations must use documented interfaces, be replaceable, and fail without disabling Velnor's core functions.

This standard is a required engineering baseline, not a claim that the repository already satisfies every requirement. Compliance must be established through implementation, tests, and review.

## Required release gates

A release must not be represented as production-ready until the applicable gates below have objective evidence.

### 1. Real functionality and product integrity
- User-facing flows must execute real application logic and real integrations; no fake success states, placeholder data presented as live, or silently mocked production paths.
- Clearly distinguish implemented, experimental, unavailable, and planned capabilities.
- Validate inputs at trust boundaries and handle empty, invalid, stale, duplicate, and adversarial inputs.
- Provide actionable error states, recovery paths, and safe failure behavior.
- Preserve data integrity across retries, concurrency, restarts, and partial failures where applicable.

### 2. Security and privacy
- Never commit credentials, private keys, tokens, signing secrets, production data, or personal information. Use environment-based secret management and rotate exposed credentials.
- Apply least privilege, secure defaults, authentication and authorization checks, and server-side enforcement for sensitive actions.
- Encrypt sensitive data in transit and at rest where the platform supports it; minimize collection, retention, and access.
- Document data categories, purposes, storage locations, retention, deletion, and third-party processors before launch.
- Protect against injection, cross-site scripting, request forgery, replay, insecure direct object references, dependency compromise, and abuse relevant to the stack.
- Do not expose internal endpoints, debug traces, stack dumps, or operational metadata to ordinary users.
- Publish a vulnerability-reporting route and maintain a security response process.

### 3. Accessibility and usability
- Provide clear navigation, understandable language, visible focus, keyboard operation where relevant, sufficient contrast, and screen-reader semantics.
- Respect reduced-motion and platform accessibility settings.
- Make forms, validation, permissions, destructive actions, and recovery understandable.
- Support responsive layouts and document supported platforms, devices, browsers, and minimum versions.

### 4. Reliability and operations
- Define service and client failure behavior, timeouts, bounded retries, rate limits, and graceful degradation.
- Add health checks and useful structured logs; avoid logging secrets or unnecessary personal data.
- Establish monitoring for availability, errors, latency, resource use, and critical workflows where operationally applicable.
- Document backup, restore, migration, rollback, incident response, and disaster recovery procedures appropriate to the product.
- Keep development, test, staging, and production configuration separate.

### 5. Quality and verification
- Provide repeatable setup and build instructions from a clean checkout.
- Add automated tests for critical business logic, security boundaries, error paths, and important user journeys.
- Run formatting, linting, static analysis, type checks, unit tests, integration tests, and end-to-end tests as applicable.
- Pin and audit dependencies; remove unused packages and address known exploitable vulnerabilities.
- CI must report failures honestly. Do not bypass, suppress, or relabel failing checks to create a green result.
- Verify migrations and upgrades against representative supported versions before release.

### 6. Public documentation and support
- Keep the README accurate: product purpose, actual capabilities, status, requirements, setup, configuration, usage, limitations, and support route.
- Include a license appropriate to the intended distribution, plus third-party notices and attribution where required.
- Publish privacy and terms information when the product collects data, provides an online service, or otherwise requires them.
- Document API contracts, compatibility, deprecation, and versioning for externally consumed interfaces.
- Provide a changelog or release notes for user-visible changes and a clear route for bug reports and security reports.

### 7. Responsible AI and model-specific requirements
For repositories that train, evaluate, distribute, or serve models or AI features:
- Record model identity, revision, architecture, intended use, limitations, provenance, and applicable license.
- Record training/evaluation data provenance, permissions, filtering, transformations, and known gaps; do not imply rights that have not been verified.
- Keep evaluation datasets and results traceable to immutable model and dataset revisions.
- Use reproducible evaluation protocols, held-out tests, documented metrics, and human review for consequential quality or safety claims.
- Assess harmful outputs, prompt injection, data leakage, memorization, misuse, and failure modes relevant to the deployment context.
- Clearly disclose model limitations and avoid unsupported claims about accuracy, safety, or capability.
- Preserve raw evaluation evidence and dissenting results; do not select or suppress evidence solely to make a model appear better.

### 8. External dependency management
- Identify external services, trust boundaries, data flows, quotas, limits, and failure behavior.
- Use supported interfaces and documented contracts; do not rely on undocumented service behavior or quota circumvention.
- Ensure external integrations are optional where possible and do not become hidden prerequisites for core product operation.

## Repository-specific implementation

This baseline must be translated into the repository's actual architecture and risk profile. A checklist alone is not proof of compliance. Maintain project-specific evidence in tests, CI, threat models, privacy documentation, model cards, runbooks, and release checklists as appropriate.

Before each public release, record:
1. Scope and supported users/platforms.
2. Implemented capabilities and known limitations.
3. Security/privacy review and dependency audit.
4. Accessibility and usability verification.
5. Test commands, results, and unresolved failures.
6. Operational readiness, rollback, and support ownership.
7. License, notices, and required user-facing policies.

## Change control

Changes affecting authentication, authorization, cryptography, personal data, payments, wallet signing, model training/evaluation, public APIs, or production infrastructure require focused review and regression tests. Avoid destructive changes and preserve backward compatibility unless a documented migration is provided.

A repository may have additional stricter requirements. Those requirements remain in force; this baseline does not weaken or replace them.
