import { after, NextRequest, NextResponse } from "next/server";
import { getStore, resolveUserId, withVelnorUser } from "@/lib/store";
import { processUserMessage } from "@/lib/ai/agent";
import { postSlackMessage } from "@/lib/channels/slack";
import { authorizeSlackRequest } from "@/lib/security/webhookAuth";
import { inboundWebhookCache, inboundKey } from "@/lib/security/idempotency";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const state = getStore();
    const signingSecret = state.config.slackSigningSecret || process.env.SLACK_SIGNING_SECRET || "";

    if (!authorizeSlackRequest({
      signingSecret,
      timestamp: req.headers.get("x-slack-request-timestamp"),
      signature: req.headers.get("x-slack-signature"),
      rawBody,
      simulator: false,
    })) {
      return NextResponse.json({ error: "Unauthorized: invalid Slack signature" }, { status: 401 });
    }

    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(rawBody);
      const text = params.get("text") || "";
      const slackUserId = params.get("user_id") || "";
      const workspaceId = params.get("team_id") || "";
      const channelId = params.get("channel_id") || "";
      const responseUrl = params.get("response_url") || "";
      if (!slackUserId || !workspaceId || !channelId) {
        return NextResponse.json({ error: "Slack command is missing its stable user, workspace, or channel identity." }, { status: 400 });
      }

      after(async () => {
        try {
          const result = await withVelnorUser(resolveUserId("slack", workspaceId + ":" + slackUserId), async () => {
            const message = await processUserMessage({
              text,
              channel: "slack",
              userHandle: "@" + slackUserId,
            });
            const scoped = getStore();
            return { reply: message.text, botToken: scoped.config.slackBotToken || process.env.SLACK_BOT_TOKEN || "" };
          });
          if (responseUrl) {
            const parsed = new URL(responseUrl);
            if (parsed.protocol !== "https:" || parsed.hostname !== "hooks.slack.com") {
              throw new Error("Slack response_url host is not trusted.");
            }
            const response = await fetch(parsed, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ response_type: "ephemeral", text: result.reply }),
              signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) throw new Error("Slack response_url rejected the response (" + response.status + ").");
          } else if (result.botToken) {
            await postSlackMessage({ botToken: result.botToken, channel: channelId, text: result.reply });
          } else {
            throw new Error("No Slack bot token or response_url is available for command delivery.");
          }
        } catch (error) {
          console.error("Slack slash command processing failed:", error);
        }
      });

      return NextResponse.json({
        response_type: "ephemeral",
        text: "Velnor is processing your request.",
      });
    }

    const payload = JSON.parse(rawBody);
    if (payload.type === "url_verification") {
      return NextResponse.json({ challenge: payload.challenge });
    }
    if (payload.type !== "event_callback") {
      return NextResponse.json({ ok: true, ignored: "unsupported_payload" });
    }

    const event = payload.event || {};
    const isDirectMessage = event.type === "message" && event.channel_type === "im";
    const isAppMention = event.type === "app_mention";
    if ((!isDirectMessage && !isAppMention) || event.subtype || event.bot_id) {
      return NextResponse.json({ ok: true, ignored: "unsupported_event" });
    }

    const slackUserId = String(event.user || "");
    const workspaceId = String(payload.team_id || event.team || "");
    const slackChannelId = String(event.channel || "");
    if (!slackUserId || !workspaceId || !slackChannelId) {
      return NextResponse.json({ error: "Slack event is missing its stable user, workspace, or channel identity." }, { status: 400 });
    }

    const eventId = String(payload.event_id || event.client_msg_id || event.ts || "");
    const dedupeKey = inboundKey(["slack", workspaceId, eventId]);
    if (eventId && !inboundWebhookCache.seen(dedupeKey)) {
      return NextResponse.json({ ok: true, duplicate: true });
    }

    const rawText = String(event.text || "").replace(/<@[A-Z0-9]+>\\s*/g, "").trim();
    const threadTs = event.thread_ts || event.ts;

    after(async () => {
      try {
        const result = await withVelnorUser(resolveUserId("slack", workspaceId + ":" + slackUserId), async () => {
          const reply = await processUserMessage({
            text: rawText,
            channel: "slack",
            userHandle: "@" + slackUserId,
          });
          const scoped = getStore();
          return { reply, botToken: scoped.config.slackBotToken || process.env.SLACK_BOT_TOKEN || "" };
        });
        if (!result.botToken) throw new Error("No Slack bot token is configured for this tenant.");
        const delivery = await postSlackMessage({
          botToken: result.botToken,
          channel: slackChannelId,
          text: result.reply,
          threadTs,
        });
        if (!delivery.ok) throw new Error(delivery.detail || "Slack message delivery failed.");
      } catch (error) {
        console.error("Slack event processing or delivery failed:", error);
      }
    });

    return NextResponse.json({ ok: true, accepted: true });
  } catch (error) {
    console.error("Slack webhook error:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
