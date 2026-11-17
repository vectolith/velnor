import { getSqliteDb } from "../sqliteDb";
import { syncAttemptByMessageId } from "./imessageDeliveryAttempts";
import { mapSendblueStatus, type SendblueDeliveryStatus } from "./sendblue";

export type StatusCallbackOutcome = "applied" | "pending" | "duplicate" | "unavailable";

interface StatusRow {
  message_handle: string;
  state: "processing" | "delivered" | "failed" | "unknown";
  error_code: number | null;
  error_detail: string | null;
}

function db() {
  return getSqliteDb();
}

/** Never let a late callback move a delivered message backwards. */
function isRegression(current: SendblueDeliveryStatus, next: SendblueDeliveryStatus): boolean {
  return current === "delivered" && next !== "delivered";
}

/**
 * Apply a Sendblue delivery callback to the matching outbound attempt.
 *
 * Callbacks routinely beat the send response, so an unknown handle is buffered
 * instead of dropped and replayed the moment the attempt stores its handle.
 */
export function syncSendblueStatusCallback(input: {
  messageHandle: string;
  status: unknown;
  errorCode?: number | null;
  errorDetail?: string | null;
}): StatusCallbackOutcome {
  const handle = String(input.messageHandle || "").trim();
  if (!handle) return "unavailable";
  const mapped = mapSendblueStatus(input.status);
  if (mapped === "queued") return "duplicate";
  const state = mapped === "processing" || mapped === "delivered" || mapped === "failed" ? mapped : "unknown";

  const attempt = syncAttemptByMessageId({
    messageId: handle,
    provider: "sendblue",
    status: state,
    errorCode: input.errorCode ?? null,
    errorDetail: input.errorDetail ?? null,
  });
  if (attempt) return attempt.state === state ? "applied" : "duplicate";

  const database = db();
  if (!database) return "unavailable";
  const existing = database.prepare("SELECT state FROM sendblue_status_events WHERE message_handle = ?")
    .get(handle) as { state: "processing" | "delivered" | "failed" | "unknown" } | undefined;
  if (existing && isRegression(existing.state, state)) return "duplicate";
  const inserted = database.prepare(`
    INSERT INTO sendblue_status_events (message_handle, state, error_code, error_detail, received_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(message_handle) DO UPDATE SET
      state = excluded.state,
      error_code = COALESCE(excluded.error_code, sendblue_status_events.error_code),
      error_detail = COALESCE(excluded.error_detail, sendblue_status_events.error_detail),
      received_at = excluded.received_at
  `).run(
    handle, state, input.errorCode ?? null,
    input.errorDetail ? String(input.errorDetail).slice(0, 500) : null,
    new Date().toISOString(),
  ) as { changes?: number };
  return Number(inserted.changes) > 0 ? "pending" : "duplicate";
}

/** Replay buffered callbacks for a handle that has just been persisted. */
export function applyPendingSendblueStatus(messageHandle: string): StatusCallbackOutcome {
  const database = db();
  if (!database || !messageHandle) return "unavailable";
  const row = database.prepare(`
    SELECT message_handle, state, error_code, error_detail
    FROM sendblue_status_events WHERE message_handle = ?
  `).get(messageHandle) as StatusRow | undefined;
  if (!row) return "duplicate";
  const attempt = syncAttemptByMessageId({
    messageId: row.message_handle,
    provider: "sendblue",
    status: row.state,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
  });
  if (!attempt) return "pending";
  database.prepare("DELETE FROM sendblue_status_events WHERE message_handle = ?").run(messageHandle);
  return "applied";
}
