import { after, NextRequest, NextResponse } from "next/server";
import { processUserMessage } from "@/lib/ai/agent";
import { resolveUserId, withVelnorTenantScope } from "@/lib/store";
import { verifyDiscordInteractionSignature } from "@/lib/security/discordAuth";
import { inboundKey, inboundWebhookCache } from "@/lib/security/idempotency";
import { PayloadTooLargeError, readRequestBodyLimited } from "@/lib/security/requestBody";

export const runtime = "nodejs";
export const maxDuration = 60;

function findPrompt(options: unknown): string {
  if (!Array.isArray(options)) return "";
  for (const option of options) {
    if (!option || typeof option !== "object") continue;
    const value = option as Record<string, unknown>;
    if (typeof value.value === "string" &&
        ["prompt", "message", "text", "request"].includes(String(value.name || "").toLowerCase())) {
      return value.value.trim();
    }
    const nested = findPrompt(value.options);
    if (nested) return nested;
  }
  return "";
}

export async function POST(req: NextRequest) {
  let rawBody: string;
  try {
    rawBody = await readRequestBodyLimited(req, 256 * 1024);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return NextResponse.json({ error: error.message }, { status: 413 });
    return NextResponse.json({ error: "Could not read Discord interaction." }, { status: 400 });
  }

  const discordPublicKey = process.env.DISCORD_PUBLIC_KEY || "";
  if (!discordPublicKey) return NextResponse.json({ error: "Discord interactions are not configured." }, { status: 503 });
  const valid = verifyDiscordInteractionSignature({
    publicKey: discordPublicKey,
    signature: req.headers.get("x-signature-ed25519"),
    timestamp: req.headers.get("x-signature-timestamp"),
    rawBody,
  });
  if (!valid) return NextResponse.json({ error: "Invalid or stale Discord interaction signature." }, { status: 401 });

  let payload: Record<string, any>;
  try { payload = JSON.parse(rawBody); }
  catch { return NextResponse.json({ error: "Invalid Discord interaction JSON." }, { status: 400 }); }

  if (payload.type === 1) return NextResponse.json({ type: 1 });
  if (payload.type !== 2) return NextResponse.json({ error: "Unsupported Discord interaction type." }, { status: 400 });

  const commandName = String(payload.data?.name || "").toLowerCase();
  if (commandName !== "ask" && commandName !== "velnor") {
    return NextResponse.json({ type: 4, data: { content: "Use /ask to send a request to VELNOR.", flags: 64 } });
  }
  const interactionId = String(payload.id || "");
  const applicationId = String(payload.application_id || "");
  const token = String(payload.token || "");
  const userId = String(payload.member?.user?.id || payload.user?.id || "");
  const guildId = String(payload.guild_id || "dm");
  const prompt = findPrompt(payload.data?.options).slice(0, 8000);
  if (!/^\d{17,20}$/.test(interactionId) || !/^\d{17,20}$/.test(applicationId) ||
      !/^\d{17,20}$/.test(userId) || !/^[A-Za-z0-9._-]{20,200}$/.test(token)) {
    return NextResponse.json({ error: "Discord interaction is missing a valid application, user, or token identity." }, { status: 400 });
  }
  if (!prompt) return NextResponse.json({ type: 4, data: { content: "Use /ask with a prompt.", flags: 64 } });
  if (!inboundWebhookCache.seen(inboundKey(["discord", interactionId]))) {
    return NextResponse.json({ type: 5, data: { flags: 64 } });
  }

  after(async () => {
    const endpoint = "https://discord.com/api/v10/webhooks/" +
      encodeURIComponent(applicationId) + "/" + encodeURIComponent(token) + "/messages/@original";
    try {
      const reply = await withVelnorTenantScope(resolveUserId("discord", guildId + ":" + userId), async () => {
        const result = await processUserMessage({
          channel: "discord",
          userHandle: userId,
          text: prompt,
        });
        return result.text;
      });
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: reply.slice(0, 2000), allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error("Discord rejected the interaction response (" + response.status + ").");
    } catch (error) {
      console.error("Discord interaction processing failed:", error);
      try {
        await fetch(endpoint, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "VELNOR could not complete that request. Please try again.", allowed_mentions: { parse: [] } }),
          signal: AbortSignal.timeout(8_000),
        });
      } catch (deliveryError) {
        console.error("Discord interaction error response failed:", deliveryError);
      }
    }
  });

  return NextResponse.json({ type: 5, data: { flags: 64 } });
}
