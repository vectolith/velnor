import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";

/**
 * Generates an Apple iOS / macOS Contact Card (.vcf) for Olli
 * Matches olly.bot's 1-tap "Add to Contacts" onboarding experience
 */
export async function GET(req: NextRequest) {
  const state = getStore();
  const phone = state.config.twilioFromNumber || "+18885556554";
  const origin = req.nextUrl.origin;

  const vcard = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Olli AI Assistant",
    "N:Assistant;Olli;AI;;",
    "ORG:Olli (olly.bot)",
    "TITLE:Personal AI in iMessage, SMS & Slack",
    `TEL;TYPE=CELL,VOICE,MSG,PREF:${phone}`,
    "EMAIL;TYPE=INTERNET:olli@olly.bot",
    `URL:${origin}`,
    "NOTE:Your personal AI assistant in iMessage, SMS & Slack. Text Olli to search the web, summarize PDFs, triage Gmail & Google Calendar, or plan trips.",
    "END:VCARD",
  ].join("\r\n");

  return new NextResponse(vcard, {
    status: 200,
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": 'attachment; filename="Olli_AI_Assistant.vcf"',
    },
  });
}
