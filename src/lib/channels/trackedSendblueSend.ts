import { sendSendblueMessage, type SendblueSendInput } from "./sendblue";
import type { SendResult } from "./types";
import {
  beginLoopMessageAttempt, finishLoopMessageAttempt, attemptStateForCertainty,
  getLatestLoopMessageAttempt, LoopMessageAttemptBlockedError, type LoopMessageDeliveryAttempt,
} from "./imessageDeliveryAttempts";
import { applyPendingSendblueStatus } from "./sendblueStatusStore";

export interface TrackedSendblueSend {
  result: SendResult;
  /** The attempt row that now records this send, delivered or not. */
  attempt: LoopMessageDeliveryAttempt;
  /** True when an earlier attempt may already have reached the recipient. */
  duplicateRisk: boolean;
}

/**
 * Send through Sendblue behind the durable attempt ledger.
 *
 * The row is committed before the network call, so a provider timeout or a
 * crashed worker leaves an explicit, attributable record instead of a message
 * that vanishes. A queued send is never reported as delivered.
 */
export async function sendTrackedSendblueMessage(input: {
  tenantId: string;
  taskId: string;
  recipient: string;
  senderId: string;
  config: Pick<SendblueSendInput, "apiKeyId" | "apiSecret" | "fromNumber" | "timeoutMs">;
  text: string;
  mediaUrl?: string;
  /** Reserved for an explicit, provider-reconciled user retry. */
  allowAmbiguousRetry?: boolean;
}): Promise<TrackedSendblueSend> {
  const previous = getLatestLoopMessageAttempt(input.tenantId, input.taskId, "sendblue");
  const previousWasAmbiguous = previous?.state === "unconfirmed" || previous?.state === "unknown";

  let started: LoopMessageDeliveryAttempt;
  try {
    started = beginLoopMessageAttempt({
      provider: "sendblue",
      tenantId: input.tenantId,
      taskId: input.taskId,
      recipient: input.recipient,
      senderId: input.senderId,
      allowAmbiguousRetry: input.allowAmbiguousRetry,
    });
  } catch (error) {
    if (!(error instanceof LoopMessageAttemptBlockedError)) throw error;
    const attempt = getLatestLoopMessageAttempt(input.tenantId, input.taskId, "sendblue");
    if (!attempt) throw error;
    return {
      result: { provider: "sendblue", ok: false, detail: error.message, sendCertainty: "ambiguous" },
      attempt,
      duplicateRisk: attempt.state !== "delivered",
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
    result = await sendSendblueMessage({
      ...input.config,
      number: input.recipient,
      content: input.text,
      mediaUrl: input.mediaUrl,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Sendblue send failed.";
    const attempt = finalize({ state: "unconfirmed", errorDetail: detail });
    return {
      result: { provider: "sendblue", ok: false, detail, sendCertainty: "ambiguous" },
      attempt,
      duplicateRisk: true,
    };
  }

  if (result.ok && result.messageId) {
    const attempt = finalize({ state: "queued", messageId: result.messageId });
    // A status callback may have landed while the request was still open.
    try {
      applyPendingSendblueStatus(result.messageId);
    } catch (error) {
      console.warn("Sendblue queued status could not be reconciled", {
        messageId: result.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { result, attempt, duplicateRisk: previousWasAmbiguous };
  }

  const state = attemptStateForCertainty(result.sendCertainty);
  const attempt = finalize({
    state,
    errorCode: result.status ?? null,
    errorDetail: result.detail || "Sendblue send failed.",
  });
  return { result, attempt, duplicateRisk: state === "unconfirmed" };
}
