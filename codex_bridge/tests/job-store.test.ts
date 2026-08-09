import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobStore } from "../src/job-store.js";
import { previewWorkPackage } from "../src/work-package.js";

test("job store is idempotent and persists bounded job artifacts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  await store.initialize();
  const preview = previewWorkPackage({ projectId: "omi", title: "Test job", objective: "Run a safe test." });
  const input = {
    project: { id: "omi", name: "OMI", path: join(root, "project") },
    workPackage: preview.workPackage,
    previewDigest: preview.previewDigest,
    idempotencyKey: "test-key-12345",
  };

  const first = await store.create(input);
  const second = await store.create(input);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.record.id, second.record.id);
  assert.match(await store.readArtifact(first.record.id, "request"), /Test job/);
  assert.equal((await store.snapshot(first.record.id)).events.length, 1);
  assert.deepEqual((await store.snapshot(first.record.id)).messages.map((message) => message.role), ["user"]);
  assert.match(await readFile(join(root, first.record.id, "messages.jsonl"), "utf8"), /Run a safe test/);
  assert.match(await readFile(join(root, first.record.id, "manifest.json"), "utf8"), /"schemaVersion": 1/);
});

test("restart marks active jobs interrupted and expires live approvals", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const firstStore = new JobStore(root);
  await firstStore.initialize();
  const preview = previewWorkPackage({ projectId: "omi", title: "Recovery", objective: "Verify recovery." });
  const created = await firstStore.create({
    project: { id: "omi", name: "OMI", path: join(root, "project") },
    workPackage: preview.workPackage,
    previewDigest: preview.previewDigest,
    idempotencyKey: "recovery-key-123",
  });
  await firstStore.addApproval(created.record.id, {
    id: "56bfa71e-7740-40cc-a643-d6e86f15a5d1",
    kind: "command",
    state: "pending",
    method: "item/commandExecution/requestApproval",
    createdAt: new Date().toISOString(),
    summary: { command: "npm test" },
  });

  const restarted = new JobStore(root);
  await restarted.initialize();
  const recovered = restarted.get(created.record.id);
  assert.equal(recovered?.status, "interrupted");
  assert.equal(recovered?.approvals[0]?.state, "expired");
});

test("job store materializes staged text and exposes bounded result artifacts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-artifacts-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  await store.initialize();
  const artifactId = randomUUID();
  const content = "Validated engineering notes.\n";
  const sha256 = createHash("sha256").update(content).digest("hex");
  const preview = previewWorkPackage({
    projectId: "omi",
    title: "Artifact job",
    objective: "Use the attached notes.",
    inputBundleIds: [artifactId],
  });
  const created = await store.create({
    project: { id: "omi", name: "OMI", path: join(root, "project") },
    workPackage: preview.workPackage,
    previewDigest: preview.previewDigest,
    idempotencyKey: "artifact-key-123",
    inputArtifacts: [{
      id: artifactId,
      fileName: "engineering_spec.txt",
      mimeType: "text/plain",
      chars: content.length,
      bytes: Buffer.byteLength(content),
      sha256,
      content,
    }],
  });

  assert.equal(await readFile(join(root, created.record.id, "inbox", `${artifactId}.txt`), "utf8"), content);
  assert.match(await store.readArtifact(created.record.id, "request"), /engineering_spec\.txt/);
  await store.setDiff(created.record.id, "diff --git a/a.ts b/a.ts\n");
  await store.complete(created.record.id, {
    status: "completed",
    message: "Done.",
    output: "Final engineering result.",
    completedAt: new Date().toISOString(),
  });
  const descriptors = await store.listArtifacts(created.record.id);
  assert.deepEqual(descriptors.map((artifact) => artifact.id), ["request", "response", "diff"]);
  const chunk = await store.readArtifactChunk(created.record.id, "response", 0, 5);
  assert.equal(chunk.content, "Final");
  assert.equal(chunk.done, false);
  assert.equal(chunk.nextCursor, 5);
});
