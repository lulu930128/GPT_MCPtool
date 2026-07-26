import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.JSTUDY_MCP_URL || "http://127.0.0.1:8790/mcp");
assert.ok(
  url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1",
  "smoke:live only connects to a loopback MCP endpoint",
);

const client = new Client({ name: "japanese-study-live-smoke", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(url);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "study_get_item",
    "study_get_plan",
    "study_get_summary",
    "study_record_attempt",
    "study_search_items",
    "study_set_manual_labels",
  ].sort());

  const summary = await client.callTool({ name: "study_get_summary", arguments: {} });
  assert.notEqual(summary.isError, true, JSON.stringify(summary.content));
  assert.equal(summary.structuredContent?.ok, true);
  assert.ok(Number(summary.structuredContent?.summary?.items?.total) > 0);

  console.log(JSON.stringify({
    ok: true,
    url: url.toString(),
    tools: names,
    items: summary.structuredContent.summary.items.total,
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
}
