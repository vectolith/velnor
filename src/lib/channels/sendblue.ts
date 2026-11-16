import type { SendResult } from "./types";

const SENDBLUE_ENDPOINT = "https://api.sendblue.co/api/send-message";

export async function sendSendblueMessage(params: {
  apiKeyId: string;
  apiSecretKey: string;
  /** E.164 phone number or an Apple Account email from an inbound iMessage thread. */
  number: string;
  /** Required for Sendblue's shared-line/free sandbox and explicit sender routing. */
  fromNumber: string;
  content: string;
  statusCallback: string;
  timeoutMs?: number;
}): Promise<SendResult> {
  if (!params.apiKeyId || !params.apiSecretKey || !params.number || !params.fromNumber || !params.statusCallback) {
    return {
      provider: "sendblue",
      ok: false,
      sendCertainty: "rejected",
      detail: "Sendblue requires API credentials, recipient, sender number, and a status callback URL.",
    };
  }
  try {
    const response = await fetch(SENDBLUE_ENDPOINT, {
      method: "POST",
      headers: {
        "sb-api-key-id": params.apiKeyId,
        "sb-api-secret-key": params.apiSecretKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        number: params.number,
        from_number: params.fromNumber,
        content: params.content,
        status_callback: params.statusCallback,
      }),
      signal: AbortSignal.timeout(params.timeoutMs ?? 12000),
    });
    const responseText = await response.text();
    let payload: {
      status?: string;
      error_message?: string;
      error_key?: string;
      error_code?: number;
      message_handle?: string;
      service?: string;
      was_downgraded?: boolean;
      raw?: string;
    } = {};
    try {
      payload = JSON.parse(responseText) as typeof payload;
    } catch {
      payload.raw = responseText.slice(0, 200);
    }
    if (!response.ok || payload.status === "ERROR" || payload.status === "DECLINED" || payload.error_key || payload.error_message) {
      const rejected = response.status >= 400 && response.status < 500;
      return {
        provider: "sendblue",
        ok: false,
        status: response.status,
        sendCertainty: rejected ? "rejected" : "ambiguous",
        detail: payload.error_message || payload.error_key || payload.raw || "Sendblue rejected the message.",
      };
    }
    if (!payload.message_handle) {
      return {
        provider: "sendblue",
        ok: false,
        status: response.status,
        sendCertainty: "ambiguous",
        detail: "Sendblue accepted the HTTP request but returned no message_handle; delivery cannot be tracked.",
      };
    }
    const downgraded = payload.was_downgraded === true ||
      (typeof payload.service === "string" && payload.service.toLowerCase() === "sms");
    return {
      provider: "sendblue",
      ok: true,
      status: response.status,
      messageId: payload.message_handle,
      deliveryStatus: downgraded ? "failed" : "queued",
      sendCertainty: "accepted",
      detail: downgraded
        ? "Sendblue downgraded this message to SMS; it is not counted as iMessage delivery."
        : "Accepted by Sendblue queue; delivery remains unconfirmed until its status callback.",
    };
  } catch (err) {
    return {
      provider: "sendblue",
      ok: false,
      sendCertainty: "ambiguous",
      detail: err instanceof Error ? err.message : "Sendblue transport failed.",
    };
  }
}


export type SendblueProviderStatus = "processing" | "failed" | "delivered" | "unknown";

export type SendblueStatusResult =
  | {
      ok: true;
      messageId: string;
      recipient: string;
      sender: string;
      status: SendblueProviderStatus;
      service: string;
      wasDowngraded: boolean;
      errorCode?: number;
    }
  | { ok: false; detail: string; status?: number };

/** Query Sendblue's status endpoint before an operator-requested retry. */
export async function getSendblueMessageStatus(params: {
  apiKeyId: string;
  apiSecretKey: string;
  messageId: string;
  timeoutMs?: number;
}): Promise<SendblueStatusResult> {
  if (!params.apiKeyId || !params.apiSecretKey || !params.messageId) {
    return { ok: false, detail: "Sendblue status lookup requires API credentials and a message handle." };
  }
  try {
    const url = new URL("https://api.sendblue.co/api/status");
    url.searchParams.set("handle", params.messageId);
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "sb-api-key-id": params.apiKeyId,
        "sb-api-secret-key": params.apiSecretKey,
      },
      signal: AbortSignal.timeout(params.timeoutMs ?? 12000),
    });
    const text = await response.text();
    let payload: {
      message_handle?: unknown;
      number?: unknown;
      to_number?: unknown;
      from_number?: unknown;
      sendblue_number?: unknown;
      status?: unknown;
      service?: unknown;
      was_downgraded?: unknown;
      error_code?: unknown;
      error_message?: unknown;
    } = {};
    try { payload = JSON.parse(text) as typeof payload; } catch {}
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        detail: typeof payload.error_message === "string"
          ? payload.error_message
          : `Sendblue status lookup failed with HTTP ${response.status}.`,
      };
    }
    const recipient = typeof payload.number === "string"
      ? payload.number
      : typeof payload.to_number === "string" ? payload.to_number : "";
    const sender = typeof payload.from_number === "string"
      ? payload.from_number
      : typeof payload.sendblue_number === "string" ? payload.sendblue_number : "";
    if (payload.message_handle !== params.messageId || !recipient || !sender || typeof payload.status !== "string") {
      return { ok: false, status: response.status, detail: "Sendblue returned an incomplete or mismatched status record." };
    }
    const providerStatus = payload.status.toUpperCase();
    const service = typeof payload.service === "string" ? payload.service : "";
    const wasDowngraded = payload.was_downgraded === true || service.toLowerCase() === "sms";
    let status: SendblueProviderStatus = "unknown";
    if (providerStatus === "ERROR" || providerStatus === "DECLINED" ||
        (wasDowngraded && (providerStatus === "SENT" || providerStatus === "DELIVERED"))) {
      status = "failed";
    } else if (providerStatus === "DELIVERED" && service.toLowerCase() === "imessage" && !wasDowngraded) {
      status = "delivered";
    } else if (["REGISTERED", "PENDING", "QUEUED", "ACCEPTED"].includes(providerStatus)) {
      status = "processing";
    }
    return {
      ok: true,
      messageId: params.messageId,
      recipient,
      sender,
      status,
      service,
      wasDowngraded,
      errorCode: Number.isInteger(payload.error_code) ? Number(payload.error_code) : undefined,
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "Sendblue status lookup failed." };
  }
}
