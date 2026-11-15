import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { getInstallationToken, type GitHubAppConfig } from "../src/lib/github/app";

function config(appId = "5764987", installationId = "123456"): GitHubAppConfig {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    appId,
    installationId,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function tokenResponse(token: string, expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()): Response {
  return new Response(JSON.stringify({ token, expires_at: expiresAt }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

test("installation tokens are cached for the same complete App identity", async () => {
  const originalFetch = globalThis.fetch;
  const app = config();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return tokenResponse("installation-token");
  };

  try {
    assert.equal(await getInstallationToken(app), "installation-token");
    assert.equal(await getInstallationToken(app), "installation-token");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("App key rotation invalidates the installation-token cache", async () => {
  const originalFetch = globalThis.fetch;
  const firstApp = config();
  const rotatedApp = { ...firstApp, privateKey: config().privateKey };
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return tokenResponse(`installation-token-${calls}`);
  };

  try {
    assert.equal(await getInstallationToken(firstApp), "installation-token-1");
    assert.equal(await getInstallationToken(rotatedApp), "installation-token-2");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("incomplete or nearly expired token responses are rejected and not cached", async () => {
  const originalFetch = globalThis.fetch;
  const app = config();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return tokenResponse("too-short-lived", new Date(Date.now() + 10_000).toISOString());
  };

  try {
    await assert.rejects(
      getInstallationToken(app),
      /incomplete or already-expiring installation token response/,
    );
    await assert.rejects(
      getInstallationToken(app),
      /incomplete or already-expiring installation token response/,
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
