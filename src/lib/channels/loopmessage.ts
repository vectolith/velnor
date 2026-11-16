import { readFailure, SendResult } from "./types";

const LOOPMESSAGE_ENDPOINT = "https://a.loopmessage.com/api/v1/message/send/";

export async function sendLoopMessage(params: {
  authKey: string;
  recipient: string;
  text: string;
  /** Required LoopMessage sender-name ID; prevents provider-default sender selection. */
  senderId: string;
  passthrough?: string;
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
        sender: params.senderId.trim(),
        passthrough: params.passthrough,
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


export interface LoopMessageSenderVerification {
  ok: boolean;
  senderId: string;
  name?: string;
  status?: string;
  imessageLink?: string;
  detail: string;
}

/** Verify the configured sender ID against LoopMessage's sender-details API. */
export async function verifyLoopMessageSender(params: {
  authKey: string;
  senderId: string;
  timeoutMs?: number;
}): Promise<LoopMessageSenderVerification> {
  const senderId = params.senderId.trim();
  if (!params.authKey || !senderId) {
    return { ok: false, senderId, detail: "LoopMessage API key and sender ID are required." };
  }
  try {
    const response = await fetch(
      "https://a.loopmessage.com/api/v1/sender/" + encodeURIComponent(senderId) + "/",
      {
        method: "GET",
        headers: { Authorization: params.authKey, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(params.timeoutMs ?? 10000),
      }
    );
    if (!response.ok) {
      return { ok: false, senderId, detail: "LoopMessage sender lookup failed with HTTP " + response.status + "." };
    }
    const payload = await response.json().catch(() => null) as {
      id?: string; name?: string; status?: string; imessage_link?: string;
    } | null;
    if (!payload || payload.id !== senderId) {
      return { ok: false, senderId, detail: "LoopMessage did not return the configured sender ID." };
    }
    const status = typeof payload.status === "string" ? payload.status.toLowerCase() : "unknown";
    return {
      ok: status === "active",
      senderId,
      name: typeof payload.name === "string" ? payload.name : undefined,
      status,
      imessageLink: typeof payload.imessage_link === "string" ? payload.imessage_link : undefined,
      detail: status === "active"
        ? "The configured LoopMessage sender ID exists and is active. The sender-details API does not expose its Apple ID email address; recipient-side verification is still required."
        : "The configured LoopMessage sender exists but is not active (" + status + ").",
    };
  } catch (error) {
    return {
      ok: false,
      senderId,
      detail: "LoopMessage sender lookup failed: " + (error instanceof Error ? error.message : String(error)),
    };
  }
}
