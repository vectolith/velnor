import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteTenantObject,
  getTenantObject,
  putTenantObject,
  TenantObjectIntegrityError,
  type R2BucketLike,
  type R2ObjectBodyLike
} from "../src/lib/storage/r2TenantObjects";

type Stored = {
  bytes: Uint8Array;
  contentType: string;
  customMetadata: Record<string, string>;
};
class FakeR2 implements R2BucketLike {
  objects = new Map<string, Stored>();
  async put(key: string, value: Uint8Array, options: {
    httpMetadata: { contentType: string };
    customMetadata: Record<string, string>;
  }): Promise<void> {
    this.objects.set(key, {
      bytes: new Uint8Array(value),
      contentType: options.httpMetadata.contentType,
      customMetadata: { ...options.customMetadata }
    });
  }
  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const bytes = new Uint8Array(stored.bytes);
    return {
      size: bytes.byteLength,
      httpMetadata: { contentType: stored.contentType },
      customMetadata: { ...stored.customMetadata },
      async arrayBuffer() { return bytes.slice().buffer as ArrayBuffer; }
    };
  }
  async delete(key: string): Promise<void> { this.objects.delete(key); }
}
const key = (tenantId: string, objectId: string) => "tenants/" + tenantId + "/objects/" + objectId;

test("R2 tenant objects round-trip binary bytes with checksum and content type", async () => {
  const bucket = new FakeR2();
  const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
  const ref = await putTenantObject(bucket, "tenant_a", "attachment_01", bytes, "application/octet-stream", 1024);
  assert.equal(ref.sizeBytes, bytes.byteLength);
  assert.match(ref.sha256, /^[a-f0-9]{64}$/);
  const loaded = await getTenantObject(bucket, "tenant_a", "attachment_01", ref);
  assert.deepEqual(loaded?.bytes, bytes);
  assert.equal(loaded?.contentType, "application/octet-stream");
  assert.equal(loaded?.sha256, ref.sha256);
});

test("R2 object keys and metadata isolate tenants", async () => {
  const bucket = new FakeR2();
  const a = await putTenantObject(bucket, "tenant_a", "same_id", new Uint8Array([1]), "image/png", 100);
  const b = await putTenantObject(bucket, "tenant_b", "same_id", new Uint8Array([2]), "image/png", 100);
  assert.deepEqual((await getTenantObject(bucket, "tenant_a", "same_id", a))?.bytes, new Uint8Array([1]));
  assert.deepEqual((await getTenantObject(bucket, "tenant_b", "same_id", b))?.bytes, new Uint8Array([2]));
  assert.equal(await getTenantObject(bucket, "tenant_c", "same_id", a), null);
  assert.equal(bucket.objects.has(key("tenant_a", "same_id")), true);
  assert.equal(bucket.objects.has(key("tenant_b", "same_id")), true);
});

test("R2 reads reject altered bytes or mismatched ownership metadata", async () => {
  const bucket = new FakeR2();
  const ref1 = await putTenantObject(bucket, "tenant_a", "object_1", new Uint8Array([1, 2]), "image/png", 100);
  bucket.objects.get(key("tenant_a", "object_1"))!.bytes[0] = 9;
  await assert.rejects(() => getTenantObject(bucket, "tenant_a", "object_1", ref1), TenantObjectIntegrityError);

  const ref2 = await putTenantObject(bucket, "tenant_a", "object_2", new Uint8Array([3]), "image/png", 100);
  bucket.objects.get(key("tenant_a", "object_2"))!.customMetadata.tenantId = "tenant_b";
  await assert.rejects(() => getTenantObject(bucket, "tenant_a", "object_2", ref2), TenantObjectIntegrityError);
});

test("R2 adapter rejects unsafe IDs, invalid content types, and oversized uploads", async () => {
  const bucket = new FakeR2();
  await assert.rejects(() => putTenantObject(bucket, "../tenant", "id", new Uint8Array([1]), "image/png", 10));
  await assert.rejects(() => putTenantObject(bucket, "tenant_a", "../id", new Uint8Array([1]), "image/png", 10));
  await assert.rejects(() => putTenantObject(bucket, "tenant_a", "id", new Uint8Array([1]), "image/png\r\npublic: yes", 10));
  await assert.rejects(() => putTenantObject(bucket, "tenant_a", "id", new Uint8Array([1, 2]), "image/png", 1));
  assert.equal(bucket.objects.size, 0);
});

test("R2 delete verifies tenant metadata before deleting", async () => {
  const bucket = new FakeR2();
  await putTenantObject(bucket, "tenant_a", "delete_me", new Uint8Array([5]), "application/octet-stream", 100);
  assert.equal(await deleteTenantObject(bucket, "tenant_a", "delete_me"), true);
  assert.equal(await deleteTenantObject(bucket, "tenant_a", "delete_me"), false);

  await putTenantObject(bucket, "tenant_a", "protected", new Uint8Array([6]), "application/octet-stream", 100);
  bucket.objects.get(key("tenant_a", "protected"))!.customMetadata.tenantId = "tenant_b";
  await assert.rejects(() => deleteTenantObject(bucket, "tenant_a", "protected"), TenantObjectIntegrityError);
  assert.equal(bucket.objects.has(key("tenant_a", "protected")), true);
});

test("R2 read verifies against the independent persisted reference", async () => {
  const bucket = new FakeR2();
  const ref = await putTenantObject(bucket, "tenant_a", "object_ref", new Uint8Array([4, 5]), "image/png", 100);
  const stored = bucket.objects.get(key("tenant_a", "object_ref"))!;
  const changed = new Uint8Array([8, 9]);
  stored.bytes = changed;
  // Simulate a writer that can also rewrite object metadata: the D1 reference
  // still detects the change because its checksum and size are independent.
  const digest = await crypto.subtle.digest("SHA-256", changed.buffer as ArrayBuffer);
  stored.customMetadata.sha256 = Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
  await assert.rejects(
    () => getTenantObject(bucket, "tenant_a", "object_ref", ref),
    TenantObjectIntegrityError
  );
});
