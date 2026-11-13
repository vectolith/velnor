import { readFailure, SendResult } from "./types";

const LOOPMESSAGE_ENDPOINT = "https://a.loopmessage.com/api/v1/message/send/";

export async function sendLoopMessage(params: {
  authKey: string;
  recipient: string;
  text: string;
  timeoutMs?: number;
}): Promise<SendResult> {
  if (!params.authKey || !params.recipient) {
    return { provider: "loopmessage", ok: false, detail: "LoopMessage is not configured" };
  }
  try {
    const response = await fetch(LOOPMESSAGE_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: params.authKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ contact: params.recipient, text: params.text }),
      signal: AbortSignal.timeout(params.timeoutMs ?? 12000),
    });
    if (!response.ok) {
      return { provider: "loopmessage", ok: false, status: response.status, detail: await readFailure(response) };
    }
    const payload = await response.json().catch(() => ({})) as { success?: boolean; message?: string; message_id?: string };
    if (payload.success === false) {
      return { provider: "loopmessage", ok: false, status: response.status, detail: payload.message || "LoopMessage rejected the message." };
    }
    return { provider: "loopmessage", ok: true, status: response.status, detail: "Accepted by LoopMessage queue; delivery is pending" + (payload.message_id ? " (" + payload.message_id + ")" : "") + "." };
  } catch (err) {
    return { provider: "loopmessage", ok: false, detail: (err as Error).message };
  }
}
