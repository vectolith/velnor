export interface GoogleOAuthStatePayload {
  tenantId: string;
  nonce: string;
  exp: number;
}
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function base64UrlDecode(value: string): Uint8Array {
  const normal = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normal + "=".repeat((4 - normal.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function hmacKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("VELNOR_TENANT_TOKEN_SECRET must be configured before Google OAuth can start.");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function validateTenantBinding(tenantId: string, nonce: string): void {
  if (!tenantId || tenantId.length > 192 || (!/^[A-Za-z0-9._@+:-]+$/.test(tenantId) && !/^v2_[A-Za-z0-9._@+-]+$/.test(tenantId))) {
    throw new Error("Invalid Google OAuth tenant binding.");
  }
  if (!nonce || nonce.length < 32) throw new Error("Google OAuth nonce is invalid.");
}
export async function createGoogleOAuthStateAsync(tenantId: string, nonce: string, secret: string, ttlSeconds = 600): Promise<string> {
  validateTenantBinding(tenantId, nonce);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new Error("Google OAuth state lifetime must be between 1 and 3600 seconds.");
  const payload: GoogleOAuthStatePayload = { tenantId, nonce, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(encoded));
  return encoded + "." + base64UrlEncode(new Uint8Array(signature));
}
export async function verifyGoogleOAuthStateAsync(value: string, secret: string): Promise<GoogleOAuthStatePayload | null> {
  try {
    const [encoded, signature, extra] = value.split(".");
    if (!encoded || !signature || extra) return null;
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), base64UrlDecode(signature), new TextEncoder().encode(encoded));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded))) as GoogleOAuthStatePayload;
    if (!payload || typeof payload.tenantId !== "string" || typeof payload.nonce !== "string" ||
        !Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    validateTenantBinding(payload.tenantId, payload.nonce);
    return payload;
  } catch { return null; }
}
