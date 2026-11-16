import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { ProviderConfig } from "./types";

const PREFIX = "velnor:enc:v1:";
const SECRET_FIELDS: Array<Exclude<keyof ProviderConfig, "activeProvider" | "geminiModel" | "geminiImageModel" | "openaiModel" | "anthropicModel">> = [
  "geminiApiKey",
  "openaiApiKey",
  "anthropicApiKey",
  "twilioAccountSid",
  "twilioAuthToken",
  "sendblueApiKey",
  "sendblueApiSecret",
  "loopMessageAuthKey",
  "loopMessageSecretKey",
  "slackBotToken",
  "slackSigningSecret",
  "googleClientSecret",
  "googleAccessToken",
  "googleRefreshToken",
];

function getEncryptionKey(): Buffer | null {
  const secret = process.env.VELNOR_SECRET_KEY || "";
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("VELNOR_SECRET_KEY is required to read or persist production credentials.");
    }
    return null;
  }
  if (secret.length < 32) {
    throw new Error("VELNOR_SECRET_KEY must contain at least 32 characters.");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

function encrypt(value: string, key: Buffer): string {
  if (value.startsWith(PREFIX)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

function decrypt(value: string, key: Buffer): string {
  if (!value.startsWith(PREFIX)) return value;
  const payload = Buffer.from(value.slice(PREFIX.length), "base64url");
  if (payload.length < 29) throw new Error("Stored credential ciphertext is invalid.");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function sealProviderSecrets(config: ProviderConfig): ProviderConfig {
  const key = getEncryptionKey();
  if (!key) return structuredClone(config);
  const sealed = { ...config };
  for (const field of SECRET_FIELDS) {
    const value = sealed[field];
    if (typeof value === "string" && value) sealed[field] = encrypt(value, key);
  }
  return sealed;
}

export function openProviderSecrets(config: ProviderConfig): ProviderConfig {
  const key = getEncryptionKey();
  if (!key) {
    if (SECRET_FIELDS.some((field) => typeof config[field] === "string" && config[field]!.startsWith(PREFIX))) {
      throw new Error("VELNOR_SECRET_KEY is required to decrypt stored credentials.");
    }
    return structuredClone(config);
  }
  const opened = { ...config };
  for (const field of SECRET_FIELDS) {
    const value = opened[field];
    if (typeof value === "string" && value.startsWith(PREFIX)) {
      opened[field] = decrypt(value, key);
    }
  }
  return opened;
}
