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

test("a tampered ciphertext is rejected, not silently trusted", () => {
  const env = process.env as Record<string, string | undefined>;
  const original = env.VELNOR_SECRET_KEY;
  env.VELNOR_SECRET_KEY = KEY;
  try {
    const sealed = sealRecord({ openaiApiKey: "sk-test" });
    const tampered = sealed.openaiApiKey.slice(0, -4) + "AAAA";
    const opened = openRecord({ openaiApiKey: tampered });
    assert.equal(opened.openaiApiKey, "", "undecryptable values are dropped");
  } finally {
    if (original === undefined) delete env.VELNOR_SECRET_KEY;
    else env.VELNOR_SECRET_KEY = original;
  }
});

test("credential field detection matches the config keys Velnor actually stores", () => {
  for (const field of ["geminiApiKey", "openaiApiKey", "googleAccessToken", "slackSigningSecret", "twilioAuthToken", "sendblueApiSecret"]) {
    assert.equal(isCredentialField(field), true, `${field} should be treated as a credential`);
  }
  for (const field of ["geminiModel", "treasury", "activeProvider"]) {
    assert.equal(isCredentialField(field), false, `${field} should not be sealed`);
  }
});
