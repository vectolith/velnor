import assert from "node:assert/strict";
import test from "node:test";
import { isCredentialField, isSealed, openRecord, sealRecord } from "../src/lib/security/secretBox";

const KEY = "unit-test-key-at-least-16-chars";

test("credentials round-trip through the sealer", () => {
  const env = process.env as Record<string, string | undefined>;
  const original = env.VELNOR_SECRET_KEY;
  env.VELNOR_SECRET_KEY = KEY;
  try {
    const sealed = sealRecord({ geminiApiKey: "AIza-secret", geminiModel: "flash" });
    assert.equal(isSealed(sealed.geminiApiKey), true);
    assert.equal(sealed.geminiModel, "flash", "non-credential fields stay readable");
    assert.notEqual(sealed.geminiApiKey, "AIza-secret");
    const opened = openRecord(sealed);
    assert.equal(opened.geminiApiKey, "AIza-secret");
  } finally {
    if (original === undefined) delete env.VELNOR_SECRET_KEY;
    else env.VELNOR_SECRET_KEY = original;
  }
});

test("LoopMessage authKey and secretKey fields are encrypted at rest", () => {
  const env = process.env as Record<string, string | undefined>;
  const original = env.VELNOR_SECRET_KEY;
  env.VELNOR_SECRET_KEY = KEY;
  try {
    const credentials = {
      loopMessageAuthKey: "loop-auth-value",
      loopMessageSecretKey: "loop-secret-value",
      loopMessageFromNumber: "+15555550123",
    };
    const sealed = sealRecord(credentials);
    assert.equal(isSealed(sealed.loopMessageAuthKey), true);
    assert.equal(isSealed(sealed.loopMessageSecretKey), true);
    assert.equal(sealed.loopMessageFromNumber, credentials.loopMessageFromNumber);
    assert.deepEqual(openRecord(sealed), credentials);
  } finally {
    if (original === undefined) delete env.VELNOR_SECRET_KEY;
    else env.VELNOR_SECRET_KEY = original;
  }
});

test("a tampered ciphertext is rejected, not silently trusted", () => {
  const env = process.env as Record<string, string | undefined>;
  const original = env.VELNOR_SECRET_KEY;
  env.VELNOR_SECRET_KEY = KEY;
  try {
    const sealed = sealRecord({ openaiApiKey: "sk-test" });
    const tampered = sealed.openaiApiKey.slice(0, -4) + "AAAA";
    const opened = openRecord({ openaiApiKey: tampered });
    assert.throws(() => openRecord({ openaiApiKey: tampered }), /Unsupported|malformed|authenticate|Unsupported state|Unsupported message/i);
  } finally {
    if (original === undefined) delete env.VELNOR_SECRET_KEY;
    else env.VELNOR_SECRET_KEY = original;
  }
});

test("credential field detection matches the config keys Velnor actually stores", () => {
  for (const field of [
    "geminiApiKey",
    "openaiApiKey",
    "googleAccessToken",
    "slackSigningSecret",
    "twilioAuthToken",
    "sendblueApiSecret",
    "loopMessageAuthKey",
    "loopMessageSecretKey",
  ]) {
    assert.equal(isCredentialField(field), true, `${field} should be treated as a credential`);
  }
  for (const field of ["geminiModel", "treasury", "activeProvider", "loopMessageFromNumber"]) {
    assert.equal(isCredentialField(field), false, `${field} should not be sealed`);
  }
});


test("keyring supports decrypting old key versions and resealing with the active key", () => {
  const env = process.env as Record<string, string | undefined>;
  const oldRing = env.VELNOR_SECRET_KEYRING_JSON;
  const oldLegacy = env.VELNOR_SECRET_KEY;
  try {
    env.VELNOR_SECRET_KEYRING_JSON = JSON.stringify({ activeKeyId: "old", keys: { old: "old-key-material-at-least-16" } });
    const previous = sealRecord({ openaiApiKey: "sk-rotation-test" }).openaiApiKey;
    env.VELNOR_SECRET_KEYRING_JSON = JSON.stringify({ activeKeyId: "new", keys: { old: "old-key-material-at-least-16", new: "new-key-material-at-least-16" } });
    const opened = openRecord({ openaiApiKey: previous });
    assert.equal(opened.openaiApiKey, "sk-rotation-test");
    const rotated = sealRecord(opened).openaiApiKey;
    assert.match(rotated, /^v2:new:/);
    assert.equal(openRecord({ openaiApiKey: rotated }).openaiApiKey, "sk-rotation-test");
  } finally {
    if (oldRing === undefined) delete env.VELNOR_SECRET_KEYRING_JSON; else env.VELNOR_SECRET_KEYRING_JSON = oldRing;
    if (oldLegacy === undefined) delete env.VELNOR_SECRET_KEY; else env.VELNOR_SECRET_KEY = oldLegacy;
  }
});

test("missing key version throws instead of silently dropping credential data", () => {
  const env = process.env as Record<string, string | undefined>;
  const oldRing = env.VELNOR_SECRET_KEYRING_JSON;
  const oldLegacy = env.VELNOR_SECRET_KEY;
  try {
    env.VELNOR_SECRET_KEYRING_JSON = JSON.stringify({ activeKeyId: "new", keys: { new: "new-key-material-at-least-16" } });
    delete env.VELNOR_SECRET_KEY;
    assert.throws(() => openRecord({ openaiApiKey: "v2:retired:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }), /key 'retired' is unavailable/);
  } finally {
    if (oldRing === undefined) delete env.VELNOR_SECRET_KEYRING_JSON; else env.VELNOR_SECRET_KEYRING_JSON = oldRing;
    if (oldLegacy === undefined) delete env.VELNOR_SECRET_KEY; else env.VELNOR_SECRET_KEY = oldLegacy;
  }
});
