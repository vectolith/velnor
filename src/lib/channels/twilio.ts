import { Buffer } from "node:buffer";
import { readFailure, SendResult } from "./types";

const TWILIO_API = "https://api.twilio.com/2010-04-01";

export async function sendTwilioSms(params: {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  body: string;
  timeoutMs?: number;
}): Promise<SendResult> {
  if (!params.accountSid || !params.authToken || !params.from || !params.to) {
    return { provider: "twilio", ok: false, detail: "Twilio SMS is not configured" };
  }
  if (params.body.length === 0 || params.body.length > 1600) {
    return { provider: "twilio", ok: false, detail: "SMS body must contain 1–1600 characters" };
  }
  try {
    const form = new URLSearchParams({ From: params.from, To: params.to, Body: params.body });
    const response = await fetch(
      `${TWILIO_API}/Accounts/${encodeURIComponent(params.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(params.accountSid + ":" + params.authToken).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(params.timeoutMs ?? 12000),
      },
    );
    if (!response.ok) {
      return { provider: "twilio", ok: false, status: response.status, detail: await readFailure(response) };
    }
    const payload = await response.json().catch(() => ({})) as { sid?: string; status?: string; error_code?: number; message?: string };
    if (!payload.sid || payload.error_code) {
      return {
        provider: "twilio",
        ok: false,
        status: response.status,
        detail: payload.message || "Twilio did not return a message SID; SMS acceptance is unconfirmed.",
      };
    }
    return {
      provider: "twilio",
      ok: true,
      status: response.status,
      detail: "Accepted by Twilio (message " + payload.sid + ", status " + (payload.status || "unknown") + ").",
    };
  } catch (error) {
    return { provider: "twilio", ok: false, detail: (error as Error).message };
  }
}
