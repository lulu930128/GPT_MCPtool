import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import test from "node:test";
import type {
  AppServerStatus,
  AppServerTransport,
  JsonRpcNotification,
  JsonRpcServerRequest,
} from "../src/app-server-client.js";
import type { BridgeConfig } from "../src/config.js";
import { CodexBridgeController, isSafeDiscoveredProjectPath } from "../src/controller.js";
import { JobStore } from "../src/job-store.js";
import { TextBundleStore } from "../src/text-bundle-store.js";
import { previewWorkPackage } from "../src/work-package.js";

class FakeTransport extends EventEmitter implements AppServerTransport {
  status: AppServerStatus = "idle";
  requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  responses: Array<{ id: string | number; result: Record<string, unknown> }> = [];
  turnCount = 0;
  threadReadResponse?: Record<string, unknown>;
  historyReadBarrier?: Promise<void>;
  onHistoryRead?: () => void;
  threadListResponses = new Map<string, Record<string, unknown>>();
  modelListResponses = new Map<string, Record<string, unknown>>();
  failSteer = false;
  failControlAction = false;
  wrongReviewThread = false;

  async ensureStarted(): Promise<void> { this.status = "ready"; }
  async close(): Promise<void> { this.status = "idle"; }
  async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.ensureStarted();
    this.requests.push({ method, params });
    if (["thread/compact/start", "review/start"].includes(method) && this.failControlAction) throw new Error("Transport lost private-secret");
    if (method === "review/start") return { reviewThreadId: this.wrongReviewThread ? "other-thread" : params?.threadId, turn: { id: `review-${++this.turnCount}`, status: "inProgress", items: [] } } as T;
    if (method === "turn/steer" && this.failSteer) throw new Error("Transport response lost");
    if (method === "permissionProfile/list") {
      return {
        data: [
          { id: "codex-bridge-read-only", allowed: true },
          { id: "codex-bridge-workspace", allowed: true },
        ],
        nextCursor: null,
      } as T;
    }
    if (method === "model/list") {
      if (this.modelListResponses.size) return this.modelListResponses.get(String(params?.cursor ?? "")) as T;
      return {
        data: [{
          id: "gpt-test",
          displayName: "GPT Test",
          isDefault: true,
          hidden: false,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "high", description: "Deep" },
            { reasoningEffort: "ultra", description: "Delegated" },
          ],
        }],
        nextCursor: null,
      } as T;
    }
    if (method === "thread/start") return { thread: { id: "thread-1" } } as T;
    if (method === "thread/resume") return { thread: { id: String(params?.threadId) } } as T;
    if (method === "thread/read") {
      const response = structuredClone(this.threadReadResponse ?? {
        thread: { id: String(params?.threadId), status: { type: "notLoaded" }, turns: [] },
      });
      if (params?.includeTurns) { this.onHistoryRead?.(); await this.historyReadBarrier; }
      return response as T;
    }
    if (method === "thread/list") return (this.threadListResponses.get(String(params?.cursor ?? "")) ?? {
      data: [],
      nextCursor: null,
    }) as T;
    if (method === "turn/start") return { turn: { id: `turn-${++this.turnCount}` } } as T;
    return {} as T;
  }
  notify(): void {}
  respond(id: string | number, result: Record<string, unknown>): void { this.responses.push({ id, result }); }
  emitNotification(message: JsonRpcNotification): void { this.emit("notification", message); }
  emitRequest(message: JsonRpcServerRequest): void { this.emit("serverRequest", message); }
  emitStderr(line: string): void { this.emit("stderr", line); }
}

test("controller starts an allowlisted sandboxed turn and gates one approval", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-controller-"));
  context.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  const projectPath = join(root, "project");
  const jobsDir = join(root, "jobs");
  await mkdir(projectPath);
  const store = new JobStore(jobsDir, join(root, ".local", "codex-inbox"));
  await store.initialize();
  const fake = new FakeTransport();
  const config = testConfig(root, jobsDir, projectPath);
  const textBundles = new TextBundleStore(config.stagingDir);
  await textBundles.initialize();
  const controller = new CodexBridgeController(config, store, textBundles, fake);
  const preview = previewWorkPackage({
    projectId: "omi",
    title: "Controller test",
    objective: "Inspect files.",
    executionMode: "plan",
  });
  const dispatched = await controller.dispatch({ preview, previewDigest: preview.previewDigest, idempotencyKey: "controller-test-1" });
  await waitFor(() => store.get(dispatched.record.id)?.status === "running");

  const turnStart = fake.requests.find((request) => request.method === "turn/start");
  const threadStart = fake.requests.find((request) => request.method === "thread/start");
  assert.equal(threadStart?.params?.permissions, "codex-bridge-read-only");
  assert.equal(turnStart?.params?.sandboxPolicy, undefined);
  assert.equal(turnStart?.params?.approvalPolicy, "on-request");
  assert.equal(threadStart?.params?.approvalsReviewer, "auto_review");
  assert.equal(turnStart?.params?.approvalsReviewer, "auto_review");
  assert.equal(String((turnStart?.params?.input as Array<{ text: string }>)[0]?.text), "Inspect files.");
  fake.emitRequest({
    id: 17,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", command: "npm test", authorization: "Bearer abcdefghijklmnop" },
  });
  await waitFor(() => store.get(dispatched.record.id)?.status === "awaiting_approval");
  const pending = store.get(dispatched.record.id)?.approvals[0];
  assert.equal(pending?.summary.authorization, undefined);
  assert.equal(pending?.summary.command, "npm test");

  await controller.decideApproval(dispatched.record.id, pending!.id, "accept");
  assert.deepEqual(fake.responses, [{ id: 17, result: { decision: "accept" } }]);
  assert.equal(store.get(dispatched.record.id)?.status, "running");

  fake.emitNotification({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "message-1",
        type: "agentMessage",
        text: `Final result with ${["sk", "fixture".repeat(3)].join("-")} redacted.`,
      },
    },
  });
  fake.emitNotification({ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1", status: "completed" } });
  await waitFor(() => store.get(dispatched.record.id)?.status === "completed");
  assert.equal(store.get(dispatched.record.id)?.result?.output, "Final result with [redacted] redacted.");
});

test("controller preserves interrupted as distinct from cancelled", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-interrupted-"));
  context.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  const projectPath = join(root, "project");
  const jobsDir = join(root, "jobs");
  await mkdir(projectPath);
  const store = new JobStore(jobsDir, join(root, ".local", "codex-inbox"));
  await store.initialize();
  const config = testConfig(root, jobsDir, projectPath);
  const textBundles = new TextBundleStore(config.stagingDir);
  await textBundles.initialize();
  const fake = new FakeTransport();
  const controller = new CodexBridgeController(config, store, textBundles, fake);
  const preview = previewWorkPackage({ projectId: "omi", title: "Interrupted", objective: "Preserve status." });
  const dispatched = await controller.dispatch({ preview, previewDigest: preview.previewDigest, idempotencyKey: "controller-interrupted-1" });
  await waitFor(() => store.get(dispatched.record.id)?.status === "running");

  fake.emitNotification({ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1", status: "interrupted" } });
  await waitFor(() => store.get(dispatched.record.id)?.status === "interrupted");
  assert.equal(store.get(dispatched.record.id)?.result?.status, "interrupted");
  assert.equal(store.get(dispatched.record.id)?.result?.message, "Codex turn was interrupted.");
});

test("plan mode refuses file-change acceptance", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-plan-"));
  context.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  const projectPath = join(root, "project");
  const jobsDir = join(root, "jobs");
  await mkdir(projectPath);
  const store = new JobStore(jobsDir, join(root, ".local", "codex-inbox"));
  await store.initialize();
  const fake = new FakeTransport();
  const config = testConfig(root, jobsDir, projectPath);
  const textBundles = new TextBundleStore(config.stagingDir);
  await textBundles.initialize();
  const controller = new CodexBridgeController(config, store, textBundles, fake);
  const preview = previewWorkPackage({ projectId: "omi", title: "Plan", objective: "Plan only." });
  const dispatched = await controller.dispatch({ preview, previewDigest: preview.previewDigest, idempotencyKey: "controller-test-2" });
  await waitFor(() => store.get(dispatched.record.id)?.status === "running");
  const conversationRevision = (await store.snapshot(dispatched.record.id)).serverConversationRevision;
  fake.emitRequest({ id: 18, method: "item/fileChange/requestApproval", params: { turnId: "turn-1", changes: ["a.ts"] } });
  await waitFor(() => store.get(dispatched.record.id)?.status === "awaiting_approval");
  await waitForConversationRevision(store, dispatched.record.id, conversationRevision + 1);
  const approval = store.get(dispatched.record.id)!.approvals[0];
  await assert.rejects(controller.decideApproval(dispatched.record.id, approval.id, "accept"), /plan mode/);
  assert.equal(fake.responses.length, 0);
});

test("controller suppresses lifecycle noise and bounds App Server diagnostics", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-events-"));
  context.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  const projectPath = join(root, "project");
  const jobsDir = join(root, "jobs");
  await mkdir(projectPath);
  const store = new JobStore(jobsDir, join(root, ".local", "codex-inbox"));
  await store.initialize();
  const fake = new FakeTransport();
  const config = testConfig(root, jobsDir, projectPath);
  const textBundles = new TextBundleStore(config.stagingDir);
  await textBundles.initialize();
  const controller = new CodexBridgeController(config, store, textBundles, fake);
  const preview = previewWorkPackage({ projectId: "omi", title: "Event filter", objective: "Inspect progress." });
  const dispatched = await controller.dispatch({ preview, previewDigest: preview.previewDigest, idempotencyKey: "controller-test-3" });
  await waitFor(() => store.get(dispatched.record.id)?.status === "running");

  for (const method of ["item/started", "item/completed"] as const) {
    fake.emitNotification({
      method,
      params: { threadId: "thread-1", turnId: "turn-1", item: { id: "reason-1", type: "reasoning" } },
    });
    fake.emitNotification({
      method,
      params: { threadId: "thread-1", turnId: "turn-1", item: { id: "user-1", type: "userMessage" } },
    });
  }
  fake.emitNotification({
    method: "item/started",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "mcp-1", type: "mcpToolCall", server: "memory", tool: "search" } },
  });
  fake.emitNotification({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "mcp-1", type: "mcpToolCall", status: "completed", server: "memory", tool: "search" } },
  });
  fake.emitNotification({
    method: "item/started",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "message-1", type: "agentMessage" } },
  });
  fake.emitNotification({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "message-1", type: "agentMessage", text: "Progress update." } },
  });
  fake.emitStderr('{"level":"WARN","fields":{"message":"harmless startup warning"},"target":"codex_test"}');
  const errorLine = '{"level":"ERROR","fields":{"message":"worker failed safely"},"target":"codex_test"}';
  fake.emitStderr(errorLine);
  fake.emitStderr(errorLine);

  await waitFor(() => (store.get(dispatched.record.id)?.lastEventSeq ?? 0) >= 8);
  const snapshot = await store.snapshot(dispatched.record.id, 0, 200);
  const itemTypes = snapshot.events
    .filter((event) => event.type.startsWith("codex.item."))
    .map((event) => event.data?.type);
  assert.deepEqual(itemTypes, ["mcpToolCall", "mcpToolCall", "agentMessage"]);
  assert.equal(snapshot.events.some((event) => event.data?.type === "reasoning" || event.data?.type === "userMessage"), false);
  const diagnostics = snapshot.events.filter((event) => event.type === "codex.diagnostic.error");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.data?.text, "worker failed safely");
  assert.equal(diagnostics[0]?.data?.target, "codex_test");
});

test("controller does not misattribute shared App Server stderr across concurrent turns", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-shared-stderr-"));
  context.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  const projectPath = join(root, "project");
  const jobsDir = join(root, "jobs");
  await mkdir(projectPath);
  const store = new JobStore(jobsDir, join(root, ".local", "codex-inbox"));
  await store.initialize();
  const fake = new FakeTransport();
  const config = testConfig(root, jobsDir, projectPath);
  const textBundles = new TextBundleStore(config.stagingDir);
  await textBundles.initialize();
  const controller = new CodexBridgeController(config, store, textBundles, fake);
  const firstPreview = previewWorkPackage({ projectId: "omi", title: "First", objective: "Inspect first." });
  const secondPreview = previewWorkPackage({ projectId: "omi", title: "Second", objective: "Inspect second." });
  const first = await controller.dispatch({
    preview: firstPreview,
    previewDigest: firstPreview.previewDigest,
    idempotencyKey: "shared-stderr-first",
  });
  const second = await controller.dispatch({
    preview: secondPreview,
    previewDigest: secondPreview.previewDigest,
    idempotencyKey: "shared-stderr-second",
  });
  await waitFor(() => store.get(first.record.id)?.status === "running" && store.get(second.record.id)?.status === "running");

  fake.emitStderr('{"level":"ERROR","fields":{"message":"unscoped shared failure"},"target":"codex_test"}');
  await new Promise((resolve) => setTimeout(resolve, 25));

  for (const jobId of [first.record.id, second.record.id]) {
    const snapshot = await store.snapshot(jobId, 0, 200);
    assert.equal(snapshot.events.some((event) => event.type === "codex.diagnostic.error"), false);
  }
});

test("controller resumes a completed conversation with the selected model and de-duplicates messages", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-conversation-"));
  context.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  const projectPath = join(root, "project");
  const jobsDir = join(root, "jobs");
  await mkdir(projectPath);
  const store = new JobStore(jobsDir, join(root, ".local", "codex-inbox"));
  await store.initialize();
  const fake = new FakeTransport();
  const config = testConfig(root, jobsDir, projectPath);
  const textBundles = new TextBundleStore(config.stagingDir);
  await textBundles.initialize();
  const controller = new CodexBridgeController(config, store, textBundles, fake);
  const preview = previewWorkPackage({
    projectId: "omi",
    title: "Conversation",
    objective: "Inspect the first issue.",
    executionMode: "plan",
    model: "gpt-test",
    effort: "low",
  });
  const dispatched = await controller.dispatch({
    preview,
    previewDigest: preview.previewDigest,
    idempotencyKey: "conversation-test-1",
  });
  await waitFor(() => store.get(dispatched.record.id)?.status === "running");
  fake.emitNotification({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", text: "First answer." } },
  });
  fake.emitNotification({
    method: "turn/completed",
    params: { threadId: "thread-1", turnId: "turn-1", status: "completed" },
  });
  await waitFor(() => store.get(dispatched.record.id)?.status === "completed");

  const sent = await controller.sendMessage({
    jobId: dispatched.record.id,
    clientMessageId: "message-client-1",
    content: "Now inspect the follow-up.",
    context: "Pasted file content.",
    executionMode: "workspace_write",
    approvalReviewer: "user",
    dataClassification: "personal",
    model: "gpt-test",
    effort: "ultra",
  });
  assert.equal(sent.delivery, "turn");
  await waitFor(() => store.get(dispatched.record.id)?.status === "running");
  const resume = fake.requests.find((request) => request.method === "thread/resume");
  assert.equal(resume?.params?.threadId, "thread-1");
  assert.equal(resume?.params?.permissions, "codex-bridge-workspace");
  assert.equal(resume?.params?.approvalsReviewer, "user");
  const secondTurn = fake.requests.filter((request) => request.method === "turn/start")[1];
  assert.equal(secondTurn?.params?.threadId, "thread-1");
  assert.equal(secondTurn?.params?.model, "gpt-test");
  assert.equal(secondTurn?.params?.effort, "ultra");
  assert.equal(secondTurn?.params?.approvalsReviewer, "user");

  const duplicate = await controller.sendMessage({
    jobId: dispatched.record.id,
    clientMessageId: "message-client-1",
    content: "Now inspect the follow-up.",
    context: "Pasted file content.",
    executionMode: "workspace_write",
    approvalReviewer: "user",
    dataClassification: "personal",
    model: "gpt-test",
    effort: "ultra",
  });
  assert.equal(duplicate.delivery, "duplicate");
  assert.equal(fake.requests.filter((request) => request.method === "turn/steer").length, 0);

  fake.emitNotification({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-2", item: { type: "agentMessage", text: "Second answer." } },
  });
  fake.emitNotification({
    method: "turn/completed",
    params: { threadId: "thread-1", turnId: "turn-2", status: "completed" },
  });
  await waitFor(() => store.get(dispatched.record.id)?.status === "completed");
  const snapshot = await store.snapshot(dispatched.record.id, 0, 200);
  assert.deepEqual(snapshot.messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(snapshot.messages.map((message) => message.content), [
    "Inspect the first issue.",
    "First answer.",
    "Now inspect the follow-up.",
    "Second answer.",
  ]);
});

test("controller injects verified staged text without granting the staging directory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-staged-controller-"));
  context.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  const projectPath = join(root, "project");
  const jobsDir = join(root, "jobs");
  await mkdir(projectPath);
  const config = testConfig(root, jobsDir, projectPath);
  const store = new JobStore(jobsDir, join(root, ".local", "codex-inbox"));
  await store.initialize();
  const textBundles = new TextBundleStore(config.stagingDir);
  await textBundles.initialize();
  const content = "請依這份工程稿檢查 MCP 回傳格式。";
  const sha256 = createHash("sha256").update(content).digest("hex");
  const begun = await textBundles.begin({
    clientTransferId: randomUUID(),
    projectId: "omi",
    fileName: "engineering_spec.txt",
    mimeType: "text/plain",
    dataClassification: "personal",
    totalChars: content.length,
    totalBytes: Buffer.byteLength(content),
    sha256,
    chunkCount: 1,
  });
  await textBundles.append(begun.bundle.id, 0, content, sha256);
  await textBundles.finalize(begun.bundle.id);

  const fake = new FakeTransport();
  const controller = new CodexBridgeController(config, store, textBundles, fake);
  const preview = previewWorkPackage({
    projectId: "omi",
    title: "Use staged text",
    objective: "Review the attached engineering draft.",
    inputBundleIds: [begun.bundle.id],
  });
  const dispatched = await controller.dispatch({
    preview,
    previewDigest: preview.previewDigest,
    idempotencyKey: "staged-controller-test",
  });
  await waitFor(() => store.get(dispatched.record.id)?.status === "running");
  await waitForConversationRevision(store, dispatched.record.id, 1);
  const turnStart = fake.requests.find((request) => request.method === "turn/start");
  const instruction = String((turnStart?.params?.input as Array<{ text: string }>)[0]?.text);
  assert.match(instruction, /engineering_spec\.txt/);
  assert.match(instruction, /請依這份工程稿檢查 MCP 回傳格式/);
  assert.match(instruction, new RegExp(sha256));
  assert.match(instruction, /localPath:/);
  assert.doesNotMatch(instruction, /Follow repository AGENTS\.md|Do not commit|Run proportionate validation/i);
  assert.match(instruction, new RegExp(escapeRegExp(JSON.stringify(join(config.handoffDir, dispatched.record.id, `${begun.bundle.id}.txt`)))));
  assert.deepEqual(turnStart?.params?.runtimeWorkspaceRoots, [projectPath]);
  assert.doesNotMatch(instruction, new RegExp(escapeRegExp(config.stagingDir), "i"));
});

test("controller refreshes persisted history when the source fingerprint changes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-hydration-controller-"));
  context.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  const projectPath = join(root, "project");
  const jobsDir = join(root, "jobs");
  await mkdir(projectPath);
  const store = new JobStore(jobsDir, join(root, ".local", "codex-inbox"));
  await store.initialize();
  const fake = new FakeTransport();
  const config = testConfig(root, jobsDir, projectPath);
  const textBundles = new TextBundleStore(config.stagingDir);
  await textBundles.initialize();
  const controller = new CodexBridgeController(config, store, textBundles, fake);
  const preview = previewWorkPackage({ projectId: "omi", title: "Hydration", objective: "First turn." });
  const dispatched = await controller.dispatch({ preview, previewDigest: preview.previewDigest, idempotencyKey: "hydration-test-1" });
  await waitFor(() => store.get(dispatched.record.id)?.status === "running");
  fake.emitNotification({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
  });
  await waitFor(() => store.get(dispatched.record.id)?.status === "completed");
  fake.threadReadResponse = {
    thread: {
      id: "thread-1",
      updatedAt: 100,
      status: { type: "notLoaded" },
      turns: [1, 2, 3].map((number) => ({
        id: `turn-${number}`,
        status: "completed",
        items: [
          { id: `user-${number}`, type: "userMessage", clientId: `client-${number}`, content: [{ type: "text", text: `User ${number}` }] },
          { id: `agent-${number}`, type: "agentMessage", text: `Assistant ${number}` },
        ],
      })),
    },
  };

  assert.equal(await controller.hydrateConversation(dispatched.record.id), true);
  assert.equal(await controller.hydrateConversation(dispatched.record.id), false);
  assert.equal(fake.requests.filter((request) => request.method === "thread/read").length, 3);
  const priorRevision = (await store.snapshot(dispatched.record.id)).conversation?.revision ?? 0;
  (fake.threadReadResponse.thread as Record<string, unknown>).updatedAt = 101;
  (fake.threadReadResponse.thread as Record<string, unknown>).turns = (
    (fake.threadReadResponse.thread as Record<string, unknown>).turns as Record<string, unknown>[]
  ).slice(0, 2);
  assert.equal(await controller.hydrateConversation(dispatched.record.id), true);
  const snapshot = await store.snapshot(dispatched.record.id, 0, 80, priorRevision);
  const current = await store.snapshot(dispatched.record.id);
  assert.deepEqual(current.conversation?.turns.map((turn) => turn.turnId), ["turn-1", "turn-2"]);
  assert.equal(snapshot.conversationChanges.at(-1)?.replaceAll, true);
});

test("controller lists complete local Codex history and discovers only safe workspaces", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-local-list-"));
  context.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  const projectPath = join(root, "project");
  const externalPath = join(root, "outside-project");
  const discoveredPath = join(process.cwd(), ".tmp", `controller-discovered-${randomUUID()}`);
  const jobsDir = join(root, "jobs");
  await mkdir(projectPath);
  await mkdir(externalPath);
  await mkdir(discoveredPath, { recursive: true });
  context.after(() => rm(discoveredPath, { recursive: true, force: true }));
  const config = testConfig(root, jobsDir, projectPath);
  const store = new JobStore(jobsDir, join(root, ".local", "codex-inbox"));
  await store.initialize();
  const textBundles = new TextBundleStore(config.stagingDir);
  await textBundles.initialize();
  const fake = new FakeTransport();
  const allowedId = randomUUID();
  const localId = randomUUID();
  fake.threadListResponses.set("", {
    data: [
      { id: allowedId, cwd: projectPath, name: "Allowlisted history", preview: "Allowed", createdAt: 10, updatedAt: 11, recencyAt: 12, status: { type: "notLoaded" } },
      { id: randomUUID(), cwd: externalPath, name: "Ephemeral", ephemeral: true, createdAt: 9 },
    ],
    nextCursor: "page-2",
  });
  fake.threadListResponses.set("page-2", {
    data: [
      { id: allowedId, cwd: projectPath, name: "Duplicate", createdAt: 10 },
      { id: randomUUID(), cwd: discoveredPath, name: "Discovered project", preview: "Continue here", createdAt: 9, updatedAt: 10, status: { type: "notLoaded" } },
      { id: localId, cwd: externalPath, preview: "Local-only conversation", createdAt: 8, updatedAt: 9, status: { type: "notLoaded" } },
    ],
    nextCursor: null,
  });

  const controller = new CodexBridgeController(config, store, textBundles, fake);
  const page = await controller.listLocalThreads();

  assert.equal(page.complete, true);
  assert.equal(page.nextCursor, undefined);
  assert.equal(page.threads.length, 3);
  assert.equal(page.threads[0]?.threadId, allowedId);
  assert.deepEqual(page.threads.map((thread) => thread.historyOnly), [false, false, true]);
  assert.equal(page.threads[0]?.projectId, "omi");
  assert.match(page.threads[1]?.projectId ?? "", /^local:[0-9a-f]{16}$/);
  assert.equal(page.threads[1]?.projectName, "controller-discovered-" + discoveredPath.split("controller-discovered-")[1]);
  assert.equal(controller.requireOperableProject(page.threads[1]!.projectId).path, discoveredPath);
  assert.match(page.threads[2]?.projectId ?? "", /^local:[0-9a-f]{16}$/);
  assert.equal(page.threads[2]?.projectName, "outside-project");
  assert.throws(() => controller.requireOperableProject(page.threads[2]!.projectId), /Unknown or protected project id/);
  assert.equal(isSafeDiscoveredProjectPath(discoveredPath, config), true);
  assert.equal(isSafeDiscoveredProjectPath(parse(discoveredPath).root, config), false);
  for (const protectedPath of [
    join(config.projectRoot, ".local"),
    join(config.projectRoot, ".secrets"),
    join(config.projectRoot, ".tunnel-client"),
    join(config.projectRoot, "..", "project_reading", ".secrets"),
    config.handoffDir,
  ]) {
    assert.equal(isSafeDiscoveredProjectPath(protectedPath, config), false);
    assert.equal(isSafeDiscoveredProjectPath(join(protectedPath, "child"), config), false);
  }
  assert.equal(fake.requests.filter((request) => request.method === "thread/list").length, 2);
});

test("controller follows the App Server cursor chain beyond two thousand native threads", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-large-local-list-"));
  context.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  const projectPath = join(root, "project");
  const jobsDir = join(root, "jobs");
  await mkdir(projectPath);
  const config = testConfig(root, jobsDir, projectPath);
  const store = new JobStore(jobsDir, join(root, ".local", "codex-inbox"));
  await store.initialize();
  const textBundles = new TextBundleStore(config.stagingDir);
  await textBundles.initialize();
  const fake = new FakeTransport();
  const total = 2_001;
  for (let offset = 0; offset < total; offset += 100) {
    const cursor = offset === 0 ? "" : `page-${offset / 100}`;
    const nextOffset = offset + 100;
    fake.threadListResponses.set(cursor, {
      data: Array.from({ length: Math.min(100, total - offset) }, (_, index) => ({
        id: randomUUID(),
        cwd: projectPath,
        name: `Thread ${offset + index}`,
        createdAt: total - offset - index,
        recencyAt: total - offset - index,
        status: { type: "notLoaded" },
      })),
      nextCursor: nextOffset < total ? `page-${nextOffset / 100}` : null,
    });
  }

  const controller = new CodexBridgeController(config, store, textBundles, fake);
  const page = await controller.listLocalThreads(undefined, total);

  assert.equal(page.threads.length, total);
  assert.equal(page.complete, true);
  assert.equal(page.nextCursor, undefined);
  assert.equal(fake.requests.filter((request) => request.method === "thread/list").length, 21);
});

test("controller reads local Codex history through the bounded conversation projection", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-local-read-"));
  context.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  const projectPath = join(root, "project");
  const jobsDir = join(root, "jobs");
  await mkdir(projectPath);
  const config = testConfig(root, jobsDir, projectPath);
  const store = new JobStore(jobsDir, join(root, ".local", "codex-inbox"));
  await store.initialize();
  const textBundles = new TextBundleStore(config.stagingDir);
  await textBundles.initialize();
  const fake = new FakeTransport();
  const threadId = randomUUID();
  const fakeSecret = ["sk", "fixturefixturefixture"].join("-");
  fake.threadReadResponse = {
    thread: {
      id: threadId,
      cwd: projectPath,
      name: "Local history",
      preview: "Inspect persisted history",
      createdAt: 10,
      updatedAt: 12,
      status: { type: "notLoaded" },
      turns: [{
        id: "turn-local-1",
        status: "completed",
        items: [
          { id: "user-local-1", type: "userMessage", content: [{ type: "text", text: "Inspect the project." }] },
          { id: "reason-local-1", type: "reasoning", summary: ["Checked the relevant files."], content: ["private chain of thought"] },
          { id: "agent-local-1", type: "agentMessage", text: `Done with ${fakeSecret}.` },
        ],
      }],
    },
  };

  const controller = new CodexBridgeController(config, store, textBundles, fake);
  const snapshot = await controller.readLocalThread(threadId);

  assert.equal(snapshot.source, "local");
  assert.equal(snapshot.readOnly, false);
  assert.equal(snapshot.executionMode, "workspace_write");
  assert.equal(snapshot.projectId, "omi");
  assert.equal(snapshot.localThreadId, threadId);
  assert.deepEqual(snapshot.conversation?.turns[0]?.items.map((item) => item.type), ["userMessage", "reasoningSummary", "agentMessage"]);
  assert.equal(snapshot.conversation?.turns[0]?.items[1]?.text, "Checked the relevant files.");
  assert.doesNotMatch(JSON.stringify(snapshot), /private chain of thought/);
  assert.match(snapshot.conversation?.turns[0]?.items[2]?.text ?? "", /\[redacted\]/);
  assert.equal(store.listPage(10).data.length, 0);
});

test("controller adopts and continues an operable local Codex thread on explicit send", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-local-send-"));
  context.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  const projectPath = join(root, "configured-project");
  const discoveredPath = join(process.cwd(), ".tmp", `controller-local-send-${randomUUID()}`);
  const jobsDir = join(root, "jobs");
  await mkdir(projectPath);
  await mkdir(discoveredPath, { recursive: true });
  context.after(() => rm(discoveredPath, { recursive: true, force: true }));
  const config = testConfig(root, jobsDir, projectPath);
  const store = new JobStore(jobsDir, join(root, ".local", "codex-inbox"));
  await store.initialize();
  const textBundles = new TextBundleStore(config.stagingDir);
  await textBundles.initialize();
  const fake = new FakeTransport();
  const threadId = randomUUID();
  fake.threadReadResponse = {
    thread: {
      id: threadId,
      cwd: discoveredPath,
      name: "Continue discovered work",
      preview: "Keep the existing project context.",
      createdAt: 10,
      updatedAt: 12,
      status: { type: "notLoaded" },
      turns: [{
        id: "turn-existing",
        status: "completed",
        items: [
          { id: "user-existing", type: "userMessage", content: [{ type: "text", text: "Inspect the current state." }] },
          { id: "agent-existing", type: "agentMessage", text: "The inspection is complete." },
        ],
      }],
    },
  };
  const controller = new CodexBridgeController(config, store, textBundles, fake);

  const sent = await controller.sendLocalThreadMessage({
    localThreadId: threadId,
    clientMessageId: randomUUID(),
    content: "Continue implementing the agreed change.",
    executionMode: "workspace_write",
    approvalReviewer: "auto_review",
    dataClassification: "personal",
  });

  assert.equal(sent.accepted, true);
  assert.equal(sent.delivery, "turn");
  await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
  const resume = fake.requests.find((request) => request.method === "thread/resume");
  const turn = fake.requests.find((request) => request.method === "turn/start");
  assert.equal(resume?.params?.threadId, threadId);
  assert.equal(resume?.params?.cwd, discoveredPath);
  assert.deepEqual(resume?.params?.runtimeWorkspaceRoots, [discoveredPath]);
  assert.equal(resume?.params?.permissions, "codex-bridge-workspace");
  assert.equal(turn?.params?.cwd, discoveredPath);
  assert.match(String((turn?.params?.input as Array<{ text: string }>)[0]?.text), /Continue implementing the agreed change/);
  const snapshot = await store.snapshot(sent.record.id);
  assert.equal(snapshot.threadId, threadId);
  assert.equal(snapshot.projectId.startsWith("local:"), true);
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.conversation?.turns.some((candidate) => candidate.turnId === "turn-existing"), true);
  assert.equal(store.listPage(10).data.length, 1);
});

test("active native recovery repairs a missing delta without starting or resuming a turn", async (context) => {
  const { controller, store, fake, jobId } = await activeRecoveryFixture(context);
  const before = await store.snapshot(jobId);
  fake.threadReadResponse = recoveryHistory("native complete text");
  const requestCount = fake.requests.length;
  assert.equal(await controller.recoverActiveConversation(jobId), true);
  const after = await store.snapshot(jobId, 0, 20, before.nextConversationRevision, true);
  assert.equal(after.conversation?.turns[0]?.items[0]?.text, "native complete text");
  assert.equal(after.threadId, before.threadId);
  assert.equal(after.turnId, before.turnId);
  assert.equal(after.messages.filter((message) => message.role === "user").length, before.messages.filter((message) => message.role === "user").length);
  assert.ok(fake.requests.slice(requestCount).every((request) => ["thread/read", "thread/turns/list"].includes(request.method)));
  assert.equal(after.nextConversationRevision, after.serverConversationRevision);
  assert.equal(await controller.recoverActiveConversation(jobId), false, "Repeated recovery observes the cooldown.");
});

test("native recovery is single-flight and discards a read raced by an ingress delta", async (context) => {
  const { controller, store, fake, jobId } = await activeRecoveryFixture(context);
  fake.threadReadResponse = recoveryHistory("stale snapshot");
  let release!: () => void;
  fake.historyReadBarrier = new Promise<void>((resolve) => { release = resolve; });
  let reading!: () => void;
  const started = new Promise<void>((resolve) => { reading = resolve; });
  fake.onHistoryRead = reading;
  const first = controller.recoverActiveConversation(jobId);
  await started;
  const second = controller.recoverActiveConversation(jobId);
  const beforeRevision = store.conversationRevision(jobId);
  fake.emitNotification({ method: "item/agentMessage/delta", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "agent", delta: "live text",
  } });
  await waitForConversationRevision(store, jobId, beforeRevision + 1);
  release();
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(fake.requests.filter((request) => request.method === "thread/read" && request.params?.includeTurns).length, 1);
  const snapshot = await store.snapshot(jobId);
  assert.equal(snapshot.conversation?.turns[0]?.items.find((item) => item.id === "agent")?.text, "live text");
});

test("native recovery preserves the projection when history omits the active turn", async (context) => {
  const { controller, store, fake, jobId } = await activeRecoveryFixture(context);
  const before = store.conversationRevision(jobId);
  fake.threadReadResponse = { thread: { id: "thread-1", turns: [] } };
  assert.equal(await controller.recoverActiveConversation(jobId), false);
  assert.equal(store.conversationRevision(jobId), before);
  assert.equal(store.get(jobId)?.status, "running");
});

test("ordinary polling automatically recovers a quiet active turn", async (context) => {
  const { controller, store, fake, jobId } = await activeRecoveryFixture(context);
  fake.threadReadResponse = recoveryHistory("recovered by ordinary poll");
  assert.equal(await controller.hydrateConversation(jobId), false, "Fresh active streams avoid full native reads.");
  const later = Date.now() + 16_000;
  context.mock.method(Date, "now", () => later);
  assert.equal(await controller.hydrateConversation(jobId), true);
  assert.equal((await store.snapshot(jobId)).conversation?.turns[0]?.items[0]?.text, "recovered by ordinary poll");
  assert.equal(fake.turnCount, 1);
});

test("native recovery reconciles a missed terminal notification without a second turn", async (context) => {
  const { controller, store, fake, jobId } = await activeRecoveryFixture(context);
  const history = recoveryHistory("final native answer");
  history.thread.turns[0]!.status = "completed";
  history.thread.status.type = "idle";
  fake.threadReadResponse = history;
  assert.equal(await controller.recoverActiveConversation(jobId), true);
  assert.equal(store.get(jobId)?.status, "completed");
  assert.equal(store.get(jobId)?.result?.output, "final native answer");
  assert.equal(fake.turnCount, 1);
  assert.equal(fake.requests.filter((request) => request.method === "thread/resume").length, 0);
});

test("cancel during a native read invalidates that recovery and preserves cancellation", async (context) => {
  const { controller, store, fake, jobId } = await activeRecoveryFixture(context);
  fake.threadReadResponse = recoveryHistory("stale active text");
  let release!: () => void;
  fake.historyReadBarrier = new Promise<void>((resolve) => { release = resolve; });
  let reading!: () => void;
  const started = new Promise<void>((resolve) => { reading = resolve; });
  fake.onHistoryRead = reading;
  const recovery = controller.recoverActiveConversation(jobId);
  await started;
  await controller.cancel(jobId);
  release();
  assert.equal(await recovery, false);
  assert.equal(store.get(jobId)?.status, "cancelled");
  assert.equal(fake.turnCount, 1);
});

test("controller streaming and critical completion drain one ordered coalesced projection", async (context) => {
  const { controller, store, fake, jobId } = await activeRecoveryFixture(context);
  for (let index = 0; index < 1000; index++) fake.emitNotification({
    method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent", delta: "a" },
  });
  fake.emitNotification({ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1", status: "completed" } });
  await waitFor(() => store.get(jobId)?.status === "completed");
  const snapshot = await store.snapshot(jobId);
  assert.equal(snapshot.conversation?.turns[0]?.items.find((item) => item.id === "agent")?.text, "a".repeat(1000));
  assert.ok(snapshot.serverConversationRevision < 20);
  await controller.close();
});

function recoveryHistory(text: string) {
  return { thread: { id: "thread-1", status: { type: "active" }, turns: [
    { id: "turn-1", status: "inProgress", items: [{ id: "agent", type: "agentMessage", text }] },
  ] } };
}

async function activeRecoveryFixture(context: import("node:test").TestContext, overrides: Partial<import("../src/work-package.js").WorkPackageInput> = {}) {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-active-recovery-"));
  context.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  const projectPath = join(root, "project");
  const jobsDir = join(root, "jobs");
  await mkdir(projectPath);
  const store = new JobStore(jobsDir, join(root, "inbox"));
  await store.initialize();
  const fake = new FakeTransport();
  const config = testConfig(root, jobsDir, projectPath);
  const bundles = new TextBundleStore(config.stagingDir);
  await bundles.initialize();
  const controller = new CodexBridgeController(config, store, bundles, fake);
  const preview = previewWorkPackage({ projectId: "omi", title: "Recovery", objective: "Offline fixture", executionMode: "plan", ...overrides });
  const dispatched = await controller.dispatch({ preview, previewDigest: preview.previewDigest, idempotencyKey: "active-recovery" });
  await waitFor(() => store.get(dispatched.record.id)?.status === "running");
  await waitForConversationRevision(store, dispatched.record.id, 2);
  return { controller, store, fake, jobId: dispatched.record.id, config, bundles };
}

test("direct dispatch enforces allowlist, reviewer, classification and stable work-package identity", async (context) => {
  const { controller, store, fake } = await activeRecoveryFixture(context);
  const preview = previewWorkPackage({ projectId: "omi", title: "Direct", objective: "Inspect", approvalReviewer: "user" });
  const input = { preview, previewDigest: preview.previewDigest, idempotencyKey: "direct-dispatch-test", source: "model_direct" as const };
  const [a, b] = await Promise.all([controller.dispatch(input), controller.dispatch(input)]);
  assert.equal(a.record.id, b.record.id);
  assert.equal(Number(a.created) + Number(b.created), 1);
  assert.equal(a.record.dispatchSource, "model_direct");
  for (const change of [{ projectId: "unknown" }, { dataClassification: "company_approved" as const }]) {
    const changed = previewWorkPackage({ ...preview.workPackage, ...change });
    await assert.rejects(controller.dispatch({ ...input, preview: changed, previewDigest: changed.previewDigest }), /DIRECT_/);
  }
  const changed = previewWorkPackage({ ...preview.workPackage, objective: "Different" });
  await assert.rejects(controller.dispatch({ ...input, preview: changed, previewDigest: changed.previewDigest }), /idempotency/);
  const changedReviewer = previewWorkPackage({ ...preview.workPackage, approvalReviewer: "auto_review" });
  await assert.rejects(controller.dispatch({ ...input, preview: changedReviewer, previewDigest: changedReviewer.previewDigest }), /idempotency/);
  await waitFor(() => store.get(a.record.id)?.status === "running");
  await waitForConversationRevision(store, a.record.id, 2);
  assert.equal(fake.requests.filter((r) => r.method === "thread/start").length, 2);
  await controller.close();
});

test("direct messages deduplicate concurrency and persist uncertain delivery across restart", async (context) => {
  const { controller, store, fake, jobId, config, bundles } = await activeRecoveryFixture(context, { approvalReviewer: "user", model: "gpt-test", effort: "low" });
  const input = { jobId, clientMessageId: "direct-message-1", content: "Inspect one more file", executionMode: "plan" as const, approvalReviewer: "user" as const, dataClassification: "personal" as const };
  const results = await Promise.all([controller.directMessage(input, "turn-1", true), controller.directMessage(input, "turn-1", true)]);
  assert.equal(results.filter((r) => r.accepted).length, 1);
  assert.equal(fake.requests.filter((r) => r.method === "turn/steer").length, 1);
  await assert.rejects(controller.directMessage({ ...input, content: "Different" }, "turn-1", true), /DIRECT_REQUEST_CONFLICT/);
  fake.failSteer = true;
  const uncertain = { ...input, clientMessageId: "direct-message-2" };
  await assert.rejects(controller.directMessage(uncertain, "turn-1", true), /Transport response lost/);
  assert.equal((await controller.directMessage(uncertain, "turn-1", true)).delivery, "unknown");
  const reloaded = new JobStore(config.jobsDir, config.handoffDir);
  await reloaded.initialize();
  const freshTransport = new FakeTransport();
  const fresh = new CodexBridgeController(config, reloaded, bundles, freshTransport);
  assert.equal((await fresh.directMessage(uncertain, "turn-1", true)).delivery, "unknown");
  assert.equal(freshTransport.requests.length, 0);
  assert.equal(Object.keys(store.get(jobId)!.directRequests!).length, 2);
  await fresh.close();
  await controller.close();
});

test("direct content rejects active reviewer changes, company history, mode escalation and wrong turn; cancel is stop-only", async (context) => {
  const fixture = await activeRecoveryFixture(context);
  const input = { jobId: fixture.jobId, clientMessageId: "direct-message-1", content: "Inspect", executionMode: "plan" as const, approvalReviewer: "user" as const, dataClassification: "personal" as const };
  await assert.rejects(fixture.controller.directMessage(input, "turn-1", true), /cannot change/);
  await assert.rejects(fixture.controller.directCancel(fixture.jobId, "cancel-wrong", "wrong-turn"), /DIRECT_TURN_CHANGED/);
  await fixture.controller.directCancel(fixture.jobId, "cancel-correct", "turn-1");
  await fixture.controller.directCancel(fixture.jobId, "cancel-correct", "turn-1");
  assert.equal(fixture.fake.requests.filter((r) => r.method === "turn/interrupt").length, 1);
  await fixture.controller.close();
  const personal = await activeRecoveryFixture(context, { approvalReviewer: "user" });
  const personalInput = { ...input, jobId: personal.jobId };
  await assert.rejects(personal.controller.directMessage({ ...personalInput, executionMode: "workspace_write" }, "turn-1"), /cannot change/);
  await assert.rejects(personal.controller.directMessage({ ...personalInput, clientMessageId: "wrong-turn-message" }, "other", true), /DIRECT_TURN_CHANGED/);
  await personal.store.appendUserMessage(personal.jobId, { ...personalInput, clientMessageId: "company-history", dataClassification: "company_approved" });
  await assert.rejects(personal.controller.directMessage({ ...personalInput, clientMessageId: "after-company" }, "turn-1", true), /DIRECT_COMPANY_AUTHORIZATION_REQUIRES_APP/);
  assert.equal(personal.fake.requests.filter((r) => r.method === "turn/steer").length, 0);
  await personal.controller.close();
});

test("model discovery follows pages, exposes cache metadata and rejects incomplete inventories and unsupported Astra effort", async (context) => {
  const { controller, fake } = await activeRecoveryFixture(context);
  fake.modelListResponses.set("", { data: [], nextCursor: "second" });
  fake.modelListResponses.set("second", { data: [{ id: "gpt-6-astra", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "max" }] }], nextCursor: null });
  const first = await controller.modelListDiagnostics(true);
  assert.equal(first.cacheHit, false);
  assert.equal(first.models[0]?.id, "gpt-6-astra");
  assert.equal((await controller.modelListDiagnostics()).cacheHit, true);
  await controller.validateModelSelection("gpt-6-astra", "max");
  await assert.rejects(controller.validateModelSelection("gpt-6-astra", "ultra"), /not available/);
  fake.modelListResponses.set("second", { data: [], nextCursor: "second" });
  await assert.rejects(controller.listModels(true), /MODEL_LIST_INCOMPLETE/);
  fake.modelListResponses.set("", { data: [], nextCursor: null });
  await controller.listModels(true);
  await assert.rejects(controller.validateModelSelection("gpt-6-astra"), /GPT6_MODEL_NOT_EXPOSED_BY_APP_SERVER/);
  await controller.close();
});

test("direct follow-up resumes once and an old cancel cannot stop the new turn", async (context) => {
  const { controller, store, fake, jobId, config } = await activeRecoveryFixture(context, { approvalReviewer: "user" });
  await controller.directCancel(jobId, "stop-first-turn", "turn-1");
  const input = { jobId, clientMessageId: "follow-up-direct", content: "Continue inspection", executionMode: "plan" as const, approvalReviewer: "user" as const, dataClassification: "personal" as const };
  await assert.rejects(controller.directMessage({ ...input, clientMessageId: "finished-target" }, "turn-1"), /DIRECT_TURN_CHANGED/);
  assert.equal((await controller.directMessage(input)).accepted, true);
  await waitFor(() => store.get(jobId)?.turnId === "turn-2");
  assert.equal((await controller.directMessage(input)).delivery, "duplicate");
  assert.equal((await controller.directCancel(jobId, "stop-first-turn", "turn-1")).delivery, "duplicate");
  await assert.rejects(controller.directCancel(jobId, "stale-other-stop", "turn-1"), /DIRECT_TURN_CHANGED/);
  assert.equal(store.get(jobId)?.status, "running");
  assert.equal(fake.requests.filter((r) => r.method === "thread/resume").length, 1);
  assert.equal(fake.requests.filter((r) => r.method === "turn/interrupt").length, 1);
  config.projects.delete("omi");
  await assert.rejects(controller.directMessage({ ...input, clientMessageId: "removed-project" }, "turn-2"), /DIRECT_PROJECT_NOT_ALLOWLISTED/);
});

for (const reviewer of [undefined, "user", "auto_review"] as const) {
  test(`direct dispatch passes ${reviewer ?? "default"} reviewer to native App Server without changing permissions`, async (context) => {
    const { controller, store, fake, config } = await activeRecoveryFixture(context);
    const preview = previewWorkPackage({ projectId: "omi", title: "Native reviewer", objective: "Inspect", executionMode: "workspace_write", approvalReviewer: reviewer });
    const input = { preview, previewDigest: preview.previewDigest, idempotencyKey: "native-reviewer-dispatch", source: "model_direct" as const };
    const { record } = await controller.dispatch(input);
    await waitFor(() => store.get(record.id)?.status === "running");
    const expected = reviewer ?? "auto_review";
    assert.equal(store.get(record.id)?.currentApprovalReviewer, expected);
    assert.equal((await store.snapshot(record.id)).approvalReviewer, expected);
    assert.equal((await controller.dispatch(input)).created, false);
    const start = fake.requests.filter((r) => r.method === "thread/start").at(-1)!;
    const turn = fake.requests.filter((r) => r.method === "turn/start").at(-1)!;
    assert.equal(start.params?.permissions, "codex-bridge-workspace");
    for (const request of [start, turn]) {
      assert.equal(request.params?.approvalsReviewer, expected);
      assert.equal(request.params?.approvalPolicy, "on-request");
      assert.deepEqual(request.params?.runtimeWorkspaceRoots, [config.projects.get("omi")!.path]);
      assert.equal(request.params?.sandboxPolicy, undefined);
    }
    // Receiving a real approval request still requires a person; the Bridge never guesses safety.
    fake.emitRequest({ id: 900, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-2", command: "npm test" } });
    await waitFor(() => store.get(record.id)?.status === "awaiting_approval");
    assert.equal(fake.responses.length, 0);
    await controller.decideApproval(record.id, store.get(record.id)!.approvals[0].id, "decline");
    assert.deepEqual(fake.responses, [{ id: 900, result: { decision: "decline" } }]);
  });
}

for (const reviewer of ["user", "auto_review"] as const) {
  test(`direct steer and follow-up inherit ${reviewer}; explicit changes are only allowed between turns`, async (context) => {
    const { controller, store, fake, jobId } = await activeRecoveryFixture(context, { approvalReviewer: reviewer, executionMode: "workspace_write" });
    const input = { jobId, clientMessageId: "inherit-steer", content: "Inspect one more file", executionMode: "workspace_write" as const, dataClassification: "personal" as const };
    assert.equal((await controller.directMessage(input, "turn-1", true)).accepted, true);
    assert.equal((await controller.directMessage(input, "turn-1", true)).delivery, "duplicate");
    const other = reviewer === "user" ? "auto_review" : "user";
    await assert.rejects(controller.directMessage({ ...input, clientMessageId: "active-reviewer-change", approvalReviewer: other }, "turn-1", true), /cannot change/);
    assert.equal(fake.requests.filter((r) => r.method === "turn/steer").length, 1);
    assert.equal(store.get(jobId)?.currentApprovalReviewer, reviewer);
    await controller.directCancel(jobId, "stop-before-followup", "turn-1");
    const followup = { ...input, clientMessageId: "inherit-followup" };
    assert.equal((await controller.directMessage(followup)).accepted, true);
    await waitFor(() => store.get(jobId)?.turnId === "turn-2");
    for (const method of ["thread/resume", "turn/start"]) {
      const request = fake.requests.filter((r) => r.method === method).at(-1)!;
      assert.equal(request.params?.approvalsReviewer, reviewer);
      assert.equal(request.params?.approvalPolicy, "on-request");
    }
    assert.equal(fake.requests.find((r) => r.method === "thread/resume")?.params?.permissions, "codex-bridge-workspace");
    await controller.directCancel(jobId, "stop-before-change", "turn-2");
    await controller.directMessage({ ...input, clientMessageId: "explicit-reviewer-change", approvalReviewer: other });
    await waitFor(() => store.get(jobId)?.turnId === "turn-3");
    assert.equal(store.get(jobId)?.currentApprovalReviewer, other);
    assert.equal(fake.requests.filter((r) => r.method === "thread/resume").at(-1)?.params?.approvalsReviewer, other);
    // Omitted settings are hashed before inheritance, so old retries remain duplicates after changes.
    assert.equal((await controller.directMessage(followup)).delivery, "duplicate");
    await assert.rejects(controller.directMessage({ ...followup, approvalReviewer: reviewer }), /DIRECT_REQUEST_CONFLICT/);
    assert.equal(fake.requests.filter((r) => r.method === "turn/start").length, 3);
  });
}

test("direct omitted-reviewer retries recognize legacy receipts without replaying or changing jobs", async (context) => {
  const { controller, store, fake, jobId, config, bundles } = await activeRecoveryFixture(context, { approvalReviewer: "user" });
  const input = {
    jobId, clientMessageId: "legacy-direct-message", content: "Inspect", context: undefined,
    executionMode: "plan" as const, dataClassification: "personal" as const, approvalReviewer: undefined,
    model: undefined, effort: undefined, inputBundleIds: undefined,
  };
  const legacyDigest = createHash("sha256").update(JSON.stringify({ ...input, approvalReviewer: "user", expectedTurnId: "turn-1" })).digest("hex");
  const key = `steer:${input.clientMessageId}`;
  await store.recordDirectRequest(jobId, key, legacyDigest, "completed");
  assert.equal((await controller.directMessage(input, "turn-1", true)).delivery, "duplicate");
  await assert.rejects(controller.directMessage({ ...input, approvalReviewer: "auto_review" }, "turn-1", true), /DIRECT_REQUEST_CONFLICT/);
  assert.equal(fake.requests.filter((r) => r.method === "turn/steer").length, 0);
  await store.recordDirectRequest(jobId, key, legacyDigest, "unknown");
  await controller.close();
  const reloaded = new JobStore(config.jobsDir, config.handoffDir);
  await reloaded.initialize();
  const transport = new FakeTransport();
  const fresh = new CodexBridgeController(config, reloaded, bundles, transport);
  context.after(() => fresh.close());
  assert.equal((await fresh.directMessage(input, "turn-1", true)).delivery, "unknown");
  assert.equal(reloaded.get(jobId)?.currentApprovalReviewer, "user");
  assert.equal(transport.requests.length, 0);
});

async function idleControlFixture(context: import("node:test").TestContext, overrides: Partial<import("../src/work-package.js").WorkPackageInput> = {}) {
  const fixture = await activeRecoveryFixture(context, overrides);
  fixture.fake.emitNotification({ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1", status: "completed" } });
  await waitFor(() => fixture.store.get(fixture.jobId)?.status === "completed");
  fixture.fake.threadReadResponse = { thread: { id: "thread-1", cwd: fixture.config.projects.get("omi")!.path, status: { type: "idle" }, turns: [] } };
  return { ...fixture, input: { jobId: fixture.jobId, requestId: "control-request", expectedThreadId: "thread-1", expectedTurnId: "turn-1" } };
}

test("compact receipt is durable/replay-safe and lifecycle maps the new turn to the existing job", async (context) => {
  const { controller, store, fake, input, config, bundles } = await idleControlFixture(context);
  const results = await Promise.all([controller.directThreadAction("compact", input), controller.directThreadAction("compact", input)]);
  assert.deepEqual(results.map((value) => value.delivery), ["accepted", "duplicate"]);
  assert.equal(fake.requests.filter((call) => call.method === "thread/compact/start").length, 1);
  assert.equal(store.get(input.jobId)?.status, "preparing");
  await assert.rejects(controller.directThreadAction("compact", { ...input, expectedTurnId: "changed" }), /DIRECT_REQUEST_CONFLICT/);
  fake.emitNotification({ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1", status: "completed" } });
  fake.emitNotification({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "compact-turn", status: "inProgress", items: [] } } });
  fake.emitNotification({ method: "item/completed", params: { threadId: "thread-1", turnId: "compact-turn", item: { id: "compact", type: "contextCompaction" } } });
  fake.emitNotification({ method: "turn/completed", params: { threadId: "thread-1", turnId: "compact-turn", status: "completed" } });
  await waitFor(() => store.get(input.jobId)?.status === "completed");
  assert.equal(store.get(input.jobId)?.turnId, "compact-turn");
  assert.ok((await store.snapshot(input.jobId)).conversation?.turns.find((turn) => turn.turnId === "compact-turn")?.items.some((item) => item.activityType === "contextCompaction"));
  const restartedStore = new JobStore(config.jobsDir, config.handoffDir);
  await restartedStore.initialize();
  const restarted = new CodexBridgeController(config, restartedStore, bundles, fake);
  assert.equal((await restarted.directThreadAction("compact", input)).delivery, "duplicate");
  assert.equal(fake.requests.filter((call) => call.method === "thread/compact/start").length, 1);
  await restarted.close();
});

test("review stays inline/read-only, preserves reviewer and captures result and exact approvals", async (context) => {
  const { controller, store, fake, input } = await idleControlFixture(context, { executionMode: "workspace_write", approvalReviewer: "user" });
  const receipt = await controller.directThreadAction("review", input);
  assert.equal(receipt.delivery, "accepted");
  const resume = fake.requests.filter((call) => call.method === "thread/resume").at(-1)!;
  assert.equal(resume.params?.permissions, "codex-bridge-read-only");
  assert.equal(resume.params?.approvalPolicy, "on-request");
  assert.equal(resume.params?.approvalsReviewer, "user");
  assert.deepEqual(fake.requests.find((call) => call.method === "review/start")?.params, { threadId: "thread-1", target: { type: "uncommittedChanges" }, delivery: "inline" });
  const turnId = store.get(input.jobId)!.turnId!;
  assert.equal((await controller.directThreadAction("review", input)).delivery, "duplicate");
  fake.emitRequest({ id: 210, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId, command: "inspect" } });
  await waitFor(() => store.get(input.jobId)?.status === "awaiting_approval");
  assert.equal(fake.responses.length, 0);
  fake.emitNotification({ method: "item/completed", params: { threadId: "thread-1", turnId, item: { id: "review-result", type: "exitedReviewMode", review: "Review findings preserved." } } });
  fake.emitNotification({ method: "turn/completed", params: { threadId: "thread-1", turnId, status: "completed" } });
  await waitFor(() => store.get(input.jobId)?.status === "completed");
  const snapshot = await store.snapshot(input.jobId);
  assert.ok(snapshot.conversation?.turns.find((turn) => turn.turnId === turnId)?.items.some((item) => item.text === "Review findings preserved."));
  assert.equal(store.listAll().length, 1);
});

test("thread actions fail closed on identity, busy native threads, changed project, classification and fork ownership", async (context) => {
  const { controller, store, fake, input, config } = await idleControlFixture(context);
  await assert.rejects(controller.directThreadAction("review", { ...input, expectedThreadId: "wrong" }), /DIRECT_THREAD_CHANGED/);
  await assert.rejects(controller.directThreadAction("compact", { ...input, requestId: "wrong-turn", expectedTurnId: "wrong" }), /DIRECT_TURN_CHANGED/);
  const before = fake.requests.length;
  await assert.rejects(controller.directThreadAction("fork", input), /Fork is blocked/);
  assert.equal(fake.requests.length, before, "Fork must never allocate an orphan native thread");
  fake.threadReadResponse!.thread = { id: "thread-1", cwd: config.projects.get("omi")!.path, status: { type: "active" } };
  await assert.rejects(controller.directThreadAction("review", { ...input, requestId: "native-busy" }), /DIRECT_THREAD_BUSY/);
  fake.threadReadResponse!.thread = { id: "thread-1", cwd: config.dataDir, status: { type: "idle" } };
  await assert.rejects(controller.directThreadAction("review", { ...input, requestId: "wrong-project" }), /DIRECT_THREAD_PROJECT_MISMATCH/);
  config.projects.clear();
  await assert.rejects(controller.directThreadAction("compact", input), /DIRECT_PROJECT_NOT_ALLOWLISTED/);
  assert.equal(fake.requests.some((call) => ["thread/compact/start", "review/start", "thread/fork"].includes(call.method)), false);
  assert.equal(store.get(input.jobId)?.status, "completed");
});

test("actions reject company history and active jobs before native mutation", async (context) => {
  const company = await idleControlFixture(context, { dataClassification: "company_approved" });
  await assert.rejects(company.controller.directThreadAction("review", company.input), /DIRECT_COMPANY_AUTHORIZATION_REQUIRES_APP/);
  const active = await activeRecoveryFixture(context);
  await assert.rejects(active.controller.directThreadAction("compact", { jobId: active.jobId, requestId: "active-action", expectedThreadId: "thread-1", expectedTurnId: "turn-1" }), /DIRECT_THREAD_BUSY/);
});

test("lost action response stays unknown across restart and cannot be sent again", async (context) => {
  const { controller, store, fake, input, config, bundles } = await idleControlFixture(context);
  fake.failControlAction = true;
  await assert.rejects(controller.directThreadAction("review", input), /Action delivery could not be confirmed/);
  assert.equal((await controller.directThreadAction("review", input)).delivery, "unknown");
  assert.equal(store.get(input.jobId)?.status, "preparing");
  const restartedStore = new JobStore(config.jobsDir, config.handoffDir);
  await restartedStore.initialize();
  const restarted = new CodexBridgeController(config, restartedStore, bundles, fake);
  assert.equal((await restarted.directThreadAction("review", input)).delivery, "unknown");
  assert.equal(fake.requests.filter((call) => call.method === "review/start").length, 1);
  await restarted.close();
});

test("detached/malformed review response fails ownership validation without adopting another thread", async (context) => {
  const { controller, store, fake, input } = await idleControlFixture(context);
  fake.wrongReviewThread = true;
  await assert.rejects(controller.directThreadAction("review", input), /DIRECT_REVIEW_IDENTITY_MISMATCH/);
  assert.equal(store.get(input.jobId)?.threadId, "thread-1");
  assert.equal(store.listAll().length, 1);
  assert.equal((await controller.directThreadAction("review", input)).delivery, "unknown");
});

test("controller projects exact telemetry even after completion and does not call requested model executed", async (context) => {
  const { controller, store, fake, jobId } = await activeRecoveryFixture(context, { model: "gpt-test" });
  const usage = { total: { totalTokens: 20, inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 3 }, last: { totalTokens: 5, inputTokens: 3, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 1 }, modelContextWindow: 100 };
  fake.emitNotification({ method: "model/rerouted", params: { threadId: "wrong-thread", turnId: "turn-1", fromModel: "gpt-test", toModel: "wrong", reason: "highRiskCyberActivity" } });
  fake.emitNotification({ method: "model/rerouted", params: { threadId: "thread-1", turnId: "turn-1", fromModel: "gpt-test", toModel: "executed", reason: "highRiskCyberActivity", requestedModel: "untrusted" } });
  fake.emitNotification({ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1", status: "completed" } });
  fake.emitNotification({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: usage } });
  await controller.close();
  const snapshot = await store.snapshot(jobId);
  assert.equal(snapshot.model, "gpt-test");
  assert.equal(snapshot.conversation?.modelRouting?.requestedModel, "gpt-test");
  assert.equal(snapshot.conversation?.modelRouting?.executedModel, "executed");
  assert.equal(snapshot.conversation?.tokenUsage?.total.totalTokens, 20);
  assert.equal(snapshot.conversation?.tokenUsage?.last.totalTokens, 5);
});

function testConfig(root: string, jobsDir: string, projectPath: string): BridgeConfig {
  return {
    projectRoot: root,
    projectsFile: join(root, "projects.json"),
    projects: new Map([["omi", { id: "omi", name: "OMI", path: projectPath }]]),
    dataDir: root,
    jobsDir,
    stagingDir: join(root, "staging"),
    handoffDir: join(root, ".local", "codex-inbox"),
    widgetPath: join(root, "widget.html"),
    codexCommand: "codex",
    codexArgs: ["app-server"],
    httpHost: "127.0.0.1",
    httpPort: 0,
    maxRecentJobs: 20,
    buildId: "test-build",
    codexHome: join(root, ".codex"),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for controller state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForConversationRevision(
  store: JobStore,
  jobId: string,
  minimumRevision: number,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await store.snapshot(jobId)).serverConversationRevision < minimumRevision) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for conversation persistence.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
