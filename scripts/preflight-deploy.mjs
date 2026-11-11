#!/usr/bin/env node
/**
 * Deployment preflight.
 *
 * Velnor fails closed, so a deployment missing a secret does not "mostly work":
 * every state-touching route answers 503 and credentials cannot be sealed. This
 * checks the environment before anything is shipped.
 *
 * Usage: node scripts/preflight-deploy.mjs
 * Exit 1 with a list of problems, exit 0 when the configuration is deployable.
 */

const REQUIRED = [
  ["VELNOR_SHARED_SECRET", "protects state-changing control-plane routes"],
  ["VELNOR_TENANT_TOKEN_SECRET", "verifies short-lived per-user identity tokens"],
  ["VELNOR_SECRET_KEY", "seals provider keys at rest; without it keys are never written"],
  ["CRON_SECRET", "authorises /api/cron/reminders"],
];

const RECOMMENDED = [
  ["VELNOR_DATA_DIR", "point this at a mounted volume, or state dies with the container"],
  ["VELNOR_PUBLIC_URL", "recommended so OAuth callback URLs are stable behind reverse proxies"],
  ["TWILIO_AUTH_TOKEN", "without it the Twilio webhook returns 503"],
  ["SLACK_SIGNING_SECRET", "without it the Slack webhook returns 503"],
  ["SLACK_BOT_TOKEN", "the bot cannot post into the channel without it"],
  ["SENDBLUE_WEBHOOK_SECRET", "required for Sendblue JSON webhooks in production"],
  ["LOOPMESSAGE_WEBHOOK_SECRET", "must match the Authorization header configured on the LoopMessage webhook"],
  ["LOOPMESSAGE_AUTH_KEY", "required for outbound LoopMessage messages"],
];

const problems = [];
const warnings = [];

for (const [name, why] of REQUIRED) {
  const value = (process.env[name] || "").trim();
  if (!value) problems.push(`${name} is missing — ${why}`);
  else if (name === "VELNOR_SECRET_KEY" && value.length < 16) {
    problems.push(`VELNOR_SECRET_KEY is only ${value.length} characters; use 32+ random characters`);
  } else if (name === "VELNOR_TENANT_TOKEN_SECRET" && value.length < 32) {
    problems.push("VELNOR_TENANT_TOKEN_SECRET must contain at least 32 characters");
  }
}

for (const [name, why] of RECOMMENDED) {
  if (!(process.env[name] || "").trim()) warnings.push(`${name} is not set — ${why}`);
}

const allowlist = (process.env.VELNOR_EMAIL_ALLOWLIST || "").trim();
if (allowlist) {
  const bad = allowlist.split(",").map((e) => e.trim()).filter((e) => e && !/^@?[^\s@]+(\.|\@)/.test(e));
  if (bad.length) problems.push(`VELNOR_EMAIL_ALLOWLIST has unusable entries: ${bad.join(", ")}`);
}

if (process.env.NODE_ENV && process.env.NODE_ENV !== "production") {
  warnings.push(`NODE_ENV is "${process.env.NODE_ENV}", not production`);
}

for (const warning of warnings) console.warn(`warn   ${warning}`);

if (problems.length) {
  for (const problem of problems) console.error(`fail   ${problem}`);
  console.error(`\n${problems.length} problem(s). Refusing to continue.`);
  process.exit(1);
}

console.log("ok     deployment environment is complete");
