-- Durable, tenant-scoped outbox for external side effects.
-- Dispatchers claim rows with expiring leases; consumers must still use provider
-- idempotency keys where the provider supports them.
CREATE TABLE IF NOT EXISTS tenant_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'delivered', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS tenant_outbox_dispatch_idx
  ON tenant_outbox(tenant_id, status, available_at, created_at);
CREATE INDEX IF NOT EXISTS tenant_outbox_lease_idx
  ON tenant_outbox(tenant_id, status, lease_until);
