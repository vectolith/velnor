import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = path.resolve("scripts/preflight-deploy.mjs");

function runPreflight(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-preflight-"));
  const env = {
    ...process.env,
    NODE_ENV: "production",
    VELNOR_SHARED_SECRET: "a".repeat(48),
    VELNOR_SECRET_KEY: "b".repeat(48),
    VELNOR_ADMIN_TOKEN: "c".repeat(48),
    CRON_SECRET: "d".repeat(48),
    VELNOR_PUBLIC_URL: "https://api.example.test",
    VELNOR_DATA_DIR: path.join(root, "data"),
    GEMINI_API_KEY: "test-model-key",
    SLACK_SIGNING_SECRET: "e".repeat(48),
    ...overrides,
  };
  try {
    return spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("production preflight accepts complete secure configuration", () => {
  const result = runPreflight();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /configuration and writable data directory verified/);
});

test("production preflight rejects missing credentials and non-HTTPS origins", () => {
  const result = runPreflight({
    VELNOR_SHARED_SECRET: "",
    VELNOR_PUBLIC_URL: "http://api.example.test",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /VELNOR_SHARED_SECRET must be set/);
  assert.match(result.stderr, /canonical HTTPS origin/);
});

test("production preflight rejects unconfigured providers and inaccessible storage", () => {
  const result = runPreflight({
    GEMINI_API_KEY: "",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    SLACK_SIGNING_SECRET: "",
    TWILIO_AUTH_TOKEN: "",
    SENDBLUE_WEBHOOK_SECRET: "",
    LOOPMESSAGE_WEBHOOK_SECRET: "",
    VELNOR_DATA_DIR: path.resolve("package.json"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at least one production model provider/);
  assert.match(result.stderr, /at least one inbound messaging webhook/);
  assert.match(result.stderr, /VELNOR_DATA_DIR must be writable by the application user/);
});
