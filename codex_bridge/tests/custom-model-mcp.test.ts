import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadBridgeConfig } from "../src/config.js";
import type { BridgeRuntime } from "../src/runtime.js";
import { CodexBridgeController } from "../src/controller.js";
import { JobStore } from "../src/job-store.js";
import { TextBundleStore } from "../src/text-bundle-store.js";
import { RemotePrivilegedBroker } from "../src/privileged/broker.js";
import { startBridgeHttpServer } from "../src/http-server.js";
import { MODEL_PRESETS, MODEL_PRESET_IDS } from "../src/model-presets.js";

test("preset and custom MCP preview, app/direct dispatch and follow-up reach only the mocked native server", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-model-http-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = join(root, "project"); await mkdir(projectPath);
  const projectsFile = join(root, "projects.json");
  await writeFile(projectsFile, JSON.stringify({ projects: [{ id: "smoke", name: "Fixture", path: projectPath }] }));
  const config = await loadBridgeConfig({ ...process.env,
    CODEX_BRIDGE_PROJECT_ROOT: fileURLToPath(new URL("../..", import.meta.url)),
    CODEX_BRIDGE_PROJECTS_FILE: projectsFile, CODEX_BRIDGE_DATA_DIR: join(root, "data"), CODEX_BRIDGE_HTTP_PORT: "0",
  });
  config.handoffDir = join(root, "handoff");
  const store = new JobStore(config.jobsDir, config.handoffDir); await store.initialize();
  const textBundles = new TextBundleStore(config.stagingDir); await textBundles.initialize();
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let failModels = false;
  let rejectTurn = false;
  const heads = new Map<string, string>();
  const settings = { activePermissionProfile: { id: "codex-bridge-read-only" }, sandbox: { type: "readOnly", networkAccess: true },
    approvalPolicy: "on-request", approvalsReviewer: "auto_review" };
  const native = Object.assign(new EventEmitter(), {
    status: "ready" as const, ensureStarted: async () => {}, close: async () => {}, notify() {}, respond() {},
    request: async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      requests.push({ method, params });
      if (method === "model/list") {
        if (failModels) throw new Error("Model discovery unavailable");
        return { data: [
          { id: "gpt-test", isDefault: true, displayName: "Fixture", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
          { id: "gpt-6-astra", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] },
          { id: "gpt-5.6-sol", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
        ], nextCursor: null } as T;
      }
      if (method === "thread/goal/get") return {goal:null} as T;
      if (method === "thread/queue/list") return {data:[],nextCursor:null} as T;
      if (method === "permissionProfile/list") return { data: [{ id: "codex-bridge-read-only", allowed: true }], nextCursor: null } as T;
      if (method === "thread/start") return { thread: { id: randomUUID() }, ...settings } as T;
      if (method === "thread/read") return {thread:{id:params?.threadId,status:{type:"idle"},canAcceptDirectInput:true}} as T;
      if (method === "thread/turns/list") return {data:[{id:heads.get(String(params?.threadId)),status:"completed"}],nextCursor:null} as T;
      if (method === "thread/resume") return { thread: { id: params?.threadId, status: { type: "idle" } }, ...settings } as T;
      if (method === "thread/settings/update") {
        native.emit("notification", { method: "thread/settings/updated", params: { threadId: params?.threadId,
          threadSettings: { ...settings, sandboxPolicy: settings.sandbox } } });
        return {} as T;
      }
      if (method === "turn/start") {
        if (rejectTurn) throw new Error(`Model ${params?.model} is not supported by this account`);
        const id = randomUUID();
        heads.set(String(params?.threadId), id);
        return { turn: { id } } as T;
      }
      if (method === "turn/steer") return {turnId:params?.expectedTurnId} as T;
      throw new Error(`Unexpected mock request: ${method}`);
    },
  });
  const controller = new CodexBridgeController(config, store, textBundles, native);
  const runtime = { config, store, textBundles, controller, widgetHtml: await readFile(config.widgetPath, "utf8"),
    privilegedBroker: RemotePrivilegedBroker.notConfigured(), close: () => controller.close() } as BridgeRuntime;
  const handle = await startBridgeHttpServer(runtime, { host: "127.0.0.1", port: 0, bearerToken: "custom-model-fixture-token" });
  const client = new Client({ name: "custom-model-http-fixture", version: "1" });
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<any>;
  const waitFor = async (predicate: () => boolean) => {
    const until = Date.now() + 2_000;
    while (!predicate() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(predicate(), "Mocked controller reached expected state");
  };
  const complete = async (jobId: string) => {
    const job = store.get(jobId)!;
    native.emit("notification", { method: "turn/completed", params: { threadId: job.threadId, turnId: job.turnId, status: "completed" } });
    await waitFor(() => store.get(jobId)?.status === "completed");
  };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), { requestInit: { headers: { authorization: "Bearer custom-model-fixture-token" } } }));
    const tools = (await client.listTools()).tools;
    for (const name of ["render_codex_console", "codex_job_preview", "codex_job_dispatch", "codex_direct_job_dispatch", "codex_conversation_send", "codex_direct_conversation_send", "codex_direct_job_steer"]) {
      const schema = tools.find((tool) => tool.name === name)!.inputSchema.properties!.model as any;
      assert.equal(schema.type, "string"); assert.equal(schema.enum, undefined); assert.equal(schema.maxLength, 120);
      const presetSchema = tools.find((tool) => tool.name === name)!.inputSchema.properties!.modelPreset as any;
      assert.deepEqual(presetSchema.enum, ["gpt-6.2-astra/high", "gpt-6.2-sol/high", "gpt-6.2-sol/medium"]);
      assert.deepEqual(presetSchema.enum, MODEL_PRESET_IDS);
      assert.equal(presetSchema.default, undefined, "No schema-level model default");
      for (const id of MODEL_PRESET_IDS) assert.ok(presetSchema.description.includes(id));
      assert.doesNotMatch(presetSchema.description, /gpt-6-astra|gpt-6\.1-sol|Astra xhigh|Sol xhigh/);
    }
    const base = { projectId: "smoke", title: "Preset", objective: "Offline only", dataClassification: "personal" };
    const nativeList = await call("codex_model_list", { forceRefresh: true });
    assert.deepEqual(nativeList.structuredContent.models.map((m: any) => m.id), ["gpt-test", "gpt-6-astra", "gpt-5.6-sol"]);
    const status = await call("codex_bridge_status", {});
    assert.deepEqual(status.structuredContent.modelPresets.map((p: any) => p.id), MODEL_PRESET_IDS);
    assert.deepEqual(status.structuredContent.modelPresets.map((p: any) => p.availability), ["NOT VERIFIED", "NOT VERIFIED", "NOT VERIFIED"]);
    const draft = await call("render_codex_console", { projectId: "smoke" });
    assert.equal(draft.structuredContent.draft.model, undefined);
    assert.equal(draft.structuredContent.draft.effort, undefined);
    const retired = [{ model: "gpt-6-astra", effort: "xhigh" }, { model: "gpt-6.1-sol", effort: "xhigh" }, { model: "gpt-6.1-sol", effort: "medium" }];
    for (const invalid of [{}, { model: "gpt-6.2-astra" }, { model: "gpt-5.6-sol", effort: "medium" },
      { model: "gpt-6.2-astra", effort: "medium" }, { modelPreset: "gpt-6.2-sol/medium", effort: "high" },
      ...retired, ...retired.map(({ model, effort }) => ({ modelPreset: `${model}/${effort}` }))]) {
      for (const name of ["codex_job_preview", "codex_direct_job_dispatch"]) {
        assert.equal((await call(name, { ...base, ...invalid, idempotencyKey: randomUUID() })).isError, true);
      }
    }
    assert.equal(requests.some((r) => r.method === "thread/start"), false);
    for (const preset of MODEL_PRESETS) {
      const preview = await call("codex_job_preview", { ...base, modelPreset: preset.id });
      assert.equal(preview.structuredContent.workPackage.model, preset.model);
      assert.equal(preview.structuredContent.workPackage.effort, preset.effort);
      const rendered = await call("render_codex_console", { projectId: "smoke", modelPreset: preset.id });
      assert.equal(rendered.structuredContent.draft.model, preset.model);
      assert.equal(rendered.structuredContent.draft.effort, preset.effort);
      for (const name of ["codex_job_dispatch", "codex_direct_job_dispatch"]) {
        const result = await call(name, { ...base, modelPreset: preset.id, previewDigest: preview.structuredContent.previewDigest, idempotencyKey: randomUUID() });
        assert.equal(result.isError, undefined);
        const id = result.structuredContent.job.id;
        await waitFor(() => store.get(id)?.status === "running");
        const start = requests.filter((r) => r.method === "thread/start").at(-1)!;
        assert.equal(start.params?.model, preset.model); assert.equal(start.params?.allowProviderModelFallback, false);
        const turn = requests.filter((r) => r.method === "turn/start").at(-1)!;
        assert.equal(turn.params?.model, preset.model); assert.equal(turn.params?.effort, preset.effort);
        assert.equal(turn.params?.serviceTierForTurn, "default");
        const message = { jobId: id, clientMessageId: randomUUID(), message: "Steer without changing pair", dataClassification: "personal", expectedTurnId: store.get(id)!.turnId };
        assert.equal((await call("codex_direct_conversation_send", message)).isError, undefined);
        assert.equal(store.get(id)?.model, preset.model); assert.equal(store.get(id)?.effort, preset.effort);
        const changed = await call("codex_direct_conversation_send", { ...message, clientMessageId: randomUUID(), modelPreset: preset.id === MODEL_PRESETS[0].id ? MODEL_PRESETS[1].id : MODEL_PRESETS[0].id });
        assert.equal(changed.isError, true, "Active settings cannot change");
        await complete(id);
        assert.equal((await call("codex_direct_conversation_send", { ...message, clientMessageId: randomUUID(), expectedTurnId: undefined })).isError, undefined);
        await waitFor(() => store.get(id)?.status === "running");
        const continued = requests.filter((r) => r.method === "turn/start").at(-1)!;
        assert.equal(continued.params?.model, preset.model); assert.equal(continued.params?.effort, preset.effort);
        await complete(id);
        const explicit = await call("codex_direct_conversation_send", { ...message, clientMessageId: randomUUID(), expectedTurnId: undefined, modelPreset: preset.id });
        assert.equal(explicit.isError, undefined);
        await waitFor(() => store.get(id)?.status === "running");
        assert.equal(requests.filter((r) => r.method === "turn/start").at(-1)!.params?.effort, preset.effort);
        await complete(id);
      }
    }
    assert.ok(requests.filter((r) => r.method === "thread/start" || r.method === "turn/start")
      .every((r) => MODEL_PRESETS.some((p) => p.model === r.params?.model)), "Fixed presets never use a legacy/default model");
    const priorJobs = store.list().length;
    const input = { ...base, title: "Custom model", modelSelection: "custom", model: "  gpt-6.1-sol  ", effort: "max" };
    for (const model of ["", " ", "x".repeat(121)]) {
      assert.equal((await call("codex_job_preview", { ...input, model })).isError, true);
    }
    assert.equal((await call("codex_job_preview", { ...input, model: "gpt-test" })).isError, true, "Known effort check survives MCP");
    const preview = await call("codex_job_preview", input);
    assert.equal(preview.isError, undefined);
    assert.equal(preview.structuredContent.workPackage.model, "gpt-6.1-sol");
    assert.equal(store.list().length, priorJobs, "Preview creates no job");

    for (const dispatchTool of ["codex_job_dispatch", "codex_direct_job_dispatch"]) {
      const dispatched = await call(dispatchTool, { ...input, previewDigest: preview.structuredContent.previewDigest, idempotencyKey: dispatchTool });
      assert.equal(dispatched.isError, undefined);
      const jobId = dispatched.structuredContent.job.id;
      await waitFor(() => store.get(jobId)?.status === "running");
      assert.equal(requests.filter((r) => r.method === "thread/start").at(-1)?.params?.model, "gpt-6.1-sol");
      assert.equal(requests.filter((r) => r.method === "thread/start").at(-1)?.params?.allowProviderModelFallback, false);
      const first = requests.filter((r) => r.method === "turn/start").at(-1)!;
      assert.equal(first.params?.model, "gpt-6.1-sol"); assert.equal(first.params?.effort, "max"); assert.equal(first.params?.serviceTierForTurn, "default");
      await complete(jobId);
      for (const tool of ["codex_conversation_send", "codex_direct_conversation_send"]) {
        const sent = await call(tool, { jobId, clientMessageId: randomUUID(), message: "Continue", model: " Vendor/Exact-Model.ID ", effort: "ultra",
          modelSelection: "custom",
          executionMode: "plan", approvalReviewer: "auto_review", dataClassification: "personal" });
        assert.equal(sent.isError, undefined);
        await waitFor(() => store.get(jobId)?.status === "running");
        const turn = requests.filter((r) => r.method === "turn/start").at(-1)!;
        assert.equal(turn.params?.model, "Vendor/Exact-Model.ID"); assert.equal(turn.params?.effort, "ultra");
        assert.equal(turn.params?.serviceTierForTurn, "default");
        await complete(jobId);
      }
    }
    failModels = true;
    const listModels = controller.listModels.bind(controller);
    context.mock.method(controller, "listModels", () => listModels(true));
    assert.equal((await call("codex_model_list", { forceRefresh: true })).isError, true);
    const unavailableStatus = await call("codex_bridge_status", {});
    assert.ok(unavailableStatus.structuredContent.modelPresets.every((p: any) => p.availability === "NOT VERIFIED"));
    assert.equal((await call("codex_job_preview", input)).isError, undefined);
    rejectTurn = true;
    for (const preset of MODEL_PRESETS) {
      const args = { ...base, modelPreset: preset.id, idempotencyKey: randomUUID() };
      const before = requests.filter((r) => r.method === "turn/start").length;
      const rejected = await call("codex_direct_job_dispatch", args);
      const id = rejected.structuredContent.job.id;
      await waitFor(() => store.get(id)?.status === "failed");
      assert.ok((await store.snapshot(id)).result!.message.includes(`Model ${preset.model} is not supported`));
      assert.equal(store.get(id)?.model, preset.model); assert.equal(store.get(id)?.effort, preset.effort);
      assert.equal((await call("codex_direct_job_dispatch", args)).structuredContent.created, false);
      assert.equal(requests.filter((r) => r.method === "turn/start").length, before + 1);
    }
    const before = requests.filter((r) => r.method === "turn/start").length;
    const rejected = await call("codex_direct_job_dispatch", { ...input, idempotencyKey: "rejected-custom-model" });
    const failedId = rejected.structuredContent.job.id;
    await waitFor(() => store.get(failedId)?.status === "failed");
    assert.match((await store.snapshot(failedId)).result!.message, /Model gpt-6.1-sol is not supported by this account/);
    assert.equal(requests.filter((r) => r.method === "turn/start").length, before + 1);
    assert.equal((await call("codex_direct_job_dispatch", { ...input, idempotencyKey: "rejected-custom-model" })).structuredContent.created, false);
    assert.equal(requests.filter((r) => r.method === "turn/start").length, before + 1, "Retry must return the failed job without another native attempt");
  } finally { await client.close(); await handle.close(); await runtime.close(); }
});
