import { NextRequest, NextResponse } from "next/server";

/**
 * Root status endpoint for Velnor.
 * Velnor runs on native messaging webhooks (iMessage, SMS, Slack, Siri) and, since
 * the IDE shipped, a browser code editor at /ide. The editor is local-first: its
 * files never leave the browser unless the user asks the assistant about them.
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  return NextResponse.json({
    service: "Velnor",
    mode: "messaging-and-ide",
    webInterface: true,
    ide: "/ide",
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
