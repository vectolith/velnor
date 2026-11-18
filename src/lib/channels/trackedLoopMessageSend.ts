import { sendLoopMessage } from "./loopmessage";
import type { SendResult } from "./types";
import {
  beginLoopMessageAttempt, finishLoopMessageAttempt, attemptStateForCertainty,
  getLatestLoopMessageAttempt, LoopMessageAttemptBlockedError, type LoopMessageDeliveryAttempt,
} from "./imessageDeliveryAttempts";
import { recordLoopMessageQueued } from "./imessageDeliveryStore";

export interface TrackedLoopMessageSend {
  result: SendResult;
  /** The attempt row that now records this send, delivered or not. */
  attempt: LoopMessageDeliveryAttempt;
  /** True when an earlier attempt may already have reached the recipient. */
  duplicateRisk: boolean;
  /** True when the provider accepted the send but the delivery record could not be written. */
  trackingDegraded: boolean;
}

/**
 * Send through LoopMessage behind a durable attempt record.
 *
 * The attempt row is committed before the network call, so a send that fails or
 * dies without a provider message ID is still retained, attributable to the
 * tenant/task/recipient/sender, and explicitly retryable. Nothing here treats a
 * queued send as delivered.
 */
export async function sendTrackedLoopMessage(input: {
  tenantId: string;
  taskId: string;
  recipient: string;
  senderId: string;
  authKey: string;
  text: string;
  timeoutMs?: number;
  /** Only explicit retry APIs may authorize a retry after an ambiguous outcome. */
  allowAmbiguousRetry?: boolean;
}): Promise<TrackedLoopMessageSend> {
  const previous = getLatestLoopMessageAttempt(input.tenantId, input.taskId);
  const previousWasAmbiguous = previous?.state === "unconfirmed" || previous?.state === "unknown";

  let started: LoopMessageDeliveryAttempt;
  try {
    started = beginLoopMessageAttempt({
      tenantId: input.tenantId, taskId: input.taskId,
      recipient: input.recipient, senderId: input.senderId,
      allowAmbiguousRetry: input.allowAmbiguousRetry,
    });
  } catch (error) {
    if (!(error instanceof LoopMessageAttemptBlockedError)) throw error;
    const attempt = getLatestLoopMessageAttempt(input.tenantId, input.taskId);
    if (!attempt) throw error;
    return {
      result: { provider: "loopmessage", ok: false, detail: error.message, sendCertainty: "ambiguous" },
      attempt,
      duplicateRisk: attempt.state !== "delivered",
      trackingDegraded: false,
    };
  }

  const finalize = (outcome: {
    state: "queued" | "failed" | "unconfirmed";
    messageId?: string | null;
    errorCode?: number | null;
    errorDetail?: string | null;
  }) => finishLoopMessageAttempt(started.attemptId, outcome);

  let result: SendResult;
  try {
    result = await sendLoopMessage({
      authKey: input.authKey,
      recipient: input.recipient,
      text: input.text,
      senderId: input.senderId,
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "LoopMessage send failed.";
    const attempt = finalize({ state: "unconfirmed", errorDetail: detail });
    return {
      result: { provider: "loopmessage", ok: false, detail, sendCertainty: "ambiguous" },
      attempt, duplicateRisk: true, trackingDegraded: false,
    };
  }

  if (result.ok && result.messageId) {
    let trackingDegraded = false;
    let detail = result.detail;
    try {
      recordLoopMessageQueued({
        messageId: result.messageId, tenantId: input.tenantId, taskId: input.taskId,
        recipient: input.recipient, senderId: input.senderId,
      });
    } catch (error) {
      // The attempt ledger still holds the provider message ID, so the delivery
      // stays attributable; surface the degraded tracking instead of dropping it.
      trackingDegraded = true;
      detail = (result.detail ? result.detail + " " : "") +
        "Delivery record could not be linked: " + (error instanceof Error ? error.message : "unknown error");
    }
    const attempt = finalize({
      state: "queued",
      messageId: result.messageId,
      errorDetail: trackingDegraded ? detail : null,
    });
    // An earlier ambiguous attempt may have landed, so this accepted send can
    // still be the second copy the recipient sees.
    return {
      result: { ...result, detail },
      attempt,
      duplicateRisk: previousWasAmbiguous,
      trackingDegraded,
    };
  }

  const state = attemptStateForCertainty(result.sendCertainty);
  const attempt = finalize({
    state,
    errorCode: result.status ?? null,
    errorDetail: result.detail || "LoopMessage send failed.",
  });
  return { result, attempt, duplicateRisk: state === "unconfirmed", trackingDegraded: false };
}
