# R2 tenant object storage

This adapter is an additive storage primitive for attachments and document binaries. It does not change the current SQLite/JSON store or move existing production data.

## Binding

Bind a private R2 bucket to the VELNOR Worker as `VELNOR_OBJECTS`. Do not enable public bucket access or publish an R2.dev domain. The Worker must be the only application principal with access; enforce tenant authorization before calling the adapter.

## Object contract

`src/lib/storage/r2TenantObjects.ts` derives object keys as `tenants/<sanitized-tenant-id>/objects/<object-id>`. Callers cannot supply paths or prefixes. Each object records tenant ID, object ID, schema version, content type, and SHA-256 in R2 metadata. Reads require the persisted D1 object reference and verify ownership metadata, the reference's expected SHA-256, byte count, and content type before returning bytes. This makes the D1 reference an independent integrity anchor rather than trusting metadata stored beside the object. Deletes verify tenant ownership before removing an object.

Upload limits are explicit per call; the adapter has no implicit global limit. The returned `TenantObjectRef` contains an object ID, content type, byte count, and checksum, but no public URL. Store references in the tenant's D1 state only after a successful R2 write.

## Migration requirements

- Replace embedded attachment `dataUrl` payloads with tenant-scoped object references.
- Move document/chunk binary payloads only after a verified export and per-tenant checksum comparison.
- Preserve authorization checks on every read, download, and delete; possession of an object ID is not authorization.
- Use a staged dual-read/dual-write migration with rollback until all references are verified.
- Keep D1 snapshots below the safe row-size ceiling; do not store binary data or base64 blobs in D1.

No R2 bucket is provisioned or bound by this change. No existing objects or production data are moved.
