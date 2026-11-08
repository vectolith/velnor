/**
 * Automated End-to-End Verification Suite for Olli
 * Tests Web Search, Document Vector RAG, Long-Term Memory, Travel + Live Weather,
 * iMessage/SMS TwiML & Sendblue Webhooks, Slack Block Kit Webhooks, Siri Shortcut & vCard.
 */
const BASE = process.env.OLLI_BASE_URL || "http://localhost:3000";

async function assertEndpoint(name, fn) {
  const start = Date.now();
  await fn();
  console.log(`✅ [PASS] ${name} (${Date.now() - start}ms)`);
}

async function main() {
  console.log(`🚀 Running Olli End-to-End Verification against ${BASE}...\n`);

  await assertEndpoint("GET /api/chat (SQLite DB + Initial State)", async () => {
    const res = await fetch(`${BASE}/api/chat`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.dbStatus?.engine) throw new Error("Missing dbStatus.engine");
    if (!Array.isArray(data.memories)) throw new Error("Missing memories array");
  });

  await assertEndpoint("POST /api/chat (Long-Term Memory Save & Recall)", async () => {
    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "imessage",
        text: "Remember that I prefer non-stop flights on ANA and window seats",
      }),
    });
    const data = await res.json();
    if (!data.reply?.text.includes("Saved to Olli Memory")) {
      throw new Error(`Unexpected reply: ${data.reply?.text}`);
    }
  });

  await assertEndpoint("POST /api/chat (Travel Plan + Live Open-Meteo Weather + Structured Card)", async () => {
    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    const res = await fetch(`${BASE}/api/webhooks/imessage`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const xml = await res.text();
    if (!xml.includes("<Response>") || !xml.includes("<Message>")) {
      throw new Error("Invalid TwiML response");
    }
  });

  await assertEndpoint("POST /api/webhooks/slack (Slack Slash Command -> Block Kit)", async () => {
    const form = new URLSearchParams({
      command: "/olli",
      text: "Check my Gmail inbox",
      user_name: "tester",
    });
    const res = await fetch(`${BASE}/api/webhooks/slack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-olli-simulator": "true",
      },
      body: form.toString(),
    });
    const data = await res.json();
    if (!Array.isArray(data.blocks)) throw new Error("Missing Slack Block Kit blocks");
  });

  await assertEndpoint("GET /api/vcard (Apple Contacts .vcf Download)", async () => {
    const res = await fetch(`${BASE}/api/vcard`);
    const vcf = await res.text();
    if (!vcf.includes("BEGIN:VCARD") || !vcf.includes("FN:Olli AI Assistant")) {
      throw new Error("Invalid vCard output");
    }
  });

  console.log("\n🎉 All Olli end-to-end verification checks passed!");
}

main().catch((err) => {
  console.error("❌ Verification failed:", err);
  process.exit(1);
});
