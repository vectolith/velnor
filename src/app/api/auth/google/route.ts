import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";

export async function GET(req: NextRequest) {
  const state = getStore();
  const clientId = state.config.googleClientId || process.env.GOOGLE_CLIENT_ID;

  if (!clientId) {
    return NextResponse.json(
      {
        error: "Google Client ID not configured yet.",
        instructions:
          "Add your Google OAuth Client ID & Secret in Olli Settings -> Workspace OAuth, or paste an OAuth Access Token directly.",
      },
      { status: 400 }
    );
  }

  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/api/auth/google/callback`;
  const scopes = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/userinfo.email",
  ].join(" ");

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(
    clientId
  )}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&response_type=code&scope=${encodeURIComponent(
    scopes
  )}&access_type=offline&prompt=consent`;

  return NextResponse.redirect(authUrl);
}

