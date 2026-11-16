import { sendSendblueMessage } from "./sendblue";
import type { SendResult } from "./types";
import {
  beginLoopMessageAttempt,
  finishLoopMessageAttempt,
  attemptStateForCertainty,
  getLatestLoopMessageAttempt,
  syncLoopMessageAttemptFromProviderStatus,
  type LoopMessageDeliveryAttempt,
} from "./imessageDeliveryAttempts";
import {
  recordLoopMessageQueued,
  updateLoopMessageProviderStatus,
} from "./imessageDeliveryStore";
import { normalizeImessageIdentity } from "./imessageIdentity";

export interface TrackedSendblueSend {
  result: SendResult;
  attempt: LoopMessageDeliveryAttempt;
  duplicateRisk: boolean;
  trackingDegraded: boolean;
}

/**
 * Send through Sendblue with a durable pre-send attempt record.
 * The existing attempt table is retained for migration compatibility; its
 * provider-neutral message handle and identity fields also track Sendblue.
 */
export async function sendTrackedSendblueMessage(input: {
  tenantId: string;
  taskId: string;
  recipient: string;
  fromNumber: string;
  apiKeyId: string;
  apiSecretKey: string;
  content: string;
  statusCallback: string;
  timeoutMs?: number;
  allowAmbiguousRetry?: boolean;
}): Promise<TrackedSendblueSend> {
  const recipient = normalizeImessageIdentity(input.recipient);
  const fromNumber = normalizeImessageIdentity(input.fromNumber);
  if (!recipient || !fromNumber) {
    throw new Error("Sendblue requires a valid recipient and configured sender identity.");
  }
  const previous = getLatestLoopMessageAttempt(input.tenantId, input.taskId);
  const previousWasAmbiguous = previous?.state === "unconfirmed" || previous?.state === "unknown";
  if (previous && normalizeImessageIdentity(previous.recipient) !== recipient) {
    throw new Error("Sendblue retry recipient differs from the original attempt; send blocked.");
  }
  if (previous && previous.senderId !== fromNumber) {
    throw new Error("Sendblue retry sender differs from the original attempt; send blocked.");
  }
  if (previous && ["queued", "processing", "delivered", "pending_send"].includes(previous.state)) {
    throw new Error(`Sendblue attempt is already ${previous.state}; another send is blocked.`);
  }
  if (previousWasAmbiguous && !input.allowAmbiguousRetry) {
    throw new Error("Sendblue outcome is ambiguous; an explicit retry is required because a duplicate may be delivered.");
  }

  const started = beginLoopMessageAttempt({
    tenantId: input.tenantId,
    taskId: input.taskId,
    recipient,
    senderId: fromNumber,
  });
  const finalize = (outcome: {
    state: "queued" | "failed" | "unconfirmed";
    messageId?: string | null;
    errorCode?: number | null;
    errorDetail?: string | null;
  }) => finishLoopMessageAttempt(started.attemptId, outcome);

  let result: SendResult;
  try {
    result = await sendSendblueMessage({
      apiKeyId: input.apiKeyId,
      apiSecretKey: input.apiSecretKey,
      number: recipient,
      fromNumber,
      content: input.content,
      statusCallback: input.statusCallback,
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Sendblue send failed.";
    const attempt = finalize({ state: "unconfirmed", errorDetail: detail });
    return {
      result: { provider: "sendblue", ok: false, detail, sendCertainty: "ambiguous" },
      attempt,
      duplicateRisk: true,
      trackingDegraded: false,
    };
  }

  if (result.messageId && result.sendCertainty === "accepted") {
    let attempt = finalize({
      state: "queued",
      messageId: result.messageId,
      errorDetail: result.deliveryStatus === "failed" ? result.detail : null,
    });
    let trackingDegraded = false;
    try {
      recordLoopMessageQueued({
        messageId: result.messageId,
        tenantId: input.tenantId,
        taskId: input.taskId,
        recipient,
        senderId: fromNumber,
      });
      if (result.deliveryStatus === "failed") {
        updateLoopMessageProviderStatus({
          messageId: result.messageId,
          tenantId: input.tenantId,
          taskId: input.taskId,
          recipient,
          senderId: fromNumber,
          status: "failed",
        });
        syncLoopMessageAttemptFromProviderStatus({
          tenantId: input.tenantId,
          taskId: input.taskId,
          messageId: result.messageId,
          status: "failed",
        });
      }
    } catch (error) {
      trackingDegraded = true;
      result = {
        ...result,
        detail: (result.detail ? result.detail + " " : "") +
          "Delivery record could not be linked: " +
          (error instanceof Error ? error.message : "unknown error"),
      };
    }
    attempt = getLatestLoopMessageAttempt(input.tenantId, input.taskId) || attempt;
    return {
      result,
      attempt,
      duplicateRisk: previousWasAmbiguous,
      trackingDegraded,
    };
  }

  const state = attemptStateForCertainty(result.sendCertainty);
  const attempt = finalize({
    state,
    errorCode: result.status ?? null,
    errorDetail: result.detail || "Sendblue send failed.",
  });
  return {
    result,
    attempt,
    duplicateRisk: state === "unconfirmed",
    trackingDegraded: false,
  };
}
