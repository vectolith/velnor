import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { inboundKey, inboundWebhookCache } from "@/lib/security/idempotency";
import { sendSendblueMessage } from "@/lib/channels/sendblue";
import { sendLoopMessage } from "@/lib/channels/loopmessage";
import {
  authorizeJsonWebhook,
  authorizeTwilioRequest,
  isSimulatorAllowed,
} from "@/lib/security/webhookAuth";
import { processUserMessage } from "@/lib/ai/agent";
import { getStore, resolveUserId, withVelnorUser } from "@/lib/store";
import { splitForSms, toPlainText } from "@/lib/format";
import { Attachment } from "@/lib/types";

const MAX_INPUT_CHARS = 8000;

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

  try {
    if (contentType.includes("application/json")) {
      const jsonDecision = authorizeJsonWebhook({
        secrets: [process.env.SENDBLUE_WEBHOOK_SECRET, process.env.LOOPMESSAGE_WEBHOOK_SECRET],
        provided: req.headers.get("x-velnor-webhook-secret"),
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
        url: req.url,
        params: paramsMap,
        simulator: isLocalSimulator,
      });
      if (!twilioDecision.ok) {
        return NextResponse.json(
          { error: twilioDecision.error },
          { status: twilioDecision.status ?? 401 }
        );
      }

      const from = String(formData.get("From") || "+15550192834").slice(0, 64);
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

      const reply = await withVelnorUser(resolveUserId("imessage", from), () =>
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
    let payload: any;
    try {
      payload = await req.json();
    } catch {
      // A malformed body is the caller's error, not a server fault.
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const senderHandle = String(
      payload.number ||
        payload.from_number ||
        payload.recipient ||
        payload.sender ||
        "+1 (555) 019-2834"
    ).slice(0, 64);
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

    const { reply, outboundText } = await withVelnorUser(
      resolveUserId("imessage", senderHandle),
      async () => {
        const reply = await processUserMessage({
          channel: "imessage",
          userHandle: senderHandle,
          text: messageText,
          attachments: attachments.length > 0 ? attachments : undefined,
        });
        const outboundText = toPlainText(reply.text);
        const scoped = getStore();

        // Outbound dispatch via Sendblue if configured
        if (scoped.config.sendblueApiKey && scoped.config.sendblueApiSecret && payload.number) {
          void sendSendblueMessage({
            apiKeyId: scoped.config.sendblueApiKey,
            apiSecretKey: scoped.config.sendblueApiSecret,
            number: payload.number,
            content: outboundText,
          });
        }

        // Outbound dispatch via LoopMessage if configured
        if (
          scoped.config.loopMessageAuthKey &&
          scoped.config.loopMessageSecretKey &&
          payload.recipient
        ) {
          void sendLoopMessage({
            authKey: scoped.config.loopMessageAuthKey,
            secretKey: scoped.config.loopMessageSecretKey,
            recipient: payload.recipient,
            text: outboundText,
          });
        }

        return { reply, outboundText };
      }
    );

    return NextResponse.json({
      status: "ok",
      provider: payload.recipient ? "loopmessage" : "sendblue",
      recipient: senderHandle,
          reply: {
            id: reply.id,
            text: outboundText,
        citations: reply.citations,
        toolActions: reply.toolActions,
        generatedImage: reply.generatedImage
          ? { prompt: reply.generatedImage.prompt }
          : undefined,
      },
    });
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
