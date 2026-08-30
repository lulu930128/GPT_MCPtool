import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationRegistry } from "../src/automation-registry.js";
import type { BridgeConfig } from "../src/config.js";
import type { CodexBridgeController } from "../src/controller.js";
import type { JobStore } from "../src/job-store.js";
import type {
  AutomationOverlay,
  JobSnapshot,
  JobSummary,
  LocalThreadListPage,
  LocalThreadSnapshot,
  LocalThreadSummary,
} from "../src/types.js";
import { UnifiedConversationRegistry } from "../src/unified-conversation-registry.js";

test("automation registry exposes only bounded safe metadata", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-automation-registry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const automationDir = join(root, "automations", "daily-check");
  await mkdir(automationDir, { recursive: true });
  await writeFile(join(automationDir, "automation.toml"), [
    'name = "Daily check"',
    'status = "ACTIVE"',
    'rrule = "RRULE:FREQ=DAILY"',
    'target_thread_id = "01a032bf-9390-79c3-b8b3-ee84f058ed16"',
    'prompt = "never expose this private instruction"',
    "created_at = 1787567187146",
    "updated_at = 1787898567525",
  ].join("\n"), "utf8");

  const automations = await new AutomationRegistry(root, 0).list();
  assert.equal(automations.length, 1);
  assert.equal(automations[0]?.status, "ACTIVE");
  assert.equal(automations[0]?.targetThreadId, "01a032bf-9390-79c3-b8b3-ee84f058ed16");
  assert.doesNotMatch(JSON.stringify(automations), /never expose|private instruction|prompt/i);
});

test("unified registry merges one native thread with Bridge and automation overlays", async () => {
  const threadId = "01a032bf-9390-79c3-b8b3-ee84f058ed16";
  const jobs = [jobSummary(threadId)];
  const nativePage: LocalThreadListPage = {
    complete: true,
    threads: [
      {
        source: "local",
        threadId,
        projectId: "omi",
        projectName: "OMI",
        title: "Native title wins",
        preview: "Native preview",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-28T01:00:00.000Z",
        threadStatus: "idle",
        historyMode: "paginated",
        isPinned: false,
        historyOnly: false,
      },
      {
        source: "local",
        threadId: "01a00000-0000-7000-8000-000000000000",
        projectId: "local:protected",
        projectName: ".codex",
        title: "Protected",
        preview: "",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
        threadStatus: "idle",
        historyMode: "legacy",
        isPinned: false,
        historyOnly: true,
      },
    ],
  };
  const automation: AutomationOverlay = {
    automationId: "daily-check",
    name: "Daily check",
    status: "ACTIVE",
    schedule: "RRULE:FREQ=DAILY",
    targetThreadId: threadId,
    updatedAt: "2026-08-29T23:00:00.000Z",
  };
  const config = { projects: new Map([["omi", { id: "omi", name: "OMI", path: "C:\\project\\OMI" }]]) } as BridgeConfig;
  const store = {
    listAll: () => jobs,
  } as unknown as JobStore;
  const controller = {
    listLocalThreads: async () => nativePage,
  } as unknown as CodexBridgeController;
  const automations = { list: async () => [automation] } as unknown as AutomationRegistry;
  const registry = new UnifiedConversationRegistry(config, store, controller, automations);

  const appPage = await registry.listPage({ visibility: "app", limit: 20 });
  assert.equal(appPage.conversations.length, 2);
  const merged = appPage.conversations.find((conversation) => conversation.threadId === threadId);
  assert.equal(merged?.title, "Native title wins");
  assert.equal(merged?.source, "mixed");
  assert.equal(merged?.historyMode, "paginated");
  assert.equal(merged?.bridgeJob?.id, jobs[0]?.id);
  assert.equal(merged?.automationState, "automation_active");
  assert.equal(merged?.updatedAt, "2026-08-28T01:00:00.000Z");
  assert.equal(merged?.automationUpdatedAt, "2026-08-29T23:00:00.000Z");

  const publicPage = await registry.listPage({ visibility: "public", limit: 20 });
  assert.deepEqual(publicPage.conversations.map((conversation) => conversation.projectId), ["omi"]);
});

test("native history remains authoritative over a stale Bridge cache and unchanged polls avoid full reads", async () => {
  const threadId = "01a032bf-9390-79c3-b8b3-ee84f058ed16";
  const job = jobSummary(threadId);
  const local = localSnapshot(threadId, "Native current text");
  const summary = localSummary(threadId);
  let fullReads = 0;
  const controller = {
    readLocalThreadFresh: async (_threadId: string, knownFingerprint?: string) => {
      if (knownFingerprint === "fingerprint-1") return { summary, sourceFingerprint: "fingerprint-1" };
      fullReads += 1;
      return { summary, sourceFingerprint: "fingerprint-1", snapshot: local };
    },
  } as unknown as CodexBridgeController;
  const store = {
    listAll: () => [job],
    findByThreadId: () => job,
    snapshot: async () => bridgeSnapshot(job, "Stale Bridge text"),
  } as unknown as JobStore;
  const registry = new UnifiedConversationRegistry(testBridgeConfig(), store, controller, { list: async () => [] } as unknown as AutomationRegistry);

  const first = await registry.get(threadId, "app");
  const second = await registry.get(threadId, "app");
  const firstUser = first.view.conversation?.turns[0]?.items.find((item) => item.type === "userMessage");
  const secondUser = second.view.conversation?.turns[0]?.items.find((item) => item.type === "userMessage");
  assert.equal(firstUser?.text, "Native current text");
  assert.equal(firstUser?.context, "Bridge context");
  assert.equal(secondUser?.text, "Native current text");
  assert.equal(fullReads, 1);
});

test("unified list preserves durable Bridge jobs when App Server inventory is unavailable", async () => {
  const job = jobSummary("01a032bf-9390-79c3-b8b3-ee84f058ed16");
  const registry = new UnifiedConversationRegistry(
    testBridgeConfig(),
    { listAll: () => [job] } as unknown as JobStore,
    { listLocalThreads: async () => { throw new Error("offline"); } } as unknown as CodexBridgeController,
    { list: async () => [] } as unknown as AutomationRegistry,
  );

  const page = await registry.listPage({ visibility: "app" });
  assert.deepEqual(page.conversations.map((conversation) => conversation.bridgeJob?.id), [job.id]);
  assert.equal(page.complete, false);
  assert.equal(page.diagnostics.some((item) => item.code === "native_unavailable"), true);
});

test("unified get opens a Bridge-only conversation when native history is missing", async () => {
  const threadId = "01a032bf-9390-79c3-b8b3-ee84f058ed16";
  const job = jobSummary(threadId);
  const view = bridgeSnapshot(job, "Durable Bridge text");
  const registry = new UnifiedConversationRegistry(
    testBridgeConfig(),
    {
      listAll: () => [job],
      findByThreadId: () => job,
      snapshot: async () => view,
    } as unknown as JobStore,
    { readLocalThreadFresh: async () => { throw new Error("missing"); } } as unknown as CodexBridgeController,
    { list: async () => [] } as unknown as AutomationRegistry,
  );

  const snapshot = await registry.get(threadId, "app");
  assert.equal(snapshot.view.id, job.id);
  assert.equal(snapshot.diagnostics.some((item) => item.code === "native_unavailable"), true);
});

test("public get checks native workspace metadata before reading full history", async () => {
  const threadId = "01a032bf-9390-79c3-b8b3-ee84f058ed16";
  const job = jobSummary(threadId);
  let fullReads = 0;
  const protectedSummary = { ...localSummary(threadId), projectId: "local:protected", historyOnly: true };
  const registry = new UnifiedConversationRegistry(
    testBridgeConfig(),
    { listAll: () => [job], findByThreadId: () => job } as unknown as JobStore,
    {
      readLocalThreadSummary: async () => protectedSummary,
      readLocalThreadFresh: async () => { fullReads += 1; throw new Error("must not run"); },
    } as unknown as CodexBridgeController,
    { list: async () => [] } as unknown as AutomationRegistry,
  );

  await assert.rejects(() => registry.get(threadId, "public"), /outside the public project allowlist/);
  assert.equal(fullReads, 0);
});

test("unified list preserves native conversations when automation metadata is unavailable", async () => {
  const nativePage: LocalThreadListPage = { threads: [localSummary("01a032bf-9390-79c3-b8b3-ee84f058ed16")], complete: true };
  const registry = new UnifiedConversationRegistry(
    testBridgeConfig(),
    { listAll: () => [] } as unknown as JobStore,
    { listLocalThreads: async () => nativePage } as unknown as CodexBridgeController,
    { list: async () => { throw new Error("automation offline"); } } as unknown as AutomationRegistry,
  );

  const page = await registry.listPage({ visibility: "app" });
  assert.equal(page.conversations.length, 1);
  assert.equal(page.diagnostics.some((item) => item.code === "automation_unavailable"), true);
});

test("unified list reports missing automation targets without exposing prompts", async () => {
  const missingTarget = "01a00000-0000-7000-8000-000000000099";
  const registry = new UnifiedConversationRegistry(
    testBridgeConfig(),
    { listAll: () => [] } as unknown as JobStore,
    { listLocalThreads: async () => ({ threads: [], complete: true }) } as unknown as CodexBridgeController,
    { list: async () => [{ automationId: "missing", name: "Missing", status: "ACTIVE", schedule: "RRULE:FREQ=DAILY", targetThreadId: missingTarget }] } as unknown as AutomationRegistry,
  );

  const page = await registry.listPage({ visibility: "app" });
  const item = page.diagnostics.find((diagnostic) => diagnostic.code === "automation_target_missing");
  assert.equal(item?.automationId, "missing");
  assert.equal(item?.targetThreadId, missingTarget);
  assert.doesNotMatch(JSON.stringify(page), /prompt/i);
});

function testBridgeConfig(): BridgeConfig {
  return { projects: new Map([["omi", { id: "omi", name: "OMI", path: "C:\\project\\OMI" }]]) } as BridgeConfig;
}

function localSummary(threadId: string): LocalThreadSummary {
  return {
    source: "local",
    threadId,
    projectId: "omi",
    projectName: "OMI",
    title: "Native title",
    preview: "Native preview",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    threadStatus: "idle",
    historyMode: "legacy",
    isPinned: false,
    historyOnly: false,
  };
}

function localSnapshot(threadId: string, text: string): LocalThreadSnapshot {
  return {
    ...bridgeSnapshot(jobSummary(threadId), text),
    id: `local:${threadId}`,
    source: "local",
    readOnly: false,
    localThreadId: threadId,
    threadStatus: "idle",
    title: "Native title",
    objective: "Native preview",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
}

function bridgeSnapshot(job: JobSummary, text: string): JobSnapshot {
  return {
    ...job,
    messages: [{ id: "message-1", clientMessageId: "client-1", role: "user", content: text, context: "Bridge context", at: "2026-08-29T00:00:00.000Z" }],
    conversation: {
      schemaVersion: 1,
      threadId: job.threadId,
      status: "notLoaded",
      revision: 1,
      updatedAt: "2026-08-29T00:00:00.000Z",
      hydratedAt: "2026-08-29T00:00:00.000Z",
      freshness: { historyMode: "legacy", synchronized: true, sourceAvailability: "available", lastMetadataCheckedAt: "2026-08-29T00:00:00.000Z" },
      turns: [{
        turnId: "turn-1",
        status: "completed",
        items: [{ id: "user-1", turnId: "turn-1", type: "userMessage", status: "completed", isStreaming: false, text, clientMessageId: "client-1" }],
      }],
    },
    conversationChanges: [],
    nextConversationRevision: 1,
    serverConversationRevision: 1,
    conversationHasMore: false,
    conversationDiagnostics: [],
    events: [],
    nextEventSeq: 0,
    serverLastEventSeq: 0,
    hasMore: false,
    approvals: [],
    hasDiff: false,
    hasResult: false,
    inputArtifacts: [],
    artifacts: [],
  };
}

function jobSummary(threadId: string): JobSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "omi",
    projectName: "OMI",
    title: "Bridge title",
    objective: "Bridge objective",
    executionMode: "workspace_write",
    approvalReviewer: "user",
    dataClassification: "personal",
    status: "completed",
    stateVersion: 4,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    threadId,
    pendingApprovalCount: 0,
  };
}
