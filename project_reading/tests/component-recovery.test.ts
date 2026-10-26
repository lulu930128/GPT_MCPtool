import { createReadOnlyRecovery } from "../src/cc-readonly.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../src/config.js";
import { createWorkspaceMcpServer } from "../src/server.js";
import { registerComponentRecoveryTools } from "../src/component-recovery-server.js";
import { componentStatus, componentPreview, componentReceipt } from "../src/component-recovery.js";

// Independent expected contract; do not derive these assertions from implementation enums.
const ids = ["codex_bridge", "omi_search", "japanese_study", "memory_core", "personal_asset_os", "english_study", "listening_audio"];
const actions = ["ensure_running", "repair_connectivity", "restart_core", "reload_runtime", "shutdown_runtime"];
const requestId = "c76f284e-e798-49eb-ae0c-a6d27189d0e7";

test("all seven fixed ports produce observations without ownership or health authority", async () => {
  const calls: unknown[] = [];
  const value = await componentStatus({}, async (args) => {
    calls.push(args); return { ok: true, connected: true, secret: "must not escape", pid: 123 };
  });
  assert.equal(value.ok, true);
  assert.deepEqual(calls, [18828, 18797, 18790, 18818, 18876, 18886, 18810].map((port) => ({ host: "127.0.0.1", port, timeoutMs: 750 })));
  assert.deepEqual(value.components.map((row) => row.componentId), ids);
  for (const row of value.components) {
    assert.equal(row.localObservation.state, "TCP_CONNECTED");
    assert.equal(row.localObservation.health, "UNVERIFIED");
    assert.equal(row.localObservation.serviceIdentity, "UNVERIFIED");
    assert.equal(row.ownership, "UNVERIFIED");
    assert.equal(row.chatgptE2e, "UNVERIFIED");
    assert.ok(Number.isFinite(Date.parse(row.localObservation.observedAt)));
  }
  assert.equal(value.authority.connection, "NOT_CONNECTED");
  assert.equal(value.mutationEnabled, false);
  assert.equal(JSON.stringify(value).includes("must not escape"), false);
  assert.ok(JSON.stringify(value).length < 10_000);
});

test("single-component sampling stays fixed and failed samples never imply Stopped", async () => {
  for (const code of ["TIMEOUT", "ECONNREFUSED", "EPERM", "secret or raw error text"]) {
    const value = await componentStatus({ componentId: "codex_bridge" }, async () => ({ ok: true, connected: false, code }));
    assert.equal(value.components.length, 1);
    assert.equal(value.components[0].status, "UNVERIFIED");
    assert.equal(value.components[0].localObservation.state, "TCP_NOT_CONNECTED");
    assert.equal(value.components[0].localObservation.code, code.startsWith("secret") ? "CONNECTION_FAILED" : code);
  }
});

test("exceptions and malformed observations are explicit, sanitized and do not discard other rows", async () => {
  let count = 0;
  const value = await componentStatus({}, async () => {
    count++;
    if (count === 1) throw new Error("private exception");
    return count === 2 ? { ok: true, connected: "yes" } : { ok: true, connected: true };
  });
  assert.equal(value.components.length, 7);
  assert.deepEqual(value.components.slice(0, 2).map((row) => row.localObservation.state), ["OBSERVATION_FAILED", "OBSERVATION_FAILED"]);
  assert.equal(value.components[2].localObservation.state, "TCP_CONNECTED");
  assert.equal(JSON.stringify(value).includes("private exception"), false);
});

test("all component/action combinations are denied without granting a preview or making a request", () => {
  for (const componentId of ids) for (const action of actions) {
    const value = componentPreview({ componentId, action });
    assert.equal(value.code, "AUTHORITY_NOT_DEPLOYED");
    assert.equal(value.previewStatus, "NOT_CONNECTED");
    assert.equal(value.allowed, false);
    assert.equal(value.executable, false);
    assert.equal(value.ownerVerified, false);
    assert.equal(value.approvalAvailable, false);
    assert.equal(value.requestCreated, false);
  }
});

test("receipt absence means no authority channel, never a fabricated not-found or completion", () => {
  const value = componentReceipt({ requestId });
  assert.equal(value.ok, false);
  assert.equal(value.code, "AUTHORITY_NOT_DEPLOYED");
  assert.equal(value.receiptStatus, "NOT_CONNECTED");
  assert.equal(value.found, null);
  assert.equal(value.completed, null);
  assert.equal(value.receipt, null);
});

test("policy revalidates self, manager, unknown, injection and unknown input fields before IO", async () => {
  let probes = 0;
  for (const componentId of ["project_reading", "mcp_control_center", "unknown", "CODEX_BRIDGE", "../codex_bridge", "codex_bridge;whoami", "__proto__", ""]) {
    await assert.rejects(componentStatus({ componentId }, async () => { probes++; return {}; }));
    assert.throws(() => componentPreview({ componentId, action: "restart_core" }));
  }
  for (const key of ["command", "path", "url", "executable", "env", "flags", "args", "cwd", "timeoutMs", "approved"]) {
    await assert.rejects(componentStatus({ componentId: "codex_bridge", [key]: "injection" }, async () => { probes++; return {}; }));
    assert.throws(() => componentPreview({ componentId: "codex_bridge", action: "restart_core", [key]: "injection" }));
    assert.throws(() => componentReceipt({ requestId, [key]: "injection" }));
  }
  for (const action of ["RestartCore", "stop_all", "powershell", "restart_core;whoami", ""]) {
    assert.throws(() => componentPreview({ componentId: "codex_bridge", action }));
  }
  for (const invalid of ["", "../receipt.json", "https://localhost", "x".repeat(1000)]) {
    assert.throws(() => componentReceipt({ requestId: invalid }));
  }
  assert.equal(probes, 0);
});

test("status concurrency is bounded across calls and permits are released after failed observations", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const probe = async () => { await gate; throw new Error("failed"); };
  const first = componentStatus({ componentId: "codex_bridge" }, probe);
  const second = componentStatus({ componentId: "omi_search" }, probe);
  try {
    const busy = await componentStatus({});
    assert.equal(busy.code, "OBSERVATION_BUSY");
    assert.deepEqual(busy.components, []);
  } finally { release(); await Promise.all([first, second]); }
  assert.equal((await componentStatus({ componentId: "codex_bridge" }, async () => ({ ok: true, connected: true }))).ok, true);
});

test("MCP schemas advertise exactly the closed allowlists and reject invalid calls on the wire", async () => {
  const server = new McpServer({ name: "component-contract-test", version: "1" });
  registerComponentRecoveryTools(server, createReadOnlyRecovery(async () => ({ unavailable: "NOT_CONNECTED" })));
  const client = new Client({ name: "component-contract-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["mcp_component_status", "mcp_component_preview", "mcp_component_receipt", "mcp_component_restart"]);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, tool.name !== "mcp_component_restart");
      assert.equal(tool.annotations?.destructiveHint, tool.name === "mcp_component_restart");
      assert.equal(tool.annotations?.openWorldHint, tool.name === "mcp_component_status");
      assert.equal(tool.inputSchema.additionalProperties, false);
      if (!["mcp_component_receipt", "mcp_component_restart"].includes(tool.name)) {
        assert.deepEqual((tool.inputSchema.properties?.componentId as { enum: string[] }).enum, ids);
      }
    }
    assert.deepEqual((tools[1].inputSchema.properties?.action as { enum: string[] }).enum, actions);
    for (const componentId of ["project_reading", "mcp_control_center", "other"]) {
      for (const name of ["mcp_component_status", "mcp_component_preview"]) {
        const args = name.endsWith("preview") ? { componentId, action: "restart_core" } : { componentId };
        assert.equal((await client.callTool({ name, arguments: args })).isError, true);
      }
    }
    assert.equal((await client.callTool({ name: "mcp_component_status", arguments: { url: "http://localhost" } })).isError, true);
    for (const componentId of ids) {
      const result = await client.callTool({ name: "mcp_component_preview", arguments: { componentId, action: "repair_connectivity" } });
      assert.equal(result.isError, false);
      assert.equal((result.structuredContent as Record<string, unknown>)?.code, "AUTHORITY_NOT_DEPLOYED");
    }
    const receipt = await client.callTool({ name: "mcp_component_receipt", arguments: { requestId } });
    assert.equal((receipt.structuredContent as Record<string, unknown>)?.receipt, null);
    for (const name of ["mcp_component_request", "mcp_component_approve", "mcp_component_execute"]) {
      assert.equal((await client.callTool({ name, arguments: {} })).isError, true);
    }
  } finally { await client.close(); await server.close(); }
});

test("canonical Workspace server discovers recovery tools in default read-only mode", async () => {
  const config = await loadConfig({ WORKSPACE_MCP_ROOTS: `fixture=${process.cwd()}` });
  const server = createWorkspaceMcpServer(config);
  const client = new Client({ name: "workspace-recovery-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 37);
    assert.equal(tools.filter((tool) => tool.name.startsWith("mcp_component_")).length, 5);
    assert.equal(tools.filter((tool) => tool.annotations?.readOnlyHint !== true).length, 1);
  } finally { await client.close(); await server.close(); }
});
