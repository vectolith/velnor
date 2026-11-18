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
let withVelnorTenantScope: typeof import("../src/lib/store").withVelnorTenantScope;
let resetStoreCache: typeof import("../src/lib/store").resetStoreCache;
let getNodeTenantRepositoryContext: typeof import("../src/lib/storage/currentTenantRepository").getNodeTenantRepositoryContext;

before(async () => {
  ({ POST: provision } = await import("../src/app/api/internal/tenants/provision/route"));
  ({ withVelnorTenantScope, resetStoreCache } = await import("../src/lib/store"));
  ({ getNodeTenantRepositoryContext } = await import("../src/lib/storage/currentTenantRepository"));
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
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows file handle release guard
  }
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

  const readProvisionedState = () =>
    withVelnorTenantScope(tenantId, async () => {
      const { repository, tenantId: scopedTenantId } =
        getNodeTenantRepositoryContext();
      return repository.load(scopedTenantId);
    });
  const firstState = await readProvisionedState();
  assert.ok(firstState);
  const firstRevision = firstState.revision;

  const second = await provision(request({ tenantId }));
  assert.equal(second.status, 200);
  const secondState = await readProvisionedState();
  assert.ok(secondState);
  assert.equal(secondState.revision, firstRevision);
});
