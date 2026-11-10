/**
 * Persisted-state validation, versioning and migration.
 *
 * The state file is the system of record for a user's conversations, reminders,
 * remembered facts and provider configuration. It has been written by several
 * versions of this service, so loading is now: parse -> migrate -> validate ->
 * fall back to a clean state (and quarantine the bad file) rather than trusting
 * whatever JSON happens to be on disk.
 */

export const STATE_SCHEMA_VERSION = 2;

const ARRAY_FIELDS = [
  "messages",
  "reminders",
  "calendarEvents",
  "emails",
  "documents",
  "memories",
] as const;

export interface ValidationReport {
  ok: boolean;
  issues: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bring older payloads forward. Each step is idempotent. */
export function migrateState(raw: unknown): { value: Record<string, unknown>; applied: number[] } {
  const applied: number[] = [];
  if (!isPlainObject(raw)) return { value: {}, applied };
  const value: Record<string, unknown> = { ...raw };
  const version = typeof value.schemaVersion === "number" ? value.schemaVersion : 1;

  if (version < 2) {
    // v1 stored the active channel under config.channel; v2 keeps it per message.
    if (isPlainObject(value.config) && "channel" in value.config) {
      const config = { ...(value.config as Record<string, unknown>) };
      delete config.channel;
      value.config = config;
    }
    applied.push(2);
  }

  value.schemaVersion = STATE_SCHEMA_VERSION;
  return { value, applied };
}

export function validateState(raw: unknown): ValidationReport {
  const issues: string[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, issues: ["state is not an object"] };
  }
  if (typeof raw.schemaVersion !== "number") issues.push("missing schemaVersion");
  for (const field of ARRAY_FIELDS) {
    if (field in raw && !Array.isArray(raw[field])) issues.push(`${field} is not an array`);
  }
  if ("config" in raw && !isPlainObject(raw.config)) issues.push("config is not an object");
  return { ok: issues.length === 0, issues };
}

/**
 * Coerce a payload into something usable: unknown top-level shapes are dropped,
 * non-array collections become empty arrays so one corrupt field cannot take the
 * whole profile down.
 */
export function coerceState(raw: unknown): { value: Record<string, unknown>; issues: string[] } {
  const issues: string[] = [];
  if (!isPlainObject(raw)) {
    return { value: {}, issues: ["state is not an object"] };
  }
  const value: Record<string, unknown> = { ...raw };
  for (const field of ARRAY_FIELDS) {
    if (field in value && !Array.isArray(value[field])) {
      issues.push(`${field} was not an array; reset to []`);
      value[field] = [];
    }
  }
  if ("config" in value && !isPlainObject(value.config)) {
    issues.push("config was not an object; reset to {}");
    value.config = {};
  }
  return { value, issues };
}
