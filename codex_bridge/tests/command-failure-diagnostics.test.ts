import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createConversationProjection, hydrateConversationProjection, projectCommandFailures, reduceConversationNotification } from "../src/conversation-projection.js";
import { JobStore } from "../src/job-store.js";
import { previewWorkPackage } from "../src/work-package.js";

const command = { id: "item-1", type: "commandExecution", status: "completed", exitCode: 5,
  command: "sensitive-command", cwd: "private-path", env: { SECRET: "private-value" },
  aggregatedOutput: "Access denied NTFS ADMIN Sandbox sk-abcdefghijklmnop" };
function hydrated(item: Record<string, unknown> = command) {
  return hydrateConversationProjection(createConversationProjection("thread-1"), {
    thread: { id: "thread-1", turns: [{ id: "turn-1", status: "completed", items: [item] }] },
  });
}

test("nonzero completion reports only allowlisted evidence, with no cause attribution", () => {
  const projection = hydrated();
  const before = structuredClone(projection);
  const result = projectCommandFailures("job-1", "thread-1", projection);
  assert.deepEqual(result, {
    evidenceStatus: "OBSERVED_NONZERO", cause: "UNKNOWN", permissionAttribution: "UNVERIFIED",
    scope: "bounded_saved_conversation", scannedItems: 1, truncated: false,
    failures: [{ jobId: "job-1", turnId: "turn-1", itemId: "item-1", exitCode: 5,
      observedStatus: "completed", evidenceStatus: "OBSERVED_NONZERO", cause: "UNKNOWN",
      permissionAttribution: "UNVERIFIED" }],
  });
  assert.deepEqual(projection, before);
  assert.doesNotMatch(JSON.stringify(result), /Access denied|NTFS|ADMIN|Sandbox|private|sensitive|sk-|command"|cwd|env|output|stderr|request|approval|grant/i);
});

test("missing or invalid exit/status and non-command items never establish failure", () => {
  for (const patch of [
    { exitCode: undefined }, { exitCode: null }, { exitCode: "5" }, { exitCode: NaN },
    { exitCode: Infinity }, { exitCode: 1.5 }, { exitCode: 0 }, { exitCode: Number.MAX_SAFE_INTEGER + 1 },
    { status: undefined }, { status: "inProgress" }, { status: "failed" }, { type: "mcpToolCall" },
    { turnId: "other-turn" },
  ]) {
    const result = projectCommandFailures("job-1", "thread-1", hydrated({ ...command, ...patch }));
    assert.equal(result.evidenceStatus, "UNVERIFIED", JSON.stringify(patch));
    assert.deepEqual(result.failures, []);
  }
});

test("started item and generic turn completion cannot fabricate completion evidence", () => {
  let projection = reduceConversationNotification(createConversationProjection("thread-1"), {
    method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: command },
  });
  projection = reduceConversationNotification(projection, {
    method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } },
  });
  assert.deepEqual(projectCommandFailures("job-1", "thread-1", projection).failures, []);
});

test("legacy markers, mismatched identities and unsafe identifiers are omitted", () => {
  for (const alter of [
    (p: ReturnType<typeof hydrated>) => { delete p.turns[0]!.items[0]!.commandCompletionObserved; },
    (p: ReturnType<typeof hydrated>) => { p.turns[0]!.items[0]!.turnId = "other-turn"; },
    (p: ReturnType<typeof hydrated>) => { p.threadId = "other-thread"; },
    (p: ReturnType<typeof hydrated>) => { p.turns[0]!.items[0]!.commandCompletionThreadId = "other-thread"; },
    (p: ReturnType<typeof hydrated>) => { p.turns[0]!.items[0]!.id = "sk-abcdefghijklmnop"; },
    (p: ReturnType<typeof hydrated>) => { p.turns[0]!.turnId = "unknown:inferred"; },
    (p: ReturnType<typeof hydrated>) => { p.turns[0]!.items[0]!.id = "x".repeat(129); },
  ]) {
    const projection = hydrated();
    alter(projection);
    assert.deepEqual(projectCommandFailures("job-1", "thread-1", projection).failures, []);
  }
  assert.deepEqual(projectCommandFailures("job-1", undefined, hydrated()).failures, []);
});

test("hydration missing result data replaces earlier evidence without stale reuse", () => {
  const projection = hydrateConversationProjection(hydrated(), {
    thread: { id: "thread-1", turns: [{ id: "turn-1", items: [{ id: "item-1", type: "commandExecution" }] }] },
  });
  assert.deepEqual(projectCommandFailures("job-1", "thread-1", projection).failures, []);
  const missingThread = hydrateConversationProjection(hydrated(), {
    thread: { turns: [{ id: "turn-1", items: [command] }] },
  });
  assert.deepEqual(projectCommandFailures("job-1", "thread-1", missingThread).failures, []);
});

test("output and scan budgets are bounded and visibly incomplete", () => {
  const projection = hydrated();
  const item = projection.turns[0]!.items[0]!;
  projection.turns[0]!.items = Array.from({ length: 60 }, (_, i) => ({ ...item, id: `item-${i}` }));
  const result = projectCommandFailures("job-1", "thread-1", projection);
  assert.equal(result.failures.length, 50);
  assert.equal(result.truncated, true);
  projection.turns[0]!.items = Array.from({ length: 2001 }, (_, i) => ({ ...item, id: `item-${i}`, exitCode: 0 }));
  const scanned = projectCommandFailures("job-1", "thread-1", projection);
  assert.equal(scanned.scannedItems, 2000);
  assert.equal(scanned.truncated, true);
  projection.turns = Array.from({ length: 201 }, (_, i) => ({ turnId: `turn-${i}`, status: "completed", items: [] }));
  assert.equal(projectCommandFailures("job-1", "thread-1", projection).truncated, true);
});

test("JobStore snapshots expose durable diagnostics across cursors and reload without lifecycle writes", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp", "readonly-diagnostics", "store-"));
  const store = new JobStore(root);
  await store.initialize();
  const preview = previewWorkPackage({ projectId: "omi", title: "Diagnostics fixture", objective: "Read saved evidence." });
  const create = async (key: string) => (await store.create({
    project: { id: "omi", name: "Fixture", path: join(root, "project") },
    workPackage: preview.workPackage, previewDigest: preview.previewDigest, idempotencyKey: key,
  })).record.id;
  const jobId = await create("fixture-1");
  const otherJobId = await create("fixture-2");
  await store.setThread(jobId, "thread-1");
  await store.setThread(otherJobId, "thread-2");
  await store.applyConversationNotification(jobId, {
    method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: command },
  });
  const before = await readFile(join(root, jobId, "manifest.json"), "utf8");
  const snapshot = await store.snapshot(jobId);
  assert.equal(snapshot.commandFailureDiagnostics?.failures[0]?.jobId, jobId);
  assert.equal(snapshot.commandFailureDiagnostics?.evidenceStatus, "OBSERVED_NONZERO");
  const delta = await store.snapshot(jobId, snapshot.nextEventSeq, 1, snapshot.serverConversationRevision);
  assert.deepEqual(delta.commandFailureDiagnostics, snapshot.commandFailureDiagnostics);
  assert.equal(await readFile(join(root, jobId, "manifest.json"), "utf8"), before);
  assert.deepEqual((await store.snapshot(otherJobId)).commandFailureDiagnostics?.failures, []);
  const reloaded = new JobStore(root);
  await reloaded.initialize();
  assert.deepEqual((await reloaded.snapshot(jobId)).commandFailureDiagnostics, snapshot.commandFailureDiagnostics);
  // Company history does not gain a new diagnostic surface.
  const company = previewWorkPackage({ projectId: "omi", title: "Company fixture", objective: "Read evidence.",
    dataClassification: "company_approved" });
  const restricted = await store.create({ project: { id: "omi", name: "Fixture", path: root },
    workPackage: company.workPackage, previewDigest: company.previewDigest, idempotencyKey: "company" });
  assert.equal((await store.snapshot(restricted.record.id)).commandFailureDiagnostics, undefined);
  const unclassified = await create("local-thread:unclassified-fixture");
  assert.equal((await store.snapshot(unclassified)).commandFailureDiagnostics, undefined);
});
