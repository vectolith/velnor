import crypto from "node:crypto";

const DISCORD_TIMESTAMP_SKEW_SECONDS = 300;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyDiscordInteractionSignature(input: {
  publicKey: string;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
  rawBody: string;
  nowSeconds?: number;
}): boolean {
  if (!/^[a-f0-9]{64}$/i.test(input.publicKey)) return false;
  if (!input.signature || !/^[a-f0-9]{128}$/i.test(input.signature)) return false;
  if (!input.timestamp || !/^\d{10,}$/.test(input.timestamp)) return false;
  const timestampSeconds = Number(input.timestamp);
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestampSeconds) ||
      Math.abs(nowSeconds - timestampSeconds) > DISCORD_TIMESTAMP_SKEW_SECONDS) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(input.publicKey, "hex")]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(
      null,
      Buffer.from(input.timestamp + input.rawBody, "utf8"),
      key,
      Buffer.from(input.signature, "hex"),
    );
  } catch {
    return false;
  }
}
