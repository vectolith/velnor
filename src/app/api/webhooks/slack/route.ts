import { NextRequest, NextResponse } from "next/server";
import { authorizeSlackRequest, isSimulatorAllowed } from "@/lib/security/webhookAuth";
import { inboundKey, inboundWebhookCache } from "@/lib/security/idempotency";
import { buildSlackBlocks, postSlackMessage } from "@/lib/channels/slack";
import { processUserMessage } from "@/lib/ai/agent";
import { getStore, resolveUserId, withVelnorUser, resolveSlackChannel } from "@/lib/store";
import { ChatMessage } from "@/lib/types";



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
      const slackUserId = params.get("user_id") || "";
      const workspaceId = params.get("team_id") || "";
      if (!slackUserId || !workspaceId) return NextResponse.json({ error: "Missing stable Slack user/workspace identity." }, { status: 400 });
      const userName = params.get("user_name") || slackUserId;

      const reply = await withVelnorUser(resolveUserId("slack", workspaceId + ":" + slackUserId), () =>
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

    // Slack redelivers when its 3s ack is missed; drop the repeat.
    const slackDedupeKey = String(event.client_msg_id || event.event_ts || event.ts || payload.event_id || "");
    if (slackDedupeKey && !inboundWebhookCache.seen(inboundKey(["slack", slackDedupeKey]))) {
      return NextResponse.json({ ok: true, duplicate: true });
    }

    const rawText = String(event.text || "").replace(/<@[A-Z0-9]+>\s*/g, "").trim();
    const slackUserId = String(event.user || "");
    const workspaceId = String(payload.team_id || event.team || "");
    if (!slackUserId || !workspaceId) return NextResponse.json({ error: "Missing stable Slack user/workspace identity." }, { status: 400 });
    const userHandle = "@" + slackUserId;
    const slackChannelId = event.channel;

    const { reply, botToken } = await withVelnorUser(resolveUserId("slack", workspaceId + ":" + slackUserId), async () => {
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

    let deliveryResult;
    if (botToken && slackChannelId) {
      deliveryResult = await postSlackMessage({
        botToken,
        channel: slackChannelId,
        text: reply.text,
        blocks,
        threadTs: event.thread_ts || event.ts,
      });
    }

    return NextResponse.json({
      ok: true,
      channel: slackChannelId || resolveSlackChannel(state),
      text: reply.text,
      blocks,
      reply,
      delivery: deliveryResult || { ok: false },
    });
  } catch (err) {
    console.error("Slack webhook error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Slack webhook failed" },
      { status: 500 }
    );
  }
}

