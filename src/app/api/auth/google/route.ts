import crypto from "node:crypto";
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
          "Add your Google OAuth Client ID & Secret in Velnor Settings -> Workspace OAuth, or paste an OAuth Access Token directly.",
      },
      { status: 400 }
    );
  }

  const origin = process.env.VELNOR_PUBLIC_URL || req.nextUrl.origin;
  const redirectUri = `${origin}/api/auth/google/callback`;
  const clientSecret = state.config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || "";
  if (!clientSecret) {
    return NextResponse.json(
      { error: "Google Client Secret is not configured." },
      { status: 503 }
    );
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(32).toString("base64url");
  const statePayload = `${timestamp}.${nonce}`;
  const signature = crypto.createHmac("sha256", clientSecret).update(statePayload).digest("base64url");
  const oauthState = `${statePayload}.${signature}`;
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
  )}&access_type=offline&prompt=consent&state=${encodeURIComponent(oauthState)}`;

  const response = NextResponse.redirect(authUrl);
  response.cookies.set("velnor_google_oauth_state", oauthState, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth/google/callback",
    maxAge: 600,
  });
  return response;
}

