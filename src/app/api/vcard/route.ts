import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";

/**
 * Generates an Apple iOS / macOS Contact Card (.vcf) for Velnor
 * Matches pluco.dev's 1-tap "Add to Contacts" onboarding experience
 */
export async function GET(req: NextRequest) {
  const state = getStore();
  const phone = state.config.twilioFromNumber || "+18885556554";
  const configuredOrigin = process.env.VELNOR_PUBLIC_URL;
  let publicOrigin: URL;
  try {
    publicOrigin = new URL(configuredOrigin || req.nextUrl.origin);
  } catch {
    return NextResponse.json({ error: "Public contact card origin is invalid." }, { status: 503 });
  }
  const isLoopbackOrigin = ["localhost", "127.0.0.1", "[::1]"].includes(publicOrigin.hostname);
  if (
    publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== "/" ||
    publicOrigin.search || publicOrigin.hash ||
    (process.env.NODE_ENV === "production" && publicOrigin.protocol !== "https:" && !(isLoopbackOrigin && !configuredOrigin)) ||
    (process.env.NODE_ENV === "production" && !configuredOrigin && !isLoopbackOrigin)
  ) {
    return NextResponse.json({ error: "Public contact card origin must be a canonical HTTPS origin." }, { status: 503 });
  }
  const origin = publicOrigin.origin;

  const vcard = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Velnor AI Agent",
    "N:Agent;Velnor;AI;;",
    "ORG:Velnor AI",
    "TITLE:Executive Personal AI in iMessage, SMS & Slack",
    `TEL;TYPE=CELL,VOICE,MSG,PREF:${phone}`,
    "EMAIL;TYPE=INTERNET:velnor@pluco.dev",
    `URL:${origin}`,
    "NOTE:Velnor — your executive personal AI agent in iMessage, SMS & Slack. Text Velnor to search the web, summarize PDFs, triage Gmail & Google Calendar, or plan trips.",
    "END:VCARD",
  ].join("\r\n");

  return new NextResponse(vcard, {
    status: 200,
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": 'attachment; filename="Velnor_AI_Agent.vcf"',
    },
  });
}
