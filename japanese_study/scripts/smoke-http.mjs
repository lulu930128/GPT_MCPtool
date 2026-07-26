import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../dist/src/config.js";
import { startJapaneseStudyHttpServer } from "../dist/src/http-server.js";

const config = loadConfig({
  ...process.env,
  JSTUDY_MCP_HOST: "127.0.0.1",
  JSTUDY_MCP_PORT: "0",
  JSTUDY_MCP_HTTP_TOKEN: "",
});
const handle = await startJapaneseStudyHttpServer(config);
const client = new Client({ name: "japanese-study-http-smoke", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(handle.url));

try {
  await client.connect(transport);
  const response = await client.listTools();
  const names = response.tools.map((tool) => tool.name).sort();
  const expected = [
    "study_get_item",
    "study_get_plan",
    "study_get_summary",
    "study_record_attempt",
    "study_search_items",
    "study_set_manual_labels",
  ].sort();
  assert.deepEqual(names, expected);
  for (const tool of response.tools) {
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} readOnlyHint`);
    assert.equal(typeof tool.annotations?.destructiveHint, "boolean", `${tool.name} destructiveHint`);
    assert.equal(typeof tool.annotations?.openWorldHint, "boolean", `${tool.name} openWorldHint`);
  }
  console.log(JSON.stringify({ ok: true, url: handle.url, tools: names }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  await handle.close();
}
