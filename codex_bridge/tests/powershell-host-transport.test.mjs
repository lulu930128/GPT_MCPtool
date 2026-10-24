// Offline harness only. Compile into .tmp/host-diagnostics-check first; no dist
// publication, real installed lookup, native process or authority issuer.
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

let activate = async () => {};
mock.module(new URL("../.tmp/host-diagnostics-check/src/installed-runtime.js", import.meta.url).href,
  { namedExports: { assertInstalledRuntimeActivation: () => activate() } });
const { createNativeHostTransport, HOST_PREFLIGHT_TIMEOUT_MS } = await import("../.tmp/host-diagnostics-check/src/powershell-approval/host-transport.js");
const { HOST_FRAME_BYTES } = await import("../.tmp/host-diagnostics-check/src/powershell-approval/host-receiver.js");
const port = new Proxy({}, { get() { assert.fail("No candidate/HostPort dispatch allowed"); } });
const installed = { codeRoot: "C:\\inert-installed-fixture" };
const flush = () => new Promise(resolve => setImmediate(resolve));
const peer = { hostId: "11111111-1111-4111-8111-111111111111", instanceId: "11111111-1111-4111-8111-111111111111",
  sid: "S-1-5-21-1000", logonId: "0000000000000001", pid: 321, processStartedAt: Date.now() - 10000,
  imageSha256: "b".repeat(64), tokenId: "inert-test-token", integrity: "MEDIUM" };

function fixture(t) {
  const frames = [], child = new EventEmitter();
  child.pid = 123; child.exitCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, encoding, done) { frames.push(JSON.parse(String(chunk))); done(); } });
  const spawn = t.mock.method(childProcess, "spawn", (file, args, options) => {
    assert.equal(file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(args, ["-NoProfile", "-NonInteractive", "-File", "C:\\inert-installed-fixture\\scripts\\powershell-host-transport.ps1", "-CoreId", String(process.pid)]);
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.deepEqual(Object.keys(options.env).sort(), ["PSModulePath", "SystemRoot", "WINDIR"]);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); activate = async () => {}; });
  const transport = createNativeHostTransport(port, installed);
  const exit = () => { child.exitCode = 0; child.emit("exit", 0); };
  t.after(async () => { exit(); await transport.close(); });
  const send = message => child.stdout.write(JSON.stringify({ ...(message.kind === "channel" ? { peer } : {}), ...message }) + "\n");
  return { transport, child, frames, spawn, exit, send };
}

test("fixed preflight sends only inert initial frame; shared concurrency returns BUSY", async t => {
  const f = fixture(t), pending = f.transport.preflight(); await flush();
  assert.equal(f.spawn.mock.callCount(), 1);
  assert.deepEqual(Object.keys(f.frames[0]).sort(), ["contract", "expiresAt", "operation", "session"]);
  assert.equal(f.frames[0].operation, "preflight");
  assert.equal((await f.transport.preflight()).code, "HOST_TRANSPORT_BUSY");
  const session = f.frames[0].session;
  f.send({ kind: "channel", session, binding: "a".repeat(64) }); await flush();
  f.send({ kind: "complete", session, code: "HOST_READY" }); await flush();
  f.exit();
  assert.equal((await pending).code, "HOST_READY");
  assert.equal(f.transport.status().preflight.code, "HOST_READY");
  assert.equal(f.spawn.mock.callCount(), 1);
});

test("missing installed, closed and activation rejection cannot spawn or access HostPort", async t => {
  const f = fixture(t), missing = createNativeHostTransport(port);
  assert.equal((await missing.preflight()).code, "NOT_DEPLOYED"); await missing.close();
  assert.equal((await missing.preflight()).code, "HOST_TRANSPORT_CLOSED");
  activate = async () => { throw new Error("PRIVATE-ACTIVATION"); };
  assert.equal((await f.transport.preflight()).code, "HOST_TRANSPORT_UNAVAILABLE");
  assert.equal(f.spawn.mock.callCount(), 0);
});

test("slow installed verification can finish beyond 20 seconds without sealing or retry", async t => {
  const f = fixture(t); t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolveActivation;
  activate = () => new Promise(resolve => { resolveActivation = resolve; });
  const pending = f.transport.preflight(); await flush();
  t.mock.timers.tick(5_000); await flush();
  assert.equal(f.spawn.mock.callCount(), 0);
  resolveActivation(); await flush();
  assert.equal(f.spawn.mock.callCount(), 1);
  t.mock.timers.tick(25_000); await flush();
  assert.equal(f.transport.status().active, true);
  assert.equal(f.transport.status().closed, false);
  assert.equal(f.child.stdin.destroyed, false);
  assert.equal((await f.transport.preflight()).code, "HOST_TRANSPORT_BUSY");
  const session = f.frames[0].session;
  f.send({ kind: "channel", session, binding: "a".repeat(64) }); await flush();
  f.send({ kind: "complete", session, code: "HOST_READY" }); await flush();
  f.exit();
  assert.deepEqual(await pending, { code: "HOST_READY" });
  assert.equal(f.spawn.mock.callCount(), 1);
});

test("preflight cannot accept execution completion or route a candidate RPC", async t => {
  const f = fixture(t), pending = f.transport.preflight(); await flush();
  const session = f.frames[0].session;
  f.send({ kind: "channel", session, binding: "a".repeat(64) }); await flush();
  f.send({ sequence: 1, message: { operation: "claim", payload: { script: "INERT-CANDIDATE" } } }); await flush();
  assert.equal(f.frames.at(-1).error, "HOST_PREFLIGHT_READ_ONLY");
  f.exit(); assert.equal((await pending).code, "HOST_TRANSPORT_UNKNOWN");
  assert.doesNotMatch(JSON.stringify(f.frames), /INERT-CANDIDATE/);
});

test("execution completion on preflight is rejected even after channel frame", async t => {
  const f = fixture(t), pending = f.transport.preflight(); await flush();
  const session = f.frames[0].session;
  f.send({ kind: "channel", session, binding: "a".repeat(64) }); await flush();
  f.send({ kind: "complete", session, code: "RECEIPT_RECORDED" }); await flush();
  f.exit(); assert.equal((await pending).code, "HOST_TRANSPORT_UNKNOWN");
});

test("oversized frame and stderr fail closed without output disclosure", async t => {
  const f = fixture(t), pending = f.transport.preflight(); await flush();
  f.child.stdout.write(Buffer.alloc(HOST_FRAME_BYTES + 1, 65));
  f.child.stderr.write("PRIVATE-STDERR"); await flush();
  assert.equal(f.child.stdin.destroyed, true);
  f.exit(); assert.deepEqual(await pending, { code: "HOST_TRANSPORT_UNKNOWN" });
});

test("deadline seals transport and retains outstanding child without retry or force kill", async t => {
  const f = fixture(t); t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = f.transport.preflight(); await flush();
  t.mock.timers.tick(HOST_PREFLIGHT_TIMEOUT_MS); await flush();
  assert.deepEqual(await pending, { code: "HOST_PREFLIGHT_TIMEOUT" });
  assert.equal(f.transport.status().closed, true);
  assert.equal(f.transport.status().active, true);
  assert.equal(f.child.stdin.destroyed, true);
  assert.equal((await f.transport.preflight()).code, "HOST_TRANSPORT_CLOSED");
  assert.equal(f.spawn.mock.callCount(), 1);
  f.exit(); await flush();
});

test("deadline also covers activation; late activation cannot launch a child", async t => {
  const f = fixture(t); let resolveActivation;
  activate = () => new Promise(resolve => { resolveActivation = resolve; });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = f.transport.preflight(); await flush();
  t.mock.timers.tick(HOST_PREFLIGHT_TIMEOUT_MS); await flush();
  assert.deepEqual(await pending, { code: "HOST_PREFLIGHT_TIMEOUT" });
  resolveActivation(); await flush();
  assert.equal(f.spawn.mock.callCount(), 0);
  assert.equal(f.transport.status().closed, true);
});
