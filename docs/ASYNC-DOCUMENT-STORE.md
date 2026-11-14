# Async repository-backed document indexing

`src/lib/tools/repositoryDocumentStore.ts` adds a tenant-explicit document indexing and retrieval service over the asynchronous `TenantRepository` contract.

## Contract

- Every instance requires a validated tenant ID and a repository.
- Mutations use the repository's isolated update operation; document metadata and chunks are committed together in one tenant-state revision.
- Reads load only the selected tenant's document collections.
- Text indexing preserves the existing chunking, tokenization, extractive summary, optional embedding, and cosine-similarity/fallback scoring behavior.
- The service accepts already-extracted text only. PDF parsing, URL fetching, SSRF controls, provider key resolution, and the legacy synchronous store remain outside this Worker-compatible boundary.
- Embeddings are injected as an optional dependency. No provider credentials are read from process globals in this service.
- Invalid tenant identifiers, malformed document state, empty input, and oversized input fail explicitly.

## Integration status

This is an additive service boundary and is not yet wired into `processUserMessage`, `executeToolCall`, or the chat route. Those callers still use the legacy `documentStore.ts` and the Node/SQLite AsyncLocalStorage scope. Wiring must happen only after the request boundary can supply a trusted tenant ID and a runtime-specific repository binding. The existing PDF/URL ingestion path remains unchanged until equivalent Worker-safe extraction and SSRF-checked fetching are implemented.

## Verification

The focused tests cover tenant-scoped ingestion and retrieval, cross-tenant isolation, malformed tenant IDs, empty input, and the 2 MB text limit. CI is the authoritative execution environment for this repository change.
