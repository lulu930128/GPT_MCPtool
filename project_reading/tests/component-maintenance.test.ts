import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { COMPONENT_IDS } from "../src/component-recovery.js";
import { createReadOnlyRecovery } from "../src/cc-readonly.js";
import { registerComponentRecoveryTools } from "../src/component-recovery-server.js";
import { startWorkspaceHttpServer } from "../src/http-server.js";
import { loadConfig } from "../src/config.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = { componentId: "personal_asset_os", action: "reload_runtime", confirmation: "interrupt_current_requests", requestId: "d18ce611-a930-449c-899c-d2e13e82bc13" };
function wire(operation = "restart", outcome = "UNKNOWN") {
  const now = new Date().toISOString();
  return { v: "1", nonce: "a".repeat(64), operation, componentId: operation === "receipt" ? "" : args.componentId,
    action: operation === "receipt" ? "" : args.action, requestId: args.requestId,
    code: operation === "receipt" ? "RECEIPT_OBSERVED" : "ACTION_ACCEPTED", components: [], supported: null,
    mutationEnabled: true, allowed: false, executable: false, found: true, completed: outcome === "COMPLETED" ? true : null,
    receipt: { ...args, outcome, createdAt: now, updatedAt: now } };
}

test("all seven targets share exact receipt correlation, authentication and read-only preview", async () => {
  for (const componentId of COMPONENT_IDS) {
    const request = { ...args, componentId };
    const response = { ...wire(), componentId, receipt: { ...wire().receipt, componentId } };
    let calls = 0;
    const query = async () => { calls++; return response; };
    assert.equal((await createReadOnlyRecovery(query).mcp_component_restart(request)).code, "AUTHENTICATED_TRANSPORT_REQUIRED");
    assert.equal(calls, 0);
    assert.equal((await createReadOnlyRecovery(query, true).mcp_component_restart(request)).code, "ACTION_ACCEPTED");
    const receipt = await createReadOnlyRecovery(async () => ({ ...response, operation: "receipt", componentId: "", action: "", code: "RECEIPT_OBSERVED" })).mcp_component_receipt({ requestId: args.requestId });
    assert.equal(receipt.receipt?.componentId, componentId);
    const previewResponse = { ...response, operation: "preview", requestId: "", code: "READ_ONLY_PREVIEW", mutationEnabled: false,
      components: [{ componentId, status: "Ready", observedAt: new Date().toISOString(), capabilities: [args.action] }],
      supported: true, found: null, completed: null, receipt: null };
    const preview = await createReadOnlyRecovery(async () => previewResponse, true).mcp_component_preview({ componentId, action: args.action });
    assert.ok("manualRestartAvailable" in preview);
    assert.equal(preview.manualRestartAvailable, true); assert.equal(preview.requestCreated, false);
    assert.equal(preview.allowed, false); assert.equal(preview.mutationEnabled, false);
    for (const status of ["OwnershipUnknown", "OwnershipMismatch", "Misconfigured", "NotInstalled", "UNVERIFIED"]) {
      const blocked = await createReadOnlyRecovery(async () => ({ ...previewResponse, components: [{ ...previewResponse.components[0], status }] }), true).mcp_component_preview({ componentId, action: args.action });
      assert.ok("manualRestartAvailable" in blocked);
      assert.equal(blocked.manualRestartAvailable, false);
    }
  }
});

test("cross-target UUID conflict and closing owner never claim completion or expose another receipt", async () => {
  for (const code of ["REQUEST_CONFLICT", "OWNER_CLOSING"]) {
    const value = { ...wire(), code, found: null, completed: null, receipt: null };
    const result = await createReadOnlyRecovery(async () => value, true).mcp_component_restart(args);
    assert.equal(result.code, code); assert.equal(result.completed, null); assert.equal(result.receipt, null);
    const invalid = await createReadOnlyRecovery(async () => ({ ...value, completed: true }), true).mcp_component_restart(args);
    assert.equal(invalid.code, "DELIVERY_UNKNOWN");
  }
});

test("unauthenticated transport cannot reach restart IPC", async () => {
  let calls = 0;
  const api = createReadOnlyRecovery(async () => { calls++; return wire(); });
  assert.equal((await api.mcp_component_restart(args)).code, "AUTHENTICATED_TRANSPORT_REQUIRED");
  assert.equal(calls, 0);
  const config = await loadConfig({ WORKSPACE_MCP_ROOTS: `fixture=${process.cwd()}` });
  const handle = await startWorkspaceHttpServer(config, { host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "no-auth", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
    const result = await client.callTool({ name: "mcp_component_restart", arguments: args });
    assert.equal((result.structuredContent as Record<string, unknown>).code, "AUTHENTICATED_TRANSPORT_REQUIRED");
  } finally { await client.close(); await handle.close(); }
});

test("existing authenticated HTTP boundary rejects missing credentials and browser origin", async () => {
  const config = await loadConfig({ WORKSPACE_MCP_ROOTS: `fixture=${process.cwd()}` });
  const bearerToken = "isolated-maintenance-fixture-token-32-plus";
  const handle = await startWorkspaceHttpServer(config, { host: "127.0.0.1", port: 0, bearerToken });
  try {
    assert.equal((await fetch(handle.url, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(handle.url, { method: "POST", body: "{}", headers: { Authorization: `Bearer ${bearerToken}`, Origin: "http://localhost" } })).status, 403);
    const health = await (await fetch(new URL("/health", handle.url))).json() as { manualMaintenanceEnabled: boolean };
    assert.equal(health.manualMaintenanceEnabled, true);
  } finally { await handle.close(); }
});

test("restart requires exact target, action, interruption confirmation and UUID before IPC", async () => {
  let calls = 0;
  const api = createReadOnlyRecovery(async () => { calls++; return wire(); }, true);
  for (const invalid of [{ ...args, componentId: "unknown" }, { ...args, componentId: "CODEX_BRIDGE" }, { ...args, componentId: "../codex_bridge" }, { ...args, componentId: "project_reading" },
    { ...args, componentId: "mcp_control_center" }, { ...args, action: "restart_core" },
    { ...args, confirmation: "yes" }, { ...args, confirmation: undefined }, { ...args, requestId: "bad" },
    { ...args, command: "whoami" }, { ...args, env: {} }]) await assert.rejects(api.mcp_component_restart(invalid));
  assert.equal(calls, 0);
  const accepted = await api.mcp_component_restart(args);
  assert.equal(calls, 1); assert.equal(accepted.code, "ACTION_ACCEPTED"); assert.equal(accepted.completed, null);
});

test("timeout is delivery UNKNOWN, no automatic retry, stable requestId retained", async () => {
  let calls = 0;
  const api = createReadOnlyRecovery(async () => { calls++; return { unavailable: "IPC_TIMEOUT" }; }, true);
  const value = await api.mcp_component_restart(args);
  assert.equal(value.code, "DELIVERY_UNKNOWN"); assert.equal(value.requestId, args.requestId);
  assert.equal(value.completed, null); assert.equal(calls, 1);
});

test("receipt correlation and finality reject wrong IDs, forged completion, unknown data", async () => {
  for (const value of [{ ...wire(), completed: true },
    { ...wire(), receipt: { ...wire().receipt, requestId: "c76f284e-e798-49eb-ae0c-a6d27189d0e7" } },
    { ...wire(), receipt: { ...wire().receipt, secret: "private" } },
    ...["ACTION_ACCEPTED", "REQUEST_REPLAY"].flatMap(code => ["UNKNOWN", "COMPLETED"].map(outcome => ({ ...wire("restart", outcome), code, receipt: { ...wire("restart", outcome).receipt, componentId: "codex_bridge" } }))),
    { ...wire(), receipt: { ...wire().receipt, action: "restart_core" } },
    { ...wire(), receipt: { ...wire().receipt, confirmation: "yes" } }]) {
    const r = await createReadOnlyRecovery(async () => value, true).mcp_component_restart(args);
    assert.equal(r.code, "DELIVERY_UNKNOWN"); assert.equal(JSON.stringify(r).includes("private"), false);
  }
  const api = createReadOnlyRecovery(async () => wire("receipt", "COMPLETED"));
  const receipt = await api.mcp_component_receipt({ requestId: args.requestId });
  assert.equal(receipt.completed, true);
});

test("SDK renders unavailable authority as structured observation and restart as destructive", async () => {
  const server = new McpServer({ name: "maintenance-test", version: "1" });
  registerComponentRecoveryTools(server, createReadOnlyRecovery(async (operation) => operation === "restart" ? wire() : { unavailable: "NOT_CONNECTED" }, true));
  const client = new Client({ name: "test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  try {
    const listed = await client.listTools();
    const tool = listed.tools.find(t => t.name === "mcp_component_restart")!;
    assert.deepEqual(tool.inputSchema.properties?.componentId, { type: "string", enum: [...COMPONENT_IDS] });
    assert.deepEqual(tool.inputSchema.properties?.action, { type: "string", const: "reload_runtime" });
    assert.equal(tool.annotations?.destructiveHint, true); assert.equal(tool.annotations?.readOnlyHint, false);
    const preview = await client.callTool({ name: "mcp_component_preview", arguments: { componentId: args.componentId, action: args.action } });
    assert.equal(preview.isError, false); assert.equal((preview.structuredContent as Record<string, unknown>).code, "AUTHORITY_NOT_DEPLOYED");
    const result = await client.callTool({ name: "mcp_component_restart", arguments: args });
    assert.equal(result.isError, false); assert.equal((result.structuredContent as Record<string, unknown>).code, "ACTION_ACCEPTED");
    assert.equal((await client.callTool({ name: "mcp_component_restart", arguments: { ...args, confirmation: "yes" } })).isError, true);
  } finally { await client.close(); await server.close(); }
});
