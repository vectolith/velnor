import { readFailure, SendResult } from "./types";

const LOOPMESSAGE_ENDPOINT = "https://a.loopmessage.com/api/v1/message/send/";

export async function sendLoopMessage(params: {
  authKey: string;
  recipient: string;
  text: string;
  /** Optional LoopMessage sender ID; configure this to pin VELNOR to its email sender. */
  senderId: string;
  timeoutMs?: number;
}): Promise<SendResult> {
  if (!params.authKey || !params.recipient || !params.senderId?.trim()) {
    return { provider: "loopmessage", ok: false, detail: "LoopMessage requires an API key, recipient, and explicit sender ID." };
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
        ...(params.senderId ? { sender: params.senderId } : {}),
      }),
      signal: AbortSignal.timeout(params.timeoutMs ?? 12000),
    });
    if (!response.ok) {
      return { provider: "loopmessage", ok: false, status: response.status, detail: await readFailure(response) };
    }
    const payload = await response.json().catch(() => ({})) as { success?: boolean; message?: string; message_id?: string };
    if (payload.success === false) {
      return { provider: "loopmessage", ok: false, status: response.status, detail: payload.message || "LoopMessage rejected the message." };
    }
    if (!payload.message_id) return { provider: "loopmessage", ok: false, status: response.status, detail: "LoopMessage accepted the HTTP request but returned no message_id; delivery cannot be tracked." };
    return { provider: "loopmessage", ok: true, status: response.status, messageId: payload.message_id, deliveryStatus: "queued", detail: "Accepted by LoopMessage queue; not yet delivered." };
  } catch (err) {
    return { provider: "loopmessage", ok: false, detail: (err as Error).message };
  }
}
