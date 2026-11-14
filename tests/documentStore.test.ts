import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withVelnorUser, getStore, resetStoreCache } from "../src/lib/store";
import { ingestDocumentOrUrl } from "../src/lib/tools/documentStore";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-doc-test-"));
process.env.VELNOR_DATA_DIR = testDataDir;
process.env.VELNOR_SECRET_KEY ||= "test-secret-key-for-store-suite-32-bytes";

after(() => {
  resetStoreCache();
  try {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  } catch {
    // Windows file handle release guard
  }
});

test("document ingestion rejects private-network URLs without creating a document", async () => {
  await withVelnorUser("document-ssrf-test", async () => {
    await assert.rejects(
      ingestDocumentOrUrl({ name: "metadata", url: "http://169.254.169.254/latest/meta-data" }),
      /Blocked private address/
    );
    assert.equal(getStore().documents.length, 0);
  });
});

test("document ingestion refuses empty or unsupported input rather than indexing a placeholder", async () => {
  await withVelnorUser("document-empty-test", async () => {
    await assert.rejects(ingestDocumentOrUrl({ name: "empty" }), /No readable text/);
    await assert.rejects(
      ingestDocumentOrUrl({ name: "unsupported.bin", base64Data: Buffer.from("binary").toString("base64"), mimeType: "application/octet-stream" }),
      /Unsupported document type/
    );
    assert.equal(getStore().documents.length, 0);
  });
});

test("text documents are indexed only from supplied readable content", async () => {
  await withVelnorUser("document-text-test", async () => {
    const result = await ingestDocumentOrUrl({
      name: "notes.txt",
      content: "This is a verified text document. It contains enough readable content to index safely.",
      mimeType: "text/plain",
    });
    assert.equal(result.wordCount > 0, true);
    assert.equal(getStore().documents.length, 1);
  });
});

test("document operations require an authenticated tenant scope", async () => {
  await assert.rejects(
    ingestDocumentOrUrl({ name: "unscoped.txt", content: "This must not be written to the root profile." }),
    /authenticated tenant scope is required/
  );
});
