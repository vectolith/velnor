import { readFailure, SendResult } from "./types";

const LOOPMESSAGE_ENDPOINT = "https://server.loopmessage.com/api/v1/message/send/";

export async function sendLoopMessage(params: {
  authKey: string;
  secretKey: string;
  recipient: string;
  text: string;
  timeoutMs?: number;
}): Promise<SendResult> {
  if (!params.authKey || !params.secretKey || !params.recipient) {
    return { provider: "loopmessage", ok: false, detail: "LoopMessage is not configured" };
  }
  try {
    const response = await fetch(LOOPMESSAGE_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: params.authKey,
        "Loop-Secret-Key": params.secretKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient: params.recipient, text: params.text }),
      signal: AbortSignal.timeout(params.timeoutMs ?? 12000),
    });
    if (!response.ok) {
      return { provider: "loopmessage", ok: false, status: response.status, detail: await readFailure(response) };
    }
    return { provider: "loopmessage", ok: true, status: response.status };
  } catch (err) {
    return { provider: "loopmessage", ok: false, detail: (err as Error).message };
  }
}
