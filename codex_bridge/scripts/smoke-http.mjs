import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadBridgeConfig } from "../dist/src/config.js";
import { startBridgeHttpServer } from "../dist/src/http-server.js";
import { createBridgeRuntime } from "../dist/src/runtime.js";

const root = await mkdtemp(join(tmpdir(), "codex-bridge-http-"));
const projectPath = join(root, "approved-project");
const projectsFile = join(root, "projects.json");
const dataDir = join(root, "runtime");
await mkdir(projectPath);
await writeFile(projectsFile, JSON.stringify({ projects: [{ id: "smoke", name: "Smoke project", path: projectPath }] }), "utf8");

const config = await loadBridgeConfig({
  ...process.env,
  CODEX_BRIDGE_PROJECT_ROOT: fileURLToPath(new URL("..", import.meta.url)),
  CODEX_BRIDGE_PROJECTS_FILE: projectsFile,
  CODEX_BRIDGE_DATA_DIR: dataDir,
  CODEX_BRIDGE_HTTP_PORT: "0",
  CODEX_BRIDGE_HTTP_TOKEN: "smoke-token",
});
const runtime = await createBridgeRuntime(config);
assert.match(config.handoffDir, /[\\/]\.tmp[\\/]codex-inbox$/);
assert.ok(config.codexArgs.includes('default_permissions="codex-bridge-read-only"'));
assert.ok(config.codexArgs.some((value) => value.includes("permissions.codex-bridge-read-only=")));
assert.ok(config.codexArgs.some((value) => value.includes("permissions.codex-bridge-workspace=")));
const handoffFilesystemRule = `${JSON.stringify(config.handoffDir)} = "read"`;
assert.equal(config.codexArgs.filter((value) => value.includes(handoffFilesystemRule)).length, 2);
for (const path of [join(config.projectRoot, ".local"), projectsFile, dataDir]) {
  assert.equal(config.codexArgs.filter((value) => value.includes(`${JSON.stringify(path)} = "deny"`)).length, 2);
}
const handle = await startBridgeHttpServer(runtime, { host: "127.0.0.1", port: 0, bearerToken: "smoke-token" });
const client = new Client({ name: "codex-bridge-http-smoke", version: "1.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
  requestInit: { headers: { authorization: "Bearer smoke-token" } },
});

try {
  const healthResponse = await fetch(new URL("/health", handle.url));
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(health.ok, true);
  assert.deepEqual(health.projectIds, ["smoke"]);
  assert.match(health.buildId, /^[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(health).includes(projectPath), false, "Health must not expose project paths.");

  const unauthorized = await fetch(handle.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(unauthorized.status, 401);

  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "codex_approval_decide",
    "codex_artifact_get",
    "codex_artifact_list",
    "codex_artifact_read_chunk",
    "codex_bridge_status",
    "codex_conversation_get",
    "codex_conversation_list",
    "codex_conversation_send",
    "codex_direct_conversation_send",
    "codex_direct_job_cancel",
    "codex_direct_job_dispatch",
    "codex_direct_job_steer",
    "codex_direct_thread_compact",
    "codex_direct_thread_fork",
    "codex_direct_thread_review",
    "codex_inventory",
    "codex_job_cancel",
    "codex_job_dispatch",
    "codex_job_get",
    "codex_job_preview",
    "codex_job_steer",
    "codex_local_thread_list",
    "codex_local_thread_read",
    "codex_model_list",
    "codex_runtime_status",
    "codex_text_bundle_append",
    "codex_text_bundle_begin",
    "codex_text_bundle_finalize",
    "codex_unified_conversation_get",
    "codex_unified_conversation_list",
    "codex_usage_status",
    "render_codex_console",
  ]);
  for (const action of [
    "codex_approval_decide",
    "codex_artifact_read_chunk",
    "codex_conversation_send",
    "codex_job_cancel",
    "codex_job_dispatch",
    "codex_job_steer",
    "codex_local_thread_list",
    "codex_local_thread_read",
    "codex_unified_conversation_get",
    "codex_unified_conversation_list",
    "codex_text_bundle_append",
    "codex_text_bundle_begin",
    "codex_text_bundle_finalize",
  ]) {
    assert.deepEqual(tools.find((tool) => tool.name === action)?._meta?.ui?.visibility, ["app"], `${action} must be app-only`);
  }
  assert.equal(tools.find((tool) => tool.name === "render_codex_console")?._meta?.ui?.resourceUri, "ui://codex-bridge/chat-workspace-v15.html");
  for (const name of names.filter((name) => name.startsWith("codex_direct_") || name === "codex_model_list")) {
    assert.notDeepEqual(tools.find((tool) => tool.name === name)?._meta?.ui?.visibility, ["app"]);
    const properties = tools.find((tool) => tool.name === name)?.inputSchema.properties;
    for (const forbidden of ["cwd", "approvalPolicy", "network", "sandbox", "companyAuthorizationConfirmed"]) assert.equal(properties?.[forbidden], undefined);
    if (["codex_direct_job_dispatch", "codex_direct_conversation_send", "codex_direct_job_steer"].includes(name)) {
      assert.deepEqual(properties?.approvalReviewer?.enum, ["user", "auto_review"]);
      assert.equal(properties?.approvalReviewer?.default, undefined, "Defaults are resolved by work-package/controller, not transport.");
    } else assert.equal(properties?.approvalReviewer, undefined);
  }
  const directInput = { projectId: "smoke", title: "Direct smoke", objective: "Inspect only", dataClassification: "personal", idempotencyKey: "direct-http-smoke" };
  for (const [change, code] of [[{ projectId: "unknown" }, "DIRECT_PROJECT_NOT_ALLOWLISTED"], [{ dataClassification: "company_approved" }, "DIRECT_COMPANY_AUTHORIZATION_REQUIRES_APP"]]) {
    const rejected = await client.callTool({ name: "codex_direct_job_dispatch", arguments: { ...directInput, ...change } });
    assert.equal(rejected.structuredContent?.error?.code, code);
  }
  // Exercise wire normalization without starting a real model turn.
  const originalDispatch = runtime.controller.dispatch.bind(runtime.controller);
  try {
    for (const reviewer of [undefined, "auto_review", "user"]) {
      runtime.controller.dispatch = async (input) => {
        assert.equal(input.source, "model_direct");
        assert.equal(input.preview.workPackage.approvalReviewer, reviewer ?? "auto_review");
        assert.equal(input.preview.workPackage.executionMode, "plan");
        throw new Error("Offline dispatch wiring verified");
      };
      const wired = await client.callTool({ name: "codex_direct_job_dispatch", arguments: { ...directInput, ...(reviewer ? { approvalReviewer: reviewer } : {}) } });
      assert.match(wired.content[0].text, /Offline dispatch wiring verified/);
    }
  } finally { runtime.controller.dispatch = originalDispatch; }
  const originalMessage = runtime.controller.directMessage.bind(runtime.controller);
  try {
    for (const name of ["codex_direct_conversation_send", "codex_direct_job_steer"]) {
      for (const reviewer of [undefined, "auto_review", "user"]) {
        runtime.controller.directMessage = async (input, expectedTurnId, steerOnly) => {
          assert.equal(input.approvalReviewer, reviewer, "Omission must reach the controller for sticky inheritance.");
          assert.equal(expectedTurnId, "offline-turn");
          assert.equal(steerOnly, name === "codex_direct_job_steer");
          throw new Error("Offline continuation wiring verified");
        };
        const wired = await client.callTool({ name, arguments: {
          jobId: randomUUID(), clientMessageId: "reviewer-http-smoke", message: "Inspect", expectedTurnId: "offline-turn",
          dataClassification: "personal", ...(reviewer ? { approvalReviewer: reviewer } : {}),
        } });
        assert.match(wired.content[0].text, /Offline continuation wiring verified/);
      }
    }
  } finally { runtime.controller.directMessage = originalMessage; }
  const invalidReviewer = await client.callTool({ name: "codex_direct_job_dispatch", arguments: { ...directInput, approvalReviewer: "always_allow" } });
  assert.equal(invalidReviewer.isError, true);

  // Exercise all new handlers through real MCP/HTTP with isolated controller fixtures.
  for (const [name, method, args] of [
    ["codex_usage_status", "usageStatus", {}],
    ["codex_runtime_status", "runtimeStatus", { projectId: "smoke" }],
    ["codex_inventory", "inventory", { projectId: "smoke", kind: "hooks" }],
  ]) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.notDeepEqual(tool._meta?.ui?.visibility, ["app"]);
    const original = runtime.controller[method];
    runtime.controller[method] = async (...received) => {
      if (method !== "usageStatus") assert.equal(received[0], "smoke");
      if (method === "inventory") assert.equal(received[1], "hooks");
      return { probe: "offline", component: { status: "unavailable", code: "UNSUPPORTED" } };
    };
    try {
      const response = await client.callTool({ name, arguments: args });
      assert.notEqual(response.isError, true);
      assert.equal(response.structuredContent.component.status, "unavailable");
    } finally { runtime.controller[method] = original; }
  }
  const originalThreadAction = runtime.controller.directThreadAction;
  try {
    for (const kind of ["compact", "review", "fork"]) {
      runtime.controller.directThreadAction = async (receivedKind, input) => {
        assert.equal(receivedKind, kind);
        assert.equal(input.expectedThreadId, "offline-thread");
        assert.equal(input.expectedTurnId, "offline-turn");
        assert.equal(input.cwd, undefined);
        return { accepted: false, delivery: "unknown" };
      };
      const response = await client.callTool({ name: `codex_direct_thread_${kind}`, arguments: {
        jobId: randomUUID(), requestId: "offline-action", expectedThreadId: "offline-thread", expectedTurnId: "offline-turn",
      } });
      assert.equal(response.structuredContent.delivery, "unknown");
    }
  } finally { runtime.controller.directThreadAction = originalThreadAction; }
  for (const name of ["codex_inventory", "codex_runtime_status"]) {
    const response = await client.callTool({ name, arguments: { projectId: "unknown" } });
    assert.equal(response.structuredContent.error.code, "DIRECT_PROJECT_NOT_ALLOWLISTED");
  }
  for (const name of ["codex_usage_status", "codex_runtime_status", "codex_inventory", "codex_direct_thread_compact", "codex_direct_thread_review", "codex_direct_thread_fork"]) {
    const properties = tools.find((tool) => tool.name === name).inputSchema.properties;
    for (const forbidden of ["method", "params", "cwd", "path", "command", "config", "sandbox", "permissions", "target", "delivery", "forceReload", "threadId"]) assert.equal(properties[forbidden], undefined);
  }

  const statusResult = await client.callTool({ name: "codex_bridge_status", arguments: {} });
  assert.equal(statusResult.structuredContent?.service, "codex-handoff-bridge");
  assert.ok(Array.isArray(statusResult.structuredContent?.models));
  const text = "Smoke engineering specification.";
  const sha256 = createHash("sha256").update(text).digest("hex");
  const beginResult = await client.callTool({
    name: "codex_text_bundle_begin",
    arguments: {
      clientTransferId: randomUUID(),
      projectId: "smoke",
      fileName: "engineering_spec.txt",
      mimeType: "text/plain",
      dataClassification: "public",
      totalChars: text.length,
      totalBytes: Buffer.byteLength(text),
      sha256,
      chunkCount: 1,
    },
  });
  const bundleId = beginResult.structuredContent?.bundleId;
  assert.match(bundleId, /^[0-9a-f-]{36}$/);
  await client.callTool({
    name: "codex_text_bundle_append",
    arguments: { bundleId, index: 0, content: text, sha256 },
  });
  const finalized = await client.callTool({
    name: "codex_text_bundle_finalize",
    arguments: { bundleId },
  });
  assert.equal(finalized.structuredContent?.status, "finalized");

  const previewResult = await client.callTool({
    name: "codex_job_preview",
    arguments: { projectId: "smoke", title: "Smoke preview", objective: "Verify the non-mutating contract.", inputBundleIds: [bundleId] },
  });
  assert.match(previewResult.structuredContent?.previewDigest, /^[0-9a-f]{64}$/);
  assert.equal(runtime.store.list().length, 0, "Preview must not create a job.");
  assert.deepEqual(tools.find((tool) => tool.name === "codex_job_get")?.inputSchema?.properties?.recovery?.enum,
    ["snapshot", "native"], "The read tool must expose separate snapshot and native recovery modes.");

  const resources = await client.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === "ui://codex-bridge/chat-workspace-v15.html"));
  const widget = await client.readResource({ uri: "ui://codex-bridge/chat-workspace-v15.html" });
  assert.equal(widget.contents[0]?.mimeType, "text/html;profile=mcp-app");
  assert.match(widget.contents[0]?.text || "", /ui\/initialize/);
  assert.match(widget.contents[0]?.text || "", /ui\/request-display-mode/);
  assert.match(widget.contents[0]?.text || "", /id="reviewer"/);
  assert.match(widget.contents[0]?.text || "", /codex_unified_conversation_list/);
  assert.match(widget.contents[0]?.text || "", /本機歷史 · 可續作/);
  assert.match(widget.contents[0]?.text || "", /本機歷史 · 受保護/);

  console.log(JSON.stringify({
    ok: true,
    health: { version: health.version, buildId: health.buildId, controller: health.controller },
    toolCount: tools.length,
    appOnlyActions: 13,
    finalizedTextBundle: bundleId,
    widgetMimeType: widget.contents[0]?.mimeType,
    previewCreatedJobs: runtime.store.list().length,
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  await handle.close();
  await rm(root, { recursive: true, force: true });
}
