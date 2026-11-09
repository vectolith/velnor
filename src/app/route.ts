import { NextRequest, NextResponse } from "next/server";

/**
 * Headless root status endpoint for Velnor.
 * Velnor operates strictly via native messaging webhooks (iMessage, SMS, Slack, Siri)
 * with no web chat UI or frontend application.
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  return NextResponse.json({
    service: "Velnor",
    mode: "headless-messaging-only",
    webInterface: false,
    model: "velnor-core-v1",
    endpoints: {
      imessageWebhook: `${origin}/api/webhooks/imessage`,
      slackWebhook: `${origin}/api/webhooks/slack`,
      siriShortcut: `${origin}/api/siri`,
      loraPilot: `${origin}/api/lora-pilot`,
      vcard: `${origin}/api/vcard`,
      health: `${origin}/api/health`,
      webhookManifest: `${origin}/api/webhooks/manifest`,
    },
  });
}
