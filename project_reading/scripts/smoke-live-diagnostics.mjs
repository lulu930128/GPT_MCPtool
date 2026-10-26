import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(process.env.WORKSPACE_MCP_SMOKE_URL || "http://127.0.0.1:18787/mcp");
const token = process.env.WORKSPACE_MCP_SMOKE_TOKEN;
const client = new Client({ name: "diagnostics-live-smoke", version: "1.7.0" });
const transport = new StreamableHTTPClientTransport(endpoint, {
  requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} },
});
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 12_000 });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.structuredContent)}`);
  assert.equal(result.structuredContent?.ok === false, false, name);
  return result.structuredContent;
};
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const expected = ["check_tcp_port", "list_listening_ports", "inspect_port_owner", "resolve_dns", "ping_host", "http_health_check"];
  for (const name of expected) {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, `${name} not loaded`);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const info = await call("workspace_info", {});
  const build = JSON.parse(await fs.readFile(new URL("../dist/build-info.json", import.meta.url), "utf8"));
  assert.equal(info.applicationVersion, "1.7.0");
  assert.equal(info.toolContractVersion, "2026-10-13.3");
  assert.equal(info.buildId, build.buildId, "Runtime did not adopt current build");
  assert.ok(Date.parse(info.runtimeStartedAt) >= Date.parse(build.buildTime));
  if (process.env.WORKSPACE_MCP_SMOKE_PREVIOUS_STARTED_AT) {
    assert.notEqual(info.runtimeStartedAt, process.env.WORKSPACE_MCP_SMOKE_PREVIOUS_STARTED_AT);
  }
  assert.equal(tools.length, info.writeCapabilities.enabled ? 41 : 35);
  // Probes observe the managed listener, never start a replacement server.
  const host = endpoint.hostname.replace(/^\[|\]$/g, "");
  const port = Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80));
  const tcp = await call("check_tcp_port", { host, port });
  assert.equal(tcp.connected, true);
  const listeners = await call("list_listening_ports", { port, maxResults: 10 });
  assert.ok(listeners.listeners.length > 0);
  const owners = await call("inspect_port_owner", { port, maxResults: 10 });
  assert.ok(owners.listeners.some((item) => item.pid > 0));
  for (const item of owners.listeners) {
    if (item.identityStatus === "observed") assert.ok(item.processName);
    else {
      assert.equal(item.identityStatus, "unavailable");
      assert.equal(item.processName, null);
      assert.ok(item.identityCode);
      assert.equal(owners.partial, true);
    }
  }
  const dns = await call("resolve_dns", { hostname: "example.com", family: "ipv4", maxResults: 5 });
  assert.ok(dns.addresses.length > 0);
  const ping = await call("ping_host", { host: "127.0.0.1" });
  assert.equal(ping.exitCode, 0);
  assert.equal(ping.echoReplyObserved, true);
  const health = await call("http_health_check", { url: new URL("/health", endpoint).href, maxBodyBytes: 256 });
  assert.equal(health.statusCode, 200);
  assert.equal(health.healthy, true);
  const missing = await call("http_health_check", { url: new URL("/diagnostics-smoke-not-found", endpoint).href });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.healthy, false);
  console.log(JSON.stringify({ ok: true, applicationVersion: info.applicationVersion,
    toolContractVersion: info.toolContractVersion, buildId: info.buildId, runtimeStartedAt: info.runtimeStartedAt,
    toolCount: tools.length, verifiedTools: expected, listenerPids: owners.listeners.map((item) => item.pid),
    ownerIdentityComplete: owners.identityComplete, ownerIdentityCode: owners.identityCode,
    dnsRecords: dns.addresses.length, pingEchoObserved: ping.echoReplyObserved, healthStatus: health.statusCode,
    non2xxStatus: missing.statusCode }, null, 2));
} finally { await client.close(); }
