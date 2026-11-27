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

test("Fast Mode MCP schemas and HTTP wiring cover preview, dispatch, app/local/direct send and steer", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-speed-http-"));
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
  const unexpectedNativeCall = async (): Promise<never> => { throw new Error("Native calls are forbidden in the HTTP speed fixture"); };
  const native = Object.assign(new EventEmitter(), {
    status: "idle" as const, ensureStarted: unexpectedNativeCall, request: unexpectedNativeCall,
    close: async () => {}, notify() {}, respond() {},
  });
  const controller = new CodexBridgeController(config, store, textBundles, native);
  const runtime = { config, store, textBundles, controller, widgetHtml: await readFile(config.widgetPath, "utf8"),
    privilegedBroker: RemotePrivilegedBroker.notConfigured(), close: () => controller.close() } as BridgeRuntime;
  controller.listModels = async () => [];
  const handle = await startBridgeHttpServer(runtime, { host: "127.0.0.1", port: 0, bearerToken: "speed-fixture-token" });
  const client = new Client({ name: "speed-http-fixture", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
    requestInit: { headers: { authorization: "Bearer speed-fixture-token" } },
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const speedJob = { projectId: "smoke", title: "Speed", objective: "Inspect", modelPreset: "gpt-6.2-sol/medium", dataClassification: "personal", idempotencyKey: "speed-http-fixture", previewDigest: "0".repeat(64) };
    const speedMessage = { jobId: randomUUID(), clientMessageId: "speed-http-fixture", message: "Inspect", executionMode: "plan", approvalReviewer: "auto_review", dataClassification: "personal" };
    for (const name of ["render_codex_console", "codex_job_preview", "codex_job_dispatch", "codex_direct_job_dispatch", "codex_conversation_send", "codex_direct_conversation_send", "codex_direct_job_steer"]) {
      assert.deepEqual((tools.find((tool) => tool.name === name)!.inputSchema.properties!.speed as any).enum, ["standard", "fast"]);
      for (const speed of ["turbo", "default", null, true]) {
        const rejected: any = await client.callTool({ name, arguments: { ...(name.includes("send") || name.includes("steer") ? speedMessage : speedJob), speed } });
        assert.equal(rejected.isError, true, `${name}: invalid speed ${speed}`);
      }
    }
    for (const speed of [undefined, "standard", "fast"]) {
      const preview: any = await client.callTool({ name: "codex_job_preview", arguments: { projectId: "smoke", title: "Speed", objective: "Inspect", modelPreset: "gpt-6.2-sol/medium", ...(speed ? { speed } : {}) } });
      assert.equal(preview.structuredContent.workPackage.speed, speed ?? "standard");
      const rendered: any = await client.callTool({ name: "render_codex_console", arguments: { projectId: "smoke", ...(speed ? { speed } : {}) } });
      assert.equal(rendered.structuredContent.draft.speed, speed);
      for (const [name, method, args] of [
        ["codex_job_dispatch", "dispatch", speedJob], ["codex_direct_job_dispatch", "dispatch", speedJob],
        ["codex_conversation_send", "sendMessage", speedMessage],
        ["codex_conversation_send", "sendLocalThreadMessage", { ...speedMessage, jobId: undefined, localThreadId: randomUUID() }],
        ["codex_direct_conversation_send", "directMessage", speedMessage], ["codex_direct_job_steer", "directMessage", speedMessage],
      ] as const) {
        const original = (runtime.controller as any)[method];
        try {
          (runtime.controller as any)[method] = async (input: any) => {
            assert.equal(method === "dispatch" ? input.preview.workPackage.speed : input.speed, method === "dispatch" ? speed ?? "standard" : speed);
            throw new Error("Offline speed wiring verified");
          };
          const wired: any = await client.callTool({ name, arguments: { ...args, ...(speed ? { speed } : {}) } });
          assert.match(wired.content[0].text, /Offline speed wiring verified/);
        } finally { (runtime.controller as any)[method] = original; }
      }
    }
    const uri = tools.find((tool) => tool.name === "render_codex_console")?._meta?.ui as { resourceUri: string };
    assert.equal(uri.resourceUri, "ui://codex-bridge/chat-workspace-v18.html");
    const widget = await client.readResource({ uri: uri.resourceUri });
    const content = widget.contents[0];
    assert.ok(content && "text" in content);
    assert.match(content.text, /id="speed"/);
    assert.equal(runtime.controller.status, "idle", "HTTP fixtures must never start App Server");
  } finally {
    await client.close(); await handle.close(); await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
