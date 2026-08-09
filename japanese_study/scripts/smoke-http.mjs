import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../dist/src/config.js";
import { startJapaneseStudyHttpServer } from "../dist/src/http-server.js";
import {
  JAPANESE_STUDY_CONTRACT_VERSION,
  JAPANESE_STUDY_MCP_VERSION,
  JAPANESE_STUDY_TOOL_COUNT,
} from "../dist/src/server.js";

const config = loadConfig({
  ...process.env,
  JSTUDY_MCP_HOST: "127.0.0.1",
  JSTUDY_MCP_PORT: "0",
  JSTUDY_MCP_HTTP_TOKEN: "",
});
const handle = await startJapaneseStudyHttpServer(config);
const client = new Client({ name: "japanese-study-http-smoke", version: "0.3.0" });
const transport = new StreamableHTTPClientTransport(new URL(handle.url));

try {
  const healthResponse = await fetch(new URL("/health", handle.url));
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.version, JAPANESE_STUDY_MCP_VERSION);
  assert.equal(health.contractVersion, JAPANESE_STUDY_CONTRACT_VERSION);
  assert.equal(health.toolCount, JAPANESE_STUDY_TOOL_COUNT);
  assert.match(health.buildId, /^[0-9a-f]{16}$/);

  await client.connect(transport);
  const response = await client.listTools();
  const names = response.tools.map((tool) => tool.name).sort();
  const expected = [
    "study_get_item",
    "study_apply_practice_target_overrides",
    "study_get_plan",
    "study_get_practice_session",
    "study_get_summary",
    "study_list_practice_sessions",
    "study_preview_practice_record",
    "study_preview_practice_target_resolution",
    "study_preview_target_resolution",
    "study_record_attempt",
    "study_record_practice",
    "study_search_items",
    "study_set_manual_labels",
    "study_supersede_practice_session",
  ].sort();
  assert.deepEqual(names, expected);
  for (const tool of response.tools) {
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} readOnlyHint`);
    assert.equal(typeof tool.annotations?.destructiveHint, "boolean", `${tool.name} destructiveHint`);
    assert.equal(typeof tool.annotations?.openWorldHint, "boolean", `${tool.name} openWorldHint`);
  }
  console.log(JSON.stringify({
    ok: true,
    url: handle.url,
    health: {
      version: health.version,
      contractVersion: health.contractVersion,
      buildId: health.buildId,
      toolCount: health.toolCount,
    },
    tools: names,
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  await handle.close();
}
