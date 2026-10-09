import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationPersistenceError, JobStore } from "../src/job-store.js";
import { previewWorkPackage } from "../src/work-package.js";

test("timestamp lineage survives delta delivery, metadata refresh and journal-only replay", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-time-lineage-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { store, jobId } = await createConversationFixture(root, "time-lineage");
  const initial = await store.snapshot(jobId);
  const durable = initial.messages.find((message) => message.role === "user")!;
  const response = { thread: { id: "thread-1", turns: [{ id: "turn-1", status: "completed", startedAt: "2026-10-08T01:00:00.000Z", completedAt: "2026-10-08T01:05:00.000Z", items: [
    { id: "user", type: "userMessage", clientId: durable.clientMessageId, content: [{ type: "text", text: "native only" }] },
    { id: "agent", type: "agentMessage", text: "native answer" },
  ] }] } };
  await store.hydrateConversation(jobId, response, "2026-10-09T01:00:00.000Z");
  const first = await store.snapshot(jobId);
  const delta = await store.snapshot(jobId, 0, 80, initial.serverConversationRevision);
  const user = delta.conversationChanges.flatMap((patch) => patch.turns.flatMap((turn) => turn.items)).find((item) => item.id === "user")!;
  assert.equal(user.createdAt, durable.at);
  assert.equal(user.timestampSource, "bridge");
  assert.equal(user.text, "native only");
  await store.markConversationFreshness(jobId, { historyMode: "legacy", synchronized: true, sourceAvailability: "available", lastMetadataCheckedAt: "2026-10-10T01:00:00.000Z" });
  assert.equal((await store.snapshot(jobId)).conversation?.updatedAt, first.conversation?.updatedAt);
  await store.hydrateConversation(jobId, response, "2026-10-11T01:00:00.000Z");
  await unlink(join(root, jobId, "conversation.json"));
  await unlink(join(root, jobId, "conversation.json.bak"));
  const restarted = new JobStore(root);
  await restarted.initialize();
  const replayed = await restarted.snapshot(jobId);
  assert.equal(replayed.conversation?.updatedAt, first.conversation?.updatedAt);
  assert.equal(replayed.conversation?.turns[0]?.items[1]?.createdAt, "2026-10-08T01:05:00.000Z");
  assert.equal(replayed.conversation?.turns[0]?.items[0]?.createdAt, durable.at);
  assert.equal(replayed.directActionHistoryEligible, true);
});

test("ten thousand streaming deltas coalesce, preserve repeated text and flush before completion", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-coalesce-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { store, jobId } = await createConversationFixture(root, "coalesced-stream");
  for (let index = 0; index < 10_000; index++) {
    await store.applyConversationNotification(jobId, {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "x" },
    }, undefined, true);
  }
  await store.applyConversationNotification(jobId, {
    method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
  }, undefined, true);
  const snapshot = await store.snapshot(jobId);
  assert.equal(snapshot.conversation?.turns[0]?.items[0]?.text, "x".repeat(10_000));
  assert.equal(snapshot.conversation?.turns[0]?.items[0]?.isStreaming, false);
  assert.ok(snapshot.serverConversationRevision < 100, "Durable writes must not track individual tokens.");
  assert.equal(snapshot.conversationDelivery?.pending, false);
  const journal = (await readFile(join(root, jobId, "conversation-events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(journal.map((patch) => patch.revision), Array.from({ length: journal.length }, (_, i) => i + 1));
  const restarted = new JobStore(root);
  await restarted.initialize();
  assert.equal((await restarted.snapshot(jobId)).conversation?.turns[0]?.items[0]?.text, "x".repeat(10_000));
});

test("telemetry survives delta delivery, native hydration and journal-only restart recovery", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-telemetry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { store, jobId } = await createConversationFixture(root, "telemetry-journal");
  const initial = await store.snapshot(jobId);
  const usage = { total: { totalTokens: 23, inputTokens: 12, cachedInputTokens: 4, cacheWriteInputTokens: 1, outputTokens: 11, reasoningOutputTokens: 2 }, last: { totalTokens: 4, inputTokens: 2, cachedInputTokens: 1, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 }, modelContextWindow: null };
  await store.applyConversationNotification(jobId, { method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: usage } });
  await store.applyConversationNotification(jobId, { method: "model/rerouted", params: { threadId: "thread-1", turnId: "turn-1", fromModel: "requested", toModel: "executed", requestedModel: "requested", reason: "highRiskCyberActivity" } });
  const delta = await store.snapshot(jobId, 0, 80, initial.serverConversationRevision);
  assert.ok(delta.conversationChanges.some((patch) => patch.tokenUsage?.total.totalTokens === 23));
  assert.ok(delta.conversationChanges.some((patch) => patch.turns[0]?.modelRouting?.executedModel === "executed"));
  await store.hydrateConversation(jobId, { thread: { id: "thread-1", turns: [{ id: "turn-1", status: "completed", items: [] }] } });
  const snapshot = await store.snapshot(jobId);
  assert.deepEqual(snapshot.conversation?.turns[0]?.tokenUsage, usage);
  assert.equal(snapshot.conversation?.modelRouting?.requestedModel, "requested");
  assert.equal(snapshot.conversation?.turns[0]?.modelRouting?.executedModel, "executed");
  await unlink(join(root, jobId, "conversation.json"));
  await unlink(join(root, jobId, "conversation.json.bak"));
  const restarted = new JobStore(root);
  await restarted.initialize();
  const recovered = await restarted.snapshot(jobId);
  assert.deepEqual(recovered.conversation?.tokenUsage, snapshot.conversation?.tokenUsage);
  assert.deepEqual(recovered.conversation?.turns[0]?.modelRouting, snapshot.conversation?.turns[0]?.modelRouting);
  const beforeInvalid = recovered.serverConversationRevision;
  await restarted.applyConversationNotification(jobId, { method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { ...usage, total: { ...usage.total, totalTokens: -1 } } } });
  assert.equal((await restarted.snapshot(jobId)).serverConversationRevision, beforeInvalid);
});

test("live cursor delivery does not read the disk journal and evicted cursors get a snapshot", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-hot-read-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { store, jobId } = await createConversationFixture(root, "hot-read");
  await store.applyConversationNotification(jobId, { method: "item/agentMessage/delta", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "committed",
  } });
  const journal = join(root, jobId, "conversation-events.jsonl");
  await rename(journal, `${journal}.offline`);
  const delta = await store.snapshot(jobId, 0, 20, 0);
  assert.equal(delta.conversationChanges.length, 1);
  assert.equal(delta.conversationChanges[0]?.turns[0]?.items[0]?.text, "committed");
  const reset = await store.snapshot(jobId, 0, 20, 0, true);
  assert.equal(reset.conversationDelivery?.mode, "snapshot");
  assert.equal(reset.conversationHasMore, false);
  assert.equal(reset.nextConversationRevision, 1);
  await rename(`${journal}.offline`, journal);
  const restarted = new JobStore(root);
  await restarted.initialize();
  const cold = await restarted.snapshot(jobId, 0, 20, 0);
  assert.ok(cold.conversation);
  assert.equal(cold.conversationChanges.length, 0);
  assert.equal(cold.nextConversationRevision, cold.serverConversationRevision);
});

test("the coalescing timer publishes partial output without requiring another notification", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-timer-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { store, jobId } = await createConversationFixture(root, "timer-flush");
  await store.applyConversationNotification(jobId, { method: "item/agentMessage/delta", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "agent", delta: "partial",
  } }, undefined, true);
  assert.equal((await store.snapshot(jobId)).conversationDelivery?.pending, true);
  const deadline = Date.now() + 2000;
  while (store.conversationRevision(jobId) === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(store.conversationRevision(jobId) > 0, "The timer must commit without an explicit flush.");
  await store.flushConversation(jobId); // Join any checkpoint promotion before removing the fixture.
  const snapshot = await store.snapshot(jobId);
  assert.equal(snapshot.conversation?.turns[0]?.items[0]?.text, "partial");
  assert.equal(snapshot.conversationDelivery?.pending, false);
});

test("a restarted five-thousand-revision journal converges in one full snapshot", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-backlog-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { store, jobId } = await createConversationFixture(root, "backlog-5000");
  await store.applyConversationNotification(jobId, { method: "item/agentMessage/delta", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "agent", delta: "seed",
  } });
  const path = join(root, jobId, "conversation-events.jsonl");
  const seed = JSON.parse((await readFile(path, "utf8")).trim());
  await writeFile(path, Array.from({ length: 5000 }, (_, index) => {
    const patch = structuredClone(seed);
    patch.revision = index + 1;
    patch.turns[0].items[0].text = `revision ${index + 1}`;
    return JSON.stringify(patch);
  }).join("\n") + "\n", "utf8");
  const restarted = new JobStore(root);
  await restarted.initialize();
  const page = await restarted.snapshot(jobId, 0, 20, 1);
  assert.equal(page.nextConversationRevision, 5000);
  assert.equal(page.serverConversationRevision, 5000);
  assert.equal(page.conversation?.turns[0]?.items[0]?.text, "revision 5000");
  assert.equal(page.conversationChanges.length, 0);
  assert.equal(page.conversationHasMore, false);
});

test("a coalesced journal commit survives a failed checkpoint promotion", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-coalesced-failure-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let fail = false;
  const store = new JobStore(root, join(root, "inbox"), async (source, destination) => {
    if (fail && destination.endsWith("conversation.json")) throw Object.assign(new Error("fixture write failure"), { code: "EIO" });
    await rename(source, destination);
  });
  await store.initialize();
  const { jobId } = await createConversationFixture(root, "coalesced-failure", store);
  await store.applyConversationNotification(jobId, { method: "item/agentMessage/delta", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "agent", delta: "durable partial",
  } }, undefined, true);
  fail = true;
  await assert.rejects(store.flushConversation(jobId), ConversationPersistenceError);
  const committed = await store.snapshot(jobId);
  assert.equal(committed.conversation?.turns[0]?.items[0]?.text, "durable partial");
  assert.ok(committed.conversationDiagnostics.some((diagnostic) => diagnostic.code === "conversation_checkpoint_write_failed"));
  const restarted = new JobStore(root);
  await restarted.initialize();
  assert.equal((await restarted.snapshot(jobId)).conversation?.turns[0]?.items[0]?.text, "durable partial");
});

test("a blocked checkpoint in one job does not block another job conversation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-isolation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let blockedJob = "";
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const store = new JobStore(root, join(root, "inbox"), async (source, destination) => {
    if (blockedJob && destination === join(root, blockedJob, "conversation.json")) { entered(); await gate; }
    await rename(source, destination);
  });
  await store.initialize();
  const first = await createConversationFixture(root, "blocked-job", store);
  const second = await createConversationFixture(root, "healthy-job", store);
  blockedJob = first.jobId;
  const notification = { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "a", delta: "hello" } };
  const blocked = store.applyConversationNotification(first.jobId, notification);
  await waiting;
  try {
    const healthy = await Promise.race([
      store.applyConversationNotification(second.jobId, notification),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Cross-job blockage")), 2000); timer.unref(); }),
    ]);
    assert.equal(healthy.turns[0]?.items[0]?.text, "hello");
  } finally { release(); await blocked; }
});

test("coalesced command, diff and approval retain final state with bounded technical projection", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-technical-stream-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { store, jobId } = await createConversationFixture(root, "technical-stream");
  for (let i = 0; i < 20; i++) {
    await store.applyConversationNotification(jobId, { method: "item/commandExecution/outputDelta", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "command", delta: "output".repeat(1000),
    } }, undefined, true);
    await store.applyConversationNotification(jobId, { method: "turn/diff/updated", params: {
      threadId: "thread-1", turnId: "turn-1", diff: `revision ${i}\n${"diff".repeat(100_000)}`,
    } }, undefined, true);
  }
  await store.applyConversationNotification(jobId, { method: "bridge/approval", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "command", approvalId: "approval", state: "pending", kind: "command",
  } }, undefined, true);
  const snapshot = await store.snapshot(jobId);
  assert.equal(snapshot.conversationDelivery?.pending, false);
  assert.ok(snapshot.conversation?.turns[0]?.items.find((item) => item.id === "command")?.outputTruncated);
  assert.match(await store.readArtifact(jobId, "diff"), /^revision 19/);
  assert.ok(snapshot.serverConversationRevision < 10);
});

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
