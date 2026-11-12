import { NextRequest, NextResponse } from "next/server";
import { getStore, saveStore, withVelnorUser } from "@/lib/store";
import { verifyGoogleOAuthState } from "@/lib/security/googleOAuthState";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const signedState = req.nextUrl.searchParams.get("state") || "";
  const providerError = req.nextUrl.searchParams.get("error");
  if (providerError) return NextResponse.json({ ok: false, error: "google_oauth_denied" }, { status: 400 });
  if (!code || !signedState) {
    return NextResponse.json({ ok: false, error: "missing_oauth_params" }, { status: 400 });
  }

  const binding = verifyGoogleOAuthState(signedState);
  if (!binding) return NextResponse.json({ ok: false, error: "invalid_or_expired_oauth_state" }, { status: 400 });

  try {
    const result = await withVelnorUser(binding.tenantId, async () => {
      const state = getStore();
      const startedAt = Date.parse(state.config.googleOAuthStartedAt || "");
      const nonceMatches = Boolean(
        state.config.googleOAuthNonce &&
        state.config.googleOAuthNonce === binding.nonce &&
        Number.isFinite(startedAt) &&
        Date.now() - startedAt <= 10 * 60 * 1000
      );
      const verifier = state.config.googleOAuthCodeVerifier || "";
      if (!nonceMatches || !verifier) {
        throw new Error("Google OAuth state is not active for this tenant.");
      }

      // Consume the one-time state before exchanging the code to prevent replay.
      delete state.config.googleOAuthNonce;
      delete state.config.googleOAuthCodeVerifier;
      delete state.config.googleOAuthStartedAt;
      saveStore(state);

      const clientId = state.config.googleClientId || process.env.GOOGLE_CLIENT_ID || "";
      const clientSecret = state.config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || "";
      if (!clientId || !clientSecret) throw new Error("Google OAuth client credentials are not configured.");

      const origin = process.env.VELNOR_PUBLIC_URL || req.nextUrl.origin;
      const redirectUri = new URL("/api/auth/google/callback", origin).toString();
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!tokenRes.ok) {
        const detail = await tokenRes.text().catch(() => "");
        console.error("Google OAuth token exchange failed:", tokenRes.status, detail.slice(0, 300));
        throw new Error("Google rejected the OAuth authorization code.");
      }

      const tokenData = await tokenRes.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (!tokenData.access_token) throw new Error("Google OAuth response did not contain an access token.");

      const profileRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: "Bearer " + tokenData.access_token },
        signal: AbortSignal.timeout(10000),
      });
      if (!profileRes.ok) throw new Error("Google could not verify the connected account profile.");
      const profile = await profileRes.json() as { email?: string };
      if (!profile.email) throw new Error("Google profile response did not include an email address.");

      state.config.googleAccessToken = tokenData.access_token;
      if (tokenData.refresh_token) state.config.googleRefreshToken = tokenData.refresh_token;
      state.config.googleAccessTokenExpiresAt = new Date(
        Date.now() + Math.max(60, Number(tokenData.expires_in || 3600)) * 1000
      ).toISOString();
      state.config.googleConnectedEmail = profile.email;
      saveStore(state);

      return { email: profile.email };
    });

    return NextResponse.json({ ok: true, status: "connected", email: result.email }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = (error as Error).message;
    const status = message.includes("not active") ? 400 : 500;
    console.error("Google OAuth callback failed:", message);
    return NextResponse.json({ ok: false, error: "oauth_exchange_failed" }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
