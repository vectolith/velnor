# VELNOR IDE — Product Thesis and Differentiating Architecture

## Product thesis
VELNOR is not a chat sidebar attached to an editor. It is a project-oriented engineering environment that turns intent into changes, then into verified evidence. The IDE should compete on execution integrity, project understanding, recoverability, and portability—not on replicating familiar editor chrome.

## Differentiating product capabilities

### 1. Intent-to-implementation
- Convert a goal into a structured plan: milestones, files likely affected, prerequisites, acceptance criteria, and validation steps.
- Inspect the workspace before proposing edits.
- Keep plans editable and require user confirmation for destructive or high-risk actions.
- Track each task as durable states: queued, planning, executing, validating, completed, blocked, cancelled.
- Support cancellation, resumable execution, bounded retries, and a task event log.

### 2. Change impact and preflight
- Build an incremental project inventory and dependency map from available files and supported language tooling.
- Preview planned changes, affected files, risk flags, and tests before writing.
- Detect conflicting edits and stale assumptions.
- Treat unknowns explicitly rather than inventing dependency or runtime facts.

### 3. Proof-driven completion
- Every task has explicit acceptance criteria.
- Validation evidence includes commands/checks run, results, diagnostics and changed-file summary.
- Distinguish verified, partially verified and unverified outcomes.
- Never claim a build/test passed unless it was actually run and its result captured.
- Keep evidence tied to a task execution record.

### 4. Project memory, not chat transcript
- Persist concise, structured project facts: architecture, dependency decisions, constraints, known failure modes, validated conventions and unresolved risks.
- Keep memory inspectable, editable, exportable and scoped to a workspace.
- Store provenance and confidence; invalidate or refresh facts when files change.
- Avoid sending project contents to model providers without user-visible provider configuration and consent.

### 5. Bounded autonomous repair
- When validation fails, classify the failure from concrete output, propose a repair, and attempt only bounded changes.
- Re-run the relevant validation after each repair.
- Maintain a recovery ledger of attempts, diff, failure evidence and final state.
- Stop on uncertainty, repeated failures, unsafe scope or resource limits; surface the blocker honestly.

### 6. Provider/model independence
- Provider adapters for OpenAI-compatible endpoints and local model endpoints.
- Model routing based on task capability, context requirements, latency, availability and explicit user policy.
- Keep project/task state, tool policy and evidence outside the model provider.
- Permit provider fallback only under the configured policy; never silently change providers for sensitive tasks.

### 7. Workspace portability and resilience
- Portable workspace import/export with validation and clear size limits.
- Recovery snapshots and explicit restore points before multi-file agent changes.
- Browser-local operation remains the zero-budget baseline; optional integrations must not make core functionality depend on paid infrastructure.
- Be honest about storage durability: browser storage is not server backup.

## Differentiating workflows
- **Build with evidence:** plan → inspect → preflight → diff preview → apply → validate → evidence report.
- **Repair with containment:** diagnose → isolate → propose → bounded patch → rerun → stop or report.
- **Understand this project:** produce an architecture map, dependency inventory, risk register and questions—not just a chat answer.
- **Change safely:** checkpoint → apply scoped changes → review diff → validate → restore checkpoint if user chooses.

## Design principles
1. Workflows and task evidence are first-class UI—not chat bubbles.
2. Keep the user in control of scope, provider, permissions and destructive operations.
3. Use measurable limits for time, retries, file scope and response size.
4. Prefer deterministic tools for formatting, tests, inspection and validation; use models for synthesis and planning.
5. Treat repository content, model output and terminal output as untrusted.
6. Zero-budget and local-first paths must remain usable without paid services.

## Proposed implementation sequence
1. Task execution state machine, task ledger and cancellation/recovery primitives.
2. Workspace snapshots, change preview and apply/restore workflow.
3. Project inventory and dependency/impact analysis with honest capability coverage.
4. Validation orchestration and evidence reports.
5. Structured project memory with provenance/invalidation.
6. Bounded repair loop.
7. Model routing and capability-based adapters.
8. E2E tests, threat-model updates and deployment readiness evidence.

## Non-goals
- Copying competitor interfaces or treating chat as the core experience.
- Claiming autonomous correctness without evidence.
- Requiring a paid hosted agent, proprietary model or paid cloud service.
- Automatically executing destructive commands, arbitrary remote scripts or broad changes without appropriate permission.
