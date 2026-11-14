import crypto from "node:crypto";

export interface GoogleOAuthStatePayload {
  tenantId: string;
  nonce: string;
  exp: number;
}

function signingSecret(): string {
  const secret = process.env.VELNOR_TENANT_TOKEN_SECRET || "";
  if (secret.length < 32) throw new Error("VELNOR_TENANT_TOKEN_SECRET must be configured before Google OAuth can start.");
  return secret;
}

export function createGoogleOAuthState(tenantId: string, nonce: string, ttlSeconds = 600): string {
  if (!tenantId || tenantId.length > 192 || !/^[A-Za-z0-9._@+:-]+$/.test(tenantId) && !/^v2_[A-Za-z0-9._@+-]+$/.test(tenantId)) {
    throw new Error("Invalid Google OAuth tenant binding.");
  }
  if (!nonce || nonce.length < 32) throw new Error("Google OAuth nonce is invalid.");
  const payload: GoogleOAuthStatePayload = {
    tenantId,
    nonce,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", signingSecret()).update(encoded).digest("base64url");
  return encoded + "." + signature;
}

export function verifyGoogleOAuthState(value: string): GoogleOAuthStatePayload | null {
  try {
    const [encoded, signature, extra] = value.split(".");
    if (!encoded || !signature || extra) return null;
    const expected = crypto.createHmac("sha256", signingSecret()).update(encoded).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as GoogleOAuthStatePayload;
    if (
      !payload ||
      typeof payload.tenantId !== "string" ||
      typeof payload.nonce !== "string" ||
      !Number.isInteger(payload.exp) ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) return null;
    return payload;
  } catch {
    return null;
  }
}
