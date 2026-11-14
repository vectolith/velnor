-- VELNOR D1 tenant state schema.
-- Payloads must be validated and secretBox-sealed before reaching this table.
CREATE TABLE IF NOT EXISTS tenant_state (
  tenant_id TEXT PRIMARY KEY NOT NULL,
  payload_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tenant_state_updated_at_idx ON tenant_state(updated_at);
