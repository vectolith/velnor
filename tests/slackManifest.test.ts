import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSlackScaffoldManifest, buildSlackManifest, explainSlackError, normalizeBaseUrl, SLACK_BOT_SCOPES } from "../src/lib/channels/slackManifest";

test("the manifest names the product Velnor Agent and points every surface at one webhook", () => {
  const m = buildSlackManifest("https://velnor.example.com/");
  assert.equal(m.display_information.name, "Velnor Agent");
  assert.equal(m.features.bot_user.display_name, "Velnor Agent");
  assert.equal(m.settings.event_subscriptions.request_url, "https://velnor.example.com/api/webhooks/slack");
  assert.equal(m.features.slash_commands[0].url, "https://velnor.example.com/api/webhooks/slack");
  assert.deepEqual(m.settings.event_subscriptions.bot_events, ["app_mention", "message.im"]);
});

test("the scopes cover what the code actually calls", () => {
  const bot: string[] = buildSlackManifest("https://x.dev").oauth_config.scopes.bot;
  // posting replies, reading threads, slash commands, and files the agent summarises
  for (const scope of ["chat:write", "chat:write.public", "channels:history", "commands", "files:read", "app_mentions:read"]) {
    assert.ok(bot.includes(scope), `missing ${scope}`);
  }
  assert.deepEqual(bot, [...SLACK_BOT_SCOPES]);
});

test("an empty base URL falls back instead of emitting a relative webhook", () => {
  assert.equal(normalizeBaseUrl("   "), "");
  const m = buildSlackManifest("");
  assert.ok(m.settings.event_subscriptions.request_url.startsWith("https://"));
});

test("the errors an operator actually hits are explained, not echoed raw", () => {
  assert.match(explainSlackError("channel_not_found"), /slackChannel|invite/i);
  assert.match(explainSlackError("not_in_channel"), /invite/i);
  assert.match(explainSlackError("invalid_auth"), /bot token/i);
  assert.equal(explainSlackError(undefined), "Slack returned no error code");
});

test("the scaffold manifest leaves out what Slack verifies at creation", () => {
  const scaffold = buildSlackScaffoldManifest();
  assert.equal(scaffold.display_information.name, "Velnor Agent");
  assert.deepEqual(scaffold.oauth_config.scopes.bot.length > 5, true);
  assert.equal("event_subscriptions" in scaffold.settings, false);
  assert.equal("slash_commands" in scaffold.features, false);
  // the pieces that need no endpoint stay intact
  assert.equal(scaffold.features.bot_user.always_online, true);
});
