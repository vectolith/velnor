import crypto from "crypto";

/**
 * Encryption for provider credentials at rest.
 *
 * Velnor persists user-supplied API keys in its state directory. Storing them in
 * clear means a backup or a stray .data copy is a credential dump, so values are
 * sealed with AES-256-GCM under a key derived from VELNOR_SECRET_KEY.
 *
 * Without VELNOR_SECRET_KEY the sealer is disabled and nothing secret is written
 * to disk at all (see store.sealConfig): production fails closed rather than
 * persisting plaintext credentials.
 */

const PREFIX = "v1:";

function derivedKey(): Buffer | null {
  const raw = process.env.VELNOR_SECRET_KEY;
  if (!raw || raw.trim().length < 16) return null;
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

export function secretsEnabled(): boolean {
  return derivedKey() !== null;
}

export function isSealed(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function sealSecret(plaintext: string): string {
  const key = derivedKey();
  if (!key) throw new Error("VELNOR_SECRET_KEY is not configured");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function openSecret(sealed: string): string {
  const key = derivedKey();
  if (!key) throw new Error("VELNOR_SECRET_KEY is not configured");
  if (!isSealed(sealed)) throw new Error("Value is not sealed");
  const buffer = Buffer.from(sealed.slice(PREFIX.length), "base64");
  if (buffer.length < 28) throw new Error("Sealed value is truncated");
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Encrypt every string field whose name looks like a credential. */
export function sealRecord<T extends Record<string, unknown>>(record: T): T {
  const out: Record<string, unknown> = { ...record };
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value && isCredentialField(key) && !isSealed(value)) {
      out[key] = sealSecret(value);
    }
  }
  return out as T;
}

/** Reverse of sealRecord; leaves anything unsealed untouched. */
export function openRecord<T extends Record<string, unknown>>(record: T): T {
  const out: Record<string, unknown> = { ...record };
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && isSealed(value)) {
      try {
        out[key] = openSecret(value);
      } catch {
        out[key] = ""; // undecryptable after a key rotation: drop rather than crash
      }
    }
  }
  return out as T;
}

/**
 * Match provider credentials by suffix. Include both key- and token-based
 * provider naming conventions (for example LoopMessage authKey/secretKey).
 */
export function isCredentialField(field: string): boolean {
  return /(apiKey|accessToken|refreshToken|authToken|authKey|clientSecret|signingSecret|botToken|codeVerifier|secretKey|secret|password|pin)$/i.test(
    field
  );
}
