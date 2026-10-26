import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import type net from "node:net";
import { readFile } from "node:fs/promises";
import { createReadOnlyRecovery, exchangePipe, CC_READONLY_LIMITS, observeControlChannel } from "../src/cc-readonly.js";

const id = "personal_asset_os", action = "restart_core", nonce = "a".repeat(64);
const requestId = "c76f284e-e798-49eb-ae0c-a6d27189d0e7";
test("self channel distinguishes a valid unavailable snapshot reply from no channel", async () => {
  const reply = { ...response("status"), componentId: "", code: "SNAPSHOT_UNAVAILABLE", components: [] };
  assert.equal((await observeControlChannel(async () => reply)).connection, "CONNECTED");
  assert.equal((await observeControlChannel(async () => ({ unavailable: "SNAPSHOT_UNAVAILABLE" }))).connection, "UNVERIFIED");
});
function response(operation = "preview") {
  return { v: "1", nonce, operation, componentId: operation === "receipt" ? "" : id,
    action: operation === "preview" ? action : "", requestId: operation === "receipt" ? requestId : "",
    code: operation === "preview" ? "READ_ONLY_PREVIEW" : operation === "receipt" ? "RECEIPT_SOURCE_UNAVAILABLE" : "OWNER_OBSERVATION",
    components: operation === "receipt" ? [] : [{ componentId: id, status: "Ready", observedAt: new Date().toISOString(), capabilities: [action] }],
    supported: operation === "preview" ? true : null, mutationEnabled: false, allowed: false, executable: false, found: null, completed: null, receipt: null };
}

test("valid local response is usable sourced observation without independent owner attestation", async () => {
  const api = createReadOnlyRecovery(async (op) => response(op));
  const preview = await api.mcp_component_preview({ componentId: id, action });

  const status = await api.mcp_component_status({ componentId: id });
  for (const value of [preview, status]) {
    assert.equal(value.ownerChannel.code, "LOCAL_CHANNEL_RESPONSE");
    assert.equal(value.ownerChannel.verified, false);
    assert.equal(value.ownerVerified, false);
    assert.equal(value.authority.connection, "CONNECTED");
    assert.equal(value.authority.deployment, "LOCAL_CHANNEL");
    assert.equal(value.mutationEnabled, false);
  }
  assert.equal(preview.allowed, false); assert.equal(preview.executable, false);

  assert.equal(status.components[0].status, "Ready");
});

test("unavailable/denied/malformed owner preserves G1 and sanitizes all errors", async () => {
  for (const code of ["UNSUPPORTED_PLATFORM", "CHANNEL_UNAVAILABLE", "NOT_CONNECTED", "IPC_TIMEOUT", "IPC_BUSY"]) {
    const api = createReadOnlyRecovery(async () => ({ unavailable: code, secret: "private" }));
    const p = await api.mcp_component_preview({ componentId: id, action });
    assert.equal(p.ownerChannel.code, code); assert.equal(p.allowed, false);
    assert.equal(JSON.stringify(p).includes("private"), false);
  }
  const variants = [
    { ...response(), nonce: "bad" }, { ...response(), componentId: "project_reading" },
    { ...response(), operation: "receipt" }, { ...response(), allowed: true },
    { ...response(), ownerVerified: true }, { ...response(), supported: false },
    { ...response(), components: [response().components[0], response().components[0]] },
    { ...response(), components: [{ ...response().components[0], observedAt: "2000-01-01T00:00:00Z" }] },
    { ...response(), components: [{ ...response().components[0], observedAt: "2099-01-01T00:00:00Z" }] },
    { ...response(), receipt: { token: "private" } }, null, "private",
  ];
  for (const value of variants) {
    const p = await createReadOnlyRecovery(async () => value).mcp_component_preview({ componentId: id, action });
    assert.equal(p.ownerChannel.code, "IPC_INVALID_RESPONSE"); assert.equal(p.ownerVerified, false);
  }
  const p = await createReadOnlyRecovery(async () => { throw Error("private"); }).mcp_component_preview({ componentId: id, action });
  assert.equal(p.ownerChannel.code, "NOT_CONNECTED"); assert.equal(JSON.stringify(p).includes("private"), false);
});

test("strict schema rejects unknown/self/command/extra fields before channel IO", async () => {
  let calls = 0;
  const api = createReadOnlyRecovery(async () => { calls++; return response(); });
  for (const componentId of ["project_reading", "mcp_control_center", "unknown", "PERSONAL_ASSET_OS", "../personal_asset_os"]) {
    await assert.rejects(api.mcp_component_status({ componentId }));
    await assert.rejects(api.mcp_component_preview({ componentId, action }));
  }
  await assert.rejects(api.mcp_component_preview({ componentId: id, action, command: "whoami" }));
  await assert.rejects(api.mcp_component_receipt({ requestId, path: "private" }));
  assert.equal(calls, 0);
});

function frame(text: string) { const body = Buffer.from(text); const header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]); }
// Fake socket separates inbound data from outbound writes (no loopback echo).
function socketFixture(deliver: (socket: PassThrough, written: Buffer) => void) {
  const socket = new PassThrough();
  socket.write = ((chunk: Buffer) => { deliver(socket, chunk); return true; }) as typeof socket.write;
  return socket;
}
const request = { v: "1", nonce, operation: "preview", componentId: id, action, requestId: "", confirmation: "" };

test("framed transport supports fragmented response, binds nonce and has no proof promotion", async () => {
  const expected = response();
  const socket = socketFixture((s, written) => {
    assert.equal(JSON.parse(written.subarray(4).toString()).challenge, "b".repeat(64));
    const data = frame(JSON.stringify(expected));
    queueMicrotask(() => { s.emit("data", data.subarray(0, 2)); s.emit("data", data.subarray(2)); });
  });
  const pending = exchangePipe(request, () => socket as unknown as net.Socket);
  socket.emit("data", frame("b".repeat(64)));
  assert.deepEqual(await pending, expected);
  assert.equal(socket.destroyed, true);
});

test("framed transport rejects replayed nonce, oversize, malformed, extra frame and invalid UTF8", async () => {
  const badResponses = [frame(JSON.stringify({ ...response(), nonce: "c".repeat(64) })), frame("not JSON"),
    Buffer.concat([frame(JSON.stringify(response())), frame("extra")]), Buffer.from([1, 0, 0, 0, 255]), Buffer.from([255, 255, 255, 127])];
  for (const bad of badResponses) {
    const socket = socketFixture((s) => queueMicrotask(() => s.emit("data", bad)));
    const pending = exchangePipe(request, () => socket as unknown as net.Socket);
    socket.emit("data", frame("b".repeat(64)));
    assert.deepEqual(await pending, { unavailable: "IPC_INVALID_RESPONSE" });
    assert.equal(socket.destroyed, true);
  }
});

test("transport uses one absolute deadline even for idle peer and releases socket", async () => {
  const socket = socketFixture(() => {}), started = Date.now();
  const result = await exchangePipe(request, () => socket as unknown as net.Socket);
  assert.deepEqual(result, { unavailable: "IPC_TIMEOUT" });
  assert.ok(Date.now() - started < CC_READONLY_LIMITS.timeoutMs + 1500);
  assert.equal(socket.destroyed, true);
});

test("production adapter has no mutable helper execution or serialized trust switch", async () => {
  const source = await readFile("src/cc-readonly.ts", "utf8");
  for (const forbidden of ["runBoundedProcess", "child_process", "cc-readonly-client.ps1", "ownerVerified: true", 'deployment: "PROTECTED_INSTALL_VERIFIED"']) assert.equal(source.includes(forbidden), false);
  assert.equal(source.includes('"CLIENT_TRUST_UNPROVEN"'), false);
});
