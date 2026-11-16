import crypto from "crypto";
import { after, NextRequest, NextResponse } from "next/server";
import { inboundKey, inboundWebhookCache } from "@/lib/security/idempotency";
import { sendTrackedSendblueMessage } from "@/lib/channels/trackedSendblueSend";
import {
  authorizeJsonWebhook,
  authorizeTwilioRequest,
  isSimulatorAllowed,
  publicRequestUrl,
} from "@/lib/security/webhookAuth";
import { processUserMessage } from "@/lib/ai/agent";
import { resolveUserId, withVelnorTenantScope } from "@/lib/store";
import { getNodeTenantRepositoryContext } from "@/lib/storage/currentTenantRepository";
import { splitForSms, toPlainText } from "@/lib/format";
import { Attachment } from "@/lib/types";
import { isLoopMessagePayload, normalizeImessageIdentity } from "@/lib/channels/imessageIdentity";
import { processLoopMessageCallbackPayload, processSendblueDeliveryCallbackPayload } from "@/lib/channels/imessageDeliveryStore";
import { PayloadTooLargeError, readRequestBodyLimited } from "@/lib/security/requestBody";

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
 * 3. Sendblue outbound delivery status callbacks (message_handle/status/service)
 */
export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") || "";
  let rootConfig: Record<string, unknown>;
  try {
    rootConfig = await withVelnorTenantScope("default", async () => {
      const { repository, tenantId } = getNodeTenantRepositoryContext();
      const record = await repository.load(tenantId);
      return (record?.state.config ?? {}) as Record<string, unknown>;
    });
  } catch (error) {
    console.error("iMessage webhook configuration could not be loaded:", error);
    return NextResponse.json({ error: "Webhook credentials are temporarily unavailable." }, { status: 503 });
  }
  const isLocalSimulator = isSimulatorAllowed(req.headers.get("x-velnor-simulator"));
  let jsonPayload: any;

  try {
    if (contentType.includes("application/json")) {
      let rawJsonBody: string;
      try {
        rawJsonBody = await readRequestBodyLimited(req, 1_048_576);
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          return NextResponse.json({ error: error.message }, { status: 413 });
        }
        throw error;
      }
      try {
        jsonPayload = JSON.parse(rawJsonBody);
      } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      if (!jsonPayload || typeof jsonPayload !== "object" || Array.isArray(jsonPayload)) {
        return NextResponse.json({ error: "Webhook JSON must be an object." }, { status: 400 });
      }

      // Each provider must prove possession of its own webhook secret. A
      // LoopMessage secret must never authenticate a Sendblue callback (or vice versa).
      const isLoopMessage = isLoopMessagePayload(jsonPayload);
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
      let rawFormBody: string;
      try {
        rawFormBody = await readRequestBodyLimited(req, 512 * 1024);
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          return NextResponse.json({ error: error.message }, { status: 413 });
        }
        throw error;
      }
      const formData = new URLSearchParams(rawFormBody);
      const paramsMap: Record<string, string> = {};
      formData.forEach((val, key) => {
        paramsMap[key] = String(val);
      });

      const twilioAuthToken =
        (typeof rootConfig.twilioAuthToken === "string" ? rootConfig.twilioAuthToken : "") || process.env.TWILIO_AUTH_TOKEN;
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

      const reply = await withVelnorTenantScope(resolveUserId("imessage", to + ":" + from), () =>
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
    const provider = isLoopMessagePayload(payload) ? "loopmessage" : "sendblue";
    if (provider === "loopmessage") {
      const outcome = processLoopMessageCallbackPayload(payload);
      if (outcome !== null) {
        if (outcome === "invalid") {
          return NextResponse.json(
            { error: "LoopMessage delivery callback is missing a valid contact or message_id." },
            { status: 400 }
          );
        }
        if (outcome === "unmatched") {
          // A callback may beat persistence of the send response. The event is
          // durably queued and reconciled when the provider message ID is saved.
          return NextResponse.json({ status: "callback_persisted_pending_correlation" });
        }
        return NextResponse.json({
          status: outcome === "applied" ? payload.event : "duplicate_callback",
        });
      }
    }
    if (provider === "sendblue") {
      const outcome = processSendblueDeliveryCallbackPayload(payload);
      if (outcome !== null) {
        if (outcome === "invalid") {
          return NextResponse.json(
            { error: "Sendblue delivery callback is missing a valid message_handle, recipient, or sender identity." },
            { status: 400 }
          );
        }
        if (outcome === "unmatched") {
          return NextResponse.json({ status: "callback_persisted_pending_correlation" });
        }
        return NextResponse.json({
          status: outcome === "applied" ? "delivery_status_applied" : "duplicate_callback",
        });
      }
    }
    if (provider === "loopmessage" && payload.event && payload.event !== "message_inbound") {
      return NextResponse.json({ status: "ignored", event: payload.event });
    }
    if (provider === "sendblue") {
      const eventType = String(payload.event_type || "").toLowerCase();
      if (
        payload.is_outbound === true ||
        (payload.message_type && payload.message_type !== "message") ||
        (eventType && !eventType.includes("message") && !eventType.includes("receive"))
      ) {
        return NextResponse.json({ status: "ignored", event: eventType || "outbound_or_non_message" });
      }
    }
    if (provider === "loopmessage") {
      return NextResponse.json({ status: "ignored", provider, reason: "Sendblue is the configured iMessage provider." });
    }
    const senderHandle = normalizeImessageIdentity(payload.contact || payload.email || payload.from_email || payload.apple_id || payload.number || payload.from_number);
    if (!senderHandle) return NextResponse.json({ error: "iMessage webhook is missing sender identity." }, { status: 400 });
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
            const { reply, outboundText, deliveryResults } = await withVelnorTenantScope(
              resolveUserId("imessage", provider + ":" + providerAccount + ":" + senderHandle),
              async () => {
                const reply = await processUserMessage({
                  channel: "imessage",
                  userHandle: senderHandle,
                  text: messageText,
                  attachments: attachments.length > 0 ? attachments : undefined,
                });
                const outboundText = toPlainText(reply.text);
                const { repository, tenantId } = getNodeTenantRepositoryContext();
                const record = await repository.load(tenantId);
                if (!record) throw new Error("Authenticated tenant state is not initialized.");
                const scoped = record.state as unknown as { config: Record<string, any> };
                const deliveryResults = [] as Array<{ provider: string; ok: boolean; status?: number; detail?: string }>; 
        
                // All VELNOR iMessage replies use Sendblue and are durably tracked.
                const sendblueFromNumber =
                  (typeof scoped.config.sendblueFromNumber === "string" ? scoped.config.sendblueFromNumber : "") ||
                  process.env.SENDBLUE_FROM_NUMBER ||
                  "";
                const sendblueApiKey =
                  (typeof scoped.config.sendblueApiKey === "string" ? scoped.config.sendblueApiKey : "") ||
                  process.env.SENDBLUE_API_KEY ||
                  "";
                const sendblueApiSecret =
                  (typeof scoped.config.sendblueApiSecret === "string" ? scoped.config.sendblueApiSecret : "") ||
                  process.env.SENDBLUE_API_SECRET ||
                  "";
                const statusCallback = process.env.VELNOR_PUBLIC_URL
                  ? process.env.VELNOR_PUBLIC_URL.replace(/\/+$/, "") + "/api/webhooks/imessage"
                  : "";
                if (sendblueApiKey && sendblueApiSecret && sendblueFromNumber && statusCallback) {
                  const tracked = await sendTrackedSendblueMessage({
                    apiKeyId: sendblueApiKey,
                    apiSecretKey: sendblueApiSecret,
                    recipient: senderHandle,
                    fromNumber: sendblueFromNumber,
                    content: outboundText,
                    statusCallback,
                    tenantId: getNodeTenantRepositoryContext().tenantId,
                    taskId: reply.interactionId || "inbound_" + (webhookId || senderHandle),
                  });
                  deliveryResults.push(tracked.result);
                  if (!tracked.result.ok || !tracked.result.messageId || tracked.trackingDegraded || tracked.attempt.state === "failed") {
                    console.warn("Sendblue outbound attempt requires attention", {
                      attemptId: tracked.attempt.attemptId,
                      state: tracked.attempt.state,
                      duplicateRisk: tracked.duplicateRisk,
                      trackingDegraded: tracked.trackingDegraded,
                    });
                  }
                } else {
                  console.warn("Sendblue reply not sent: API credentials and SENDBLUE_FROM_NUMBER are required.");
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
