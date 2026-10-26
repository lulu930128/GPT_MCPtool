// DEPRECATED historical G2 prototype; not composed by the tray.
// Current path/tests: WorkspaceLocal.Native.cs and test-workspace-local.ps1.
import assert from "node:assert/strict";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { exchangePipe, createReadOnlyRecovery } from "../dist/src/cc-readonly.js";

// Only launched by the isolated CC test harness. Production namespace forbidden.
const name = process.argv[2];
assert.match(name ?? "", /^mcpcc-g2-fixture-[0-9a-f]{32}$/);
const query = async (operation, args) => exchangePipe({ v: "1", nonce: randomBytes(32).toString("hex"),
  operation, componentId: args.componentId ?? "", action: args.action ?? "", requestId: args.requestId ?? "" },
  () => net.createConnection(`\\\\.\\pipe\\${name}`));
const componentId = "personal_asset_os", action = "restart_core";
const wire = await query("preview", { componentId, action });
assert.equal(wire.code, "READ_ONLY_PREVIEW");
assert.equal(wire.components[0].componentId, componentId);
assert.equal(wire.allowed, false);
// A correctly framed native owner fixture STILL cannot grant Workspace trust.
// Use the already received response so listener recreation scheduling is irrelevant.
const adapter = createReadOnlyRecovery(async () => wire);
const value = await adapter.mcp_component_preview({ componentId, action });
assert.equal(value.ownerChannel.code, "CLIENT_TRUST_UNPROVEN");
assert.equal(value.ownerVerified, false);
assert.equal(value.allowed, false);
assert.equal(value.executable, false);
assert.equal(value.authority.connection, "NOT_CONNECTED");
console.log(JSON.stringify({ ok: true, evidenceScope: "ISOLATED_NODE_NATIVE_PIPE_INTEROP", authenticatedHostOwner: "NOT_VERIFIED",
  trayLaunch: "NOT_ACTIVATED", protectedBootstrap: "MANUAL_PENDING", mutationEnabled: false }));
