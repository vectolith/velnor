import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { processUserMessage } from "@/lib/ai/agent";
import { getStore } from "@/lib/store";
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

function verifyTwilioSignature(
  authToken: string,
  twilioSignature: string,
  url: string,
  params: Record<string, string>
): boolean {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const k of sortedKeys) {
    data += k + params[k];
  }
  const computed = crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed),
      Buffer.from(twilioSignature)
    );
  } catch {
    return false;
  }
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
  const isLocalSimulator = req.headers.get("x-velnor-simulator") === "true";

  try {
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
      const twilioSig = req.headers.get("x-twilio-signature");

      if (twilioAuthToken && twilioSig && !isLocalSimulator) {
        const valid = verifyTwilioSignature(
          twilioAuthToken,
          twilioSig,
          req.url,
          paramsMap
        );
        if (!valid) {
          return NextResponse.json(
            { error: "Invalid X-Twilio-Signature" },
            { status: 401 }
          );
        }
      }

      const from = String(formData.get("From") || "+15550192834").slice(0, 64);
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

    const reply = await processUserMessage({
      channel: "imessage",
      userHandle: senderHandle,
      text: messageText,
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    // Optional outbound dispatch via Sendblue if configured
    if (
      state.config.sendblueApiKey &&
      state.config.sendblueApiSecret &&
      payload.number
    ) {
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
    if (
      state.config.loopMessageAuthKey &&
      state.config.loopMessageSecretKey &&
      payload.recipient
    ) {
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
