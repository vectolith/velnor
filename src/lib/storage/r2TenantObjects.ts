/**
 * Private, tenant-scoped Cloudflare R2 object storage.
 *
 * Object keys are derived internally; callers never receive a public URL.
 * The bucket must remain private and be bound only to the VELNOR Worker.
 */
export interface R2ObjectBodyLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  size?: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}
export interface R2BucketLike {
  put(
    key: string,
    value: Uint8Array,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
    }
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  delete(key: string): Promise<void>;
}
export interface TenantObjectRef {
  objectId: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}
export interface TenantObjectData extends TenantObjectRef {
  bytes: Uint8Array;
}
export class TenantObjectIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantObjectIntegrityError";
  }
}
function assertTenantId(tenantId: string): void {
  if (!tenantId || tenantId.length > 128 || !/^[A-Za-z0-9._@+-]+$/.test(tenantId)) {
    throw new Error("Invalid or unsanitized tenant storage identifier.");
  }
}
function assertObjectId(objectId: string): void {
  if (!objectId || objectId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(objectId)) {
    throw new Error("Invalid tenant object identifier.");
  }
}
function objectKey(tenantId: string, objectId: string): string {
  assertTenantId(tenantId);
  assertObjectId(objectId);
  return "tenants/" + tenantId + "/objects/" + objectId;
}
function assertContentType(contentType: string): void {
  if (!contentType || contentType.length > 255 || /[\r\n\0]/.test(contentType)) {
    throw new Error("Invalid object content type.");
  }
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
export async function putTenantObject(
  bucket: R2BucketLike,
  tenantId: string,
  objectId: string,
  bytes: Uint8Array,
  contentType: string,
  maxBytes: number
): Promise<TenantObjectRef> {
  const key = objectKey(tenantId, objectId);
  assertContentType(contentType);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive safe integer.");
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error("Tenant object exceeds the configured upload limit.");
  }
  const checksum = await sha256(bytes);
  await bucket.put(key, new Uint8Array(bytes), {
    httpMetadata: { contentType },
    customMetadata: {
      tenantId,
      objectId,
      sha256: checksum,
      schemaVersion: "1"
    }
  });
  return { objectId, contentType, sizeBytes: bytes.byteLength, sha256: checksum };
}
export async function getTenantObject(
  bucket: R2BucketLike,
  tenantId: string,
  objectId: string
): Promise<TenantObjectData | null> {
  const object = await bucket.get(objectKey(tenantId, objectId));
  if (!object) return null;
  const metadata = object.customMetadata || {};
  if (metadata.tenantId !== tenantId || metadata.objectId !== objectId || metadata.schemaVersion !== "1") {
    throw new TenantObjectIntegrityError("R2 object tenant metadata does not match its requested owner.");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  const checksum = await sha256(bytes);
  if (!metadata.sha256 || checksum !== metadata.sha256) {
    throw new TenantObjectIntegrityError("R2 object checksum verification failed.");
  }
  return {
    objectId,
    contentType: object.httpMetadata?.contentType || "application/octet-stream",
    sizeBytes: bytes.byteLength,
    sha256: checksum,
    bytes
  };
}
export async function deleteTenantObject(
  bucket: R2BucketLike,
  tenantId: string,
  objectId: string
): Promise<boolean> {
  const key = objectKey(tenantId, objectId);
  const object = await bucket.get(key);
  if (!object) return false;
  const metadata = object.customMetadata || {};
  if (metadata.tenantId !== tenantId || metadata.objectId !== objectId || metadata.schemaVersion !== "1") {
    throw new TenantObjectIntegrityError("Refusing to delete an R2 object with mismatched tenant metadata.");
  }
  await bucket.delete(key);
  return true;
}
