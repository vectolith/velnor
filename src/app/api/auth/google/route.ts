import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getStore, saveStore, withVelnorUser } from "@/lib/store";
import { authorizeChatTenant } from "@/lib/security/tenant";
import { createGoogleOAuthState } from "@/lib/security/googleOAuthState";
import { secretsEnabled } from "@/lib/security/secretBox";

export async function GET(req: NextRequest) {
  const tenant = authorizeChatTenant(req.headers.get("authorization"));
  if (!tenant.ok) return NextResponse.json({ error: tenant.error }, { status: tenant.status ?? 401 });
  if (!secretsEnabled()) {
    return NextResponse.json({ error: "Credential encryption is not configured." }, { status: 503 });
  }

  const clientId = await withVelnorUser(tenant.userId, () => {
    const state = getStore();
    return state.config.googleClientId || process.env.GOOGLE_CLIENT_ID || "";
  });
  if (!clientId) {
    return NextResponse.json(
      { error: "Google Client ID is not configured for this tenant." },
      { status: 400 }
    );
  }

  const origin = process.env.VELNOR_PUBLIC_URL || req.nextUrl.origin;
  const redirectUri = new URL("/api/auth/google/callback", origin).toString();
  if (process.env.NODE_ENV === "production" && !redirectUri.startsWith("https://")) {
    return NextResponse.json({ error: "Google OAuth requires an HTTPS public callback URL." }, { status: 500 });
  }

  const nonce = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const signedState = createGoogleOAuthState(tenant.userId, nonce);

  await withVelnorUser(tenant.userId, () => {
    const state = getStore();
    state.config.googleOAuthNonce = nonce;
    state.config.googleOAuthCodeVerifier = verifier;
    state.config.googleOAuthStartedAt = new Date().toISOString();
    saveStore(state);
  });

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

  return NextResponse.json({ authUrl: authUrl.toString(), expiresIn: 600 });
}
