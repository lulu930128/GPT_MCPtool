import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AppServerStatus,
  AppServerTransport,
  JsonRpcNotification,
  JsonRpcServerRequest,
} from "../src/app-server-client.js";
import type { BridgeConfig } from "../src/config.js";
import { CodexBridgeController } from "../src/controller.js";
import { JobStore } from "../src/job-store.js";
import { TextBundleStore } from "../src/text-bundle-store.js";
import { previewWorkPackage } from "../src/work-package.js";

class FakeTransport extends EventEmitter implements AppServerTransport {
  status: AppServerStatus = "idle";
  requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  responses: Array<{ id: string | number; result: Record<string, unknown> }> = [];
  turnCount = 0;

  async ensureStarted(): Promise<void> { this.status = "ready"; }
  async close(): Promise<void> { this.status = "idle"; }
  async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.ensureStarted();
    this.requests.push({ method, params });
    if (method === "permissionProfile/list") {
      return {
        data: [
          { id: ":read-only", allowed: true },
          { id: ":workspace", allowed: true },
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
  const store = new JobStore(jobsDir);
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
  assert.equal(threadStart?.params?.permissions, ":read-only");
  assert.equal(turnStart?.params?.sandboxPolicy, undefined);
  assert.equal(turnStart?.params?.approvalPolicy, "on-request");
  assert.match(String((turnStart?.params?.input as Array<{ text: string }>)[0]?.text), /# Controller test/);
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
  const store = new JobStore(jobsDir);
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
  const store = new JobStore(jobsDir);
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
  const store = new JobStore(jobsDir);
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
    dataClassification: "personal",
    model: "gpt-test",
    effort: "ultra",
  });
  assert.equal(sent.delivery, "turn");
  await waitFor(() => store.get(dispatched.record.id)?.status === "running");
  const resume = fake.requests.find((request) => request.method === "thread/resume");
  assert.equal(resume?.params?.threadId, "thread-1");
  assert.equal(resume?.params?.permissions, ":workspace");
  const secondTurn = fake.requests.filter((request) => request.method === "turn/start")[1];
  assert.equal(secondTurn?.params?.threadId, "thread-1");
  assert.equal(secondTurn?.params?.model, "gpt-test");
  assert.equal(secondTurn?.params?.effort, "ultra");

  const duplicate = await controller.sendMessage({
    jobId: dispatched.record.id,
    clientMessageId: "message-client-1",
    content: "Now inspect the follow-up.",
    context: "Pasted file content.",
    executionMode: "workspace_write",
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
  const store = new JobStore(jobsDir);
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
  assert.deepEqual(turnStart?.params?.runtimeWorkspaceRoots, [projectPath]);
  assert.doesNotMatch(instruction, /staging[\\/]/i);
});

function testConfig(root: string, jobsDir: string, projectPath: string): BridgeConfig {
  return {
    projectRoot: root,
    projectsFile: join(root, "projects.json"),
    projects: new Map([["omi", { id: "omi", name: "OMI", path: projectPath }]]),
    dataDir: root,
    jobsDir,
    stagingDir: join(root, "staging"),
    widgetPath: join(root, "widget.html"),
    codexCommand: "codex",
    codexArgs: ["app-server"],
    httpHost: "127.0.0.1",
    httpPort: 0,
    maxRecentJobs: 20,
    buildId: "test-build",
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for controller state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
