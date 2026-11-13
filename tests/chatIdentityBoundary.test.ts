import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/chat/route";

const secret = "test-chat-identity-secret-with-at-least-32-bytes";
process.env.VELNOR_TENANT_TOKEN_SECRET = secret;

function validOwnerBearer(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    iss: "velnor-auth",
    aud: "velnor-api",
    sub: "owner",
    iat: now,
    nbf: now - 1,
    exp: now + 300,
  });
  const signature = crypto.createHmac("sha256", secret).update(header + "." + payload).digest("base64url");
  return "Bearer " + header + "." + payload + "." + signature;
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("chat POST ignores a valid identity token supplied in body.userHandle", async () => {
  const response = await POST(post(
    { userHandle: validOwnerBearer(), text: "This must not execute." },
    { "x-velnor-user": "owner" },
  ));
  assert.equal(response.status, 401);
});

test("chat POST ignores the legacy x-velnor-user tenant header", async () => {
  const response = await POST(post(
    { userHandle: "owner", text: "This must not execute." },
    { "x-velnor-user": "owner" },
  ));
  assert.equal(response.status, 401);
});
