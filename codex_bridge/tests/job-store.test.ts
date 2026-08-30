import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationPersistenceError, JobStore } from "../src/job-store.js";
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

test("job store durably adopts one existing local thread without inventing a user message", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-local-import-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  await store.initialize();
  const threadId = randomUUID();
  const preview = previewWorkPackage({
    projectId: "local:fixture",
    title: "Adopt existing thread",
    objective: "Continue the persisted conversation.",
    executionMode: "workspace_write",
  });
  const input = {
    project: { id: "local:fixture", name: "Fixture project", path: join(root, "project") },
    workPackage: preview.workPackage,
    previewDigest: preview.previewDigest,
    threadId,
    threadResponse: {
      thread: {
        id: threadId,
        status: { type: "notLoaded" },
        turns: [{
          id: "turn-existing",
          status: "completed",
          items: [
            { id: "user-existing", type: "userMessage", content: [{ type: "text", text: "Existing question." }] },
            { id: "agent-existing", type: "agentMessage", text: "Existing answer." },
          ],
        }],
      },
    },
  };

  const imported = await store.importLocalThread(input);
  const duplicate = await store.importLocalThread(input);
  assert.equal(imported.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.record.id, imported.record.id);
  const snapshot = await store.snapshot(imported.record.id);
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.threadId, threadId);
  assert.deepEqual(snapshot.messages, []);
  assert.deepEqual(snapshot.conversation?.turns[0]?.items.map((item) => item.text), ["Existing question.", "Existing answer."]);

  const restarted = new JobStore(root);
  await restarted.initialize();
  const recovered = await restarted.snapshot(imported.record.id);
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.threadId, threadId);
  assert.deepEqual(recovered.conversation?.turns[0]?.items.map((item) => item.text), ["Existing question.", "Existing answer."]);
});

test("event cursor advances only through delivered pages", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-cursor-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  await store.initialize();
  const preview = previewWorkPackage({ projectId: "omi", title: "Cursor", objective: "Verify event paging." });
  const created = await store.create({
    project: { id: "omi", name: "OMI", path: join(root, "project") },
    workPackage: preview.workPackage,
    previewDigest: preview.previewDigest,
    idempotencyKey: "cursor-test-12345",
  });
  for (let index = 2; index <= 96; index += 1) {
    await store.appendEvent(created.record.id, "test.event", `Event ${index}.`, { index });
  }

  const delivered: number[] = [];
  let afterSeq = 0;
  let hasMore = true;
  while (hasMore) {
    const page = await store.snapshot(created.record.id, afterSeq, 20);
    delivered.push(...page.events.map((event) => event.seq));
    assert.equal(page.serverLastEventSeq, 96);
    assert.equal(page.nextEventSeq, page.events.at(-1)?.seq ?? afterSeq);
    afterSeq = page.nextEventSeq;
    hasMore = page.hasMore;
  }

  assert.deepEqual(delivered, Array.from({ length: 96 }, (_, index) => index + 1));
  assert.equal(new Set(delivered).size, 96);
  assert.equal(afterSeq, 96);
});

test("conversation polling returns bounded revision patches after initial hydration", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-conversation-patch-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  await store.initialize();
  const preview = previewWorkPackage({ projectId: "omi", title: "Projection", objective: "Stream the answer." });
  const created = await store.create({
    project: { id: "omi", name: "OMI", path: join(root, "project") },
    workPackage: preview.workPackage,
    previewDigest: preview.previewDigest,
    idempotencyKey: "conversation-patch-12345",
  });
  const initial = await store.snapshot(created.record.id);
  assert.ok(initial.conversation);
  assert.equal(initial.serverConversationRevision, 0);

  await store.applyConversationNotification(created.record.id, {
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "Hello" },
  });
  const delta = await store.snapshot(created.record.id, 0, 20, initial.nextConversationRevision);
  assert.equal(delta.conversation, undefined);
  assert.equal(delta.conversationChanges.length, 1);
  assert.equal(delta.conversationChanges[0]?.turns[0]?.items[0]?.text, "Hello");
  assert.equal(delta.nextConversationRevision, 1);
  assert.equal(delta.serverConversationRevision, 1);
  assert.equal(delta.conversationHasMore, false);
});

test("conversation listing pages through every saved allowlisted job", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-list-page-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  await store.initialize();
  for (let index = 1; index <= 5; index += 1) {
    const preview = previewWorkPackage({ projectId: index % 2 ? "omi" : "mcp", title: `Job ${index}`, objective: `Task ${index}.` });
    await store.create({
      project: { id: preview.workPackage.projectId, name: preview.workPackage.projectId.toUpperCase(), path: join(root, preview.workPackage.projectId) },
      workPackage: preview.workPackage,
      previewDigest: preview.previewDigest,
      idempotencyKey: `list-page-test-${index}`,
    });
  }

  const first = store.listPage(2);
  const second = store.listPage(2, first.nextCursor);
  const third = store.listPage(2, second.nextCursor);
  const ids = [...first.data, ...second.data, ...third.data].map((job) => job.id);
  assert.equal(first.data.length, 2);
  assert.equal(second.data.length, 2);
  assert.equal(third.data.length, 1);
  assert.equal(third.nextCursor, undefined);
  assert.deepEqual(ids, store.list(100).map((job) => job.id));
  assert.equal(store.listPage(100, undefined, "omi").data.length, 3);
  assert.throws(() => store.listPage(20, "invalid cursor"), /Invalid conversation cursor/);
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

test("cancellation settles pending approvals and restart repairs stale terminal records", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-cancel-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  await store.initialize();
  const preview = previewWorkPackage({ projectId: "omi", title: "Cancel recovery", objective: "Close the old job." });
  const created = await store.create({
    project: { id: "omi", name: "OMI", path: join(root, "project") },
    workPackage: preview.workPackage,
    previewDigest: preview.previewDigest,
    idempotencyKey: "cancel-recovery-key-123",
  });
  await store.addApproval(created.record.id, {
    id: "66bfa71e-7740-40cc-a643-d6e86f15a5d1",
    kind: "command",
    state: "pending",
    method: "item/commandExecution/requestApproval",
    createdAt: new Date().toISOString(),
    summary: { command: "npm test" },
  });
  const cancelled = await store.complete(created.record.id, {
    status: "cancelled",
    message: "Job cancelled by the operator.",
    completedAt: new Date().toISOString(),
  });
  assert.equal(cancelled.approvals[0]?.state, "cancelled");

  const manifestPath = join(root, created.record.id, "manifest.json");
  const staleRecord = JSON.parse(await readFile(manifestPath, "utf8"));
  staleRecord.approvals[0].state = "pending";
  delete staleRecord.approvals[0].resolvedAt;
  await writeFile(manifestPath, `${JSON.stringify(staleRecord, null, 2)}\n`, "utf8");

  const restarted = new JobStore(root);
  await restarted.initialize();
  assert.equal(restarted.get(created.record.id)?.approvals[0]?.state, "cancelled");
});

test("job store materializes staged text and exposes bounded result artifacts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-artifacts-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const handoffRoot = join(root, ".local", "codex-inbox");
  const store = new JobStore(root, handoffRoot);
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
  assert.equal(await readFile(join(handoffRoot, created.record.id, `${artifactId}.txt`), "utf8"), content);
  const materialized = await store.readInputArtifacts(created.record.id, [artifactId]);
  assert.equal(materialized[0]?.localPath, join(handoffRoot, created.record.id, `${artifactId}.txt`));
  assert.match(await readFile(join(handoffRoot, created.record.id, "manifest.json"), "utf8"), /"access": "read-only"/);
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

test("conversation persistence commits the journal and checkpoint before a clean restart", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-persistence-normal-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { store, jobId } = await createConversationFixture(root, "persistence-normal");

  await appendAgentDelta(store, jobId, "Hello");
  const jobDir = join(root, jobId);
  const checkpoint = JSON.parse(await readFile(join(jobDir, "conversation.json"), "utf8"));
  const backup = JSON.parse(await readFile(join(jobDir, "conversation.json.bak"), "utf8"));
  const journal = nonEmptyLines(await readFile(join(jobDir, "conversation-events.jsonl"), "utf8"));
  assert.equal(checkpoint.revision, 1);
  assert.equal(backup.revision, 0);
  assert.equal(JSON.parse(journal[0]!).revision, 1);

  const restarted = new JobStore(root);
  await restarted.initialize();
  const recovered = await restarted.snapshot(jobId);
  assert.equal(recovered.conversation?.revision, 1);
  assert.equal(recovered.conversation?.turns[0]?.items[0]?.text, "Hello");
});

test("startup replays a committed journal revision when the checkpoint is behind", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-persistence-behind-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { store, jobId } = await createConversationFixture(root, "persistence-behind");
  await appendAgentDelta(store, jobId, "Hello");
  await appendAgentDelta(store, jobId, " again");
  const jobDir = join(root, jobId);
  await writeFile(
    join(jobDir, "conversation.json"),
    await readFile(join(jobDir, "conversation.json.bak"), "utf8"),
    "utf8",
  );

  const restarted = new JobStore(root);
  await restarted.initialize();
  const recovered = await restarted.snapshot(jobId);
  assert.equal(recovered.conversation?.revision, 2);
  assert.equal(recovered.conversation?.turns[0]?.items[0]?.text, "Hello again");
  assert.ok(recovered.conversationDiagnostics.some((item) => item.code === "conversation_checkpoint_recovered"));
  assert.equal(JSON.parse(await readFile(join(jobDir, "conversation.json"), "utf8")).revision, 2);
});

test("startup recovers a malformed primary from backup plus journal instead of resetting", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-persistence-corrupt-primary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { store, jobId } = await createConversationFixture(root, "persistence-corrupt-primary");
  await appendAgentDelta(store, jobId, "Preserved answer");
  const checkpointPath = join(root, jobId, "conversation.json");
  await writeFile(checkpointPath, "{\"schemaVersion\":1,", "utf8");

  const restarted = new JobStore(root);
  await restarted.initialize();
  const recovered = await restarted.snapshot(jobId);
  assert.equal(recovered.conversation?.revision, 1);
  assert.equal(recovered.conversation?.turns[0]?.items[0]?.text, "Preserved answer");
  assert.ok(recovered.conversationDiagnostics.some((item) => item.code === "conversation_checkpoint_corrupt"));
  assert.ok(recovered.conversationDiagnostics.some((item) => item.code === "conversation_checkpoint_recovered"));
  assert.equal(JSON.parse(await readFile(checkpointPath, "utf8")).revision, 1);
});

test("startup truncates only an incomplete final journal tail", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-persistence-tail-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { store, jobId } = await createConversationFixture(root, "persistence-tail");
  await appendAgentDelta(store, jobId, "Complete revision");
  const journalPath = join(root, jobId, "conversation-events.jsonl");
  await appendFile(journalPath, "{\"revision\":2", "utf8");

  const restarted = new JobStore(root);
  await restarted.initialize();
  const recovered = await restarted.snapshot(jobId);
  assert.equal(recovered.conversation?.revision, 1);
  assert.ok(recovered.conversationDiagnostics.some((item) => item.code === "conversation_journal_tail_truncated"));
  assert.equal(nonEmptyLines(await readFile(journalPath, "utf8")).length, 1);
});

test("middle journal corruption remains visible and never becomes an empty projection", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-persistence-middle-corrupt-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { store, jobId } = await createConversationFixture(root, "persistence-middle-corrupt");
  await appendAgentDelta(store, jobId, "One");
  await appendAgentDelta(store, jobId, " two");
  const journalPath = join(root, jobId, "conversation-events.jsonl");
  const lines = nonEmptyLines(await readFile(journalPath, "utf8"));
  await writeFile(journalPath, `${lines[0]}\n{not-json}\n${lines[1]}\n`, "utf8");

  const restarted = new JobStore(root);
  await restarted.initialize();
  assert.ok(restarted.get(jobId));
  await assert.rejects(
    () => restarted.snapshot(jobId),
    (error: unknown) => error instanceof ConversationPersistenceError && error.code === "conversation_journal_corrupt",
  );
  assert.equal(JSON.parse(await readFile(join(root, jobId, "conversation.json"), "utf8")).revision, 2);
});

test("identical duplicate journal revisions are deterministic and not double-applied", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-persistence-duplicate-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { store, jobId } = await createConversationFixture(root, "persistence-duplicate");
  await appendAgentDelta(store, jobId, "Once");
  const journalPath = join(root, jobId, "conversation-events.jsonl");
  const entry = nonEmptyLines(await readFile(journalPath, "utf8"))[0]!;
  await appendFile(journalPath, `${entry}\n`, "utf8");

  const restarted = new JobStore(root);
  await restarted.initialize();
  const recovered = await restarted.snapshot(jobId);
  assert.equal(recovered.conversation?.revision, 1);
  assert.equal(recovered.conversation?.turns[0]?.items.length, 1);
  assert.equal(recovered.conversation?.turns[0]?.items[0]?.text, "Once");
  assert.ok(recovered.conversationDiagnostics.some((item) => item.code === "conversation_journal_duplicate"));
});

test("revision gaps fail closed without inventing the missing patch", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-persistence-gap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { store, jobId } = await createConversationFixture(root, "persistence-gap");
  await appendAgentDelta(store, jobId, "One");
  await appendAgentDelta(store, jobId, " two");
  const journalPath = join(root, jobId, "conversation-events.jsonl");
  const entries = nonEmptyLines(await readFile(journalPath, "utf8")).map((line) => JSON.parse(line));
  entries[1].revision = 3;
  await writeFile(journalPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

  const restarted = new JobStore(root);
  await restarted.initialize();
  await assert.rejects(
    () => restarted.snapshot(jobId),
    (error: unknown) => error instanceof ConversationPersistenceError && error.code === "conversation_journal_gap",
  );
});

test("Windows rename fallback preserves the previous checkpoint instead of copying over primary", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-persistence-eperm-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let injectFailure = false;
  let failedOnce = false;
  const renameWithWindowsCollision = async (source: string, destination: string) => {
    if (injectFailure && !failedOnce && destination.endsWith("conversation.json") && source.endsWith(".tmp")) {
      failedOnce = true;
      throw Object.assign(new Error("simulated Windows rename collision"), { code: "EPERM" });
    }
    await rename(source, destination);
  };
  const store = new JobStore(root, join(root, "codex-inbox"), renameWithWindowsCollision);
  await store.initialize();
  const { jobId } = await createConversationFixture(root, "persistence-eperm", store);
  injectFailure = true;
  await appendAgentDelta(store, jobId, "Promoted safely");

  assert.equal(failedOnce, true);
  assert.equal(JSON.parse(await readFile(join(root, jobId, "conversation.json"), "utf8")).revision, 1);
  assert.equal(JSON.parse(await readFile(join(root, jobId, "conversation.json.bak"), "utf8")).revision, 0);
});

test("a second restart after successful recovery is stable and legacy checkpoints seed one backup", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-persistence-second-restart-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { store, jobId } = await createConversationFixture(root, "persistence-second-restart");
  await appendAgentDelta(store, jobId, "Stable");
  const jobDir = join(root, jobId);
  await writeFile(join(jobDir, "conversation.json"), "{", "utf8");

  const firstRestart = new JobStore(root);
  await firstRestart.initialize();
  assert.equal((await firstRestart.snapshot(jobId)).conversation?.revision, 1);
  const secondRestart = new JobStore(root);
  await secondRestart.initialize();
  const stable = await secondRestart.snapshot(jobId);
  assert.equal(stable.conversation?.revision, 1);
  assert.ok(!stable.conversationDiagnostics.some((item) => item.code === "conversation_checkpoint_recovered"));

  await unlink(join(jobDir, "conversation-events.jsonl"));
  await unlink(join(jobDir, "conversation.json.bak"));
  const legacyRestart = new JobStore(root);
  await legacyRestart.initialize();
  assert.equal((await legacyRestart.snapshot(jobId)).conversation?.revision, 1);
  assert.equal(JSON.parse(await readFile(join(jobDir, "conversation.json.bak"), "utf8")).revision, 1);
});

async function createConversationFixture(root: string, key: string, existingStore?: JobStore) {
  const store = existingStore ?? new JobStore(root);
  if (!existingStore) await store.initialize();
  const preview = previewWorkPackage({ projectId: "omi", title: key, objective: "Persist this conversation." });
  const created = await store.create({
    project: { id: "omi", name: "OMI", path: join(root, "project") },
    workPackage: preview.workPackage,
    previewDigest: preview.previewDigest,
    idempotencyKey: `${key}-idempotency`,
  });
  return { store, jobId: created.record.id };
}

async function appendAgentDelta(store: JobStore, jobId: string, delta: string): Promise<void> {
  await store.applyConversationNotification(jobId, {
    method: "item/agentMessage/delta",
    params: { threadId: "thread-persistence", turnId: "turn-persistence", itemId: "agent-persistence", delta },
  });
}

function nonEmptyLines(content: string): string[] {
  return content.split(/\r?\n/).filter(Boolean);
}
