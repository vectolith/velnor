export interface SendResult {
  provider: "sendblue" | "loopmessage" | "slack" | "twilio";
  ok: boolean;
  status?: number;
  detail?: string;
}

/** Read an error body without letting a broken stream mask the failure. */
export async function readFailure(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 200);
  } catch {
    return "";
  }
}
