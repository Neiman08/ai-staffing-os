import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalMockDocumentStorageProvider } from "./local-mock.provider";

test("store() never returns a real navigable URL -- always mock:// prefixed", async () => {
  const provider = new LocalMockDocumentStorageProvider();
  const result = await provider.store({ fileName: "i9-form.pdf" });
  assert.ok(result.reference.startsWith("mock://"));
  assert.equal(result.status, "pending");
});

test("store() sanitizes unsafe characters in fileName, never trusts it verbatim", async () => {
  const provider = new LocalMockDocumentStorageProvider();
  const result = await provider.store({ fileName: "../../etc/passwd; rm -rf /" });
  assert.equal(/[^a-zA-Z0-9._\-/:]/.test(result.reference.replace("mock://pending-storage-adapter/", "")), false);
});

test("store() generates a unique reference per call, even for the same fileName", async () => {
  const provider = new LocalMockDocumentStorageProvider();
  const a = await provider.store({ fileName: "resume.pdf" });
  const b = await provider.store({ fileName: "resume.pdf" });
  assert.notEqual(a.reference, b.reference);
});
