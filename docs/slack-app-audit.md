# VELNOR Slack app audit

Reviewed: `src/lib/channels/slackManifest.ts`, `src/lib/channels/slack.ts`,
`src/lib/security/webhookAuth.ts`, `src/lib/store.ts`.

## What is right

1. The manifest is generated from one source of truth, so the scopes the operator
   installs and the scopes the code assumes cannot drift.
2. Requests are verified with the signing secret and a 300 second clock skew window
   (`SLACK_MAX_SKEW_SECONDS`), and a missing secret is a 503 rather than an open door.
3. Both `app_mention` and `message.im` are subscribed, which is what a direct-message
   product needs.

## Findings

1. **`chat:write.public` is broader than necessary.** It lets the bot post to any public
   channel it has not joined. Unless posting to arbitrary channels is a product feature,
   drop it and rely on `chat:write` in channels the app is invited to. Risk: medium,
   because a token leak becomes spam capability across the workspace.
2. **No `app_uninstalled` / `tokens_revoked` handling.** When an admin uninstalls the
   app the stored bot token keeps being used and fails silently. Subscribe to
   `app_uninstalled` and `tokens_revoked` and clear the workspace token on receipt.
3. **No `files:write`.** `files:read` is requested, so attachments can be read but
   artefacts the agent produces cannot be uploaded. Either add it deliberately or drop
   `files:read` if reading files is not implemented.
4. **Slash commands share the events URL.** Slack requires a response within 3 seconds;
   if the handler runs the agent inline, the command times out. Acknowledge first, then
   process. Verify this in the route before shipping the command.
5. **Channel default is hard-coded** to `#velnor-agent` in `src/lib/store.ts`. Fine, but
   it means a workspace without that channel silently posts nowhere; surface the failure.

## Recommended manifest changes

- Remove `chat:write.public` unless arbitrary-channel posting is required.
- Decide on `files:read` / `files:write` together, not one without the other.
- Add `app_uninstalled` and `tokens_revoked` to `SLACK_EVENTS`.
