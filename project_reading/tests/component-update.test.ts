import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createReadOnlyRecovery, exchangePipe, type ReadOnlyQuery } from "../src/cc-readonly.js";
import { registerComponentRecoveryTools } from "../src/component-recovery-server.js";
import { componentUpdateSchemas, updateParameterDigest, type UpdateOperation } from "../src/component-update-contract.js";

const args = { componentId: "codex_bridge", action: "update_from_source", versionId: "phase2-e", expectedSourceDigest: "a".repeat(64),
  idlePolicy: "wait_for_idle", confirmation: "interrupt_current_requests", requestId: "d18ce611-a930-449c-899c-d2e13e82bc13" } as const;
const targets = ["codex_bridge", "omi_search", "japanese_study", "memory_core", "personal_asset_os", "english_study", "listening_audio", "project_reading", "mcp_control_center"];
function receipt(phase = "QUEUED") {
  const { confirmation: _, ...parameters } = args;
  return { ...parameters, parameterDigest: updateParameterDigest(parameters), operationId: "b".repeat(32), blockedByOperationId: null, phase, code: "WAITING_FOR_IDLE",
    createdAt: "2026-10-28T12:00:00.000Z", updatedAt: "2026-10-28T12:00:00.000Z",
    selectedVersion: null, observedVersion: null, preparedBuildId: null, observedBuildId: null, ready: null };
}
function wire(operation: UpdateOperation = "update") {
  const isRead = ["update_status", "update_preview"].includes(operation);
  const requested = operation === "update_status" || operation === "update_receipt" ? "" : args.componentId;
  return { v: "2", nonce: "c".repeat(64), operation, componentId: requested,
    action: requested ? args.action : "", requestId: isRead ? "" : args.requestId,
    code: operation === "update" ? "UPDATE_QUEUED" : operation === "update_receipt" ? "RECEIPT_OBSERVED" : "UPDATE_PREVIEW",
    targets: isRead ? (requested ? [requested] : targets).map(componentId => ({ componentId,
      supported: componentId === "codex_bridge", owner: componentId === "codex_bridge" ? "daily_code" : null,
      reason: componentId === "codex_bridge" ? null : "NOT_SUPPORTED" })) : [],
    sourceDigest: operation === "update_preview" ? args.expectedSourceDigest : null,
    receipt: isRead ? null : receipt(), mutationEnabled: !isRead };
}

test("v2 source-update allowlist adds self and CC without widening v1 restart or permitting command inputs", async () => {
  let calls = 0;
  const api = createReadOnlyRecovery(async () => { calls++; return wire(); }, true);
  for (const componentId of ["project_reading", "mcp_control_center"]) {
    assert.equal(componentUpdateSchemas.mcp_component_update.safeParse({ ...args, componentId }).success, true);
    await assert.rejects(api.mcp_component_restart({ componentId, action: "reload_runtime", confirmation: args.confirmation, requestId: args.requestId }));
  }
  for (const value of [{ ...args, componentId: "other" }, { ...args, versionId: "../release" }, { ...args, versionId: "UPPER" },
    { ...args, versionId: "x".repeat(49) }, { ...args, expectedSourceDigest: undefined }, { ...args, expectedSourceDigest: "abc" },
    { ...args, idlePolicy: "force" }, { ...args, action: "reload_runtime" }]) await assert.rejects(api.mcp_component_update(value));
  for (const field of ["path", "command", "args", "env", "cwd", "force", "approved", "candidateRoot", "timeoutMs"]) {
    await assert.rejects(api.mcp_component_update({ ...args, [field]: "injection" }));
  }
  assert.equal(calls, 0);
});

test("update requires existing authenticated maintenance transport before IPC", async () => {
  let calls = 0;
  const api = createReadOnlyRecovery(async () => { calls++; return wire(); });
  const result = await api.mcp_component_update(args);
  assert.equal(result.code, "AUTHENTICATED_TRANSPORT_REQUIRED");
  assert.equal(calls, 0);
});

test("preview exposes missing source digest explicitly and never fabricates a usable update", async () => {
  const previewArgs = { componentId: args.componentId, action: args.action, versionId: args.versionId, idlePolicy: args.idlePolicy };
  for (const sourceDigest of [null, args.expectedSourceDigest]) {
    const code = sourceDigest ? "UPDATE_PREVIEW" : "SOURCE_NOT_OBSERVED";
    const result = await createReadOnlyRecovery(async () => ({ ...wire("update_preview"), sourceDigest, code }), true).mcp_component_update_preview(previewArgs);
    assert.equal(result.code, code);
    assert.equal("sourceDigest" in result ? result.sourceDigest : undefined, sourceDigest);
    assert.equal(result.requestCreated, false);
    assert.equal(result.executable, false);
  }
});

test("status returns exact separate nine targets with explicit unsupported owner capability", async () => {
  const result = await createReadOnlyRecovery(async () => wire("update_status")).mcp_component_update_status({});
  assert.equal(result.code, "UPDATE_PREVIEW");
  assert.deepEqual("targets" in result ? result.targets.map(t => t.componentId) : [], targets);
  assert.equal("targets" in result ? result.targets[1].reason : "", "NOT_SUPPORTED");
  const invalid = await createReadOnlyRecovery(async () => ({ ...wire("update_status"), targets: wire("update_status").targets.slice(0, 7) })).mcp_component_update_status({});
  assert.equal(invalid.code, "IPC_INVALID_RESPONSE");
});

test("queued/replayed receipt preserves canonical operation and parameter binding", async () => {
  let calls = 0;
  const api = createReadOnlyRecovery(async (operation) => { calls++; return { ...wire(operation as UpdateOperation), code: calls === 1 ? "UPDATE_QUEUED" : "REQUEST_REPLAY" }; }, true);
  const first = await api.mcp_component_update(args);
  const replay = await api.mcp_component_update(args);
  assert.equal(first.receipt?.operationId, "b".repeat(32));
  assert.equal(first.receipt?.phase, "QUEUED");
  assert.equal(first.completed, false);
  assert.deepEqual(first.receipt, replay.receipt);
  assert.equal(calls, 2);
});

test("replayed receipt cannot substitute a different target version digest or accepted identity", async () => {
  for (const patch of [{ componentId: "project_reading" }, { versionId: "other" }, { expectedSourceDigest: "d".repeat(64) },
    { parameterDigest: "d".repeat(64) }, { phase: "ACCEPTED" }, { requestId: "e18ce611-a930-449c-899c-d2e13e82bc13" },
    { updatedAt: "2026-10-27T12:00:00.000Z" }]) {
    const api = createReadOnlyRecovery(async () => ({ ...wire(), code: "REQUEST_REPLAY", receipt: { ...receipt(), ...patch } }), true);
    const result = await api.mcp_component_update(args);
    assert.equal(result.code, "DELIVERY_UNKNOWN");
    assert.equal("ownerChannel" in result ? result.ownerChannel.code : "", "IPC_INVALID_RESPONSE");
    assert.equal(result.receipt, null);
  }
});

test("terminal acceptance requires selected and loaded identity plus Ready evidence", async () => {
  const accepted = { ...receipt("ACCEPTED"), code: "UPDATE_ACCEPTED", selectedVersion: args.versionId,
    observedVersion: args.versionId, preparedBuildId: "build123", observedBuildId: "build123", ready: true };
  for (const phase of ["QUEUED", "RUNNING", "REJECTED", "RECOVERY_REQUIRED", "ACCEPTED"]) {
    const response = { ...wire("update_receipt"), receipt: phase === "ACCEPTED" ? accepted : receipt(phase) };
    const result = await createReadOnlyRecovery(async () => response).mcp_component_update_receipt({ requestId: args.requestId });
    assert.equal(result.code, "RECEIPT_OBSERVED");
    assert.equal(result.completed, ["ACCEPTED", "REJECTED"].includes(phase));
    assert.equal(result.terminal, ["ACCEPTED", "REJECTED"].includes(phase));
    assert.equal(result.finished, result.terminal);
    assert.equal(result.succeeded, phase === "ACCEPTED" ? true : phase === "REJECTED" ? false : null);
    assert.equal(result.requiresRecovery, phase === "RECOVERY_REQUIRED");
    assert.equal(result.receipt?.phase, phase);
  }
  for (const patch of [{ preparedBuildId: "different" }, { preparedBuildId: null }, { observedVersion: "old-version" }, { blockedByOperationId: "d".repeat(32) }]) {
    const result = await createReadOnlyRecovery(async () => ({ ...wire("update_receipt"), receipt: { ...accepted, ...patch } })).mcp_component_update_receipt({ requestId: args.requestId });
    assert.equal(result.code, "IPC_INVALID_RESPONSE");
  }
  const workspaceReceipt = { ...accepted, componentId: "project_reading" as const, observedVersion: "1.7.0" };
  workspaceReceipt.parameterDigest = updateParameterDigest(workspaceReceipt);
  const result = await createReadOnlyRecovery(async () => ({ ...wire("update_receipt"), receipt: workspaceReceipt })).mcp_component_update_receipt({ requestId: args.requestId });
  assert.equal(result.succeeded, true);
  const blockedReceipt = { ...receipt("RECOVERY_REQUIRED"), code: "UPDATE_BLOCKED_BY_OTHER_OPERATION", blockedByOperationId: "d".repeat(32) };
  const blocked = await createReadOnlyRecovery(async () => ({ ...wire("update_receipt"), receipt: blockedReceipt })).mcp_component_update_receipt({ requestId: args.requestId });
  assert.equal(blocked.requiresRecovery, true);
  assert.equal(blocked.succeeded, null);
  assert.equal(blocked.receipt?.blockedByOperationId, "d".repeat(32));
});

test("disconnect, exception and timeout never retry mutation or invent not-found completion", async () => {
  for (const failure of ["IPC_TIMEOUT", "NOT_CONNECTED", "CHANNEL_UNAVAILABLE"]) {
    let calls = 0;
    const query: ReadOnlyQuery = async () => { calls++; return { unavailable: failure }; };
    const result = await createReadOnlyRecovery(query, true).mcp_component_update(args);
    assert.equal(result.code, "DELIVERY_UNKNOWN");
    assert.equal(result.requestId, args.requestId);
    assert.equal(result.receipt, null);
    assert.equal(result.completed, null);
    assert.equal(calls, 1);
  }
  const result = await createReadOnlyRecovery(async () => { throw Error("private"); }, true).mcp_component_update(args);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("request conflict or unavailable receipt never returns another operation success", async () => {
  for (const code of ["REQUEST_CONFLICT", "OWNER_CLOSING", "RECEIPT_UNAVAILABLE", "RECEIPT_CAPACITY", "NOT_SUPPORTED"]) {
    const result = await createReadOnlyRecovery(async () => ({ ...wire(), code, receipt: null }), true).mcp_component_update(args);
    assert.equal(result.code, code);
    assert.equal(result.receipt, null);
    assert.equal(result.completed, null);
  }
});

function frame(text: string) { const body = Buffer.from(text); const header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]); }
test("v2 framed exchange retains challenge nonce and bounded strict reply validation", async () => {
  for (const corrupt of [false, true]) {
    const expected = wire();
    const socket = new PassThrough();
    socket.write = ((chunk: Buffer) => {
      const sent = JSON.parse(chunk.subarray(4).toString());
      assert.equal(sent.v, "2"); assert.equal(sent.challenge, "e".repeat(64));
      assert.equal(sent.expectedSourceDigest, args.expectedSourceDigest);
      const reply = { ...expected, ...(corrupt ? { extraCommand: "forbidden" } : {}) };
      queueMicrotask(() => socket.emit("data", frame(JSON.stringify(reply)))); return true;
    }) as typeof socket.write;
    const pending = exchangePipe({ v: "2", operation: "update", nonce: expected.nonce, ...args }, () => socket as unknown as net.Socket);
    socket.emit("data", frame("e".repeat(64)));
    assert.deepEqual(await pending, corrupt ? { unavailable: "IPC_INVALID_RESPONSE" } : expected);
  }
});

test("MCP discovers strict distinct update tools and denies unauthenticated mutation on the wire", async () => {
  const server = new McpServer({ name: "update-test", version: "1" });
  registerComponentRecoveryTools(server, createReadOnlyRecovery(async () => { throw Error("unexpected IPC"); }));
  const client = new Client({ name: "update-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  try {
    const { tools } = await client.listTools();
    const update = tools.find(t => t.name === "mcp_component_update")!;
    assert.equal(update.annotations?.destructiveHint, true);
    assert.equal(update.annotations?.readOnlyHint, false);
    assert.equal(update.inputSchema.additionalProperties, false);
    assert.deepEqual((update.inputSchema.properties?.componentId as { enum: string[] }).enum, targets);
    assert.ok(update.inputSchema.required?.includes("expectedSourceDigest"));
    const result = await client.callTool({ name: update.name, arguments: args });
    assert.equal((result.structuredContent as Record<string, unknown>)?.code, "AUTHENTICATED_TRANSPORT_REQUIRED");
    assert.equal((await client.callTool({ name: update.name, arguments: { ...args, command: "whoami" } })).isError, true);
  } finally { await client.close(); await server.close(); }
});
