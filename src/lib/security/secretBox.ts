import crypto from "crypto";

const V1_PREFIX = "v1:";
const V2_PREFIX = "v2:";
const AAD_PREFIX = "velnor-credential:v2:";

type Keyring = { activeKeyId: string; keys: Record<string, string> };

function legacyKey(): Buffer | null {
  const raw = process.env.VELNOR_SECRET_KEY;
  if (!raw || raw.trim().length < 16) return null;
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

function readKeyring(): Keyring | null {
  const raw = process.env.VELNOR_SECRET_KEYRING_JSON;
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("VELNOR_SECRET_KEYRING_JSON is not valid JSON"); }
  if (!parsed || typeof parsed !== "object") throw new Error("VELNOR_SECRET_KEYRING_JSON must be an object");
  const candidate = parsed as Partial<Keyring>;
  if (!candidate.activeKeyId || !/^[A-Za-z0-9_-]{1,32}$/.test(candidate.activeKeyId) || !candidate.keys || typeof candidate.keys !== "object" || Array.isArray(candidate.keys)) {
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

function keyFor(id: string): Buffer | null {
  const ring = readKeyring();
  const raw = ring?.keys[id] ?? (id === "legacy" ? process.env.VELNOR_SECRET_KEY : undefined);
  if (!raw || raw.trim().length < 16) return null;
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

function activeKey(): { id: string; key: Buffer } | null {
  const ring = readKeyring();
  if (ring) {
    const key = keyFor(ring.activeKeyId);
    if (!key) throw new Error("Active credential encryption key is unavailable");
    return { id: ring.activeKeyId, key };
  }
  const key = legacyKey();
  return key ? { id: "legacy", key } : null;
}

export function secretsEnabled(): boolean { return activeKey() !== null; }
export function isSealed(value: unknown): boolean {
  return typeof value === "string" && (value.startsWith(V1_PREFIX) || /^v2:[A-Za-z0-9_-]{1,32}:/.test(value));
}

export function sealSecret(plaintext: string): string {
  const active = activeKey();
  if (!active) throw new Error("VELNOR_SECRET_KEY or VELNOR_SECRET_KEYRING_JSON is not configured");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", active.key, iv);
  cipher.setAAD(Buffer.from(AAD_PREFIX + active.id, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
  return V2_PREFIX + active.id + ":" + payload;
}

function decrypt(buffer: Buffer, key: Buffer, aad?: Buffer): string {
  if (buffer.length < 28) throw new Error("Credential ciphertext is malformed");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12));
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString("utf8");
}

export function openSecret(sealed: string): string {
  if (sealed.startsWith(V1_PREFIX)) {
    const key = legacyKey();
    if (!key) throw new Error("Legacy credential key is unavailable; restore VELNOR_SECRET_KEY without modifying stored ciphertext");
    return decrypt(Buffer.from(sealed.slice(V1_PREFIX.length), "base64"), key);
  }
  const match = /^v2:([A-Za-z0-9_-]{1,32}):([A-Za-z0-9+/=]+)$/.exec(sealed);
  if (!match) throw new Error("Credential ciphertext format is unsupported");
  const [, id, encoded] = match;
  const key = keyFor(id);
  if (!key) throw new Error("Credential decryption key '" + id + "' is unavailable; restore it before retrying");
  return decrypt(Buffer.from(encoded, "base64"), key, Buffer.from(AAD_PREFIX + id, "utf8"));
}

export function sealRecord<T extends Record<string, unknown>>(record: T): T {
  const out: Record<string, unknown> = { ...record };
  for (const [field, value] of Object.entries(record)) {
    if (typeof value === "string" && value && isCredentialField(field) && !isSealed(value)) out[field] = sealSecret(value);
  }
  return out as T;
}

/** Propagate decryption errors so unreadable credentials are never silently erased or overwritten. */
export function openRecord<T extends Record<string, unknown>>(record: T): T {
  const out: Record<string, unknown> = { ...record };
  for (const [field, value] of Object.entries(record)) {
    if (typeof value === "string" && isSealed(value)) out[field] = openSecret(value);
  }
  return out as T;
}

export function isCredentialField(field: string): boolean {
  return /^(loopMessageAuthKey|loopMessageSecretKey)$/i.test(field) || /(apiKey|accessToken|refreshToken|authToken|clientSecret|signingSecret|botToken|codeVerifier|secret|password|pin)$/i.test(field);
}
