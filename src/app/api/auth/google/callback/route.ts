import { NextRequest, NextResponse } from "next/server";
import { withVelnorTenantScope } from "@/lib/store";
import { getNodeTenantRepositoryContext } from "@/lib/storage/currentTenantRepository";
import { verifyGoogleOAuthStateAsync } from "@/lib/security/googleOAuthStateWebCrypto";
import type { PersistedTenantState } from "@/lib/storage/d1TenantState";

function configOf(state: PersistedTenantState): Record<string, unknown> {
  const config = state.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Google OAuth tenant configuration is invalid.");
  return config as Record<string, unknown>;
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const signedState = req.nextUrl.searchParams.get("state") || "";
  const providerError = req.nextUrl.searchParams.get("error");
  if (providerError) return NextResponse.json({ ok: false, error: "google_oauth_denied" }, { status: 400 });
  if (!code || !signedState) return NextResponse.json({ ok: false, error: "missing_oauth_params" }, { status: 400 });

  const binding = await verifyGoogleOAuthStateAsync(signedState, process.env.VELNOR_TENANT_TOKEN_SECRET || "");
  if (!binding) return NextResponse.json({ ok: false, error: "invalid_or_expired_oauth_state" }, { status: 400 });

  const configuredOrigin = process.env.VELNOR_PUBLIC_URL;
  if (process.env.NODE_ENV === "production" && !configuredOrigin) {
    return NextResponse.json({ ok: false, error: "oauth_public_origin_not_configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  let publicOrigin: URL;
  try { publicOrigin = new URL(configuredOrigin || req.nextUrl.origin); }
  catch { return NextResponse.json({ ok: false, error: "oauth_public_origin_invalid" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
  if (
    publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== "/" ||
    publicOrigin.search || publicOrigin.hash ||
    (process.env.NODE_ENV === "production" && publicOrigin.protocol !== "https:")
  ) {
    return NextResponse.json({ ok: false, error: "oauth_public_origin_invalid" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const redirectUri = new URL("/api/auth/google/callback", publicOrigin).toString();

  try {
    const result = await withVelnorTenantScope(binding.tenantId, async () => {
      const { repository, tenantId } = getNodeTenantRepositoryContext();
      const record = await repository.load(tenantId);
      if (!record) throw new Error("Google OAuth tenant state is not initialized.");

      // Consume the nonce/verifier atomically before contacting Google. A callback replay cannot reuse them.
      const consumed = await repository.update(
        tenantId,
        () => record.state,
        (draft) => {
          const config = configOf(draft);
          const startedAt = Date.parse(String(config.googleOAuthStartedAt || ""));
          const nonceMatches = Boolean(
            config.googleOAuthNonce &&
            config.googleOAuthNonce === binding.nonce &&
            Number.isFinite(startedAt) &&
            Date.now() >= startedAt &&
            Date.now() - startedAt <= 10 * 60 * 1000
          );
          const verifier = typeof config.googleOAuthCodeVerifier === "string" ? config.googleOAuthCodeVerifier : "";
          if (!nonceMatches || !verifier) throw new Error("Google OAuth state is not active for this tenant.");
          const clientId = typeof config.googleClientId === "string" && config.googleClientId
            ? config.googleClientId : process.env.GOOGLE_CLIENT_ID || "";
          const clientSecret = typeof config.googleClientSecret === "string" && config.googleClientSecret
            ? config.googleClientSecret : process.env.GOOGLE_CLIENT_SECRET || "";
          if (!clientId || !clientSecret) throw new Error("Google OAuth client credentials are not configured.");
          delete config.googleOAuthNonce;
          delete config.googleOAuthCodeVerifier;
          delete config.googleOAuthStartedAt;
          draft.config = config;
          return { verifier, clientId, clientSecret };
        },
      );

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: consumed.result.clientId,
          client_secret: consumed.result.clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          code_verifier: consumed.result.verifier,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!tokenRes.ok) throw new Error("Google rejected the OAuth authorization code.");
      const tokenData = await tokenRes.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!tokenData.access_token) throw new Error("Google OAuth response did not contain an access token.");

      const profileRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: "Bearer " + tokenData.access_token },
        signal: AbortSignal.timeout(10_000),
      });
      if (!profileRes.ok) throw new Error("Google could not verify the connected account profile.");
      const profile = await profileRes.json() as { email?: string };
      if (!profile.email) throw new Error("Google profile response did not include an email address.");

      const expiresIn = Number(tokenData.expires_in);
      await repository.update(
        tenantId,
        () => record.state,
        (draft) => {
          const config = configOf(draft);
          config.googleAccessToken = tokenData.access_token!;
          if (tokenData.refresh_token) config.googleRefreshToken = tokenData.refresh_token;
          config.googleAccessTokenExpiresAt = new Date(
            Date.now() + Math.max(60, Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000
          ).toISOString();
          config.googleConnectedEmail = profile.email;
          draft.config = config;
        },
      );
      return { email: profile.email };
    });

    return NextResponse.json({ ok: true, status: "connected", email: result.email }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google OAuth callback failed.";
    const status = message.includes("not active") ? 400 : 500;
    console.error("Google OAuth callback failed:", message);
    return NextResponse.json({ ok: false, error: "oauth_exchange_failed" }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
