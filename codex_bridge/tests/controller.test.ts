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
  threadListResponses = new Map<string, Record<string, unknown>>();

  async ensureStarted(): Promise<void> { this.status = "ready"; }
  async close(): Promise<void> { this.status = "idle"; }
  async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.ensureStarted();
    this.requests.push({ method, params });
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
    if (method === "thread/read") return (this.threadReadResponse ?? {
      thread: { id: String(params?.threadId), status: { type: "notLoaded" }, turns: [] },
    }) as T;
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
  context.after(() => rm(root, { recursive: true, force: true }));
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

test("plan mode refuses file-change acceptance", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-plan-"));
  context.after(() => rm(root, { recursive: true, force: true }));
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
  fake.emitRequest({ id: 18, method: "item/fileChange/requestApproval", params: { turnId: "turn-1", changes: ["a.ts"] } });
  await waitFor(() => store.get(dispatched.record.id)?.status === "awaiting_approval");
  const approval = store.get(dispatched.record.id)!.approvals[0];
  await assert.rejects(controller.decideApproval(dispatched.record.id, approval.id, "accept"), /plan mode/);
  assert.equal(fake.responses.length, 0);
});

test("controller suppresses lifecycle noise and bounds App Server diagnostics", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-events-"));
  context.after(() => rm(root, { recursive: true, force: true }));
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

test("controller resumes a completed conversation with the selected model and de-duplicates messages", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-conversation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
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
  context.after(() => rm(root, { recursive: true, force: true }));
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

test("controller hydrates persisted multi-turn history once per process", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-hydration-controller-"));
  context.after(() => rm(root, { recursive: true, force: true }));
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
  assert.equal(fake.requests.filter((request) => request.method === "thread/read").length, 1);
  const snapshot = await store.snapshot(dispatched.record.id);
  assert.deepEqual(snapshot.conversation?.turns.map((turn) => turn.turnId), ["turn-1", "turn-2", "turn-3"]);
  assert.deepEqual(snapshot.conversation?.turns[2]?.items.map((item) => item.text), ["User 3", "Assistant 3"]);
});

test("controller lists complete local Codex history and discovers only safe workspaces", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-local-list-"));
  context.after(() => rm(root, { recursive: true, force: true }));
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
  assert.equal(fake.requests.filter((request) => request.method === "thread/list").length, 2);
});

test("controller reads local Codex history through the bounded conversation projection", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-local-read-"));
  context.after(() => rm(root, { recursive: true, force: true }));
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
  context.after(() => rm(root, { recursive: true, force: true }));
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
