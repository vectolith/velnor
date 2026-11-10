#!/usr/bin/env node
/**
 * Creates (or validates) the Velnor Agent Slack app from the manifest the server
 * already serves, so nobody has to hand-copy scopes and URLs into api.slack.com.
 *
 * Needs an app configuration token from api.slack.com/apps -> "Your App
 * Configuration Tokens" (it looks like xoxe.xoxp-...). An ordinary user or bot
 * token cannot create apps: Slack answers missing_scope.
 *
 *   SLACK_CONFIG_TOKEN=xoxe... node --import tsx scripts/create-slack-app.mjs \
 *     --base-url https://velnor-xyz-uc.a.run.app
 *
 * Slack calls the manifest's request URL while creating the app, so the base URL
 * must be the live deployment, not a placeholder.
 */
import { buildSlackManifest, buildSlackScaffoldManifest, normalizeBaseUrl } from "../src/lib/channels/slackManifest.ts";

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function readArgs(argv) {
  const args = { dryRun: false, validateOnly: false, deferEndpoints: false, baseUrl: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") args.baseUrl = argv[++i] || "";
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--validate-only") args.validateOnly = true;
    else if (arg === "--defer-endpoints") args.deferEndpoints = true;
    else fail(`unknown argument ${arg}`);
  }
  return args;
}

async function callSlack(method, token, manifest) {
  const body = new URLSearchParams({ token, manifest: JSON.stringify(manifest) });
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(20000),
  });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}

function explain(payload) {
  const errors = (payload.errors || []).map((e) => `${e.pointer || "?"}: ${e.message}`).join("; ");
  const hunks = [payload.error];
  if (payload.needed) hunks.push(`needed=${payload.needed}`);
  if (errors) hunks.push(errors);
  return hunks.filter(Boolean).join(" | ") || `http ${payload.status ?? ""}`;
}

const args = readArgs(process.argv.slice(2));
const baseUrl = normalizeBaseUrl(args.baseUrl || process.env.VELNOR_BASE_URL || "");
if (!args.deferEndpoints) {
  if (!baseUrl) fail("pass --base-url https://your-deployment (or VELNOR_BASE_URL)");
  if (!/^https:\/\//.test(baseUrl)) fail(`base url must be https, got ${baseUrl}`);
}
if (!args.dryRun && !args.validateOnly && !process.env.SLACK_CONFIG_TOKEN) {
  fail("SLACK_CONFIG_TOKEN is not set; generate an app configuration token at api.slack.com/apps");
}

const manifest = args.deferEndpoints ? buildSlackScaffoldManifest() : buildSlackManifest(baseUrl);

if (args.dryRun) {
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(0);
}

const token = process.env.SLACK_CONFIG_TOKEN;
const method = args.validateOnly ? "apps.manifest.validate" : "apps.manifest.create";
const { payload } = await callSlack(method, token, manifest);

if (payload.ok !== true) fail(`${method} was refused: ${explain(payload)}`);

if (args.validateOnly) {
  console.log(`manifest is valid${args.deferEndpoints ? " (endpoints deferred)" : ` for ${baseUrl}`}`);
  process.exit(0);
}

const credentials = payload.credentials || {};
console.log(`created app ${payload.app_id}${args.deferEndpoints ? " (endpoints deferred until the deployment URL is known)" : ` for ${baseUrl}`}`);
if (credentials.client_id) {
  const scopes = manifest.oauth_config.scopes.bot.join(",");
  console.log(`install: https://slack.com/oauth/v2/authorize?client_id=${credentials.client_id}&scope=${encodeURIComponent(scopes)}`);
}
console.log("next: install the app, then set SLACK_BOT_TOKEN (xoxb-) and SLACK_SIGNING_SECRET on the deployment, and invite the bot to the channel");
