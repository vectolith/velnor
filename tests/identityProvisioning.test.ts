import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { NextRequest } from "next/server";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-provisioning-test-"));
process.env.VELNOR_DATA_DIR = dataDir;
process.env.VELNOR_SECRET_KEY = "test-secret-key-for-provisioning-tests-32-bytes";
process.env.VELNOR_PROVISIONING_SECRET = "test-provisioning-secret-with-at-least-32-bytes";

let provision: typeof import("../src/app/api/internal/tenants/provision/route").POST;
let listUserIds: typeof import("../src/lib/store").listUserIds;
let sanitizeUserId: typeof import("../src/lib/store").sanitizeUserId;
let resetStoreCache: typeof import("../src/lib/store").resetStoreCache;

before(async () => {
  ({ POST: provision } = await import("../src/app/api/internal/tenants/provision/route"));
  ({ listUserIds, sanitizeUserId, resetStoreCache } = await import("../src/lib/store"));
});

function request(body: unknown, secret = process.env.VELNOR_PROVISIONING_SECRET || "") {
  return new NextRequest("http://localhost/api/internal/tenants/provision", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-velnor-provisioning-secret": secret,
    },
    body: JSON.stringify(body),
  });
}

after(() => {
  resetStoreCache?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("tenant provisioning refuses an incorrect gateway secret", async () => {
  const response = await provision(request({ tenantId: "cf-" + "a".repeat(64) }, "incorrect-secret"));
  assert.equal(response.status, 401);
});

test("tenant provisioning rejects arbitrary or caller-selected tenant identifiers", async () => {
  const response = await provision(request({ tenantId: "owner" }));
  assert.equal(response.status, 400);
});

test("tenant provisioning creates a deterministic tenant partition idempotently", async () => {
  const tenantId = "cf-" + "b".repeat(64);
  const first = await provision(request({ tenantId }));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, tenantId });

  const second = await provision(request({ tenantId }));
  assert.equal(second.status, 200);
  const stored = new Set(listUserIds().map((id) => sanitizeUserId(id)));
  assert.equal(stored.has(sanitizeUserId(tenantId)), true);
});
