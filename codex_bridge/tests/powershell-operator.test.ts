import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomBytes, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, realpath, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createConnection, createServer } from "node:net";
import { execFileSync } from "node:child_process";
import * as protocol from "../src/powershell-approval/operator-ipc.js";
import { PowerShellApprovalBroker } from "../src/powershell-approval/broker.js";
import { ApprovalError, sha256, type ProposalInput, type Receipt, type RunnerResult } from "../src/powershell-approval/contract.js";
import { runOfflineNormalMarker, type OfflineRunner } from "../src/powershell-approval/runner.js";
import { projectApprovalResult } from "../src/powershell-approval/job-projection.js";
import { JobStore } from "../src/job-store.js";
import { previewWorkPackage } from "../src/work-package.js";

// Resolve only this repository-owned module. Never a request-selected module/path.
const owner = await import(pathToFileURL(resolve("../mcp_control_center/src/NormalMarkerOperator.mjs")).href);
const SID = "S-1-5-21-1000";
const synthetic = async (r: Readonly<Receipt>): Promise<RunnerResult> => ({
  evidence: "SYNTHETIC", requestId: r.request.requestId, digest: r.digest, executionMode: "NORMAL",
  executorId: r.request.executorId, sid: r.request.expectedSid, elevated: false, pid: 1234,
  ownership: "INHERITED_NOT_HOST_ACCEPTED", exitCode: 0, outcome: "SUCCEEDED", code: "MARKER_CONFIRMED",
  marker: "CODEX_NORMAL_SYNTHETIC_V1", stdoutBytes: 32, stderrBytes: 0,
});
async function fixture(t: TestContext, runner: OfflineRunner = synthetic, sid = SID) {
  const base = resolve(".tmp/g1-operator-20261013/cases"); await mkdir(base, { recursive: true });
  const dir = await realpath(await mkdtemp(join(base, "case-")));
  const authority = protocol.createIsolatedHandoffAuthority();
  const bridge = protocol.isolatedPeerKeys(), operator = protocol.isolatedPeerKeys();
  let calls = 0;
  const endpoint = await owner.startIsolatedNormalMarkerOperator({ protocol, keys: operator,
    bridgePublicKey: bridge.publicKey, claim: authority.claim,
    runner: async (r: Receipt) => { calls++; return runner(r); } });
  t.after(() => endpoint.close());
  const client = { authority, port: endpoint.port, session: endpoint.session, keys: bridge, operatorPublicKey: operator.publicKey };
  const password = randomBytes(32).toString("hex");
  let delivered: Receipt | undefined;
  const bridgeRunner = protocol.isolatedOperatorRunner(client);
  const { broker, localReview } = await PowerShellApprovalBroker.offlineFixture({
    directory: join(dir, "approval"), projects: new Map([["fixture", dir]]), expectedSid: sid,
    enrollment: Buffer.from(password), evidence: async (input: ProposalInput) => ({
      source: "OFFLINE_FIXTURE", eventId: randomUUID(), jobId: input.jobId, turnId: input.turnId,
      classification: "JOB_OBJECT", code: "FIXTURE_JOB_RESTRICTED", observedAt: Date.now(), evidenceSha256: sha256("synthetic job evidence"),
    }), runner: async r => { delivered = structuredClone(r); return bridgeRunner(r); },
  });
  t.after(() => broker.close());
  const input: ProposalInput = { idempotencyKey: randomUUID(), projectId: "fixture", jobId: randomUUID(),
    turnId: "isolated-turn", executionMode: "NORMAL", artifactId: "fixture.marker.v1" };
  return { dir, broker, localReview, authority, bridge, operator, endpoint, client, input, password,
    calls: () => calls, delivered: () => delivered!,
    async approve(overrides: Partial<ProposalInput> = {}) {
      const receipt = await broker.propose({ ...input, ...overrides });
      const review = await localReview.open(receipt.request.requestId);
      return localReview.decide(review.binding, "approve", Buffer.from(password));
    },
  };
}
test("G1 signed IPC: local review -> CC owner -> canonical journal; secrets absent; replay denied", async t => {
  const f = await fixture(t);
  const approved = await f.approve();
  const receipt = await f.broker.execute(approved.request.requestId);
  assert.equal(receipt.state, "SUCCEEDED"); assert.equal(f.calls(), 1);
  assert.deepEqual(await f.broker.execute(approved.request.requestId), receipt);
  await assert.rejects(protocol.exchangeIsolatedMarker({ ...f.client, handoff: protocol.handoffOf(f.delivered()) }));
  assert.throws(() => f.authority.arm(f.delivered()), /IPC_REPLAY_OR_CAPACITY/);
  assert.equal(f.calls(), 1);
  const journal = await readFile(join(f.dir, "approval/receipts.jsonl"), "utf8");
  assert.equal(journal.includes(f.password), false);
  assert.equal(journal.includes("PRIVATE KEY"), false);
  assert.equal(JSON.stringify(protocol.handoffOf(f.delivered())).includes(f.password), false);
  assert.deepEqual(journal.trim().split("\n").map(line => JSON.parse(line).receipt.state),
    ["PROPOSED", "REVIEW_PENDING", "APPROVED", "DISPATCHING", "RUNNING", "SUCCEEDED"]);
});
test("G1 authority rejects unapproved, ADMIN, all scope mutations and caller execution fields", async t => {
  const f = await fixture(t);
  const proposed = await f.broker.propose(f.input);
  assert.throws(() => f.authority.arm(proposed));
  await f.approve(); await f.broker.execute(proposed.request.requestId);
  const r = f.delivered(), h = protocol.handoffOf(r);
  const authority = protocol.createIsolatedHandoffAuthority(); authority.arm(r);
  for (const patch of [{ requestId: randomUUID() }, { receiptId: randomUUID() }, { digest: "0".repeat(64) },
    { approvalEventId: randomUUID() }, { bootId: randomUUID() }, { jobId: randomUUID() }, { turnId: "other" },
    { sid: "S-1-5-21-2" }, { expiresAt: h.expiresAt + 1 }, { executorId: "other" }, { executionMode: "ADMIN" },
    { artifactId: "other" }, { command: "whoami" }, { path: "C:\\" }, { flags: [] }, { environment: {} }]) {
    assert.throws(() => authority.claim({ ...h, ...patch }));
  }
  assert.equal(authority.claim(h).digest, r.digest);
  assert.throws(() => authority.claim(h));
  const stale = structuredClone(r);
  // Arm and claim both use real wall time; no caller clock can extend the grant.
  const original = Date.now;
  try { Date.now = () => h.expiresAt; assert.throws(() => protocol.createIsolatedHandoffAuthority().arm(stale), /TTL_EXPIRED/); }
  finally { Date.now = original; }
});
test("G1 mutual pins and session: wrong Bridge, wrong Operator, role reflection and old session deny", async t => {
  const f = await fixture(t); const approved = await f.approve(); await f.broker.execute(approved.request.requestId);
  const h = protocol.handoffOf(f.delivered());
  const stranger = protocol.isolatedPeerKeys();
  for (const patch of [{ keys: stranger }, { operatorPublicKey: stranger.publicKey }, { session: randomUUID() },
    { operatorPublicKey: f.bridge.publicKey }]) {
    await assert.rejects(protocol.exchangeIsolatedMarker({ ...f.client, ...patch, handoff: h }));
  }
  assert.equal(f.calls(), 1);
  await assert.rejects(protocol.listenIsolatedOperator({ keys: f.bridge, bridgePublicKey: f.bridge.publicKey,
    claim: f.authority.claim, runner: synthetic }), /IPC_ROLE_REJECTED/);
});
test("G1 nonce tamper and oversized frames never invoke executor", async t => {
  const f = await fixture(t);
  const approved = await f.approve(); await f.broker.execute(approved.request.requestId);
  const handoff = protocol.handoffOf(f.delivered());
  const attack = async (oversize: boolean) => new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: f.endpoint.port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("attack did not close")); }, 2000);
    let data = "";
    socket.on("data", chunk => {
      data += chunk.toString(); if (!data.includes("\n")) return;
      if (oversize) socket.write("x".repeat(16385));
      else {
        const hello = JSON.parse(JSON.parse(data.trim()).body);
        const body = JSON.stringify({ contract: hello.contract, kind: "dispatch", role: "bridge",
          session: hello.session, serverNonce: randomUUID(), clientNonce: randomUUID(), handoff });
        socket.write(JSON.stringify({ body, signature: sign(null, Buffer.from(body), f.bridge.privateKey).toString("base64") }) + "\n");
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => { clearTimeout(timer); resolve(); });
  });
  await attack(false); await attack(true); assert.equal(f.calls(), 1);
});
test("G1 full result envelope mismatch and raw executor errors yield UNKNOWN without leaks or resend", async t => {
  for (const runner of [async (r: Readonly<Receipt>) => ({ ...await synthetic(r), sid: "S-1-5-21-2" }),
    async (r: Readonly<Receipt>) => ({ ...await synthetic(r), unexpected: "synthetic-secret" }),
    async () => { throw new Error("synthetic-secret: access denied"); }]) {
    const f = await fixture(t, runner); const approved = await f.approve();
    const receipt = await f.broker.execute(approved.request.requestId);
    assert.equal(receipt.state, "UNKNOWN");
    assert.equal(JSON.stringify(receipt).includes("synthetic-secret"), false);
    await f.broker.execute(approved.request.requestId); assert.equal(f.calls(), 1);
  }
});
test("G1 executor timeout is bounded, UNKNOWN is final, late success cannot update journal", async t => {
  let late!: (r: RunnerResult) => void; let snapshot!: Readonly<Receipt>;
  const f = await fixture(t, r => { snapshot = r; return new Promise(resolve => { late = resolve; }); });
  const approved = await f.approve(), start = Date.now();
  const receipt = await f.broker.execute(approved.request.requestId);
  assert.equal(receipt.state, "UNKNOWN"); assert.ok(Date.now() - start < 6500);
  late(await synthetic(snapshot));
  assert.deepEqual(await f.broker.execute(approved.request.requestId), receipt); assert.equal(f.calls(), 1);
});
test("G1 nonzero final receipt survives IPC without being treated as success", async t => {
  const f = await fixture(t, async r => ({ ...await synthetic(r), outcome: "FAILED", exitCode: 9,
    code: "NONZERO_EXIT", marker: "" }));
  const approved = await f.approve(); const receipt = await f.broker.execute(approved.request.requestId);
  assert.equal(receipt.state, "FAILED"); assert.equal(receipt.result?.exitCode, 9);
});
test("G1 actual isolated JobStore correlation is read-only and rejects stale turn/project/missing job", async t => {
  const f = await fixture(t); const jobs = new JobStore(join(f.dir, "jobs")); await jobs.initialize();
  const preview = previewWorkPackage({ projectId: "fixture", title: "marker", objective: "isolated marker" });
  const { record } = await jobs.create({ project: { id: "fixture", name: "fixture", path: f.dir },
    ...preview, idempotencyKey: randomUUID() });
  await jobs.setTurn(record.id, f.input.turnId);
  const approved = await f.approve({ jobId: record.id }); await f.broker.execute(approved.request.requestId);
  const before = jobs.get(record.id);
  const projected = await projectApprovalResult(jobs, f.broker, approved.request.requestId);
  assert.equal(projected.state, "SUCCEEDED"); assert.equal(projected.automaticResume, false);
  assert.deepEqual(jobs.get(record.id), before);
  await assert.rejects(projectApprovalResult({ get: () => undefined }, f.broker, approved.request.requestId));
  await assert.rejects(projectApprovalResult({ get: () => ({ ...before!, project: { ...before!.project, id: "other" } }) }, f.broker, approved.request.requestId));
  await jobs.setTurn(record.id, "next-turn");
  await assert.rejects(projectApprovalResult(jobs, f.broker, approved.request.requestId), /JOB_CORRELATION_REJECTED/);
});
test("G1 production factories stay blocked regardless of fixture success", () => {
  assert.throws(() => protocol.productionOperator(), /BLOCKED_HOST_ACCEPTANCE/);
  assert.throws(() => owner.startProductionNormalMarkerOperator(), /BLOCKED_HOST_ACCEPTANCE/);
  assert.equal(PowerShellApprovalBroker.status().enabled, false);
  assert.equal(PowerShellApprovalBroker.status().ADMIN, "BLOCKED_AWAITING_LOCAL_UAC");
});
test("G1 NORMAL host-like marker through actual IPC; inherited process is never host acceptance", async t => {
  // Current SID only. No secrets, profile, CIM scan, elevation or alternate execution path.
  const preflight = JSON.parse(execFileSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", resolve("../mcp_control_center/scripts/normal-marker-preflight.ps1")],
    { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 4096 }));
  assert.equal(preflight.elevated, false);
  assert.equal(preflight.enabled, false);
  const f = await fixture(t, runOfflineNormalMarker, preflight.sid);
  const approved = await f.approve(); const receipt = await f.broker.execute(approved.request.requestId);
  assert.equal(receipt.state, "SUCCEEDED"); assert.equal(receipt.result?.exitCode, 0);
  assert.equal(receipt.result?.evidence, "LOCAL_INHERITED_PROCESS");
  assert.equal(receipt.result?.ownership, "INHERITED_NOT_HOST_ACCEPTED");
  await writeFile(join(f.dir, "acceptance.json"), JSON.stringify({ preflight, receipt, operator: {
    evidence: f.endpoint.evidence, outOfJob: f.endpoint.outOfJob } }, null, 2));
  t.diagnostic(`receipt=${join(f.dir, "acceptance.json")}; outOfJob=UNVERIFIED; production=OFF`);
});
