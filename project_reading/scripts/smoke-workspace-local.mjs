import assert from "node:assert/strict";
import net from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { exchangePipe, createReadOnlyRecovery } from "../dist/src/cc-readonly.js";
import { createComponentDiagnostics } from "../dist/src/runtime-status.js";
const name = process.argv[2];
assert.match(name ?? "", /^mcpcc-local-fixture-[0-9a-f]{32}$/);
const query = (operation, args) => exchangePipe({ v: "1", nonce: randomBytes(32).toString("hex"), operation,
  componentId: args.componentId ?? "", action: args.action ?? "", requestId: args.requestId ?? "", confirmation: args.confirmation ?? "" },
  () => net.createConnection(`\\\\.\\pipe\\${name}`));
const api = createReadOnlyRecovery(query, true);
const detail = await createComponentDiagnostics(query)({ componentId: "codex_bridge" });
assert.equal(detail.state.value.status, "Ready");
assert.equal(detail.workload.value.state, "ACTIVE");
assert.equal(detail.workload.value.activeJobs, 1);
assert.equal(detail.workload.source, "CC_PROVIDER_HEALTH_SUMMARY");
const ids = ["codex_bridge", "omi_search", "japanese_study", "memory_core", "personal_asset_os", "english_study", "listening_audio"];
const action = "reload_runtime";
for (const componentId of ids) {
assert.equal((await api.mcp_component_status({ componentId })).components[0].status, "Ready");
assert.equal((await api.mcp_component_status({})).components.length, 7);
const preview = await api.mcp_component_preview({ componentId, action });
assert.equal(preview.manualRestartAvailable, true, JSON.stringify(preview));
assert.equal((await api.mcp_component_receipt({ requestId: randomUUID() })).found, false);
const args = { componentId, action, requestId: randomUUID(), confirmation: "interrupt_current_requests" };
const accepted = await api.mcp_component_restart(args);
assert.equal(accepted.code, "ACTION_ACCEPTED"); assert.equal(accepted.completed, null);
assert.equal((await api.mcp_component_restart(args)).code, "REQUEST_REPLAY");
let receipt;
for (let i = 0; i < 30; i++) {
  receipt = await api.mcp_component_receipt({ requestId: args.requestId });
  if (receipt.completed === true) break;
  await new Promise(resolve => setTimeout(resolve, 30));
}
assert.equal(receipt.completed, true); assert.equal(receipt.receipt.outcome, "COMPLETED");
assert.equal((await api.mcp_component_restart(args)).code, "REQUEST_REPLAY");
assert.equal(receipt.receipt.componentId, componentId);
const conflict = await api.mcp_component_restart({ ...args, componentId: ids[(ids.indexOf(componentId) + 1) % ids.length] });
assert.equal(conflict.code, "REQUEST_CONFLICT"); assert.equal(conflict.completed, null); assert.equal(conflict.receipt, null);
}
// A silent client times out without permanently disabling the owner listener.
const idle = net.createConnection(`\\\\.\\pipe\\${name}`);
idle.on("error", () => {}); idle.resume();
await new Promise(resolve => setTimeout(resolve, 2000)); idle.destroy();
assert.equal((await api.mcp_component_status({ componentId: ids[0] })).code, "OWNER_OBSERVATION");
console.log(JSON.stringify({ ok: true, scope: "ISOLATED_NODE_DOTNET_IPC", lifecycle: "MOCK_ONLY", realServiceRestart: false }));
