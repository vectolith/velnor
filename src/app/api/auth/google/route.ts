import { NextRequest, NextResponse } from "next/server";
import { withVelnorTenantScope } from "@/lib/store";
import { getNodeTenantRepositoryContext } from "@/lib/storage/currentTenantRepository";
import { authorizeChatTenant } from "@/lib/security/tenant";
import { createGoogleOAuthStateAsync } from "@/lib/security/googleOAuthStateWebCrypto";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export async function GET(req: NextRequest) {
  const tenant = authorizeChatTenant(req.headers.get("authorization"));
  if (!tenant.ok) return NextResponse.json({ error: tenant.error }, { status: tenant.status ?? 401 });

  const encryptionConfigured = Boolean(process.env.VELNOR_SECRET_KEY || process.env.VELNOR_SECRET_KEYRING_JSON);
  if (!encryptionConfigured) {
    return NextResponse.json({ error: "Credential encryption is not configured." }, { status: 503 });
  }

  const configuredOrigin = process.env.VELNOR_PUBLIC_URL;
  if (process.env.NODE_ENV === "production" && !configuredOrigin) {
    return NextResponse.json({ error: "Google OAuth is disabled until VELNOR_PUBLIC_URL is configured." }, { status: 503 });
  }
  let publicOrigin: URL;
  try { publicOrigin = new URL(configuredOrigin || req.nextUrl.origin); }
  catch { return NextResponse.json({ error: "VELNOR_PUBLIC_URL must be a valid absolute origin." }, { status: 503 }); }
  if (
    publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== "/" ||
    publicOrigin.search || publicOrigin.hash ||
    (process.env.NODE_ENV === "production" && publicOrigin.protocol !== "https:")
  ) {
    return NextResponse.json({ error: "VELNOR_PUBLIC_URL must be a canonical HTTPS origin in production." }, { status: 503 });
  }

  const signingSecret = process.env.VELNOR_TENANT_TOKEN_SECRET || "";
  if (signingSecret.length < 32) {
    return NextResponse.json({ error: "Google OAuth state signing is not configured." }, { status: 503 });
  }
  const redirectUri = new URL("/api/auth/google/callback", publicOrigin).toString();
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = base64Url(nonceBytes);
  const verifier = base64Url(verifierBytes);
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const signedState = await createGoogleOAuthStateAsync(tenant.userId, nonce, signingSecret);

  let clientId = "";
  try {
    clientId = await withVelnorTenantScope(tenant.userId, async () => {
      const { repository, tenantId } = getNodeTenantRepositoryContext();
      const record = await repository.load(tenantId);
      if (!record) throw new Error("Authenticated tenant state is not initialized.");
      const config = record.state.config as Record<string, unknown> | undefined;
      const configuredClientId = typeof config?.googleClientId === "string" ? config.googleClientId : "";
      const resolvedClientId = configuredClientId || process.env.GOOGLE_CLIENT_ID || "";
      if (!resolvedClientId) return "";
      await repository.update(tenantId, () => record.state, (draft) => {
        const next = draft.config && typeof draft.config === "object"
          ? draft.config as Record<string, unknown>
          : {};
        next.googleOAuthNonce = nonce;
        next.googleOAuthCodeVerifier = verifier;
        next.googleOAuthStartedAt = new Date().toISOString();
        draft.config = next;
      });
      return resolvedClientId;
    });
  } catch (error) {
    console.error("Google OAuth initialization failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Google OAuth could not be initialized for this tenant." }, { status: 503 });
  }
  if (!clientId) {
    return NextResponse.json({ error: "Google Client ID is not configured for this tenant." }, { status: 400 });
  }

  const scopes = [
    "openid",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/userinfo.email",
  ];
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", signedState);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return NextResponse.json({ authUrl: authUrl.toString(), expiresIn: 600 }, { headers: { "Cache-Control": "no-store" } });
}
