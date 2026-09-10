import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../dist/src/http-server.js";
import { backend, health, send } from "../dist/tests/fixtures.js";
const fixture = await backend((_req, res) => send(res, health));
const token = "test-only-bearer-" + "x".repeat(32);
const server = await startHttpServer({ ...fixture.config, port: 0, token });
const client = new Client({ name: "http-smoke", version: "1" });
try {
  assert.equal((await fetch(server.url)).status, 401);
  assert.equal((await fetch(server.url, { headers: { authorization: `Bearer ${token}`, origin: "https://evil.test" } })).status, 403);
  const status = await fetch(server.url.replace("/mcp", "/health"), { headers: { authorization: `Bearer ${token}` } });
  const info = await status.json(); assert.equal(info.toolCount, 5); assert.match(info.buildId, /^[0-9a-f]{16}$/);
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  assert.equal((await client.listTools()).tools.length, 5);
  const result = await client.callTool({ name: "listening_health", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.contractVersion, "listening-trainer-v1");
  assert.equal((await client.listResourceTemplates()).resourceTemplates.length, 1);
  console.log("PASS: authenticated HTTP MCP initialize, tools/list, health, resource template, build identity, origin rejection.");
} finally { await client.close(); await server.close(); await fixture.close(); }
