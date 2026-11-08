import { NextRequest, NextResponse } from "next/server";
import { processUserMessage } from "@/lib/ai/agent";
import { getStore } from "@/lib/store";
import { Attachment } from "@/lib/types";

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

  try {
    // =========================================================================
    // 1. TWILIO SMS / MMS WEBHOOK (application/x-www-form-urlencoded)
    // =========================================================================
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await req.formData();
      const from = String(formData.get("From") || "+15550192834");
      const body = String(formData.get("Body") || "").trim();
      const numMedia = Number(formData.get("NumMedia") || "0");

      const attachments: Attachment[] = [];
      for (let i = 0; i < numMedia; i++) {
        const mediaUrl = String(formData.get(`MediaUrl${i}`) || "");
        const mediaType = String(formData.get(`MediaContentType${i}`) || "image/jpeg");
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

      const reply = await processUserMessage({
        channel: "imessage",
        userHandle: from,
        text: body || "Sent an attachment",
        attachments: attachments.length > 0 ? attachments : undefined,
      });

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(reply.text)}</Message>
</Response>`;

      return new NextResponse(twiml, {
        status: 200,
        headers: { "Content-Type": "text/xml; charset=utf-8" },
      });
    }

    // =========================================================================
    // 2. SENDBLUE / LOOPMESSAGE iMESSAGE JSON WEBHOOK
    // =========================================================================
    const payload = await req.json();
    const senderHandle =
      payload.number ||
      payload.from_number ||
      payload.recipient ||
      payload.sender ||
      "+1 (555) 019-2834";
    const messageText =
      payload.content ||
      payload.text ||
      payload.body ||
      payload.message ||
      "";

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

    const reply = await processUserMessage({
      channel: "imessage",
      userHandle: String(senderHandle),
      text: String(messageText),
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    // Optional outbound dispatch via Sendblue if configured
    if (state.config.sendblueApiKey && state.config.sendblueApiSecret && payload.number) {
      fetch("https://api.sendblue.co/api/send-message", {
        method: "POST",
        headers: {
          "sb-api-key-id": state.config.sendblueApiKey,
          "sb-api-secret-key": state.config.sendblueApiSecret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          number: payload.number,
          content: reply.text,
        }),
      }).catch(() => {});
    }

    // Optional outbound dispatch via LoopMessage if configured
    if (state.config.loopMessageAuthKey && state.config.loopMessageSecretKey && payload.recipient) {
      fetch("https://server.loopmessage.com/api/v1/message/send/", {
        method: "POST",
        headers: {
          Authorization: state.config.loopMessageAuthKey,
          "Loop-Secret-Key": state.config.loopMessageSecretKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recipient: payload.recipient,
          text: reply.text,
        }),
      }).catch(() => {});
    }

    return NextResponse.json({
      status: "ok",
      provider: payload.recipient ? "loopmessage" : "sendblue",
      recipient: senderHandle,
      reply: {
        id: reply.id,
        text: reply.text,
        citations: reply.citations,
        toolActions: reply.toolActions,
        generatedImage: reply.generatedImage ? { prompt: reply.generatedImage.prompt } : undefined,
      },
    });
  } catch (err) {
    console.error("iMessage/SMS webhook error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Webhook processing failed" },
      { status: 500 }
    );
  }
}

