import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const baseUrl =
    req.nextUrl.searchParams.get("baseUrl") ||
    req.nextUrl.origin ||
    "https://your-olli-domain.run.app";

  const slackManifest = {
    display_information: {
      name: "Olli",
      description: "Personal AI assistant for Web Search, Docs, Gmail, Calendar & Travel",
      background_color: "#0d111a",
    },
    features: {
      bot_user: {
        display_name: "Olli",
        always_online: true,
      },
      slash_commands: [
        {
          command: "/olli",
          url: `${baseUrl}/api/webhooks/slack`,
          description: "Ask Olli anything (search, summarize docs, check Gmail/Calendar, plan trips)",
          usage_hint: "[ask anything, e.g. summarize my unread emails]",
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "channels:history",
          "chat:write",
          "commands",
          "files:read",
          "im:history",
          "im:read",
          "im:write",
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: `${baseUrl}/api/webhooks/slack`,
        bot_events: ["app_mention", "message.im"],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };

  return NextResponse.json({
    baseUrl,
    imessageWebhookUrl: `${baseUrl}/api/webhooks/imessage`,
    slackWebhookUrl: `${baseUrl}/api/webhooks/slack`,
    siriShortcutUrl: `${baseUrl}/api/siri`,
    cronRemindersUrl: `${baseUrl}/api/cron/reminders`,
    slackManifest,
  });
}
