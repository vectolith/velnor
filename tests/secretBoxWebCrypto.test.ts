import assert from "node:assert/strict";
import test from "node:test";
import { openSecret, sealSecret } from "../src/lib/security/secretBox";
import {
  openCredentialAsync,
  openCredentialRecordAsync,
  sealCredentialAsync,
  sealCredentialRecordAsync,
} from "../src/lib/security/secretBoxWebCrypto";

const secretKey = "web-crypto-compatibility-test-key-32-bytes";

test("Workers Web Crypto envelope interoperates with the existing Node secretBox v1/v2 format", async () => {
  const previous = process.env.VELNOR_SECRET_KEY;
  process.env.VELNOR_SECRET_KEY = secretKey;
  try {
    const webSealed = await sealCredentialAsync("provider-token");
    assert.match(webSealed, /^v2:legacy:/);
    assert.equal(openSecret(webSealed), "provider-token");

    const nodeSealed = sealSecret("legacy-token");
    assert.equal(await openCredentialAsync(nodeSealed), "legacy-token");
  } finally {
    if (previous === undefined) delete process.env.VELNOR_SECRET_KEY;
    else process.env.VELNOR_SECRET_KEY = previous;
  }
});

test("credential record helpers seal only credential fields and fail closed on tampering", async () => {
  const env = { VELNOR_SECRET_KEY: secretKey };
  const sealed = await sealCredentialRecordAsync({
    googleAccessToken: "oauth-access",
    googleRefreshToken: "oauth-refresh",
    googleConnectedEmail: "owner@example.com",
  }, env);
  assert.notEqual(sealed.googleAccessToken, "oauth-access");
  assert.equal(sealed.googleConnectedEmail, "owner@example.com");
  assert.deepEqual(await openCredentialRecordAsync(sealed, env), {
    googleAccessToken: "oauth-access",
    googleRefreshToken: "oauth-refresh",
    googleConnectedEmail: "owner@example.com",
  });

  const tampered = sealed.googleAccessToken!.slice(0, -2) + "AA";
  await assert.rejects(
    openCredentialAsync(tampered, env),
    /authentication failed|malformed|unsupported/
  );
});
