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
    "codex_conversation_send",
    "codex_job_cancel",
    "codex_job_dispatch",
    "codex_job_get",
    "codex_job_preview",
    "codex_job_steer",
    "codex_text_bundle_append",
    "codex_text_bundle_begin",
    "codex_text_bundle_finalize",
    "render_codex_console",
  ]);
  for (const action of [
    "codex_approval_decide",
    "codex_artifact_read_chunk",
    "codex_conversation_send",
    "codex_job_cancel",
    "codex_job_dispatch",
    "codex_job_steer",
    "codex_text_bundle_append",
    "codex_text_bundle_begin",
    "codex_text_bundle_finalize",
  ]) {
    assert.deepEqual(tools.find((tool) => tool.name === action)?._meta?.ui?.visibility, ["app"], `${action} must be app-only`);
  }
  assert.equal(tools.find((tool) => tool.name === "render_codex_console")?._meta?.ui?.resourceUri, "ui://codex-bridge/chat-workspace-v3.html");

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

  const resources = await client.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === "ui://codex-bridge/chat-workspace-v3.html"));
  const widget = await client.readResource({ uri: "ui://codex-bridge/chat-workspace-v3.html" });
  assert.equal(widget.contents[0]?.mimeType, "text/html;profile=mcp-app");
  assert.match(widget.contents[0]?.text || "", /ui\/initialize/);

  console.log(JSON.stringify({
    ok: true,
    health: { version: health.version, buildId: health.buildId, controller: health.controller },
    toolCount: tools.length,
    appOnlyActions: 9,
    finalizedTextBundle: bundleId,
    widgetMimeType: widget.contents[0]?.mimeType,
    previewCreatedJobs: runtime.store.list().length,
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  await handle.close();
  await rm(root, { recursive: true, force: true });
}
