import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../dist/src/config.js";
import { startWorkspaceHttpServer } from "../dist/src/http-server.js";

// Isolated authenticated HTTP server in this test process, not an installed runtime.
// No ambient operator policy, secrets, controller, process launch or lifecycle action.
const config = await loadConfig({ WORKSPACE_MCP_ROOTS: `fixture=${process.cwd()}` });
const handle = await startWorkspaceHttpServer(config, { host: "127.0.0.1", port: 0, bearerToken: "isolated-test-token" });
const client = new Client({ name: "component-recovery-smoke", version: "1" });
try {
  const unauthorized = await fetch(handle.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(unauthorized.status, 401);
  await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), {
    requestInit: { headers: { Authorization: "Bearer isolated-test-token" } },
  }));
  const { tools } = await client.listTools();
  const info = await client.callTool({ name: "workspace_info", arguments: {} });
  assert.equal(info.structuredContent.toolContractVersion, "2026-10-14.1");
  assert.equal(tools.length, 35);
  assert.deepEqual(tools.filter((tool) => tool.name.startsWith("mcp_component_")).map((tool) => tool.name),
    ["mcp_component_status", "mcp_component_preview", "mcp_component_receipt", "mcp_component_restart"]);
  const status = await client.callTool({ name: "mcp_component_status", arguments: {} });
  assert.equal(status.isError, false);
  assert.ok(["CONNECTED", "NOT_CONNECTED"].includes(status.structuredContent.authority.connection));
  assert.equal(status.structuredContent.components.length, 7);
  for (const row of status.structuredContent.components) {
    if (row.localObservation) { assert.equal(row.ownership, "UNVERIFIED"); assert.equal(row.localObservation.health, "UNVERIFIED"); }
  }
  const denied = [];
  for (const componentId of ["project_reading", "mcp_control_center"]) {
    const result = await client.callTool({ name: "mcp_component_status", arguments: { componentId } });
    assert.equal(result.isError, true); denied.push(componentId);
  }
  const preview = await client.callTool({ name: "mcp_component_preview", arguments: { componentId: "codex_bridge", action: "reload_runtime" } });
  assert.ok(["READ_ONLY_PREVIEW", "AUTHORITY_NOT_DEPLOYED"].includes(preview.structuredContent.code));
  assert.equal(preview.structuredContent.allowed, false);
  const receipt = await client.callTool({ name: "mcp_component_receipt", arguments: { requestId: "c76f284e-e798-49eb-ae0c-a6d27189d0e7" } });
  assert.ok(["RECEIPT_NOT_FOUND", "RECEIPT_OBSERVED", "AUTHORITY_NOT_DEPLOYED"].includes(receipt.structuredContent.code));
  console.log(JSON.stringify({ evidenceScope: "ISOLATED_HTTP_CONTRACT_READ_TOOLS_ONLY", toolContractVersion: info.structuredContent.toolContractVersion, unauthorizedStatus: 401,
    toolCount: tools.length, denied, previewCode: preview.structuredContent.code,
    receiptCode: receipt.structuredContent.code, status: status.structuredContent,
    installedRuntimeAdoption: "UNVERIFIED", chatgptE2e: "UNVERIFIED" }, null, 2));
} finally { await client.close(); await handle.close(); }
