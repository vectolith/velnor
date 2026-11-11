import crypto from "node:crypto";
import { listUserIds, sanitizeUserId } from "@/lib/store";

export interface TenantDecision {
  ok: boolean;
  userId: string;
  status?: number;
  error?: string;
}

export const DEFAULT_TENANT = "owner";
const ISSUER = process.env.VELNOR_TENANT_TOKEN_ISSUER || "velnor-auth";
const AUDIENCE = process.env.VELNOR_TENANT_TOKEN_AUDIENCE || "velnor-api";

function decodeSegment(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return null;
  }
}

/**
 * The control plane accepts only a short-lived HS256 identity token minted by a
 * trusted authentication gateway. A tenant ID supplied in a body/header is not
 * an identity proof and must never select a tenant.
 */
export function authorizeChatTenant(
  authorization: string | null | undefined,
  knownUsers?: string[],
  nowSeconds = Math.floor(Date.now() / 1000)
): TenantDecision {
  const denied = (error: string, status = 401): TenantDecision => ({
    ok: false,
    userId: DEFAULT_TENANT,
    status,
    error,
  });

  const secret = process.env.VELNOR_TENANT_TOKEN_SECRET || "";
  if (secret.length < 32) {
    return denied("Tenant authentication is not configured.", 503);
  }

  const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(authorization || "");
  if (!match) return denied("A verified Velnor identity token is required.");

  const parts = match[1].split(".");
  if (parts.length !== 3) return denied("Malformed identity token.");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const headerBytes = decodeSegment(encodedHeader);
  const payloadBytes = decodeSegment(encodedPayload);
  const signature = decodeSegment(encodedSignature);
  if (!headerBytes || !payloadBytes || !signature) return denied("Malformed identity token.");

  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(headerBytes.toString("utf8"));
    claims = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return denied("Malformed identity token.");
  }

  if (header.alg !== "HS256" || header.typ !== "JWT") {
    return denied("Unsupported identity token algorithm.");
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(encodedHeader + "." + encodedPayload)
    .digest();
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) {
    return denied("Invalid identity token signature.");
  }

  if (claims.iss !== ISSUER || claims.aud !== AUDIENCE) {
    return denied("Identity token issuer or audience is invalid.");
  }
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds ||
      (typeof claims.nbf === "number" && claims.nbf > nowSeconds)) {
    return denied("Identity token is expired or not yet valid.");
  }
  if (typeof claims.iat !== "number" || claims.iat > nowSeconds + 60 ||
      claims.exp - claims.iat > 15 * 60) {
    return denied("Identity token lifetime is invalid.");
  }
  if (typeof claims.sub !== "string" || !/^[A-Za-z0-9._@+-]{1,96}$/.test(claims.sub) || claims.sub.startsWith("v2_") || claims.sub.startsWith("v2h_")) {
    return denied("Identity token subject is invalid.");
  }

  const requested = sanitizeUserId(claims.sub);
  const known = (knownUsers ?? safeListUsers()).map((id) => sanitizeUserId(id));
  if (requested !== sanitizeUserId(DEFAULT_TENANT) && !known.includes(requested)) {
    return denied("Identity is not provisioned for this Velnor deployment.", 403);
  }
  return { ok: true, userId: requested === sanitizeUserId(DEFAULT_TENANT) ? "default" : claims.sub as string };
}

function safeListUsers(): string[] {
  try {
    return listUserIds();
  } catch {
    return [];
  }
}
