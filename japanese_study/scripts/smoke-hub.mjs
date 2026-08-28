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
const client = new Client({ name: "japanese-study-hub-smoke", version: "1.2.1" });
const transport = new StreamableHTTPClientTransport(new URL(handle.url));

try {
  await client.connect(transport);
  const response = await client.callTool({ name: "study_get_summary", arguments: {} });
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  assert.equal(response.structuredContent?.ok, true);
  console.log(JSON.stringify({ ok: true, hub: config.hubBaseUrl, result: response.structuredContent }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  await handle.close();
}
