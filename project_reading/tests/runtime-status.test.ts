import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createComponentDiagnostics, createWorkspaceRuntimeStatus } from "../src/runtime-status.js";
import { registerRuntimeStatusTools } from "../src/runtime-status-server.js";
import type { ServerConfig } from "../src/config.js";
import { COMPONENT_IDS } from "../src/component-recovery.js";

function wire() {
  const at = new Date().toISOString();
  return { v: "1", nonce: "a".repeat(64), operation: "diagnostics", componentId: "codex_bridge", diagnosticsVersion: "1",
    code: "DIAGNOSTICS_OBSERVATION", observedAt: at,
    detail: { componentId: "codex_bridge", status: "Ready", localStatus: "Ready", observedAt: at, readinessScope: "local",
      probes: [{ role: "core", success: true, tcpOpen: true, ownerKnown: true, pid: 123,
        matchesExpected: true, runtimeBuildId: "abcd1234", activeJobs: 1 as number | null, pendingApproval: 0 as number | null, controller: "ready" as string | null }] } };
}
const config = {
  runtimeIdentity: { applicationVersion: "1.7.0", toolContractVersion: "2026-10-14.2", buildId: "abcd1234",
    buildTime: "2026-10-14T00:00:00Z", gitCommit: null, dirty: true, runtimeStartedAt: "2026-10-14T01:00:00Z" },
  writePolicy: { enabled: false, reason: "read_only_mode", protectedPaths: [] },
} as unknown as ServerConfig;
const run = (value: unknown) => createComponentDiagnostics(async () => value)({ componentId: "codex_bridge" });

test("Ready with provider active=1 is ACTIVE, with separate provenance and no ownership attestation", async () => {
  const r = await run(wire());
  assert.equal(r.state.value?.status, "Ready");
  assert.equal(r.workload.value?.state, "ACTIVE");
  assert.equal(r.workload.value?.activeJobs, 1);
  assert.equal(r.workload.source, "CC_PROVIDER_HEALTH_SUMMARY");
  assert.equal(r.workload.observedAt, r.state.observedAt);
  assert.equal(r.channel.independentOwnerAttestation, false);
  assert.equal(r.ownership.value?.trust, "CC_PROBE_OBSERVATION_CONTROLLER_RECHECK_REQUIRED");
  assert.equal(r.maintenance.value, null); assert.equal(r.sourceBuild.value, null);
  assert.equal(r.componentIpc.value, null); assert.equal(r.chatgptE2e.value, null);
});

test("Idle requires both zero counts AND ready/idle controller; pending approval alone is active", async () => {
  for (const controller of ["ready", "idle", "starting", "unavailable", null]) {
    const w = wire(); Object.assign(w.detail.probes[0], { activeJobs: 0, controller });
    assert.equal((await run(w)).workload.value?.state, ["ready", "idle"].includes(controller ?? "") ? "IDLE" : "UNVERIFIED");
  }
  const w = wire(); Object.assign(w.detail.probes[0], { activeJobs: 0, pendingApproval: 1, controller: null });
  assert.equal((await run(w)).workload.value?.state, "ACTIVE");
  Object.assign(w.detail.probes[0], { activeJobs: null, pendingApproval: null });
  assert.equal((await run(w)).workload.value, null);
});

test("unhealthy, owner mismatch/absence and missing provider build are not promoted", async () => {
  const w = wire(); w.detail.status = "OwnershipMismatch"; w.detail.probes[0].matchesExpected = false;
  assert.equal((await run(w)).ownership.value?.roles[0].matchesExpected, false);
  Object.assign(w.detail, { status: "Unhealthy", localStatus: "Unhealthy" });
  Object.assign(w.detail.probes[0], { success: false, ownerKnown: false, pid: null, matchesExpected: null, runtimeBuildId: null, activeJobs: null, pendingApproval: null, controller: null });
  const r = await run(w);
  assert.equal(r.state.value?.status, "Unhealthy"); assert.equal(r.connectivity.value?.[0].success, false);
  assert.equal(r.ownership.value?.roles[0].known, false); assert.equal(r.runtimeBuild.value, null);
  assert.equal(r.workload.value, null);
});

test("foreign/spoofed zero-job health cannot imply IDLE or maintenance permission", async () => {
  for (const fields of [
    { ownerKnown: false, pid: null, matchesExpected: null },
    { ownerKnown: true, pid: 456, matchesExpected: null },
    { ownerKnown: true, pid: 456, matchesExpected: false },
  ]) {
    const w = wire(); Object.assign(w.detail.probes[0], fields, { activeJobs: 0, pendingApproval: 0 });
    const r = await run(w);
    assert.equal(r.workload.value?.state, "UNVERIFIED"); assert.equal(r.workload.value?.activeJobs, 0);
    assert.equal(r.workload.value?.ownershipMatched, false); assert.equal(r.workload.value?.maintenanceAuthorized, false);
    assert.equal(r.workload.source, "CC_PROVIDER_HEALTH_SUMMARY");
  }
  for (const status of ["OwnershipUnknown", "OwnershipMismatch", "UNVERIFIED"]) {
    const w = wire(); w.detail.status = status;
    Object.assign(w.detail.probes[0], { activeJobs: 0, pendingApproval: 0 });
    assert.equal((await run(w)).workload.value?.state, "UNVERIFIED");
    w.detail.status = "Ready"; w.detail.localStatus = status;
    assert.equal((await run(w)).workload.value?.state, "UNVERIFIED");
  }
});

test("stale/future/old CC/malformed/mismatched schemas fail closed without fallback", async () => {
  for (const age of [91000, -10000]) {
    const w = wire(); w.observedAt = w.detail.observedAt = new Date(Date.now() - age).toISOString();
    const r = await run(w); assert.equal(r.code, "UNVERIFIED"); assert.equal(r.freshness.state, "STALE"); assert.equal(r.workload.value, null);
  }
  const variants: unknown[] = [null, {}, { unavailable: "NOT_CONNECTED" }, { ...wire(), diagnosticsVersion: "2" },
    { ...wire(), token: "secret" }, { ...wire(), componentId: "omi_search" }, { ...wire(), code: "SNAPSHOT_UNAVAILABLE" }];
  for (const mutate of [
    (w: ReturnType<typeof wire>) => { w.detail.observedAt = "2000-01-01T00:00:00Z"; },
    (w: ReturnType<typeof wire>) => { Object.assign(w.detail.probes[0], { activeJobs: -1 }); },
    (w: ReturnType<typeof wire>) => { Object.assign(w.detail.probes[0], { pendingApproval: null }); },
    (w: ReturnType<typeof wire>) => { Object.assign(w.detail.probes[0], { ownerKnown: false }); },
    (w: ReturnType<typeof wire>) => { Object.assign(w.detail.probes[0], { success: false }); },
    (w: ReturnType<typeof wire>) => { Object.assign(w.detail.probes[0], { controller: { token: "secret" } }); },
  ]) { const w = wire(); mutate(w); variants.push(w); }
  for (const w of variants) {
    const r = await run(w); assert.equal(r.code, "UNVERIFIED"); assert.equal(r.state.value, null); assert.equal(r.workload.value, null);
    assert.equal(JSON.stringify(r).includes("secret"), false);
  }
  assert.equal((await run(wire())).code, "DIAGNOSTICS_OBSERVATION"); // no poisoned cache
});

test("exact inputs reject before IO, including self/manager/unknown ids and arbitrary fields", async () => {
  let calls = 0; const api = createComponentDiagnostics(async () => { calls++; return wire(); });
  for (const componentId of ["project_reading", "mcp_control_center", "unknown", "CODEX_BRIDGE", "../codex_bridge"]) await assert.rejects(api({ componentId }));
  for (const key of ["url", "path", "command", "requestId", "approved"]) await assert.rejects(api({ componentId: "codex_bridge", [key]: "x" }));
  await assert.rejects(api({})); assert.equal(calls, 0);
});

test("self uses boot identity and HTTP context, remains available without CC, no secret/config leakage", async () => {
  let listening = true; const calls: unknown[] = [];
  const api = createWorkspaceRuntimeStatus(config, { runtimeContext: () => ({ transport: "streamable-http", httpListening: listening }) }, async (op, args) => { calls.push([op, args]); return { unavailable: "NOT_CONNECTED" }; });
  const r = await api({});
  assert.equal(r.identity.value?.runtimeStartedAt, config.runtimeIdentity.runtimeStartedAt);
  assert.equal(r.identity.value?.buildId, "abcd1234"); assert.equal(r.sourceBuild.value, null);
  assert.equal(r.permissions.value?.mode, "read-only"); assert.equal(r.coreHttp.value?.listening, true);
  assert.equal(r.controlChannel.connection, "UNVERIFIED"); assert.deepEqual(calls, [["status", {}]]);
  listening = false; assert.equal((await api({})).coreHttp.value?.listening, false);
  const stdio = await createWorkspaceRuntimeStatus(config, { runtimeContext: () => ({ transport: "stdio", httpListening: null }) }, async () => null)({});
  assert.equal(stdio.coreHttp.value, null); assert.equal(stdio.mcp.value?.transport, "stdio");
  await assert.rejects(api({ token: "private" })); assert.equal(calls.length, 2);
  for (const forbidden of ["protectedPaths", "policyDigest", "roots", "bearerToken"]) assert.equal(JSON.stringify(r).includes(forbidden), false);
});

test("both tools are discoverable with strict schemas/readOnlyHint and wire calls", async () => {
  const server = new McpServer({ name: "runtime-test", version: "1" });
  registerRuntimeStatusTools(server, config, {}, async () => wire());
  const client = new Client({ name: "runtime-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name), ["workspace_runtime_status", "mcp_component_diagnostics"]);
    for (const t of tools) { assert.equal(t.annotations?.readOnlyHint, true); assert.equal(t.inputSchema.additionalProperties, false); assert.equal(t.outputSchema?.additionalProperties, false); }
    assert.deepEqual((tools[1].inputSchema.properties!.componentId as { enum: string[] }).enum, [...COMPONENT_IDS]);
    assert.equal((await client.callTool({ name: tools[1].name, arguments: { componentId: "codex_bridge" } })).isError, false);
    assert.equal((await client.callTool({ name: tools[0].name, arguments: {} })).isError, false);
    assert.equal((await client.callTool({ name: tools[0].name, arguments: { shell: "x" } })).isError, true);
  } finally { await client.close(); await server.close(); }
});
