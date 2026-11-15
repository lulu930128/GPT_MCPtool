import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { JobStore } from "../src/job-store.js";
import { MEMORY_POLICY, MemoryMaintenance, MemoryMaintenanceError, type MaintenanceWork } from "../src/memory-maintenance.js";
import { previewWorkPackage } from "../src/work-package.js";
import { loadBridgeConfig } from "../src/config.js";
import { createBridgeRuntime } from "../src/runtime.js";
import { startBridgeHttpServer } from "../src/http-server.js";
import { closeIdleRuntime } from "../src/cooperative-shutdown.js";

const idle = (): MaintenanceWork => ({ jobs: 0, approvals: 0, operations: 0, tools: 0, background: 0, http: 0, controllerReady: true });
const identity = () => ({ pid: process.pid, instance: randomUUID(), buildId: "fixture-build", startedAt: new Date().toISOString() });
async function root() { const base = resolve(".tmp/memory-maintenance-tests"); await mkdir(base, { recursive: true }); return mkdtemp(join(base, "run-")); }
function input(path: string) {
  const preview = previewWorkPackage({ projectId: "fixture", title: "Memory fixture", objective: "Local fixture only",
    executionMode: "plan", approvalReviewer: "user", dataClassification: "personal" });
  return { project: { id: "fixture", name: "Fixture", path }, workPackage: preview.workPackage, previewDigest: preview.previewDigest, idempotencyKey: randomUUID() };
}
async function fixture(t: TestContext) {
  const dir = await root(); const store = new JobStore(join(dir, "jobs")); await store.initialize();
  let now = Date.now(), heap = 0; const work = idle();
  const manager = new MemoryMaintenance(store, dir, identity(), () => ({ ...work, operations: store.pendingAdmissions }), () => now, () => heap,
    { ...MEMORY_POLICY, thresholdBytes: 100 });
  await manager.initialize(); t.after(() => manager.close());
  return { dir, store, manager, work, sample: async (value: number, elapsed = 60_000) => { heap = value; now += elapsed; await manager.tick(); }, now: () => now };
}
test("strict 1500 MiB defaults; consecutive 60s samples latch across GC, clock ticks and process initialization", async t => {
  assert.deepEqual(MEMORY_POLICY, { thresholdBytes: 1572864000, sampleMs: 60000, consecutive: 2, cooldownMs: 600000 });
  const f = await fixture(t); f.work.jobs = 1;
  await f.sample(101); await f.sample(100); assert.equal(f.manager.blocked, false);
  await f.sample(101); await f.sample(101, 59_999); assert.equal(f.manager.blocked, false);
  await f.sample(101, 1); assert.equal(f.manager.snapshot().phase, "draining");
  await f.sample(0, 600_000); assert.equal(f.manager.blocked, true);
  assert.equal(f.store.selfReloadDrain, null);
  await assert.rejects(f.store.create(input(f.dir)), MemoryMaintenanceError);
  const restored = new MemoryMaintenance(f.store, f.dir, identity(), idle);
  await restored.initialize(); assert.equal(restored.blocked, true); await restored.tick();
  await restored.reconcilePreviousRuntime(true);
  assert.equal(restored.blocked, true); // The old PID is this still-running test process.
  await restored.close();
});
test("atomic admission completes accepted append/prepare while later work is rejected; full pending inventory gates ready", async t => {
  const f = await fixture(t); let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
  const accepted = f.store.withAdmission(async () => {
    entered(); await barrier;
    const job = await f.store.create(input(f.dir));
    await f.store.prepareTurn(job.record.id, { executionMode: "plan", approvalReviewer: "user", dataClassification: "personal" });
    return job.record.id;
  });
  await started; await f.sample(101); await f.sample(101);
  assert.equal(f.manager.snapshot().phase, "draining");
  await assert.rejects(f.store.withAdmission(async () => {}), MemoryMaintenanceError);
  release(); const jobId = await accepted; assert.equal(f.store.get(jobId)?.status, "preparing");
  for (const field of ["jobs", "approvals", "tools", "background", "http"] as const) {
    f.work[field] = 1; await f.manager.tick(); assert.equal(f.manager.snapshot().phase, "draining", field); f.work[field] = 0;
  }
  await f.manager.tick(); assert.equal(f.manager.snapshot().phase, "ready");
  assert.equal(f.store.selfReloadDrain, null);
});
test("failed/UNKNOWN restart remains sealed and a verified success carries ten-minute cooldown across another process", async t => {
  const f = await fixture(t); await f.sample(101); await f.sample(101);
  const intent = JSON.parse(await readFile(f.manager.path, "utf8"));
  intent.phase = "failed"; intent.code = "MEMORY_RESTART_FAILED_OR_UNKNOWN";
  await writeFile(f.manager.path, JSON.stringify(intent)); await f.manager.tick();
  assert.equal(f.manager.snapshot().phase, "failed"); await f.sample(0, 600_001); assert.equal(f.manager.blocked, true);
  intent.phase = "cooldown"; intent.next = f.manager.identity;
  intent.completedAt = new Date(f.now()).toISOString(); intent.cooldownUntil = new Date(f.now() + 600_000).toISOString();
  await writeFile(f.manager.path, JSON.stringify(intent)); await f.manager.tick();
  assert.equal(f.manager.blocked, false);
  await f.sample(999, 599_999); assert.equal(f.manager.blocked, false);
  const other = new MemoryMaintenance(f.store, f.dir, identity(), idle, f.now, () => 999, { ...MEMORY_POLICY, thresholdBytes: 100 });
  await other.initialize(); await other.tick(); assert.equal(other.snapshot().consecutiveSamples, 0);
  await other.close(); await f.sample(999, 60_000); assert.equal(f.manager.blocked, false);
  await f.sample(999); assert.equal(f.manager.blocked, true);
});

test("an uncertain restart remains pending without a timer fault or another ready signal", async t => {
  const f = await fixture(t); await f.sample(101); await f.sample(101);
  const intent = JSON.parse(await readFile(f.manager.path, "utf8"));
  intent.phase = "restarting"; intent.restartRequestedAt = new Date(f.now()).toISOString();
  await writeFile(f.manager.path, JSON.stringify(intent)); await f.sample(0, 180_000);
  assert.equal(f.manager.snapshot().phase, "restarting");
  assert.equal(f.manager.snapshot().code, null);
  await assert.rejects(f.store.create(input(f.dir)), MemoryMaintenanceError);
});

test("a busy or unavailable CC leaves ready available for the next poll without a 180s fault", async t => {
  const f = await fixture(t); await f.sample(101); await f.sample(101);
  assert.equal(f.manager.snapshot().phase, "ready");
  await f.sample(0, 180_000);
  assert.equal(f.manager.snapshot().phase, "ready");
  assert.equal(f.manager.snapshot().code, null);
  await assert.rejects(f.store.create(input(f.dir)), MemoryMaintenanceError);
});
test("a healthy replacement reconciles prior ready/draining/unknown/failed intent and preserves incident bytes", async t => {
  for (const phase of ["ready", "draining", "restarting", "failed"]) {
    const f = await fixture(t); await f.sample(101); await f.sample(101); await f.manager.close();
    const intent = JSON.parse(await readFile(f.manager.path, "utf8"));
    intent.phase = phase; intent.old.pid = 2147483647;
    intent.code = "MEMORY_RESTART_OWNER_UNCONFIRMED";
    const before = JSON.stringify(intent); await writeFile(f.manager.path, before);
    const replacement = new MemoryMaintenance(f.store, f.dir, { ...identity(), buildId: "recovery-build" }, idle,
      f.now, () => 0, MEMORY_POLICY, () => true);
    await replacement.initialize(); assert.equal(replacement.blocked, true);
    await replacement.reconcilePreviousRuntime(true);
    assert.equal(replacement.snapshot().phase, "cooldown", phase);
    assert.equal(replacement.snapshot().admission, "open", phase);
    assert.equal(replacement.snapshot().code, "PREVIOUS_RUNTIME_REPLACED");
    const saved = JSON.parse(await readFile(replacement.path, "utf8"));
    assert.equal(saved.intentId, intent.intentId); assert.deepEqual(saved.old, intent.old);
    assert.equal(Date.parse(saved.cooldownUntil) - Date.parse(saved.completedAt), 600000);
    assert.equal(await readFile(join(f.dir, `memory-maintenance.${intent.intentId}.before-reconcile.json`), "utf8"), before);
    assert.equal((await f.store.create(input(f.dir))).created, true);
    await replacement.close();
  }
});
test("reconciliation preserves the latch for live/unknown old PID, unavailable stores, active work or malformed state", async t => {
  const f = await fixture(t); await f.sample(101); await f.sample(101); await f.manager.close();
  const intent = JSON.parse(await readFile(f.manager.path, "utf8")); intent.old.pid = 2147483647;
  const bytes = JSON.stringify(intent); await writeFile(f.manager.path, bytes);
  let exited = false; const work = idle();
  const replacement = new MemoryMaintenance(f.store, f.dir, identity(), () => work, f.now, () => 0, MEMORY_POLICY, () => exited);
  await replacement.initialize(); await replacement.reconcilePreviousRuntime(true);
  assert.equal(replacement.blocked, true);
  exited = true; await replacement.reconcilePreviousRuntime(false); assert.equal(replacement.blocked, true);
  work.jobs = 1; await replacement.reconcilePreviousRuntime(true); assert.equal(replacement.blocked, true);
  assert.equal(await readFile(replacement.path, "utf8"), bytes); await replacement.close();
  await writeFile(f.manager.path, "{");
  const malformed = new MemoryMaintenance(f.store, f.dir, identity(), idle);
  await malformed.initialize(); await malformed.reconcilePreviousRuntime(true);
  assert.equal(malformed.snapshot().code, "MAINTENANCE_STATE_UNAVAILABLE"); await malformed.close();
});
test("loopback MCP rejects stale clients, drains all jobs and tools, persists output, closes without self-reload deadlock and reopens only after verification", async t => {
  const dir = await root(); const projectsFile = join(dir, "projects.json");
  await writeFile(projectsFile, JSON.stringify({ projects: [{ id: "fixture", name: "Fixture", path: dir }] }));
  const config = await loadBridgeConfig({ CODEX_BRIDGE_PROJECT_ROOT: process.cwd(), CODEX_BRIDGE_PROJECTS_FILE: projectsFile,
    CODEX_BRIDGE_DATA_DIR: join(dir, "data"), CODEX_HOME: join(dir, "codex-home"), CODEX_BRIDGE_CODEX_COMMAND: process.execPath,
    CODEX_BRIDGE_CODEX_ARGS: '["app-server"]' }); config.handoffDir = join(dir, "handoff");
  const runtime = await createBridgeRuntime(config); t.after(() => runtime.close());
  runtime.controller.listModels = async () => [];
  await runtime.memoryMaintenance!.close(); let now = Date.now();
  runtime.memoryMaintenance = new MemoryMaintenance(runtime.store, config.dataDir, { ...identity(), pid: 2147483647 }, runtime.maintenanceWork!, () => now, () => 101, { ...MEMORY_POLICY, thresholdBytes: 100 });
  await runtime.memoryMaintenance.initialize();
  const first = await runtime.store.create(input(dir)), second = await runtime.store.create(input(dir));
  for (let i = 0; i < 21; i++) { const j = await runtime.store.create(input(dir)); await runtime.store.transition(j.record.id, "completed", "Fixture history"); }
  const http = await startBridgeHttpServer(runtime, { host: "127.0.0.1", port: 0 }); t.after(() => http.close());
  const client = new Client({ name: "memory-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(http.url)); await client.connect(transport); t.after(() => client.close());
  await runtime.memoryMaintenance.tick(); now += 60_000; await runtime.memoryMaintenance.tick();
  const preview = previewWorkPackage(input(dir).workPackage);
  const rejected = await client.callTool({ name: "codex_direct_job_dispatch", arguments: { ...preview.workPackage, idempotencyKey: randomUUID() } });
  assert.equal(rejected.isError, true);
  assert.equal((rejected.structuredContent as any).error.code, "MEMORY_MAINTENANCE");
  const status = await client.callTool({ name: "codex_bridge_status", arguments: {} });
  assert.equal((status.structuredContent as any).maintenance.pendingWork.jobs, 2);
  assert.equal((await client.callTool({ name: "codex_job_get", arguments: { jobId: first.record.id } })).isError, undefined);
  await runtime.store.transition(first.record.id, "completed", "first done"); await runtime.memoryMaintenance.tick();
  assert.equal(runtime.memoryMaintenance.snapshot().phase, "draining");
  await runtime.store.complete(second.record.id, { status: "completed", message: "done", output: "persisted fixture result", completedAt: new Date().toISOString() });
  runtime.activity!.tools++; await runtime.memoryMaintenance.tick(); assert.equal(runtime.memoryMaintenance.snapshot().phase, "draining");
  runtime.activity!.tools--; await runtime.memoryMaintenance.tick(); assert.equal(runtime.memoryMaintenance.snapshot().phase, "ready");
  await transport.terminateSession(); await client.close();
  const intent = JSON.parse(await readFile(runtime.memoryMaintenance.path, "utf8")); intent.phase = "restarting";
  await writeFile(runtime.memoryMaintenance.path, JSON.stringify(intent));
  assert.equal(await closeIdleRuntime(runtime, http, randomUUID()), "CLOSED");
  const replacement = await createBridgeRuntime(config); t.after(() => replacement.close());
  assert.equal(replacement.memoryMaintenance!.blocked, true);
  assert.equal((await replacement.store.snapshot(second.record.id)).result?.output, "persisted fixture result");
  const replacementHttp = await startBridgeHttpServer(replacement, { host: "127.0.0.1", port: 0 }); t.after(() => replacementHttp.close());
  assert.equal(replacement.memoryMaintenance!.blocked, false);
  const health = await (await fetch(new URL("/health", replacementHttp.url))).json() as any;
  assert.equal(health.memoryMaintenance.admission, "open"); assert.equal(health.stores.review, "OPEN");
  assert.equal((await replacement.store.create(input(dir))).created, true);
});
