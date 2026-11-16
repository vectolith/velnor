import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getStore, saveStore } from "@/lib/store";

function validOAuthState(value: string, secret: string): boolean {
  const [timestampText, nonce, signature, extra] = value.split(".");
  const timestamp = Number(timestampText);
  if (
    extra !== undefined ||
    !Number.isSafeInteger(timestamp) ||
    Math.abs(Date.now() / 1000 - timestamp) > 600 ||
    !/^[A-Za-z0-9_-]{40,}$/.test(nonce || "") ||
    !signature
  ) return false;

  const expected = crypto.createHmac("sha256", secret)
    .update(`${timestampText}.${nonce}`)
    .digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function clearOAuthState(response: NextResponse): NextResponse {
  response.cookies.set("velnor_google_oauth_state", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth/google/callback",
    maxAge: 0,
  });
  return response;
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const oauthState = req.nextUrl.searchParams.get("state") || "";
  const cookieState = req.cookies.get("velnor_google_oauth_state")?.value || "";
  const state = getStore();
  const clientId = state.config.googleClientId || process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = state.config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || "";
  const origin = process.env.VELNOR_PUBLIC_URL || req.nextUrl.origin;
  const redirectUri = `${origin}/api/auth/google/callback`;
  const oauthStateBytes = Buffer.from(oauthState);
  const cookieStateBytes = Buffer.from(cookieState);
  const statesMatch = oauthStateBytes.length === cookieStateBytes.length &&
    crypto.timingSafeEqual(oauthStateBytes, cookieStateBytes);

  if (
    !clientSecret ||
    !oauthState ||
    !cookieState ||
    !statesMatch ||
    !validOAuthState(oauthState, clientSecret)
  ) {
    return clearOAuthState(NextResponse.json(
      { ok: false, error: "invalid_oauth_state" },
      { status: 400 }
    ));
  }

  if (!code || !clientId || !clientSecret) {
    return clearOAuthState(NextResponse.json(
      { ok: false, error: "missing_oauth_params" },
      { status: 400 }
    ));
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
      signal: AbortSignal.timeout(10_000),
    });

    if (tokenRes.ok) {
      const tokenData = await tokenRes.json();
      if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
        throw new Error("Google token response did not contain an access token.");
      }
      state.config.googleAccessToken = tokenData.access_token;
      if (tokenData.refresh_token) {
        state.config.googleRefreshToken = tokenData.refresh_token;
      }

      // Fetch user's email address
      const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (profileRes.ok) {
        const profile = await profileRes.json();
        state.config.googleConnectedEmail = profile.email || "connected@gmail.com";
      }

      saveStore(state);
      return clearOAuthState(NextResponse.json({
        ok: true,
        status: "connected",
        email: state.config.googleConnectedEmail,
      }));
    }
  } catch (err) {
    console.error("Google OAuth callback error:", err);
  }

  return clearOAuthState(NextResponse.json(
    { ok: false, error: "oauth_exchange_failed" },
    { status: 500 }
  ));
}

