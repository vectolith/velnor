import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import worker from "../identity-gateway/src/index";

const teamDomain = "https://test-team.cloudflareaccess.com";
const audience = "velnor-access-audience";
const origin = "https://origin.velnor.example";
const tokenSecret = "test-velnor-tenant-token-secret-with-at-least-32-bytes";
const sharedSecret = "test-velnor-shared-secret-with-at-least-32-bytes";
const provisioningSecret = "test-velnor-provisioning-secret-with-at-least-32-bytes";
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "test-key-id",
  alg: "RS256",
  use: "sig",
};

const env = {
  CF_ACCESS_TEAM_DOMAIN: teamDomain,
  CF_ACCESS_AUD: audience,
  VELNOR_ORIGIN: origin,
  VELNOR_SHARED_SECRET: sharedSecret,
  VELNOR_TENANT_TOKEN_SECRET: tokenSecret,
  VELNOR_PROVISIONING_SECRET: provisioningSecret,
};

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function accessToken(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "RS256", typ: "JWT", kid: "test-key-id" });
  const payload = base64url({
    iss: teamDomain,
    aud: audience,
    sub: "stable-upstream-subject-123",
    iat: now,
    nbf: now - 1,
    exp: now + 300,
    ...overrides,
  });
  const signature = crypto.sign("RSA-SHA256", Buffer.from(header + "." + payload), privateKey).toString("base64url");
  return header + "." + payload + "." + signature;
}

async function withFetchMock(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("gateway verifies Access JWT, provisions tenant, and injects isolated Velnor credentials", async () => {
  let provisionCount = 0;
  let upstreamHeaders: Headers | null = null;
  await withFetchMock(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === teamDomain + "/cdn-cgi/access/certs") {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
    if (url === origin + "/api/internal/tenants/provision") {
      provisionCount += 1;
      assert.equal(new Headers(init?.headers).get("x-velnor-provisioning-secret"), provisioningSecret);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url === origin + "/api/chat") {
      upstreamHeaders = new Headers(input instanceof Request ? input.headers : init?.headers);
      return new Response("proxied", { status: 200 });
    }
    throw new Error("Unexpected gateway fetch: " + url);
  }, async () => {
    const request = new Request("https://velnor.example/api/chat", {
      method: "GET",
      headers: { "Cf-Access-Jwt-Assertion": accessToken() },
    });
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 200);
  });

  assert.equal(provisionCount, 1);
  assert.ok(upstreamHeaders);
  assert.equal(upstreamHeaders.get("x-velnor-secret"), sharedSecret);
  assert.match(upstreamHeaders.get("authorization") || "", /^Bearer /);
  assert.equal(upstreamHeaders.has("cf-access-jwt-assertion"), false);
  assert.equal(upstreamHeaders.has("x-velnor-provisioning-secret"), false);

  const bearer = (upstreamHeaders.get("authorization") || "").slice("Bearer ".length);
  const [header, payload, signature] = bearer.split(".");
  const expected = crypto.createHmac("sha256", tokenSecret).update(header + "." + payload).digest("base64url");
  assert.equal(signature, expected);
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const expectedTenant = "cf-" + crypto.createHash("sha256").update("stable-upstream-subject-123").digest("hex");
  assert.equal(claims.sub, expectedTenant);
  assert.equal(claims.tenant_id, expectedTenant);
  assert.equal(claims.exp - claims.iat, 300);
});

test("gateway rejects a validly signed Access token for the wrong audience", async () => {
  await withFetchMock(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === teamDomain + "/cdn-cgi/access/certs") {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
    throw new Error("Invalid Access token reached provisioning or origin: " + url);
  }, async () => {
    const request = new Request("https://velnor.example/api/chat", {
      headers: { "Cf-Access-Jwt-Assertion": accessToken({ aud: "another-application" }) },
    });
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 401);
  });
});

test("gateway fails closed when no Cloudflare Access assertion is present", async () => {
  await withFetchMock(async () => {
    throw new Error("Unauthenticated request must not make an outbound call");
  }, async () => {
    const request = new Request("https://velnor.example/api/chat");
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 401);
  });
});
