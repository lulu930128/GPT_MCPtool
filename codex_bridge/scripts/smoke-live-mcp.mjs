import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.CODEX_BRIDGE_SMOKE_URL?.trim() || "http://127.0.0.1:18828/mcp");
const token = process.env.CODEX_BRIDGE_HTTP_TOKEN?.trim();
const client = new Client({ name: "codex-bridge-live-smoke", version: "1.1.0" });
const transport = new StreamableHTTPClientTransport(url, token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : undefined);

try {
  const healthResponse = await fetch(new URL("/health", url));
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 15);
  const resources = await client.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === "ui://codex-bridge/chat-workspace-v4.html"));
  const resource = await client.readResource({ uri: "ui://codex-bridge/chat-workspace-v4.html" });
  const widgetHtml = resource.contents.find((content) => content.uri === "ui://codex-bridge/chat-workspace-v4.html")?.text;
  assert.equal(typeof widgetHtml, "string");
  assert.match(widgetHtml, /aria-label="專案與對話"/);
  assert.match(widgetHtml, /id="model"/);
  assert.match(widgetHtml, /codex_text_bundle_begin/);
  assert.match(widgetHtml, /codex_artifact_read_chunk/);
  assert.match(widgetHtml, /--workspace-height: 720px/);
  assert.ok(!widgetHtml.includes("100vh") && !widgetHtml.includes("100dvh"), "live widget must not couple its height to the host iframe viewport");
  assert.ok(!widgetHtml.includes('class="event-list'), "live widget must not expose technical event logs in the chat UI");
  const statusResult = await client.callTool({ name: "codex_bridge_status", arguments: {} });
  const models = statusResult.structuredContent?.models;
  assert.ok(Array.isArray(models) && models.length > 0, "live App Server must return at least one picker-visible model");
  console.log(JSON.stringify({
    ok: true,
    url: url.href,
    health,
    toolCount: tools.length,
    widgetBytes: Buffer.byteLength(widgetHtml),
    modelCount: models.length,
    models: models.map((model) => model.id),
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
}
