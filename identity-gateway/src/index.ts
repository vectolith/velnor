interface Env {
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  VELNOR_ORIGIN: string;
  VELNOR_SHARED_SECRET: string;
  VELNOR_TENANT_TOKEN_SECRET: string;
  VELNOR_PROVISIONING_SECRET: string;
  VELNOR_TENANT_TOKEN_ISSUER?: string;
  VELNOR_TENANT_TOKEN_AUDIENCE?: string;
}

interface AccessClaims {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
  email?: unknown;
}

interface JwksResponse {
  keys?: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }>;
}

let jwksCache: { keys: NonNullable<JwksResponse["keys"]>; expiresAt: number } | null = null;
const provisionedTenants = new Map<string, number>();
const encoder = new TextEncoder();

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function decodeBase64Url(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url segment");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function parseJsonSegment<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

function accessTeamOrigin(env: Env): string {
  const raw = env.CF_ACCESS_TEAM_DOMAIN.trim();
  const url = new URL(raw.startsWith("https://") ? raw : "https://" + raw);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("CF_ACCESS_TEAM_DOMAIN must be an HTTPS team domain origin");
  }
  return url.origin;
}

async function getAccessKeys(env: Env): Promise<NonNullable<JwksResponse["keys"]>> {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const response = await fetch(new URL("/cdn-cgi/access/certs", accessTeamOrigin(env)), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Could not retrieve Cloudflare Access signing keys");
  const payload = await response.json() as JwksResponse;
  if (!Array.isArray(payload.keys) || payload.keys.length === 0) throw new Error("Cloudflare Access returned no signing keys");
  jwksCache = { keys: payload.keys, expiresAt: Date.now() + 5 * 60 * 1000 };
  return payload.keys;
}

async function verifyAccessAssertion(token: string, env: Env): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed Cloudflare Access assertion");
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const header = parseJsonSegment<{ alg?: string; typ?: string; kid?: string }>(encodedHeader);
  if (header.alg !== "RS256" || header.typ !== "JWT" || typeof header.kid !== "string") {
    throw new Error("Unsupported Cloudflare Access assertion");
  }

  const keys = await getAccessKeys(env);
  const jwk = keys.find((key) => key.kid === header.kid && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
  if (!jwk) {
    jwksCache = null;
    throw new Error("Unknown Cloudflare Access signing key");
  }

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    decodeBase64Url(encodedSignature),
    encoder.encode(encodedHeader + "." + encodedClaims),
  );
  if (!valid) throw new Error("Invalid Cloudflare Access signature");

  const claims = parseJsonSegment<AccessClaims>(encodedClaims);
  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== accessTeamOrigin(env) || !audience.includes(env.CF_ACCESS_AUD)) {
    throw new Error("Cloudflare Access issuer or audience mismatch");
  }
  if (
    typeof claims.sub !== "string" ||
    claims.sub.length < 1 ||
    claims.sub.length > 512 ||
    typeof claims.exp !== "number" ||
    claims.exp <= now ||
    (typeof claims.nbf === "number" && claims.nbf > now) ||
    typeof claims.iat !== "number" ||
    claims.iat > now + 60 ||
    claims.iat < now - 24 * 60 * 60
  ) {
    throw new Error("Cloudflare Access assertion is expired or invalid");
  }
  return claims;
}

async function deriveTenantId(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(subject));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return "cf-" + hex;
}

async function signVelnorToken(tenantId: string, env: Env): Promise<string> {
  if (env.VELNOR_TENANT_TOKEN_SECRET.length < 32) throw new Error("Velnor token signing secret is not configured");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => encodeBase64Url(encoder.encode(JSON.stringify(value)));
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    iss: env.VELNOR_TENANT_TOKEN_ISSUER || "velnor-auth",
    aud: env.VELNOR_TENANT_TOKEN_AUDIENCE || "velnor-api",
    sub: tenantId,
    tenant_id: tenantId,
    iat: now,
    nbf: now - 1,
    exp: now + 5 * 60,
    jti: crypto.randomUUID(),
  });
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.VELNOR_TENANT_TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(header + "." + payload));
  return header + "." + payload + "." + encodeBase64Url(new Uint8Array(signature));
}

async function provisionTenant(tenantId: string, env: Env): Promise<void> {
  const cachedUntil = provisionedTenants.get(tenantId) || 0;
  if (cachedUntil > Date.now()) return;
  if (env.VELNOR_PROVISIONING_SECRET.length < 32) throw new Error("Velnor provisioning secret is not configured");
  const origin = new URL(env.VELNOR_ORIGIN);
  const response = await fetch(new URL("/api/internal/tenants/provision", origin), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-velnor-provisioning-secret": env.VELNOR_PROVISIONING_SECRET,
    },
    body: JSON.stringify({ tenantId }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Velnor tenant provisioning failed with status " + response.status);
  if (provisionedTenants.size >= 1000) {
    const oldestTenant = provisionedTenants.keys().next().value;
    if (oldestTenant) provisionedTenants.delete(oldestTenant);
  }
  provisionedTenants.set(tenantId, Date.now() + 5 * 60 * 1000);
}

function isPublicApiPath(pathname: string): boolean {
  return pathname === "/api/health" ||
    pathname.startsWith("/api/webhooks/") ||
    pathname.startsWith("/api/cron/") ||
    pathname === "/api/auth/google/callback";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    if (!incoming.pathname.startsWith("/api/")) return fetch(request);
    if (request.method === "OPTIONS") return fetch(request);
    // Tenant provisioning is an internal control-plane operation. The Worker
    // invokes it directly against VELNOR_ORIGIN with its separate secret.
    if (incoming.pathname === "/api/internal/tenants/provision") {
      return jsonError("Not found.", 404);
    }

    if (!env.VELNOR_ORIGIN || !env.VELNOR_SHARED_SECRET || env.VELNOR_SHARED_SECRET.length < 32) {
      return jsonError("Identity gateway origin or perimeter secret is not configured.", 503);
    }

    let upstreamOrigin: URL;
    try {
      upstreamOrigin = new URL(env.VELNOR_ORIGIN);
      if (upstreamOrigin.protocol !== "https:" && upstreamOrigin.hostname !== "localhost") {
        return jsonError("Velnor origin must use HTTPS.", 503);
      }
      if (
        upstreamOrigin.username ||
        upstreamOrigin.password ||
        upstreamOrigin.pathname !== "/" ||
        upstreamOrigin.search ||
        upstreamOrigin.hash ||
        upstreamOrigin.hostname === incoming.hostname
      ) {
        return jsonError("Velnor origin must be a separate origin that does not route back through this Worker.", 503);
      }
    } catch {
      return jsonError("Velnor origin is invalid.", 503);
    }

    const upstreamUrl = new URL(incoming.pathname + incoming.search, upstreamOrigin);
    const publicPath = isPublicApiPath(incoming.pathname);
    const headers = new Headers(request.headers);
    headers.delete("Cf-Access-Jwt-Assertion");
    headers.delete("x-velnor-provisioning-secret");
    headers.delete("host");
    headers.delete("x-forwarded-for");
    headers.delete("x-real-ip");
    headers.delete("x-forwarded-host");
    headers.delete("x-forwarded-proto");

    if (publicPath) {
      // External providers cannot present an Access assertion. The Worker
      // still injects the deployment secret so the origin can reject direct
      // calls that bypass this gateway. Preserve provider auth headers.
      headers.set("x-velnor-secret", env.VELNOR_SHARED_SECRET);
      if (incoming.pathname === "/api/health") headers.delete("x-velnor-secret");
      try {
        const method = request.method.toUpperCase();
        return await fetch(new Request(upstreamUrl, {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : request.body,
          redirect: "manual",
        }));
      } catch (error) {
        console.error("Velnor public upstream request failed:", error);
        return jsonError("Velnor API is temporarily unavailable.", 502);
      }
    }

    if (
      !env.CF_ACCESS_TEAM_DOMAIN ||
      !env.CF_ACCESS_AUD ||
      !env.VELNOR_TENANT_TOKEN_SECRET ||
      env.VELNOR_TENANT_TOKEN_SECRET.length < 32 ||
      !env.VELNOR_PROVISIONING_SECRET ||
      env.VELNOR_PROVISIONING_SECRET.length < 32
    ) {
      return jsonError("Identity gateway is not configured.", 503);
    }

    const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!assertion) return jsonError("A Cloudflare Access identity is required.", 401);

    let claims: AccessClaims;
    try {
      claims = await verifyAccessAssertion(assertion, env);
    } catch (error) {
      console.warn("Cloudflare Access assertion rejected:", error);
      return jsonError("Identity verification failed.", 401);
    }

    let bearer: string;
    try {
      const tenantId = await deriveTenantId(claims.sub as string);
      await provisionTenant(tenantId, env);
      bearer = await signVelnorToken(tenantId, env);
    } catch (error) {
      console.error("Velnor tenant provisioning or token issuance failed:", error);
      return jsonError("Identity service is temporarily unavailable.", 503);
    }

    try {
      headers.set("Authorization", "Bearer " + bearer);
      headers.set("x-velnor-secret", env.VELNOR_SHARED_SECRET);
      const method = request.method.toUpperCase();
      const upstreamRequest = new Request(upstreamUrl, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      });
      return await fetch(upstreamRequest);
    } catch (error) {
      console.error("Velnor upstream request failed:", error);
      return jsonError("Velnor API is temporarily unavailable.", 502);
    }
  },
};
