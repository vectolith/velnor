import { getStore, saveStore } from "@/lib/store";

export async function getGoogleAccessToken(): Promise<string> {
  const state = getStore();
  const accessToken = state.config.googleAccessToken || "";
  const expiresAt = Date.parse(state.config.googleAccessTokenExpiresAt || "");
  if (accessToken && (!Number.isFinite(expiresAt) || expiresAt > Date.now() + 60_000)) {
    return accessToken;
  }

  const refreshToken = state.config.googleRefreshToken || "";
  const clientId = state.config.googleClientId || process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = state.config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || "";
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error("A verified Google OAuth connection is required; access expired. Reconnect the Google account to continue.");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("Google OAuth refresh failed:", response.status, detail.slice(0, 300));
    throw new Error("Google OAuth refresh failed; reconnect the Google account.");
  }

  const payload = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token) throw new Error("Google OAuth refresh response did not contain an access token.");
  state.config.googleAccessToken = payload.access_token;
  if (payload.refresh_token) state.config.googleRefreshToken = payload.refresh_token;
  state.config.googleAccessTokenExpiresAt = new Date(
    Date.now() + Math.max(60, Number(payload.expires_in || 3600)) * 1000
  ).toISOString();
  saveStore(state);
  return payload.access_token;
}
