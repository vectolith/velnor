import { randomUUID } from "node:crypto";
import { getSqliteDb } from "../sqliteDb";
import type { OutboundSendCertainty } from "./types";

/**
 * Durable outbound attempt ledger for iMessage providers (LoopMessage, Sendblue).
 *
 * A row is written before the provider request, so an attempt that fails
 * without a provider message ID still has a recoverable record. States:
 * - pending_send: written before the request; outcome not yet known.
 * - queued: provider returned a message ID (delivery still unconfirmed).
 * - processing / delivered / failed / unknown: provider-reported delivery state.
 * - unconfirmed: the request left the process and the outcome could not be
 *   established (timeout, 5xx, 2xx without a message ID, crashed worker).
 *   A retry is allowed but may duplicate a message that actually landed.
 */
export type IMessageProvider = "loopmessage" | "sendblue";

export type LoopMessageAttemptState =
  | "pending_send" | "queued" | "processing" | "delivered" | "failed" | "unknown" | "unconfirmed";

export interface LoopMessageDeliveryAttempt {
  attemptId: string;
  provider: IMessageProvider;
  tenantId: string;
  taskId: string;
  recipient: string;
  senderId: string;
  attemptNo: number;
  state: LoopMessageAttemptState;
  messageId: string | null;
  errorCode: number | null;
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AttemptRow {
  attempt_id: string; provider: IMessageProvider; tenant_id: string; task_id: string;
  recipient: string; sender_id: string; attempt_no: number; state: LoopMessageAttemptState;
  message_id: string | null; error_code: number | null; error_detail: string | null;
  created_at: string; updated_at: string;
}

export class LoopMessageAttemptInFlightError extends Error {
  constructor(message = "An iMessage send is already in flight for this task.") {
    super(message);
    this.name = "LoopMessageAttemptInFlightError";
  }
}

export class LoopMessageAttemptBlockedError extends LoopMessageAttemptInFlightError {
  constructor(readonly state: LoopMessageAttemptState, message?: string) {
    super(
      message ?? (state === "delivered"
        ? "This task already has a delivered outbound message."
        : state === "unconfirmed" || state === "unknown"
          ? "A previous outbound attempt has an ambiguous outcome; an explicit, reconciled retry is required."
          : "A previous outbound attempt is still pending or in progress."),
    );
    this.name = "LoopMessageAttemptBlockedError";
  }
}

function db() {
  const database = getSqliteDb();
  if (!database) throw new Error("Durable iMessage attempts require Node SQLite; refusing ephemeral delivery state.");
  return database;
}

function requireIdentity(input: {
  provider: IMessageProvider; tenantId: string; taskId: string; recipient: string; senderId: string;
}): void {
  if (!input.tenantId || !input.taskId) throw new Error("An iMessage attempt requires a tenant and task identity.");
  if (!input.recipient || !input.senderId) throw new Error("An iMessage attempt requires a recipient and sender identity.");
}

function fromRow(row: AttemptRow): LoopMessageDeliveryAttempt {
  return {
    attemptId: row.attempt_id, provider: row.provider, tenantId: row.tenant_id, taskId: row.task_id,
    recipient: row.recipient, senderId: row.sender_id, attemptNo: row.attempt_no,
    state: row.state, messageId: row.message_id, errorCode: row.error_code,
    errorDetail: row.error_detail, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** Persist intent to send BEFORE the provider request so it can never be lost. */
export function beginLoopMessageAttempt(input: {
  provider?: IMessageProvider;
  tenantId: string; taskId: string; recipient: string; senderId: string;
  allowAmbiguousRetry?: boolean;
}): LoopMessageDeliveryAttempt {
  const provider = input.provider ?? "loopmessage";
  requireIdentity({ ...input, provider });
  const database = db();
  const now = new Date().toISOString();
  const attemptId = "attempt_" + randomUUID();
  database.exec("BEGIN IMMEDIATE");
  try {
    // The write transaction makes this state check atomic across workers.
    // Never create a second attempt while the previous one may still be in flight
    // or is already delivered. Ambiguous outcomes require an explicit caller opt-in.
    const previous = database.prepare(
      "SELECT state, error_detail FROM imessage_delivery_attempts WHERE tenant_id = ? AND task_id = ? AND provider = ? ORDER BY attempt_no DESC LIMIT 1",
    ).get(input.tenantId, input.taskId, provider) as { state: LoopMessageAttemptState; error_detail?: string | null } | undefined;
    if (previous) {
      const state = previous.state;
      const smsDowngrade = provider === "sendblue" &&
        /downgraded(?: this message)? to SMS/i.test(previous.error_detail || "");
      if (smsDowngrade && !input.allowAmbiguousRetry) {
        throw new LoopMessageAttemptBlockedError(
          state,
          "A previous Sendblue attempt may have reached the recipient as SMS; an explicit, reconciled retry is required.",
        );
      }
      if (state === "pending_send" || state === "queued" || state === "processing" || state === "delivered") {
        throw new LoopMessageAttemptBlockedError(state);
      }
      if ((state === "unconfirmed" || state === "unknown") && !input.allowAmbiguousRetry) {
        throw new LoopMessageAttemptBlockedError(state);
      }
    }
    const next = database.prepare(
      "SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next FROM imessage_delivery_attempts WHERE tenant_id = ? AND task_id = ?",
    ).get(input.tenantId, input.taskId) as { next: number } | undefined;
    const attemptNo = Number(next?.next ?? 1);
    try {
      database.prepare(`
        INSERT INTO imessage_delivery_attempts
          (attempt_id, provider, tenant_id, task_id, recipient, sender_id, attempt_no, state, message_id, error_code, error_detail, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_send', NULL, NULL, NULL, ?, ?)
      `).run(attemptId, provider, input.tenantId, input.taskId, input.recipient, input.senderId, attemptNo, now, now);
    } catch (error) {
      if (error instanceof Error && /UNIQUE/i.test(error.message)) throw new LoopMessageAttemptInFlightError();
      throw error;
    }
    const row = database.prepare("SELECT * FROM imessage_delivery_attempts WHERE attempt_id = ?")
      .get(attemptId) as AttemptRow | undefined;
    if (!row) throw new Error("iMessage attempt was not persisted.");
    database.exec("COMMIT");
    return fromRow(row);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

/** Close a pending attempt with its known outcome. Only pending_send rows are mutable. */
export function finishLoopMessageAttempt(attemptId: string, outcome: {
  state: "queued" | "failed" | "unconfirmed" | "unknown";
  messageId?: string | null;
  errorCode?: number | null;
  errorDetail?: string | null;
}): LoopMessageDeliveryAttempt {
  const database = db();
  const result = database.prepare(`
    UPDATE imessage_delivery_attempts
    SET state = ?, message_id = COALESCE(?, message_id), error_code = ?, error_detail = ?, updated_at = ?
    WHERE attempt_id = ? AND state = 'pending_send'
  `).run(
    outcome.state, outcome.messageId ?? null, outcome.errorCode ?? null,
    outcome.errorDetail ? String(outcome.errorDetail).slice(0, 500) : null,
    new Date().toISOString(), attemptId,
  ) as { changes?: number };
  const row = database.prepare("SELECT * FROM imessage_delivery_attempts WHERE attempt_id = ?")
    .get(attemptId) as AttemptRow | undefined;
  if (!row) throw new Error("iMessage attempt was not found.");
  if (Number(result.changes) !== 1 && row.state === "pending_send") {
    throw new Error("iMessage attempt could not be finalized.");
  }
  return fromRow(row);
}

/** Map the durable send certainty onto a recoverable attempt state. */
export function attemptStateForCertainty(certainty: OutboundSendCertainty | undefined): "failed" | "unconfirmed" {
  return certainty === "rejected" ? "failed" : "unconfirmed";
}

/**
 * A pending_send attempt whose worker is gone (crash, redeploy, killed request)
 * is ambiguous, never delivered and never silently failed.
 */
export function recoverStaleLoopMessageAttempts(
  tenantId: string, taskId: string, staleAfterMs = 15 * 60_000,
): number {
  if (!tenantId || !taskId || !Number.isSafeInteger(staleAfterMs) || staleAfterMs < 0) return 0;
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const result = db().prepare(`
    UPDATE imessage_delivery_attempts
    SET state = 'unconfirmed', error_detail = COALESCE(error_detail, 'Send outcome was never recorded (worker stopped mid-send).'), updated_at = ?
    WHERE tenant_id = ? AND task_id = ? AND state = 'pending_send' AND updated_at <= ?
  `).run(new Date().toISOString(), tenantId, taskId, cutoff) as { changes?: number };
  return Number(result.changes) || 0;
}

/** Keep the attempt ledger aligned with a provider-confirmed delivery status. */
export function syncLoopMessageAttemptFromProviderStatus(input: {
  tenantId: string; taskId: string; status: "processing" | "failed" | "delivered" | "unknown";
  errorCode?: number | null;
}): boolean {
  const result = db().prepare(`
    UPDATE imessage_delivery_attempts
    SET state = ?, error_code = COALESCE(?, error_code), updated_at = ?
    WHERE tenant_id = ? AND task_id = ? AND message_id IS NOT NULL AND state NOT IN ('delivered')
      AND attempt_id = (
        SELECT attempt_id FROM imessage_delivery_attempts
        WHERE tenant_id = ? AND task_id = ? AND message_id IS NOT NULL
        ORDER BY attempt_no DESC LIMIT 1
      )
  `).run(
    input.status, input.errorCode ?? null, new Date().toISOString(),
    input.tenantId, input.taskId, input.tenantId, input.taskId,
  ) as { changes?: number };
  return Number(result.changes) === 1;
}

/**
 * Apply a provider delivery callback to the attempt that owns the message ID.
 * Returns null when no attempt has claimed that ID yet, so the caller can
 * acknowledge the callback and let correlation happen after persistence.
 */
export function syncAttemptByMessageId(input: {
  messageId: string;
  provider: IMessageProvider;
  status: "processing" | "failed" | "delivered" | "unknown";
  errorCode?: number | null;
  errorDetail?: string | null;
}): LoopMessageDeliveryAttempt | null {
  if (!input.messageId) return null;
  const database = db();
  database.prepare(`
    UPDATE imessage_delivery_attempts
    SET state = ?, error_code = COALESCE(?, error_code),
        error_detail = COALESCE(?, error_detail), updated_at = ?
    WHERE provider = ? AND message_id = ? AND state <> 'delivered'
  `).run(
    input.status, input.errorCode ?? null,
    input.errorDetail ? String(input.errorDetail).slice(0, 500) : null,
    new Date().toISOString(), input.provider, input.messageId,
  );
  const row = database.prepare(
    "SELECT * FROM imessage_delivery_attempts WHERE provider = ? AND message_id = ?",
  ).get(input.provider, input.messageId) as AttemptRow | undefined;
  return row ? fromRow(row) : null;
}

export function getLatestLoopMessageAttempt(
  tenantId: string, taskId: string, provider: IMessageProvider = "loopmessage",
): LoopMessageDeliveryAttempt | null {
  if (!tenantId || !taskId) return null;
  const row = db().prepare(`
    SELECT * FROM imessage_delivery_attempts WHERE tenant_id = ? AND task_id = ? AND provider = ?
    ORDER BY attempt_no DESC LIMIT 1
  `).get(tenantId, taskId, provider) as AttemptRow | undefined;
  return row ? fromRow(row) : null;
}

export function listLoopMessageAttempts(
  tenantId: string, taskId: string, limit = 20, provider: IMessageProvider = "loopmessage",
): LoopMessageDeliveryAttempt[] {
  if (!tenantId || !taskId) return [];
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Attempt history limit must be between 1 and 100.");
  const rows = db().prepare(`
    SELECT * FROM imessage_delivery_attempts WHERE tenant_id = ? AND task_id = ? AND provider = ?
    ORDER BY attempt_no DESC LIMIT ?
  `).all(tenantId, taskId, provider, limit) as AttemptRow[];
  return rows.map(fromRow);
}

export function getLoopMessageAttempt(tenantId: string, attemptId: string): LoopMessageDeliveryAttempt | null {
  if (!tenantId || !attemptId) return null;
  const row = db().prepare("SELECT * FROM imessage_delivery_attempts WHERE tenant_id = ? AND attempt_id = ?")
    .get(tenantId, attemptId) as AttemptRow | undefined;
  return row ? fromRow(row) : null;
}
