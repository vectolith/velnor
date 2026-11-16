import { readFailure, SendResult } from "./types";

const LOOPMESSAGE_ENDPOINT = "https://a.loopmessage.com/api/v1/message/send/";

export async function sendLoopMessage(params: {
  authKey: string;
  recipient: string;
  text: string;
  /** Required LoopMessage sender-name ID; prevents provider-default sender selection. */
  senderId: string;
  timeoutMs?: number;
}): Promise<SendResult> {
  if (!params.authKey || !params.recipient || !params.senderId?.trim()) {
    return {
      provider: "loopmessage", ok: false, sendCertainty: "rejected",
      detail: "LoopMessage requires an API key, recipient, and explicit sender ID.",
    };
  }
  try {
    const response = await fetch(LOOPMESSAGE_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: params.authKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contact: params.recipient,
        text: params.text,
        sender: params.senderId.trim(),
      }),
      signal: AbortSignal.timeout(params.timeoutMs ?? 12000),
    });
    if (!response.ok) {
      // 4xx is an explicit refusal; 5xx/429 may have been processed before the error.
      const rejected = response.status >= 400 && response.status < 500 && response.status !== 429;
      return {
        provider: "loopmessage", ok: false, status: response.status,
        sendCertainty: rejected ? "rejected" : "ambiguous",
        detail: await readFailure(response),
      };
    }
    const payload = await response.json().catch(() => ({})) as { success?: boolean; message?: string; message_id?: string };
    if (payload.success === false) {
      return {
        provider: "loopmessage", ok: false, status: response.status, sendCertainty: "rejected",
        detail: payload.message || "LoopMessage rejected the message.",
      };
    }
    if (!payload.message_id) {
      return {
        provider: "loopmessage", ok: false, status: response.status, sendCertainty: "ambiguous",
        detail: "LoopMessage accepted the HTTP request but returned no message_id; delivery cannot be tracked.",
      };
    }
    return {
      provider: "loopmessage", ok: true, status: response.status, messageId: payload.message_id,
      deliveryStatus: "queued", sendCertainty: "accepted",
      detail: "Accepted by LoopMessage queue; not yet delivered.",
    };
  } catch (err) {
    // A timeout or reset can happen after the provider accepted the request,
    // so a thrown transport error is never proof that nothing was sent.
    return {
      provider: "loopmessage", ok: false, sendCertainty: "ambiguous",
      detail: (err as Error).message,
    };
  }
}


export type LoopMessageProviderStatus = "processing" | "failed" | "delivered" | "unknown";

export type LoopMessageStatusResult =
  | { ok: true; messageId: string; contact: string; status: LoopMessageProviderStatus; errorCode?: number }
  | { ok: false; detail: string; status?: number };

/** Query LoopMessage's documented status endpoint for an accepted outbound message. */
export async function getLoopMessageStatus(params: {
  authKey: string;
  messageId: string;
  timeoutMs?: number;
}): Promise<LoopMessageStatusResult> {
  if (!params.authKey || !params.messageId) {
    return { ok: false, detail: "LoopMessage status lookup requires an API key and message ID." };
  }
  try {
    const response = await fetch(
      `https://a.loopmessage.com/api/v1/message/status/${encodeURIComponent(params.messageId)}/`,
      {
        method: "GET",
        headers: { Authorization: params.authKey, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(params.timeoutMs ?? 12000),
      },
    );
    const payload = await response.json().catch(() => ({})) as {
      message_id?: unknown; contact?: unknown; status?: unknown; error_code?: unknown; message?: unknown;
    };
    if (!response.ok) {
      return {
        ok: false, status: response.status,
        detail: typeof payload.message === "string" ? payload.message : `LoopMessage status lookup failed with HTTP ${response.status}.`,
      };
    }
    const validStatuses = ["processing", "failed", "delivered", "unknown"];
    if (payload.message_id !== params.messageId ||
        typeof payload.contact !== "string" ||
        typeof payload.status !== "string" ||
        !validStatuses.includes(payload.status)) {
      return { ok: false, status: response.status, detail: "LoopMessage returned an incomplete or mismatched message status record." };
    }
    return {
      ok: true,
      messageId: payload.message_id,
      contact: payload.contact,
      status: payload.status as LoopMessageProviderStatus,
      errorCode: Number.isInteger(payload.error_code) ? Number(payload.error_code) : undefined,
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "LoopMessage status lookup failed." };
  }
}
