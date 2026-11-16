#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const problems = [];

function requiredSecret(name, minimumLength = 32) {
  const value = (process.env[name] || "").trim();
  if (value.length < minimumLength) {
    problems.push(`${name} must be set to at least ${minimumLength} characters`);
  }
  return value;
}

if (process.env.NODE_ENV !== "production") {
  problems.push("NODE_ENV must be production");
}

for (const name of [
  "VELNOR_SHARED_SECRET",
  "VELNOR_SECRET_KEY",
  "VELNOR_ADMIN_TOKEN",
  "CRON_SECRET",
]) {
  requiredSecret(name);
}

const publicUrl = process.env.VELNOR_PUBLIC_URL || "";
try {
  const parsed = new URL(publicUrl);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    problems.push("VELNOR_PUBLIC_URL must be a canonical HTTPS origin");
  }
} catch {
  problems.push("VELNOR_PUBLIC_URL must be a canonical HTTPS origin");
}

const dataDirectory = process.env.VELNOR_DATA_DIR || "";
if (!dataDirectory) {
  problems.push("VELNOR_DATA_DIR must point to a durable mounted directory");
} else {
  try {
    const resolved = path.resolve(dataDirectory);
    fs.mkdirSync(resolved, { recursive: true });
    const probe = path.join(resolved, `.velnor-write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok", { flag: "wx", mode: 0o600 });
    fs.unlinkSync(probe);
  } catch {
    problems.push("VELNOR_DATA_DIR must be writable by the application user");
  }
}

if (!["GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"].some((key) => (process.env[key] || "").trim())) {
  problems.push("Configure at least one production model provider API key");
}

const webhookSecrets = [
  "TWILIO_AUTH_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SENDBLUE_WEBHOOK_SECRET",
  "LOOPMESSAGE_WEBHOOK_SECRET",
].map((name) => [name, (process.env[name] || "").trim()]);
const configuredWebhook = webhookSecrets.some(([, value]) => value);
if (!configuredWebhook) {
  problems.push("Configure authentication for at least one inbound messaging webhook");
}
for (const [name, value] of webhookSecrets) {
  if (value && value.length < 32) {
    problems.push(`${name} must contain at least 32 characters when configured`);
  }
}

if (problems.length) {
  for (const problem of problems) console.error(`fail   ${problem}`);
  console.error(`\n${problems.length} production configuration issue(s); refusing to start.`);
  process.exit(1);
}

console.log("ok     Velnor production configuration and writable data directory verified");
