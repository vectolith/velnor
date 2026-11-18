import { readFailure, SendResult } from "./types";

const SENDBLUE_ENDPOINT = "https://api.sendblue.co/api/send-message";
const SENDBLUE_STATUS_ENDPOINT = "https://api.sendblue.co/api/status";

export type SendblueDeliveryStatus = "queued" | "processing" | "delivered" | "failed" | "unknown";

/** Map Sendblue's callback vocabulary onto the delivery states VELNOR stores. */
export function mapSendblueStatus(raw: unknown): SendblueDeliveryStatus {
  switch (String(raw ?? "").trim().toUpperCase()) {
    case "QUEUED":
    case "ACCEPTED":
    case "SENT":
      return "queued";
    case "RECEIVED":
    case "PROCESSING":
      return "processing";
    case "DELIVERED":
      return "delivered";
    case "ERROR":
    case "FAILED":
    case "DECLINED":
    case "EXPIRED":
      return "failed";
    default:
      return "unknown";
  }
}

export interface SendblueSendInput {
  apiKeyId: string;
  apiSecret?: string;
  /** @deprecated legacy name kept for existing callers. */
  apiSecretKey?: string;
  number: string;
  fromNumber?: string;
  content: string;
  mediaUrl?: string;
  timeoutMs?: number;
}

/**
 * Send one iMessage/SMS through Sendblue.
 *
 * The result states what the provider actually proved:
 * - accepted: 2xx with a message handle we can track.
 * - rejected: the provider explicitly refused (4xx or an error payload).
 * - ambiguous: the request may have been delivered but we cannot prove it
 *   (timeout, 5xx, 2xx without a handle). Callers must not treat it as sent.
 */
export async function sendSendblueMessage(params: SendblueSendInput): Promise<SendResult> {
  const secret = params.apiSecret || params.apiSecretKey || "";
  if (!params.apiKeyId || !secret || !params.number || !params.content.trim()) {
    return { provider: "sendblue", ok: false, detail: "Sendblue is not configured", sendCertainty: "rejected" };
  }
  let response: Response;
  try {
    response = await fetch(SENDBLUE_ENDPOINT, {
      method: "POST",
      headers: {
        "sb-api-key-id": params.apiKeyId,
        "sb-api-secret-key": secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        number: params.number,
        content: params.content,
        ...(params.fromNumber ? { from_number: params.fromNumber } : {}),
        ...(params.mediaUrl ? { media_url: params.mediaUrl } : {}),
      }),
      signal: AbortSignal.timeout(params.timeoutMs ?? 15000),
    });
  } catch (err) {
    // The request may still have reached Sendblue before the timeout fired.
    return { provider: "sendblue", ok: false, detail: (err as Error).message, sendCertainty: "ambiguous" };
  }

  if (!response.ok) {
    const detail = await readFailure(response);
    const certainty = response.status >= 500 || response.status === 429 ? "ambiguous" : "rejected";
    return { provider: "sendblue", ok: false, status: response.status, detail, sendCertainty: certainty };
  }

  const payload = (await response.json().catch(() => ({}))) as {
    status?: string;
    error_message?: string;
    error_key?: string;
    error_code?: number | string;
    message_handle?: string;
  };
  const errorDetail = payload.error_message || payload.error_key || "";
  if (String(payload.status ?? "").toUpperCase() === "ERROR" || errorDetail) {
    return {
      provider: "sendblue",
      ok: false,
      status: response.status,
      detail: errorDetail || "Sendblue rejected the message.",
      sendCertainty: "rejected",
    };
  }
  if (!payload.message_handle) {
    return {
      provider: "sendblue",
      ok: false,
      status: response.status,
      detail: "Sendblue accepted the request but returned no message handle.",
      sendCertainty: "ambiguous",
    };
  }
  return {
    provider: "sendblue",
    ok: true,
    status: response.status,
    messageId: payload.message_handle,
    deliveryStatus: mapSendblueStatus(payload.status),
    sendCertainty: "accepted",
  };
}

/** Ask Sendblue for the authoritative status of one message handle. */
export async function fetchSendblueStatus(params: {
  apiKeyId: string;
  apiSecret: string;
  messageHandle: string;
  timeoutMs?: number;
}): Promise<{ status: SendblueDeliveryStatus; raw?: string; error?: string }> {
  if (!params.apiKeyId || !params.apiSecret || !params.messageHandle) {
    return { status: "unknown", error: "Sendblue is not configured" };
  }
  try {
    const url = new URL(SENDBLUE_STATUS_ENDPOINT);
    url.searchParams.set("message_handle", params.messageHandle);
    const response = await fetch(url.toString(), {
      headers: {
        "sb-api-key-id": params.apiKeyId,
        "sb-api-secret-key": params.apiSecret,
      },
      signal: AbortSignal.timeout(params.timeoutMs ?? 10000),
    });
    if (!response.ok) return { status: "unknown", error: await readFailure(response) };
    const payload = (await response.json().catch(() => ({}))) as { status?: string; error_message?: string };
    return { status: mapSendblueStatus(payload.status), raw: payload.status, error: payload.error_message };
  } catch (err) {
    return { status: "unknown", error: (err as Error).message };
  }
}
