import { readFailure, SendResult } from "./types";

const SENDBLUE_ENDPOINT = "https://api.sendblue.co/api/send-message";

export async function sendSendblueMessage(params: {
  apiKeyId: string;
  apiSecretKey: string;
  number: string;
  fromNumber?: string;
  content: string;
  timeoutMs?: number;
}): Promise<SendResult> {
  if (!params.apiKeyId || !params.apiSecretKey || !params.number) {
    return { provider: "sendblue", ok: false, detail: "Sendblue is not configured" };
  }
  try {
    const response = await fetch(SENDBLUE_ENDPOINT, {
      method: "POST",
      headers: {
        "sb-api-key-id": params.apiKeyId,
        "sb-api-secret-key": params.apiSecretKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ number: params.number, content: params.content, ...(params.fromNumber ? { from_number: params.fromNumber } : {}) }),
      signal: AbortSignal.timeout(params.timeoutMs ?? 12000),
    });
    if (!response.ok) {
      return { provider: "sendblue", ok: false, status: response.status, detail: await readFailure(response) };
    }
    const payload = await response.json().catch(() => ({})) as { status?: string; error_message?: string; error_key?: string; message_handle?: string };
    if (payload.status === "ERROR" || payload.error_key || payload.error_message) {
      return { provider: "sendblue", ok: false, status: response.status, detail: payload.error_message || payload.error_key || "Sendblue rejected the message." };
    }
    return { provider: "sendblue", ok: true, status: response.status, detail: payload.message_handle ? "Accepted by Sendblue; message handle " + payload.message_handle : "Accepted by Sendblue." };
  } catch (err) {
    return { provider: "sendblue", ok: false, detail: (err as Error).message };
  }
}
