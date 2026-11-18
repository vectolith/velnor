import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { verifyDiscordInteractionSignature } from "../src/lib/security/discordAuth";

test("Discord accepts a fresh Ed25519-signed interaction", () => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const publicKey = der.subarray(-32).toString("hex");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: 1 });
  const signature = crypto.sign(null, Buffer.from(timestamp + body), pair.privateKey).toString("hex");
  assert.equal(verifyDiscordInteractionSignature({ publicKey, signature, timestamp, rawBody: body }), true);
});

test("Discord rejects altered bodies, malformed signatures and stale timestamps", () => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const publicKey = der.subarray(-32).toString("hex");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = "{}";
  const signature = crypto.sign(null, Buffer.from(timestamp + body), pair.privateKey).toString("hex");
  assert.equal(verifyDiscordInteractionSignature({ publicKey, signature, timestamp, rawBody: "{\"changed\":true}" }), false);
  assert.equal(verifyDiscordInteractionSignature({ publicKey, signature: "bad", timestamp, rawBody: body }), false);
  assert.equal(verifyDiscordInteractionSignature({ publicKey, signature, timestamp: "1000000000", rawBody: body }), false);
});
