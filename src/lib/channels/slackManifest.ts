/**
 * The Slack app a workspace needs in order to talk to velnor.
 *
 * Kept in one place so the manifest served to an operator and the scopes the code
 * assumes cannot drift apart: the webhook route needs signing verification, the
 * agent posts replies into a channel, and slash commands arrive on the same URL.
 */
export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "commands",
  "files:read",
  "im:history",
  "im:read",
  "im:write",
  "users:read",
] as const;

export const SLACK_EVENTS = ["app_mention", "message.im"] as const;

export function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || "").trim().replace(/\/+$/, "");
}

export function buildSlackManifest(baseUrl: string) {
  const base = normalizeBaseUrl(baseUrl) || "https://your-velnor-domain.run.app";
  const webhook = `${base}/api/webhooks/slack`;

  return {
    display_information: {
      name: "velnor",
      description: "Headless personal AI agent for iMessage, SMS, Siri and Slack",
      background_color: "#0d111a",
    },
    features: {
      bot_user: {
        display_name: "velnor",
        always_online: true,
      },
      slash_commands: [
        {
          command: "/velnor",
          url: webhook,
          description: "Ask velnor anything: web search, documents, Gmail, Calendar, trips",
          usage_hint: "[ask anything, e.g. summarize my unread emails]",
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: [...SLACK_BOT_SCOPES],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: webhook,
        bot_events: [...SLACK_EVENTS],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/**
 * Slack replies with terse codes; the two an operator actually hits deserve an
 * instruction rather than a raw string in the log.
 */
export function explainSlackError(error: string | undefined): string {
  switch ((error || "").trim()) {
    case "channel_not_found":
      return "channel_not_found: create the channel, invite the app to it, or set slackChannel in /api/settings to one that exists";
    case "not_in_channel":
      return "not_in_channel: invite the velnor app to that channel with /invite @velnor";
    case "invalid_auth":
    case "not_authed":
      return "Slack rejected the bot token; reinstall the app and copy the fresh xoxb- token into settings";
    case "missing_scope":
      return "the app is missing a bot scope; update the manifest at api.slack.com/apps and reinstall";
    default:
      return error || "Slack returned no error code";
  }
}

/**
 * The app without its endpoint wiring: no event subscription and no slash command.
 * Slack calls request_url while the app is created, so an app cannot be created
 * before its deployment is reachable. Create with this, install it, then add the
 * endpoints with apps.manifest.update once the deployment URL is known.
 */
export function buildSlackScaffoldManifest() {
  const full = buildSlackManifest("https://pending.example.com");
  const { event_subscriptions, ...settings } = full.settings;
  const { slash_commands, ...features } = full.features;
  return {
    display_information: full.display_information,
    features,
    oauth_config: full.oauth_config,
    settings,
  };
}
