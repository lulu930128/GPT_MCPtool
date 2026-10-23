import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { access, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadBridgeConfig } from "../src/config.js";
import { createBridgeRuntime } from "../src/runtime.js";
import { startBridgeHttpServer } from "../src/http-server.js";
import { startRuntimeHttp } from "../src/http-main.js";
import { ApprovalStore } from "../src/powershell-approval/store.js";
import { initializePowerShellReview } from "../src/powershell-approval/review-runtime.js";
import { CodexAppServerClient } from "../src/app-server-client.js";
import { closeResources, waitForClose } from "../src/close-resources.js";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { closeIdleRuntime } from "../src/cooperative-shutdown.js";
import { randomUUID } from "node:crypto";
import { previewWorkPackage } from "../src/work-package.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCodexBridgeMcpServer } from "../src/server.js";
import type { ReviewStoreDiagnostics } from "../src/powershell-approval/review-runtime.js";

async function fixture(t: TestContext) {
  const base = resolve(".tmp/lifecycle-cleanup-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "run-"));
  const projectsFile = join(root, "projects.json");
  await writeFile(projectsFile, JSON.stringify({ projects: [{ id: "fixture", name: "Fixture", path: root }] }));
  const config = await loadBridgeConfig({ CODEX_BRIDGE_PROJECT_ROOT: process.cwd(), CODEX_BRIDGE_PROJECTS_FILE: projectsFile,
    CODEX_BRIDGE_DATA_DIR: join(root, "data"), CODEX_HOME: join(root, "codex-home"),
    CODEX_BRIDGE_CODEX_COMMAND: process.execPath, CODEX_BRIDGE_CODEX_ARGS: '["app-server"]' });
  config.handoffDir = join(root, "handoff");
  const runtime = await createBridgeRuntime(config);
  t.after(async () => { await runtime.close().catch(() => undefined); });
  return { runtime, directory: join(config.dataDir, "powershell-approval"), root };
}
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

test("HTTP bind failure closes runtime and same canonical Store reopens", async t => {
  const { runtime, directory } = await fixture(t);
  const busy = new Server(); await new Promise<void>(r => busy.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => busy.close(() => r())));
  await assert.rejects(startRuntimeHttp(runtime, { host: "127.0.0.1", port: (busy.address() as { port: number }).port }),
    (e: unknown) => (e as NodeJS.ErrnoException).code === "EADDRINUSE");
  await assert.rejects(access(join(directory, "approval.lock")), missing);
  const reopened = await ApprovalStore.open(directory); await reopened.close();
});

test("post-bind startup failure closes listener and canonical Store", async t => {
  const { runtime, directory } = await fixture(t);
  let port = 0;
  await assert.rejects(startRuntimeHttp(runtime, { host: "127.0.0.1", port: 0, log(message) {
    port = Number(/:(\d+)\/mcp/.exec(message)?.[1]);
    throw new Error("logging-failed-after-bind");
  } }), /logging-failed-after-bind/);
  assert.ok(port > 0);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  await assert.rejects(access(join(directory, "approval.lock")), missing);
  const reopened = await ApprovalStore.open(directory); await reopened.close();
});

test("HTTP admission and health stay unavailable until control startup completes; close cannot reopen", async t => {
  const { runtime } = await fixture(t);
  const http = await startRuntimeHttp(runtime, { host: "127.0.0.1", port: 0, deferAdmission: true });
  assert.equal((await fetch(`http://127.0.0.1:${http.port}/health`)).status, 503);
  assert.equal((await fetch(http.url, { method: "POST", body: "{}" })).status, 503);
  assert.equal(http.isIdle(), false);
  http.activate();
  assert.equal((await fetch(`http://127.0.0.1:${http.port}/health`)).status, 200);
  await http.close();
  assert.throws(() => http.activate(), /HTTP_CLOSING/);
});

test("bind failure and cleanup failure both survive; later Store cleanup still runs", async t => {
  const { runtime, directory } = await fixture(t);
  runtime.privilegedBroker.close = async () => { throw new Error("broker-close-failure"); };
  const busy = new Server(); await new Promise<void>(r => busy.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => busy.close(() => r())));
  await assert.rejects(startRuntimeHttp(runtime, { host: "127.0.0.1", port: (busy.address() as { port: number }).port }),
    (e: unknown) => e instanceof AggregateError && e.errors[0].code === "EADDRINUSE" && e.errors[1].message === "broker-close-failure");
  await assert.rejects(access(join(directory, "approval.lock")), missing);
});

test("runtime attempts all cleanup even if the first two steps fail; repeated close retains failure", async t => {
  const { runtime, directory } = await fixture(t); const order: string[] = [];
  runtime.selfReload!.close = () => { order.push("self"); throw new Error("self"); };
  runtime.privilegedBroker.close = async () => { order.push("broker"); throw new Error("broker"); };
  runtime.controller.close = async () => { order.push("controller"); };
  await assert.rejects(runtime.close(), AggregateError);
  await assert.rejects(runtime.close(), AggregateError);
  assert.deepEqual(order, ["self", "broker", "controller"]);
  await assert.rejects(access(join(directory, "approval.lock")), missing);
});

test("HTTP close error still closes runtime; close is single flight", async t => {
  const { runtime, directory } = await fixture(t);
  const handle = await startBridgeHttpServer(runtime, { host: "127.0.0.1", port: 0 });
  const original = Server.prototype.close;
  const mock = t.mock.method(Server.prototype, "close", function(this: Server, callback?: (error?: Error) => void) {
    return original.call(this, () => callback?.(new Error("http-close-failure")));
  });
  const first = handle.close(); assert.equal(first, handle.close());
  await assert.rejects(first, /http-close-failure/); mock.mock.restore();
  await assert.rejects(access(join(directory, "approval.lock")), missing);
  await assert.rejects(fetch(`http://127.0.0.1:${handle.port}/health`));
});

test("transport close failure preserves failure while finally closing HTTP and Store", async t => {
  const { runtime, directory } = await fixture(t);
  const handle = await startBridgeHttpServer(runtime, { host: "127.0.0.1", port: 0 });
  const response = await fetch(handle.url, { method: "POST", headers: { "content-type": "application/json",
    accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1,
      method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } }) });
  await response.text(); assert.equal(response.status, 200);
  const original = StreamableHTTPServerTransport.prototype.close;
  t.mock.method(StreamableHTTPServerTransport.prototype, "close", async function(this: StreamableHTTPServerTransport) {
    await original.call(this); throw new Error("transport-close-failure");
  });
  await assert.rejects(handle.close(), /transport-close-failure/);
  await assert.rejects(access(join(directory, "approval.lock")), missing);
});

test("startup STORE_LOCKED remains cached while live metadata changes; never automatically reopens", async t => {
  const { runtime, directory } = await fixture(t);
  const review = await initializePowerShellReview(runtime.config.dataDir);
  const before = await review.reviewStoreDiagnostics();
  assert.equal(before.startup.errorCode, "STORE_LOCKED"); assert.equal(before.startup.source, "CACHE_ON_STARTUP");
  assert.equal(before.current.presence, "PRESENT"); assert.equal(before.current.owner, "UNVERIFIED");
  assert.equal(before.current.lifecycle, "UNVERIFIED");
  assert.ok(Number.isFinite(Date.parse(before.current.observedAt)));
  assert.equal((await runtime.reviewStoreDiagnostics!()).current.owner, "THIS_INSTANCE");
  assert.equal((await runtime.reviewStoreDiagnostics!()).current.lifecycle, "OPEN");
  await runtime.close(); const after = await review.reviewStoreDiagnostics();
  assert.equal(after.startup.errorCode, "STORE_LOCKED"); assert.equal(after.current.presence, "ABSENT");
  assert.equal(after.automaticRecovery, false); assert.equal(review.approvalStore, undefined);
  assert.equal((await runtime.reviewStoreDiagnostics!()).current.lifecycle, "CLOSED");
  assert.doesNotMatch(JSON.stringify(after), /dataDir|startedUtcTicks|pid|sid|instance|[A-Z]:\\/i);
  await assert.rejects(access(join(directory, "approval.lock")), missing);
});

test("registered MCP status exposes current Store evidence without reopening or reading Journal", async t => {
  const { runtime } = await fixture(t);
  const server = createCodexBridgeMcpServer(runtime), client = new Client({ name: "lock-diagnostics", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const mock = t.mock.method(fsPromises, "open", async () => { throw new Error("status-must-not-open-a-store-or-journal"); });
  syncBuiltinESMExports();
  try {
    const result = await client.callTool({ name: "codex_powershell_status", arguments: {} });
    assert.notEqual(result.isError, true);
    const evidence = (result.structuredContent as { reviewStore: ReviewStoreDiagnostics }).reviewStore;
    assert.equal(evidence.startup.source, "CACHE_ON_STARTUP");
    assert.equal(evidence.current.owner, "THIS_INSTANCE");
    assert.equal(evidence.current.lifecycle, "OPEN");
    assert.equal(evidence.automaticRecovery, false);
    assert.equal(mock.mock.callCount(), 0);
    assert.doesNotMatch(JSON.stringify(evidence), /dataDir|startedUtcTicks|"pid"|"sid"|"instance"|[A-Z]:\\/i);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("new lock has bounded instance metadata; legacy/foreign lock is never removed", async t => {
  const { runtime, directory, root } = await fixture(t);
  const metadata = JSON.parse(await readFile(join(directory, "approval.lock"), "utf8"));
  assert.equal(metadata.contract, "approval-lock-owner-v1"); assert.match(metadata.instance, /^[0-9a-f-]{36}$/);
  const legacy = join(root, "legacy"); await mkdir(legacy); await writeFile(join(legacy, "approval.lock"), "");
  await assert.rejects(ApprovalStore.open(legacy), (e: unknown) => (e as { code: string }).code === "STORE_LOCKED");
  assert.equal(await readFile(join(legacy, "approval.lock"), "utf8"), "");
  assert.equal((await ApprovalStore.inspectLock(legacy)).owner, "UNVERIFIED");
  await runtime.close();
});

test("a replaced lock is preserved and repeated close cannot hide ownership failure", async t => {
  const { runtime, directory } = await fixture(t);
  const lock = join(directory, "approval.lock"); await rename(lock, lock + ".original"); await writeFile(lock, "foreign");
  assert.equal((await runtime.approvalStore!.lockDiagnostics()).owner, "UNVERIFIED");
  await assert.rejects(runtime.close(), /STORE_LOCK_OWNER_CHANGED/);
  await assert.rejects(runtime.close(), /STORE_LOCK_OWNER_CHANGED/);
  assert.equal((await runtime.approvalStore!.lockDiagnostics()).lifecycle, "CLOSE_FAILED");
  assert.equal(await readFile(lock, "utf8"), "foreign");
});

test("failed journal close still attempts lock close and retains lock", async t => {
  const original = fsPromises.open; const calls: string[] = [];
  const mock = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
    const handle = await original(...args), path = String(args[0]);
    if (/receipts\.jsonl$|approval\.lock$/.test(path)) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); calls.push(path);
        if (path.endsWith("receipts.jsonl")) throw new Error("journal-close-failed"); };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const { runtime, directory } = await fixture(t);
    await assert.rejects(runtime.close(), /journal-close-failed/);
    assert.equal(calls.length, 2); await access(join(directory, "approval.lock"));
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("lock replacement during journal close remains untouched", async t => {
  const original = fsPromises.open;
  let lockPath = "";
  const mock = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
    const handle = await original(...args);
    if (String(args[0]).endsWith("receipts.jsonl")) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close(); await rename(lockPath, lockPath + ".prior"); await writeFile(lockPath, "foreign-during-close");
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const { runtime, directory } = await fixture(t); lockPath = join(directory, "approval.lock");
    await assert.rejects(runtime.close(), /STORE_LOCK_OWNER_CHANGED/);
    assert.equal(await readFile(lockPath, "utf8"), "foreign-during-close");
    assert.equal((await runtime.approvalStore!.lockDiagnostics()).lifecycle, "CLOSE_FAILED");
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("failed open cleans both owned handles even when journal close rejects", async t => {
  const base = resolve(".tmp/lifecycle-cleanup-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "open-failure-")); await writeFile(join(root, "receipts.jsonl"), "torn-tail");
  const original = fsPromises.open; const closed: string[] = [];
  const mock = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
    const handle = await original(...args), path = String(args[0]), close = handle.close.bind(handle);
    handle.close = async () => { await close(); closed.push(path);
      if (path.endsWith("receipts.jsonl")) throw new Error("injected-open-cleanup-failure"); };
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(ApprovalStore.open(root), (e: unknown) => (e as { code: string }).code === "STORE_CLEANUP_UNCERTAIN");
    assert.equal(closed.length, 2); await access(join(root, "approval.lock"));
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("EEXIST after acquiring the lock is not cached as STORE_LOCKED; owned lock is released", async t => {
  const base = resolve(".tmp/lifecycle-cleanup-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "journal-exists-"));
  const original = fsPromises.open;
  const mock = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
    if (String(args[0]).endsWith("receipts.jsonl")) throw Object.assign(new Error("injected"), { code: "EEXIST" });
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(ApprovalStore.open(root), (e: unknown) => (e as { code: string }).code === "STORE_UNAVAILABLE");
    await assert.rejects(access(join(root, "approval.lock")), missing);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("bounded wait reports UNKNOWN without retrying or cancelling delayed cleanup", async () => {
  let complete!: () => void; let calls = 0;
  const operation = new Promise<void>(resolve => { calls++; complete = resolve; });
  await assert.rejects(waitForClose(operation, 10, "CLOSE_UNKNOWN"), /CLOSE_UNKNOWN/);
  assert.equal(calls, 1);
  complete(); await operation;
  assert.equal(await waitForClose(Promise.resolve("CLOSED"), 100, "CLOSE_UNKNOWN"), "CLOSED");
});

test("closeResources preserves multiple errors and executes each cleanup", async () => {
  const seen: number[] = [];
  await assert.rejects(closeResources([() => { seen.push(1); throw new Error("one"); }, () => { seen.push(2); throw new Error("two"); }]),
    (e: unknown) => e instanceof AggregateError && e.errors.length === 2);
  assert.deepEqual(seen, [1, 2]);
});

test("real App Server child exits on stdin EOF without kill", async t => {
  const base = resolve(".tmp/lifecycle-cleanup-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "child-")), script = join(root, "stdio.mjs"), marker = join(root, "closed");
  await writeFile(script, `import{createInterface}from'node:readline';import{writeFileSync}from'node:fs';
const input=createInterface({input:process.stdin});input.on('line',line=>{const x=JSON.parse(line);if(x.id)console.log(JSON.stringify({id:x.id,result:{}}));});
input.on('close',()=>writeFileSync(${JSON.stringify(marker)},'EOF'));`);
  const client = new CodexAppServerClient({ command: process.execPath, args: [script] });
  t.after(() => client.close());
  await client.ensureStarted(); await client.close();
  assert.equal(await readFile(marker, "utf8"), "EOF"); assert.equal(client.status, "idle");
});

test("cooperative receiver refuses real queued work and releases only its own admission lease", async t => {
  const { runtime, directory } = await fixture(t);
  const handle = await startBridgeHttpServer(runtime, { host: "127.0.0.1", port: 0 });
  t.after(() => handle.close());
  const preview = previewWorkPackage({ projectId: "fixture", title: "fixture", objective: "fixture", dataClassification: "personal" });
  await runtime.store.create({ project: runtime.config.projects.get("fixture")!, workPackage: preview.workPackage,
    previewDigest: preview.previewDigest, idempotencyKey: randomUUID() });
  assert.equal(await closeIdleRuntime(runtime, handle, randomUUID()), "ACTIVE_WORK_PRESENT");
  assert.equal(runtime.store.selfReloadDrain, null); await access(join(directory, "approval.lock"));
  assert.equal((await fetch(`http://127.0.0.1:${handle.port}/health`)).status, 200);
});

test("cooperative receiver closes real idle HTTP/runtime/Store and keeps admissions closed", async t => {
  const { runtime, directory } = await fixture(t);
  const handle = await startBridgeHttpServer(runtime, { host: "127.0.0.1", port: 0 });
  const requestId = randomUUID();
  assert.equal(await closeIdleRuntime(runtime, handle, requestId), "CLOSED");
  assert.equal(runtime.store.selfReloadDrain?.requestId, requestId);
  await assert.rejects(access(join(directory, "approval.lock")), missing);
  assert.equal(await closeIdleRuntime(runtime, handle, randomUUID()), "ACTIVE_WORK_PRESENT");
});

test("another admission lease is not overwritten or released", async t => {
  const { runtime } = await fixture(t);
  const handle = await startBridgeHttpServer(runtime, { host: "127.0.0.1", port: 0 }); t.after(() => handle.close());
  const existing = randomUUID(); await runtime.store.beginSelfReload(existing, new Date(Date.now() + 60_000).toISOString());
  assert.equal(await closeIdleRuntime(runtime, handle, randomUUID()), "ACTIVE_WORK_PRESENT");
  assert.equal(runtime.store.selfReloadDrain?.requestId, existing);
});

test("drain refusal checks release permission inside the queue, after a deadline can expire", async t => {
  const { runtime } = await fixture(t);
  const requestId = randomUUID();
  await runtime.store.beginSelfReload(requestId, new Date(Date.now() + 60000).toISOString());
  let canRelease = true;
  const release = runtime.store.endSelfReload(requestId, () => canRelease);
  canRelease = false;
  await release;
  assert.equal(runtime.store.selfReloadDrain?.requestId, requestId);
});

test("cooperative close failure leaves admission closed, never reports CLOSED", async t => {
  const { runtime } = await fixture(t);
  const handle = await startBridgeHttpServer(runtime, { host: "127.0.0.1", port: 0 });
  runtime.privilegedBroker.close = async () => { throw new Error("close-uncertain"); };
  const requestId = randomUUID(); await assert.rejects(closeIdleRuntime(runtime, handle, requestId), /close-uncertain/);
  assert.equal(runtime.store.selfReloadDrain?.requestId, requestId);
});
