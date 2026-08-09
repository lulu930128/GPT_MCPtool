import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TextBundleStore } from "../src/text-bundle-store.js";

test("text bundle store verifies chunks, full hash, and project/classification binding", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-text-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new TextBundleStore(root);
  await store.initialize();
  const chunks = ["第一段工程需求。\n", "Second verified chunk."];
  const content = chunks.join("");
  const declaration = {
    clientTransferId: randomUUID(),
    projectId: "omi",
    fileName: "engineering_spec.txt",
    mimeType: "text/plain",
    dataClassification: "personal" as const,
    totalChars: content.length,
    totalBytes: Buffer.byteLength(content, "utf8"),
    sha256: digest(content),
    chunkCount: chunks.length,
  };

  const begun = await store.begin(declaration);
  assert.equal(begun.created, true);
  assert.equal((await store.begin(declaration)).created, false);
  await store.append(begun.bundle.id, 0, chunks[0]!, digest(chunks[0]!));
  await store.append(begun.bundle.id, 0, chunks[0]!, digest(chunks[0]!));
  await store.append(begun.bundle.id, 1, chunks[1]!, digest(chunks[1]!));
  const finalized = await store.finalize(begun.bundle.id);
  assert.equal(finalized.status, "finalized");
  assert.equal((await store.resolveMany([begun.bundle.id], "omi", "personal"))[0]?.content, content);
  await assert.rejects(store.resolveMany([begun.bundle.id], "other", "personal"), /another project/);
  await assert.rejects(store.resolveMany([begun.bundle.id], "omi", "public"), /classification/);
});

test("text bundle store rejects invalid filenames, mismatched hashes, and likely hard secrets", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-text-reject-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new TextBundleStore(root);
  await store.initialize();
  const invalidBase = {
    clientTransferId: randomUUID(),
    projectId: "omi",
    fileName: "../secret.txt",
    mimeType: "text/plain",
    dataClassification: "personal" as const,
    totalChars: 4,
    totalBytes: 4,
    sha256: digest("test"),
    chunkCount: 1,
  };
  await assert.rejects(store.begin(invalidBase), /filename is invalid/);

  const secret = `OPENAI_API_KEY=${["sk", "proj", "fixture".repeat(4)].join("-")}`;
  const begun = await store.begin({
    ...invalidBase,
    clientTransferId: randomUUID(),
    fileName: "notes.txt",
    totalChars: secret.length,
    totalBytes: Buffer.byteLength(secret),
    sha256: digest(secret),
  });
  await assert.rejects(store.append(begun.bundle.id, 0, secret, digest("different")), /does not match/);
  await store.append(begun.bundle.id, 0, secret, digest(secret));
  await assert.rejects(store.finalize(begun.bundle.id), /appears to contain/);
});

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
