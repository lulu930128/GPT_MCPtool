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
  assert.equal(tools.length, 21);
  const resources = await client.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === "ui://codex-bridge/chat-workspace-v13.html"));
  const resource = await client.readResource({ uri: "ui://codex-bridge/chat-workspace-v13.html" });
  const widgetHtml = resource.contents.find((content) => content.uri === "ui://codex-bridge/chat-workspace-v13.html")?.text;
  assert.equal(typeof widgetHtml, "string");
  assert.match(widgetHtml, /aria-label="專案與對話"/);
  assert.match(widgetHtml, /id="model"/);
  assert.match(widgetHtml, /id="reviewer"/);
  assert.match(widgetHtml, /ui\/request-display-mode/);
  assert.match(widgetHtml, /codex_text_bundle_begin/);
  assert.match(widgetHtml, /codex_artifact_read_chunk/);
  assert.match(widgetHtml, /codex_unified_conversation_list/);
  assert.match(widgetHtml, /本機歷史 · 可續作/);
  assert.match(widgetHtml, /本機歷史 · 受保護/);
  assert.match(widgetHtml, /inlineWorkspaceHeight\(availableWidth\)/);
  assert.match(widgetHtml, /element\.focus\(\{ preventScroll: true \}\)/);
  assert.match(widgetHtml, /data-theme="night-shift"/);
  assert.ok(!widgetHtml.includes("100vh") && !widgetHtml.includes("100dvh"), "live widget must not couple its height to the host iframe viewport");
  assert.ok(!widgetHtml.includes('class="event-list'), "live widget must not expose technical event logs in the chat UI");
  const statusResult = await client.callTool({ name: "codex_bridge_status", arguments: {} });
  const models = statusResult.structuredContent?.models;
  assert.ok(Array.isArray(models) && models.length > 0, "live App Server must return at least one picker-visible model");
  const unifiedResult = await client.callTool({
    name: "codex_unified_conversation_list",
    arguments: { limit: 2000, maxConversations: 10000 },
  });
  assert.notEqual(unifiedResult.isError, true);
  const conversations = unifiedResult.structuredContent?.conversations;
  assert.ok(Array.isArray(conversations) && conversations.length > 0, "live unified conversation inventory must not be empty");
  assert.equal(new Set(conversations.map((conversation) => conversation.conversationId)).size, conversations.length);
  const automationOverlays = conversations.flatMap((conversation) => conversation.automations || []);
  assert.equal(automationOverlays.every((automation) => (
    automation && typeof automation.automationId === "string" && !("prompt" in automation)
  )), true, "automation overlays must contain only safe metadata");
  const paginatedConversation = conversations.find((conversation) => conversation.historyMode === "paginated");
  let hydratedPaginatedTurnCount = 0;
  if (paginatedConversation) {
    const readResult = await client.callTool({
      name: "codex_unified_conversation_get",
      arguments: { conversationId: paginatedConversation.conversationId },
    });
    assert.notEqual(readResult.isError, true);
    const hydrated = readResult.structuredContent?.unifiedConversation;
    assert.equal(hydrated?.historyFreshness?.historyMode, "paginated");
    assert.equal(hydrated?.historyFreshness?.synchronized, true);
    assert.ok(Array.isArray(hydrated?.view?.conversation?.turns));
    hydratedPaginatedTurnCount = hydrated.view.conversation.turns.length;
  }
  const publicResult = await client.callTool({ name: "codex_conversation_list", arguments: { limit: 100 } });
  assert.notEqual(publicResult.isError, true);
  const publicConversations = publicResult.structuredContent?.conversations || [];
  const allowedProjectIds = new Set(health.projectIds || []);
  assert.equal(publicConversations.every((conversation) => allowedProjectIds.has(conversation.projectId)), true);
  console.log(JSON.stringify({
    ok: true,
    url: url.href,
    health,
    toolCount: tools.length,
    widgetBytes: Buffer.byteLength(widgetHtml),
    modelCount: models.length,
    models: models.map((model) => model.id),
    unifiedConversationCount: conversations.length,
    paginatedConversationCount: conversations.filter((conversation) => conversation.historyMode === "paginated").length,
    automationOverlayCount: automationOverlays.length,
    hydratedPaginatedTurnCount,
    publicConversationCount: publicConversations.length,
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
}
