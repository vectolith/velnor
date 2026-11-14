import type { PersistedTenantState } from "../storage/d1TenantState";
import type { TenantRepository } from "../storage/tenantRepository";

export interface GoogleOAuthEnvironment {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}
function runtimeEnvironment(override?: GoogleOAuthEnvironment): GoogleOAuthEnvironment {
  if (override) return override;
  if (typeof process !== "undefined" && process.env) {
    return { GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET };
  }
  return {};
}
function configOf(state: PersistedTenantState): Record<string, unknown> {
  const config = state.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Tenant provider configuration is invalid.");
  return config as Record<string, unknown>;
}
function validAccessToken(config: Record<string, unknown>): string | null {
  const token = typeof config.googleAccessToken === "string" ? config.googleAccessToken : "";
  const expiresAt = Date.parse(String(config.googleAccessTokenExpiresAt || ""));
  return token && (!Number.isFinite(expiresAt) || expiresAt > Date.now() + 60_000) ? token : null;
}

/** Workers-compatible Google OAuth refresh over the async tenant boundary. */
export async function getGoogleAccessTokenAsync(
  repository: TenantRepository,
  tenantId: string,
  environment?: GoogleOAuthEnvironment,
): Promise<string> {
  const record = await repository.load(tenantId);
  if (!record) throw new Error("Authenticated tenant state is not initialized.");
  const config = configOf(record.state);
  const current = validAccessToken(config);
  if (current) return current;

  const refreshToken = typeof config.googleRefreshToken === "string" ? config.googleRefreshToken : "";
  const env = runtimeEnvironment(environment);
  const clientId = typeof config.googleClientId === "string" && config.googleClientId ? config.googleClientId : env.GOOGLE_CLIENT_ID || "";
  const clientSecret = typeof config.googleClientSecret === "string" && config.googleClientSecret ? config.googleClientSecret : env.GOOGLE_CLIENT_SECRET || "";
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error("A verified Google OAuth connection is required; access expired. Please reconnect the Google account to continue.");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Google OAuth refresh failed (" + response.status + "); reconnect the Google account.");
  const payload = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!payload.access_token) throw new Error("Google OAuth refresh response did not contain an access token.");
  const expiresIn = Number(payload.expires_in);
  const expiresAt = new Date(Date.now() + Math.max(60, Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000).toISOString();

  const updated = await repository.update(
    tenantId,
    (): PersistedTenantState => { throw new Error("Tenant disappeared during Google token refresh."); },
    (draft) => {
      const nextConfig = configOf(draft);
      const concurrentlyRefreshed = validAccessToken(nextConfig);
      if (concurrentlyRefreshed) return concurrentlyRefreshed;
      if (nextConfig.googleRefreshToken !== refreshToken) {
        throw new Error("Google OAuth credentials changed during refresh; reload and reconnect if needed.");
      }
      nextConfig.googleAccessToken = payload.access_token;
      if (payload.refresh_token) nextConfig.googleRefreshToken = payload.refresh_token;
      nextConfig.googleAccessTokenExpiresAt = expiresAt;
      draft.config = nextConfig;
      return payload.access_token!;
    },
  );
  return updated.result;
}
