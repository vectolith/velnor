import { ChatMessage } from "../types";
import { readFailure, SendResult } from "./types";

/** Slack Block Kit rendering for a Velnor reply. */
export function buildSlackBlocks(reply: ChatMessage): Record<string, any>[] {
  const blocks: Record<string, any>[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: reply.text.replace(/\*\*(.*?)\*\*/g, "*$1*"),
      },
    },
  ];

  if (reply.toolActions && reply.toolActions.length > 0) {
    blocks.push({
      type: "context",
      elements: reply.toolActions.map((t) => ({
        type: "mrkdwn",
        text: `⚡ *${t.label}* (${t.details || t.tool})`,
      })),
    });
  }

  if (reply.citations && reply.citations.length > 0) {
    blocks.push({
      type: "context",
      elements: reply.citations.slice(0, 4).map((c) => ({
        type: "mrkdwn",
        text: `🔗 <${c.url}|${c.title}>`,
      })),
    });
  }

  return blocks;
}

export async function postSlackMessage(params: {
  botToken: string;
  channel: string;
  text: string;
  blocks?: Record<string, any>[];
  threadTs?: string;
  timeoutMs?: number;
}): Promise<SendResult> {
  if (!params.botToken || !params.channel) {
    return { provider: "slack", ok: false, detail: "Slack is not configured" };
  }
  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: params.channel,
        text: params.text,
        blocks: params.blocks,
        thread_ts: params.threadTs,
      }),
      signal: AbortSignal.timeout(params.timeoutMs ?? 12000),
    });
    if (!response.ok) {
      return { provider: "slack", ok: false, status: response.status, detail: await readFailure(response) };
    }
    // Slack answers 200 with {ok:false,error:"..."} for most failures.
    const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (payload.ok === false) {
      return { provider: "slack", ok: false, status: response.status, detail: payload.error || "slack api error" };
    }
    return { provider: "slack", ok: true, status: response.status };
  } catch (err) {
    return { provider: "slack", ok: false, detail: (err as Error).message };
  }
}
