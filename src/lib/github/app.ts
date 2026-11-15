import { createHash, createPrivateKey, sign as signJwt } from "node:crypto";

const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
}

let tokenCache: { token: string; expiresAt: number; cacheKey: string } | null = null;

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Missing required GitHub App configuration: ${name}`);
  return value.trim();
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function createAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 8 * 60, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = signJwt("RSA-SHA256", Buffer.from(signingInput), createPrivateKey(privateKeyPem));
  return `${signingInput}.${base64url(signature)}`;
}

export function getGitHubAppConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig {
  return {
    appId: required(env.VELNOR_GITHUB_APP_ID, "VELNOR_GITHUB_APP_ID"),
    privateKey: required(env.VELNOR_GITHUB_PRIVATE_KEY, "VELNOR_GITHUB_PRIVATE_KEY").replace(/\\\\n/g, "\n"),
    installationId: required(env.VELNOR_GITHUB_INSTALLATION_ID, "VELNOR_GITHUB_INSTALLATION_ID"),
  };
}

function tokenCacheKey(config: GitHubAppConfig): string {
  // Bind cached credentials to the complete App identity. A key rotation or
  // App/installation change must never reuse an installation token minted by
  // the previous configuration.
  return createHash("sha256")
    .update(`${config.appId}\0${config.installationId}\0${config.privateKey}`)
    .digest("hex");
}

export async function getInstallationToken(config = getGitHubAppConfig()): Promise<string> {
  const cacheKey = tokenCacheKey(config);
  if (tokenCache && tokenCache.cacheKey === cacheKey && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }

  const response = await fetch(
    `${API_ORIGIN}/app/installations/${encodeURIComponent(config.installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${createAppJwt(config.appId, config.privateKey)}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub App token exchange failed (HTTP ${response.status})`);
  }

  const payload = await response.json() as InstallationTokenResponse;
  const expiresAt = typeof payload.expires_at === "string" ? Date.parse(payload.expires_at) : Number.NaN;
  if (typeof payload.token !== "string" || !payload.token || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000) {
    throw new Error("GitHub returned an incomplete or already-expiring installation token response");
  }

  tokenCache = { token: payload.token, expiresAt, cacheKey };
  return payload.token;
}

export async function githubAppRequest<T>(
  path: string,
  init: RequestInit = {},
  config = getGitHubAppConfig(),
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("GitHub API path must be an absolute API path");
  }

  const token = await getInstallationToken(config);
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-GitHub-Api-Version", API_VERSION);

  const response = await fetch(new URL(path, API_ORIGIN), {
    ...init,
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    const requestId = response.headers.get("x-github-request-id");
    throw new Error(
      `GitHub API request failed (HTTP ${response.status})${requestId ? `; request ${requestId}` : ""}`,
    );
  }

  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}
