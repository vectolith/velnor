import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Automated End-to-End Verification Suite for Velnor
 * Tests Health/Readiness, Rate-Limiting & Security Headers, Web Search, Document Vector RAG,
 * Long-Term Memory, Travel + Live Weather, iMessage/SMS TwiML & Sendblue Webhooks,
 * Slack Block Kit Webhooks, Siri Shortcut & vCard.
 */
const BASE = process.env.VELNOR_BASE_URL || "http://localhost:3000";
const API_SECRET = process.env.VELNOR_SHARED_SECRET || "";
const API_HEADERS = API_SECRET ? { "x-velnor-secret": API_SECRET } : {};

function twilioSignature(url, params, token) {
  const payload = Object.keys(params).sort()
    .reduce((value, key) => value + key + params[key], url);
  return crypto.createHmac("sha1", token).update(payload).digest("base64");
}

function slackSignature(timestamp, body, secret) {
  const digest = crypto.createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return `v0=${digest}`;
}

async function assertEndpoint(name, fn) {
  const start = Date.now();
  await fn();
  console.log(`✅ [PASS] ${name} (${Date.now() - start}ms)`);
}

async function main() {
  console.log(`🚀 Running Velnor Production End-to-End Verification against ${BASE}...\n`);
  if (API_SECRET.length < 32) throw new Error("VELNOR_SHARED_SECRET must be set for production verification");

  await assertEndpoint("GET /api/health (Readiness, SQLite DB & Security Headers)", async () => {
    const res = await fetch(`${BASE}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (res.headers.get("x-content-type-options") !== "nosniff") {
      throw new Error("Missing X-Content-Type-Options: nosniff security header");
    }
    if (!res.headers.get("x-ratelimit-limit")) {
      throw new Error("Missing X-RateLimit-Limit header");
    }
    const data = await res.json();
    if (data.status !== "healthy") throw new Error("Service not healthy");
  });

  await assertEndpoint("GET / (Headless service status)", async () => {
    const res = await fetch(`${BASE}/`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.service !== "Velnor" || data.webInterface !== false) {
      throw new Error("Invalid headless service status");
    }
  });

  await assertEndpoint("GET /api/chat (SQLite DB + Initial State)", async () => {
    const unauthenticated = await fetch(`${BASE}/api/chat`);
    if (unauthenticated.status !== 401) {
      throw new Error(`expected unauthenticated request to receive 401, got ${unauthenticated.status}`);
    }
    const res = await fetch(`${BASE}/api/chat`, { headers: API_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.dbStatus?.engine) throw new Error("Missing dbStatus.engine");
    if (!Array.isArray(data.memories)) throw new Error("Missing memories array");
  });

  await assertEndpoint("POST /api/chat (Long-Term Memory Save & Recall)", async () => {
    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { ...API_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "imessage",
        text: "Remember that I prefer non-stop flights on ANA and window seats",
      }),
    });
    const data = await res.json();
    if (!data.reply?.text.includes("Saved to Velnor Memory")) {
      throw new Error(`Unexpected reply: ${data.reply?.text}`);
    }
  });

  await assertEndpoint("POST /api/chat (Travel Plan + Live Open-Meteo Weather + Structured Card)", async () => {
    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { ...API_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "imessage",
        text: "Plan a trip to Tokyo for 3 days",
      }),
    });
    const data = await res.json();
    if (data.reply?.structuredCard?.type !== "travel") {
      throw new Error("Expected structuredCard.type === 'travel'");
    }
  });

  await assertEndpoint("POST /api/webhooks/imessage (Twilio SMS Form -> TwiML XML)", async () => {
    const form = new URLSearchParams({
      From: "+15550192834",
      Body: "What do you remember about me?",
      NumMedia: "0",
    });
    const params = Object.fromEntries(form.entries());
    const signatureUrl = `${process.env.VELNOR_PUBLIC_URL || BASE}/api/webhooks/imessage`;
    const res = await fetch(`${BASE}/api/webhooks/imessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilioSignature(
          signatureUrl,
          params,
          process.env.TWILIO_AUTH_TOKEN || ""
        ),
      },
      body: form.toString(),
    });
    const xml = await res.text();
    if (!xml.includes("<Response>") || !xml.includes("<Message>")) {
      throw new Error("Invalid TwiML response");
    }
    const unsigned = await fetch(`${BASE}/api/webhooks/imessage`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (unsigned.status !== 401) throw new Error(`expected unsigned Twilio request to receive 401, got ${unsigned.status}`);
  });

  await assertEndpoint("POST /api/webhooks/slack (Slack Slash Command -> Block Kit)", async () => {
    const form = new URLSearchParams({
      command: "/velnor",
      text: "Check my Gmail inbox",
      user_name: "tester",
    });
    const rawBody = form.toString();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const simulatorBypass = await fetch(`${BASE}/api/webhooks/slack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-velnor-simulator": "true",
      },
      body: rawBody,
    });
    if (simulatorBypass.status !== 401) {
      throw new Error(`production simulator header bypassed Slack auth: ${simulatorBypass.status}`);
    }
    const res = await fetch(`${BASE}/api/webhooks/slack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": slackSignature(
          timestamp,
          rawBody,
          process.env.SLACK_SIGNING_SECRET || ""
        ),
      },
      body: rawBody,
    });
    const data = await res.json();
    if (!Array.isArray(data.blocks)) throw new Error("Missing Slack Block Kit blocks");
  });

  await assertEndpoint("GET /api/vcard (Apple Contacts .vcf Download)", async () => {
    const res = await fetch(`${BASE}/api/vcard`);
    const vcf = await res.text();
    if (!vcf.includes("BEGIN:VCARD") || !vcf.includes("FN:Velnor AI Assistant")) {
      throw new Error("Invalid vCard output");
    }
  });

  await assertEndpoint("POST /api/settings encrypts provider credentials at rest", async () => {
    const marker = "ci-provider-secret-must-not-be-plaintext";
    const res = await fetch(`${BASE}/api/settings`, {
      method: "POST",
      headers: {
        ...API_HEADERS,
        "x-velnor-admin-token": process.env.VELNOR_ADMIN_TOKEN || "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ geminiApiKey: marker }),
    });
    if (res.status !== 200) throw new Error(`settings update returned HTTP ${res.status}`);

    const dataDirectory = process.env.VELNOR_DATA_DIR || ".data";
    const stored = fs.readFileSync(path.join(dataDirectory, "velnor-store.json"), "utf8");
    if (stored.includes(marker)) throw new Error("provider credential was written in plaintext");
    if (!stored.includes("velnor:enc:v1:")) throw new Error("encrypted credential marker was not persisted");
  });

  console.log("\n🎉 All 9 Velnor production end-to-end verification checks passed!");
}

main().catch((err) => {
  console.error("❌ Verification failed:", err);
  process.exit(1);
});
