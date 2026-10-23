import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RemotePrivilegedBroker } from "../src/privileged/broker.js";
import { createCodexBridgeMcpServer } from "../src/server.js";
import { startBridgeHttpServer } from "../src/http-server.js";
import type { BridgeRuntime } from "../src/runtime.js";

const data = (response: Awaited<ReturnType<Client["callTool"]>>) => response.structuredContent as Record<string, unknown>;

function isolatedRuntime(): BridgeRuntime {
  const blocked = new Proxy({}, { get: () => { throw new Error("Forbidden Controller/App Server/JobStore access"); } });
  return { privilegedBroker: RemotePrivilegedBroker.notConfigured(), controller: blocked, store: blocked,
    conversations: blocked, textBundles: blocked, widgetHtml: "", close: async () => undefined } as unknown as BridgeRuntime;
}

test("MCP -> independent Broker contract; model cannot request, execute or approve", async (t) => {
  const runtime = isolatedRuntime();
  const server = createCodexBridgeMcpServer(runtime);
  const client = new Client({ name: "broker-offline", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools.filter((tool) => tool.name.startsWith("codex_privileged_"));
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["codex_privileged_preview", "codex_privileged_status"]);
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.openWorldHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const status = await client.callTool({ name: "codex_privileged_status", arguments: {} });
  assert.equal(data(status).deployment, "NOT DEPLOYED");
  assert.equal(data(status).writeProtection, "NOT ENFORCED");
  const preview = await client.callTool({ name: "codex_privileged_preview", arguments: { operationId: "diagnostics.os_summary" } });
  assert.equal(data(preview).mode, "dry_run");
  assert.equal(data(preview).execution, "not_executed");
  for (const name of ["request", "approval_decide", "execute", "receipt_get"]) {
    const result = await client.callTool({ name: `codex_privileged_${name}`, arguments: { requestId: randomUUID(), human: true, source: "app" } });
    assert.equal(result.isError, true);
  }
  for (const args of [{ operationId: "shell" }, { operationId: "diagnostics.os_summary", path: "C:\\Windows" },
    { operationId: "diagnostics.os_summary", command: "whoami" }, { operationId: "diagnostics.os_summary", env: {} },
    { operationId: "diagnostics.os_summary", flags: [] }]) {
    assert.equal((await client.callTool({ name: "codex_privileged_preview", arguments: args })).isError, true);
  }
});

test("existing HTTP bearer gate protects broker calls; unknown approval endpoint cannot bypass MCP", async (t) => {
  const server = await startBridgeHttpServer(isolatedRuntime(), { host: "127.0.0.1", port: 0, bearerToken: "offline-broker-token" });
  const client = new Client({ name: "broker-http-offline", version: "1" });
  t.after(async () => { await client.close(); await server.close(); });
  const authHeaders: Record<string, string>[] = [{}, { authorization: "Bearer wrong-token" }];
  for (const headers of authHeaders) {
    const denied = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "codex_privileged_status", arguments: {} } }) });
    assert.equal(denied.status, 401);
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: "Bearer offline-broker-token" } } }));
  assert.equal(data(await client.callTool({ name: "codex_privileged_status", arguments: {} })).state, "not_configured");
  const forged = await client.callTool({ name: "codex_privileged_approval_decide", arguments: { requestId: randomUUID(), source: "app", human: true } });
  assert.equal(forged.isError, true);
  const noRoute = await fetch(new URL("/privileged/approve", server.url), { method: "POST", headers: { authorization: "Bearer offline-broker-token" } });
  assert.equal(noRoute.status, 404);
});
