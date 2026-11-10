import { readFailure, SendResult } from "./types";

const SENDBLUE_ENDPOINT = "https://api.sendblue.co/api/send-message";

export async function sendSendblueMessage(params: {
  apiKeyId: string;
  apiSecretKey: string;
  number: string;
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
      body: JSON.stringify({ number: params.number, content: params.content }),
      signal: AbortSignal.timeout(params.timeoutMs ?? 12000),
    });
    if (!response.ok) {
      return { provider: "sendblue", ok: false, status: response.status, detail: await readFailure(response) };
    }
    return { provider: "sendblue", ok: true, status: response.status };
  } catch (err) {
    return { provider: "sendblue", ok: false, detail: (err as Error).message };
  }
}
