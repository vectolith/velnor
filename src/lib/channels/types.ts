/**
 * What the outbound attempt proved about delivery intent.
 * - accepted: the provider acknowledged the request with a trackable message ID.
 * - rejected: the provider explicitly refused the request, so nothing was queued.
 * - ambiguous: the request left this process but the outcome is unknown (timeout,
 *   5xx, or a 2xx response without a message ID). A retry may duplicate.
 */
export type OutboundSendCertainty = "accepted" | "rejected" | "ambiguous";

export interface SendResult {
  provider: "sendblue" | "loopmessage" | "slack" | "twilio";
  ok: boolean;
  status?: number;
  detail?: string;
  messageId?: string;
  deliveryStatus?: "queued" | "processing" | "delivered" | "failed" | "unknown";
  sendCertainty?: OutboundSendCertainty;
}

/** Read an error body without letting a broken stream mask the failure. */
export async function readFailure(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 200);
  } catch {
    return "";
  }
}
