import { readFailure, SendResult } from "./types";

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
    const payload = await response.json().catch(async () => ({
      raw: await readFailure(response),
    })) as {
      status?: string;
      error_message?: string;
      error_key?: string;
      error_code?: number;
      message_handle?: string;
      service?: string;
      was_downgraded?: boolean;
    };
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
