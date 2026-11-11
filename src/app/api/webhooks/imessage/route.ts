import crypto from "crypto";
import { after, NextRequest, NextResponse } from "next/server";
import { inboundKey, inboundWebhookCache } from "@/lib/security/idempotency";
import { sendSendblueMessage } from "@/lib/channels/sendblue";
import { sendLoopMessage } from "@/lib/channels/loopmessage";
import {
  authorizeJsonWebhook,
  authorizeTwilioRequest,
  isSimulatorAllowed,
  publicRequestUrl,
} from "@/lib/security/webhookAuth";
import { processUserMessage } from "@/lib/ai/agent";
import { getStore, resolveUserId, withVelnorUser } from "@/lib/store";
import { splitForSms, toPlainText } from "@/lib/format";
import { Attachment } from "@/lib/types";

const MAX_INPUT_CHARS = 8000;

export const runtime = "nodejs";
export const maxDuration = 60;

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}


/**
 * Unified SMS & Apple iMessage Webhook Endpoint
 * Supports:
 * 1. Twilio Programmable SMS/MMS (application/x-www-form-urlencoded -> returns TwiML XML)
 * 2. Sendblue iMessage API (application/json: { number, content, media_url })
 * 3. LoopMessage iMessage API (application/json: { recipient, text, attachments })
 */
export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") || "";
  const state = getStore();
  const isLocalSimulator = isSimulatorAllowed(req.headers.get("x-velnor-simulator"));
  let jsonPayload: any;

  try {
    if (contentType.includes("application/json")) {
      const rawJsonBody = await req.text();
      try {
        jsonPayload = JSON.parse(rawJsonBody);
      } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      // Each provider must prove possession of its own webhook secret. A
      // LoopMessage secret must never authenticate a Sendblue callback (or vice versa).
      const isLoopMessage = Boolean(jsonPayload.contact) || jsonPayload.event === "message_inbound";
      const expectedSecret = isLoopMessage
        ? process.env.LOOPMESSAGE_WEBHOOK_SECRET
        : process.env.SENDBLUE_WEBHOOK_SECRET;
      const provided = isLoopMessage
        ? req.headers.get("authorization") || req.headers.get("x-velnor-webhook-secret")
        : req.headers.get("sb-signing-secret") || req.headers.get("x-velnor-webhook-secret");
      const jsonDecision = authorizeJsonWebhook({
        secrets: [expectedSecret],
        provided,
        simulator: isLocalSimulator,
      });
      if (!jsonDecision.ok) {
        return NextResponse.json(
          { error: jsonDecision.error },
          { status: jsonDecision.status ?? 401 }
        );
      }
    }

    // =========================================================================
    // 1. TWILIO SMS / MMS WEBHOOK (application/x-www-form-urlencoded)
    // =========================================================================
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await req.formData();
      const paramsMap: Record<string, string> = {};
      formData.forEach((val, key) => {
        paramsMap[key] = String(val);
      });

      const twilioAuthToken =
        state.config.twilioAuthToken || process.env.TWILIO_AUTH_TOKEN;
      const twilioDecision = authorizeTwilioRequest({
        authToken: twilioAuthToken,
        signature: req.headers.get("x-twilio-signature"),
        url: publicRequestUrl(req),
        params: paramsMap,
        simulator: isLocalSimulator,
      });
      if (!twilioDecision.ok) {
        return NextResponse.json(
          { error: twilioDecision.error },
          { status: twilioDecision.status ?? 401 }
        );
      }

      const from = String(formData.get("From") || "").slice(0, 64);
      const to = String(formData.get("To") || "").slice(0, 64);
      if (!from || !to) return NextResponse.json({ error: "Twilio webhook is missing sender or destination identity." }, { status: 400 });
      // Twilio retries on slow responses; do not run the agent twice for one SMS.
      const twilioMessageId = String(formData.get("MessageSid") || formData.get("SmsSid") || "");
      if (twilioMessageId && !inboundWebhookCache.seen(inboundKey(["twilio", twilioMessageId]))) {
        return new NextResponse("<Response></Response>", {
          status: 200,
          headers: { "content-type": "text/xml" },
        });
      }
      const body = String(formData.get("Body") || "")
        .trim()
        .slice(0, MAX_INPUT_CHARS);
      const numMedia = Math.min(Number(formData.get("NumMedia") || "0"), 5);

      const attachments: Attachment[] = [];
      for (let i = 0; i < numMedia; i++) {
        const mediaUrl = String(formData.get(`MediaUrl${i}`) || "");
        const mediaType = String(
          formData.get(`MediaContentType${i}`) || "image/jpeg"
        );
        if (mediaUrl) {
          attachments.push({
            id: `tw-media-${Date.now()}-${i}`,
            name: `MMS_Attachment_${i + 1}`,
            mimeType: mediaType,
            type: mediaType.startsWith("image/") ? "image" : "document",
            dataUrl: mediaUrl,
          });
        }
      }

      const reply = await withVelnorUser(resolveUserId("imessage", to + ":" + from), () =>
        processUserMessage({
          channel: "imessage",
          userHandle: from,
          text: body || "Sent an attachment",
          attachments: attachments.length > 0 ? attachments : undefined,
        })
      );

          const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
    ${splitForSms(reply.text)
      .map((part) => `  <Message>${escapeXml(part)}</Message>`)
      .join("\n")}
    </Response>`;

      return new NextResponse(twiml, {
        status: 200,
        headers: { "Content-Type": "text/xml; charset=utf-8" },
      });
    }

    // =========================================================================
    // 2. SENDBLUE / LOOPMESSAGE iMESSAGE JSON WEBHOOK
    // =========================================================================
    const payload: any = jsonPayload;
    const senderHandle = String(payload.contact || payload.number || payload.from_number || "").slice(0, 64);
    if (!senderHandle) return NextResponse.json({ error: "iMessage webhook is missing sender identity." }, { status: 400 });
    if (payload.is_outbound === true || (payload.event && payload.event !== "message_inbound")) return NextResponse.json({ status: "ignored", event: payload.event || "outbound" });
    const provider = payload.contact ? "loopmessage" : "sendblue";
    const providerAccount = String(payload.organization_id || payload.sendblue_number || payload.to_number || "default");
    const webhookId = String(payload.message_handle || payload.webhook_id || payload.message_id || "");
    if (webhookId && !inboundWebhookCache.seen(inboundKey([provider, webhookId]))) return NextResponse.json({ status: "duplicate" });
    const messageText = String(
      payload.content || payload.text || payload.body || payload.message || ""
    )
      .trim()
      .slice(0, MAX_INPUT_CHARS);

    const attachments: Attachment[] = [];
    if (payload.media_url) {
      attachments.push({
        id: `sb-media-${Date.now()}`,
        name: "iMessage_Attachment",
        mimeType: "image/jpeg",
        type: "image",
        dataUrl: String(payload.media_url),
      });
    }

    after(async () => {
      try {
            const { reply, outboundText, deliveryResults } = await withVelnorUser(
              resolveUserId("imessage", provider + ":" + providerAccount + ":" + senderHandle),
              async () => {
                const reply = await processUserMessage({
                  channel: "imessage",
                  userHandle: senderHandle,
                  text: messageText,
                  attachments: attachments.length > 0 ? attachments : undefined,
                });
                const outboundText = toPlainText(reply.text);
                const scoped = getStore();
                const deliveryResults = [] as Array<{ provider: string; ok: boolean; status?: number; detail?: string }>; 
        
                // Outbound dispatch via Sendblue if configured
                if (scoped.config.sendblueApiKey && scoped.config.sendblueApiSecret && payload.number) {
                  deliveryResults.push(await sendSendblueMessage({
                    apiKeyId: scoped.config.sendblueApiKey,
                    apiSecretKey: scoped.config.sendblueApiSecret,
                    number: payload.number,
                    fromNumber: scoped.config.sendblueFromNumber || process.env.SENDBLUE_FROM_NUMBER,
                    content: outboundText,
                  }));
                }
        
                // Outbound dispatch via LoopMessage if configured
                if (
                  scoped.config.loopMessageAuthKey &&
                  payload.contact
                ) {
                  deliveryResults.push(await sendLoopMessage({
                    authKey: scoped.config.loopMessageAuthKey,
                    recipient: payload.contact,
                    text: outboundText,
                  }));
                }
        
                return { reply, outboundText, deliveryResults };
              }
            );
        console.info("iMessage JSON webhook processed", {
          provider,
          webhookId,
          delivery: deliveryResults.map((result) => ({ provider: result.provider, ok: result.ok, status: result.status })),
        });
      } catch (error) {
        console.error("iMessage JSON webhook processing failed:", error);
      }
    });

    return NextResponse.json({ status: "accepted", provider, webhookId });
  } catch (err) {
    console.error("iMessage/SMS webhook error:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Webhook processing failed",
      },
      { status: 500 }
    );
  }
}
