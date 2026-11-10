import { NextRequest, NextResponse } from "next/server";
import { buildSlackManifest, normalizeBaseUrl } from "@/lib/channels/slackManifest";

export async function GET(req: NextRequest) {
  const baseUrl = normalizeBaseUrl(
    req.nextUrl.searchParams.get("baseUrl") || req.nextUrl.origin || "https://your-velnor-domain.run.app"
  );
  const slackManifest = buildSlackManifest(baseUrl);

  // ?only=manifest hands back the paste-ready object alone, so an operator can
  // create the app from it without picking the manifest out of a bundle.
  if (req.nextUrl.searchParams.get("only") === "manifest") {
    return NextResponse.json(slackManifest);
  }

  return NextResponse.json({
    baseUrl,
    imessageWebhookUrl: `${baseUrl}/api/webhooks/imessage`,
    slackWebhookUrl: `${baseUrl}/api/webhooks/slack`,
    siriShortcutUrl: `${baseUrl}/api/siri`,
    cronRemindersUrl: `${baseUrl}/api/cron/reminders`,
    slackManifest,
  });
}
