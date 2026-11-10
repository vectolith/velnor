import { NextRequest, NextResponse } from "next/server";
import { authorizeSlackRequest, isSimulatorAllowed } from "@/lib/security/webhookAuth";
import { processUserMessage } from "@/lib/ai/agent";
import { getStore, resolveUserId, withVelnorUser } from "@/lib/store";
import { ChatMessage } from "@/lib/types";


function buildSlackBlocks(reply: ChatMessage) {
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

/**
 * Slack Bot Webhook Endpoint
 * Supports:
 * 1. Events API url_verification challenge
 * 2. Events API event_callback (message.im, app_mention)
 * 3. Slash Commands (/velnor <prompt> via application/x-www-form-urlencoded)
 */
export async function POST(req: NextRequest) {
  const state = getStore();
  const contentType = req.headers.get("content-type") || "";
  const rawBody = await req.text();

  const signingSecret =
    state.config.slackSigningSecret || process.env.SLACK_SIGNING_SECRET || "";
  const isLocalSimulator = isSimulatorAllowed(req.headers.get("x-velnor-simulator"));

  const slackDecision = authorizeSlackRequest({
    signingSecret,
    rawBody,
    timestamp: req.headers.get("x-slack-request-timestamp"),
    signature: req.headers.get("x-slack-signature"),
    simulator: isLocalSimulator,
  });
  if (!slackDecision.ok) {
    return NextResponse.json(
      { error: slackDecision.error },
      { status: slackDecision.status ?? 401 }
    );
  }

  try {
    // 1. SLACK SLASH COMMAND (/velnor)
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(rawBody);
      const commandText = params.get("text") || "Help";
      const userName = params.get("user_name") || "slack-user";

      const reply = await withVelnorUser(resolveUserId("slack", "@" + userName), () =>
        processUserMessage({
          channel: "slack",
          userHandle: "@" + userName,
          text: commandText,
        })
      );

      return NextResponse.json({
        response_type: "in_channel",
        text: reply.text,
        blocks: buildSlackBlocks(reply),
      });
    }

    // 2. SLACK EVENTS API JSON PAYLOAD
    const payload = JSON.parse(rawBody || "{}");

    // URL Verification Challenge
    if (payload.type === "url_verification") {
      return NextResponse.json({ challenge: payload.challenge });
    }

    const event = payload.event || payload;
    // Ignore bot's own messages to prevent loops
    if (event.bot_id || event.subtype === "bot_message") {
      return NextResponse.json({ ok: true, ignored: "bot_message" });
    }

    const rawText = String(event.text || "").replace(/<@[A-Z0-9]+>\s*/g, "").trim();
    const userHandle = event.user ? `@${event.user}` : "@slack-user";
    const slackChannelId = event.channel;

    const { reply, botToken } = await withVelnorUser(resolveUserId("slack", userHandle), async () => {
      const reply = await processUserMessage({
        channel: "slack",
        userHandle,
        text: rawText || "Hello Velnor!",
      });
      return {
        reply,
        botToken: getStore().config.slackBotToken || process.env.SLACK_BOT_TOKEN,
      };
    });

    const blocks = buildSlackBlocks(reply);

    if (botToken && slackChannelId) {
      fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: slackChannelId,
          text: reply.text,
          blocks,
          thread_ts: event.thread_ts || event.ts,
        }),
      }).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      channel: slackChannelId || "#velnor-assistant",
      text: reply.text,
      blocks,
      reply,
    });
  } catch (err) {
    console.error("Slack webhook error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Slack webhook failed" },
      { status: 500 }
    );
  }
}

