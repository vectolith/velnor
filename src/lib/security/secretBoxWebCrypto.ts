/**
 * Workers-compatible AES-256-GCM credential envelope.
 * Preserves the Node secretBox v1/v2 wire formats and AAD semantics.
 */
const V1_PREFIX = "v1:";
const V2_PREFIX = "v2:";
const AAD_PREFIX = "velnor-credential:v2:";

export interface CredentialCryptoEnvironment {
  VELNOR_SECRET_KEY?: string;
  VELNOR_SECRET_KEYRING_JSON?: string;
}

interface Keyring { activeKeyId: string; keys: Record<string, string>; }

function environment(override?: CredentialCryptoEnvironment): CredentialCryptoEnvironment {
  if (override) return override;
  if (typeof process !== "undefined" && process.env) {
    return {
      VELNOR_SECRET_KEY: process.env.VELNOR_SECRET_KEY,
      VELNOR_SECRET_KEYRING_JSON: process.env.VELNOR_SECRET_KEYRING_JSON,
    };
  }
  return {};
}

function readKeyring(env: CredentialCryptoEnvironment): Keyring | null {
  if (!env.VELNOR_SECRET_KEYRING_JSON) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(env.VELNOR_SECRET_KEYRING_JSON); }
  catch { throw new Error("VELNOR_SECRET_KEYRING_JSON is not valid JSON"); }
  if (!parsed || typeof parsed !== "object") throw new Error("VELNOR_SECRET_KEYRING_JSON must be an object");
  const candidate = parsed as Partial<Keyring>;
  if (!candidate.activeKeyId || !/^[A-Za-z0-9_-]{1,32}$/.test(candidate.activeKeyId) ||
      !candidate.keys || typeof candidate.keys !== "object" || Array.isArray(candidate.keys)) {
    throw new Error("VELNOR_SECRET_KEYRING_JSON must contain activeKeyId and a keys object");
  }
  for (const [id, value] of Object.entries(candidate.keys)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || typeof value !== "string" || value.trim().length < 16) {
      throw new Error("VELNOR_SECRET_KEYRING_JSON contains an invalid key entry");
    }
  }
  if (!candidate.keys[candidate.activeKeyId]) throw new Error("Active credential key is missing from keyring");
  return candidate as Keyring;
}

function rawKeyFor(id: string, env: CredentialCryptoEnvironment): string | null {
  const ring = readKeyring(env);
  const raw = ring?.keys[id] ?? (id === "legacy" ? env.VELNOR_SECRET_KEY : undefined);
  return raw && raw.trim().length >= 16 ? raw : null;
}

async function importAesKey(raw: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function isCredentialSealed(value: unknown): boolean {
  return typeof value === "string" && (value.startsWith(V1_PREFIX) || /^v2:[A-Za-z0-9_-]{1,32}:/.test(value));
}

export function isCredentialFieldWebCrypto(field: string): boolean {
  return /^(loopMessageAuthKey|loopMessageSecretKey)$/i.test(field) ||
    /(apiKey|accessToken|refreshToken|authToken|clientSecret|signingSecret|botToken|codeVerifier|secret|password|pin)$/i.test(field);
}

export async function sealCredentialAsync(
  plaintext: string,
  override?: CredentialCryptoEnvironment,
): Promise<string> {
  const env = environment(override);
  const ring = readKeyring(env);
  const id = ring?.activeKeyId ?? "legacy";
  const raw = ring?.keys[id] ?? env.VELNOR_SECRET_KEY;
  if (!raw || raw.trim().length < 16) {
    throw new Error("VELNOR_SECRET_KEY or VELNOR_SECRET_KEYRING_JSON is not configured");
  }
  const key = await importAesKey(raw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(AAD_PREFIX + id);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
    key,
    new TextEncoder().encode(plaintext),
  ));
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const tag = encrypted.subarray(encrypted.length - 16);
  const payload = new Uint8Array(iv.length + tag.length + ciphertext.length);
  payload.set(iv, 0);
  payload.set(tag, iv.length);
  payload.set(ciphertext, iv.length + tag.length);
  return V2_PREFIX + id + ":" + toBase64(payload);
}

export async function openCredentialAsync(
  sealed: string,
  override?: CredentialCryptoEnvironment,
): Promise<string> {
  const env = environment(override);
  let id = "legacy";
  let encoded: string;
  let aad: Uint8Array | undefined;
  if (sealed.startsWith(V1_PREFIX)) {
    encoded = sealed.slice(V1_PREFIX.length);
  } else {
    const match = /^v2:([A-Za-z0-9_-]{1,32}):([A-Za-z0-9+/=]+)$/.exec(sealed);
    if (!match) throw new Error("Credential ciphertext format is unsupported");
    id = match[1];
    encoded = match[2];
    aad = new TextEncoder().encode(AAD_PREFIX + id);
  }
  const raw = rawKeyFor(id, env);
  if (!raw) throw new Error("Credential decryption key '" + id + "' is unavailable; restore it before retrying");
  const payload = fromBase64(encoded);
  if (payload.length < 28) throw new Error("Credential ciphertext is malformed");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);
  try {
    const key = await importAesKey(raw);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, ...(aad ? { additionalData: aad } : {}), tagLength: 128 },
      key,
      combined,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("Credential authentication failed; refusing to return or overwrite unreadable secrets.");
  }
}

export async function sealCredentialRecordAsync<T extends Record<string, unknown>>(
  record: T,
  override?: CredentialCryptoEnvironment,
): Promise<T> {
  const out: Record<string, unknown> = { ...record };
  for (const [field, value] of Object.entries(record)) {
    if (typeof value === "string" && value && isCredentialFieldWebCrypto(field) && !isCredentialSealed(value)) {
      out[field] = await sealCredentialAsync(value, override);
    }
  }
  return out as T;
}

export async function openCredentialRecordAsync<T extends Record<string, unknown>>(
  record: T,
  override?: CredentialCryptoEnvironment,
): Promise<T> {
  const out: Record<string, unknown> = { ...record };
  for (const [field, value] of Object.entries(record)) {
    if (typeof value === "string" && isCredentialSealed(value)) {
      out[field] = await openCredentialAsync(value, override);
    }
  }
  return out as T;
}
