import { NextRequest, NextResponse } from "next/server";
import { getStore, saveStore } from "@/lib/store";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = getStore();
  const clientId = state.config.googleClientId || process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = state.config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || "";
  const redirectUri = `${req.nextUrl.origin}/api/auth/google/callback`;

  if (!code || !clientId || !clientSecret) {
    return NextResponse.redirect(`${req.nextUrl.origin}/?oauth=missing_params`);
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (tokenRes.ok) {
      const tokenData = await tokenRes.json();
      state.config.googleAccessToken = tokenData.access_token;
      if (tokenData.refresh_token) {
        state.config.googleRefreshToken = tokenData.refresh_token;
      }

      // Fetch user's email address
      const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (profileRes.ok) {
        const profile = await profileRes.json();
        state.config.googleConnectedEmail = profile.email || "connected@gmail.com";
      }

      saveStore(state);
      return NextResponse.redirect(`${req.nextUrl.origin}/?oauth=success`);
    }
  } catch (err) {
    console.error("Google OAuth callback error:", err);
  }

  return NextResponse.redirect(`${req.nextUrl.origin}/?oauth=error`);
}

