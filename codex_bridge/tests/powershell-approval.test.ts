import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCodexBridgeMcpServer } from "../src/server.js";
import { startBridgeHttpServer } from "../src/http-server.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RemotePrivilegedBroker } from "../src/privileged/broker.js";
import type { BridgeRuntime } from "../src/runtime.js";
import { PowerShellApprovalBroker } from "../src/powershell-approval/broker.js";
import { ApprovalError, CHALLENGE_TTL_MS, digest, MARKER_SCRIPT, OUTPUT_LIMIT, proposalInputSchema,
  receiptSchema, sha256, TTL_MS, type ProposalInput, type Receipt, type RunnerResult } from "../src/powershell-approval/contract.js";
import { ApprovalStore } from "../src/powershell-approval/store.js";
import { offlineLocalReviewHandler, reviewHtml } from "../src/powershell-approval/local-ui.js";
import { observeOfflineMarkerChild, runOfflineNormalMarker, validateDelivery, type OfflineRunner } from "../src/powershell-approval/runner.js";

const SID = "S-1-5-21-1000";
const code = (expected: string) => (error: unknown) => error instanceof ApprovalError && error.code === expected;
const result = (receipt: Readonly<Receipt>): RunnerResult => ({ evidence: "SYNTHETIC", requestId: receipt.request.requestId,
  digest: receipt.digest, executionMode: "NORMAL", executorId: "offline-normal-marker", sid: receipt.request.expectedSid,
  elevated: false, pid: 1234, ownership: "INHERITED_NOT_HOST_ACCEPTED", exitCode: 0, outcome: "SUCCEEDED", code: "MARKER_CONFIRMED",
  marker: "CODEX_NORMAL_SYNTHETIC_V1", stdoutBytes: 32, stderrBytes: 0 });
async function directory() {
  const base = join(process.cwd(), ".tmp", "powershell-approval-tests");
  await mkdir(base, { recursive: true });
  return realpath(await mkdtemp(join(base, "case-")));
}
async function fixture(t: TestContext, runner: OfflineRunner = async r => result(r), sid = SID) {
  const dir = await directory();
  const workspace = join(dir, "workspace");
  await mkdir(workspace);
  // Random, ephemeral enrollment generated at runtime; never a stored password fixture.
  const secret = randomBytes(32).toString("hex");
  let now = Date.now();
  let calls = 0;
  const options = { directory: join(dir, "journal"), projects: new Map([["fixture", workspace]]), expectedSid: sid,
    enrollment: Buffer.from(secret), clock: () => now,
    evidence: async (input: ProposalInput) => ({ source: "OFFLINE_FIXTURE" as const, eventId: randomUUID(), jobId: input.jobId, turnId: input.turnId,
      classification: "SANDBOX_POLICY" as const, code: "FIXTURE_SANDBOX_DENIED" as const, observedAt: now, evidenceSha256: sha256("synthetic restriction") }),
    runner: async (r: Readonly<Receipt>) => { calls++; return runner(r); } };
  const { broker, localReview } = await PowerShellApprovalBroker.offlineFixture(options);
  assert.equal(options.enrollment.every(byte => byte === 0), true);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await broker.close(); } };
  t.after(close);
  const input: ProposalInput = { idempotencyKey: randomUUID(), projectId: "fixture", jobId: randomUUID(), turnId: "fixture-turn", executionMode: "NORMAL", artifactId: "fixture.marker.v1" };
  return { broker, localReview, dir, options, secret, input, close, calls: () => calls, advance: (ms: number) => { now += ms; },
    async approved(mode: "NORMAL" | "ADMIN" = "NORMAL") {
      const r = await broker.propose({ ...input, executionMode: mode });
      const review = await localReview.open(r.request.requestId);
      const approved = await localReview.decide(review.binding, "approve", Buffer.from(secret));
      return { approved, review };
    } };
}

test("G0 strict immutable proposal; no caller script/path/env/auth and allowlist enforced", async t => {
  const f = await fixture(t);
  for (const extra of [{ command: "ignored" }, { scriptSnapshot: "ignored" }, { cwd: "C:\\" }, { args: [] }, { env: {} }, { password: true }, { auth: true }]) {
    assert.equal(proposalInputSchema.safeParse({ ...f.input, ...extra }).success, false);
    await assert.rejects(f.broker.propose({ ...f.input, ...extra }), code("INVALID_INPUT"));
  }
  await assert.rejects(f.broker.propose({ ...f.input, projectId: "unknown" }), code("PROJECT_NOT_ALLOWED"));
  const r = await f.broker.propose(f.input);
  assert.equal(r.request.scriptSnapshot, MARKER_SCRIPT);
  assert.equal(r.request.scriptSha256, sha256(MARKER_SCRIPT));
  assert.equal(r.request.expiresAt - r.request.createdAt, TTL_MS);
  assert.equal(r.digest, digest(r.request));
  assert.equal(r.request.failureEvidence.jobId, f.input.jobId);
  await assert.rejects(f.broker.execute(r.request.requestId), code("NOT_APPROVED"));
  assert.equal(f.calls(), 0);
});

test("G0/G1 synthetic E2E persists exact flow and idempotency; terminal replay never dispatches", async t => {
  let journalDirectory: string;
  const f = await fixture(t, async r => {
    const entries = (await readFile(join(journalDirectory, "receipts.jsonl"), "utf8")).trim().split("\n");
    const durable = JSON.parse(entries.at(-1)!).receipt;
    assert.equal(durable.state, "RUNNING");
    assert.equal(durable.digest, r.digest);
    return result(r);
  });
  journalDirectory = f.options.directory;
  const { approved } = await f.approved();
  const done = await f.broker.execute(approved.request.requestId);
  assert.equal(done.state, "SUCCEEDED");
  assert.equal(done.result?.evidence, "SYNTHETIC");
  assert.equal(done.request.jobId, f.input.jobId);
  assert.equal(done.request.turnId, f.input.turnId);
  assert.equal(done.approvalEventId, approved.approvalEventId);
  assert.deepEqual(await f.broker.propose(f.input), done);
  await assert.rejects(f.broker.propose({ ...f.input, executionMode: "ADMIN" }), code("IDEMPOTENCY_CONFLICT"));
  assert.deepEqual(await f.broker.execute(done.request.requestId), done);
  done.request.scriptSnapshot = "tampered" as typeof MARKER_SCRIPT;
  assert.equal((await f.broker.get(done.request.requestId)).request.scriptSnapshot, MARKER_SCRIPT);
  const journal = await readFile(join(f.options.directory, "receipts.jsonl"), "utf8");
  const entries = journal.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(entries.map(e => e.receipt.state), ["PROPOSED", "REVIEW_PENDING", "APPROVED", "DISPATCHING", "RUNNING", "SUCCEEDED"]);
  assert.equal(journal.includes(f.secret), false);
  assert.equal(f.calls(), 1);
  await f.close();
  const reopened = await PowerShellApprovalBroker.offlineFixture({ ...f.options, enrollment: Buffer.from(f.secret) });
  t.after(() => reopened.broker.close());
  assert.equal((await reopened.broker.execute(approved.request.requestId)).state, "SUCCEEDED");
  assert.equal(f.calls(), 1);
});

test("G0 local challenge binds request/digest/job/turn/mode/executor; concurrent replay loses", async t => {
  const f = await fixture(t);
  const r = await f.broker.propose(f.input);
  const review = await f.localReview.open(r.request.requestId);
  for (const patch of [{ requestId: randomUUID() }, { digest: "0".repeat(64) }, { jobId: randomUUID() },
    { turnId: "other" }, { executionMode: "ADMIN" }, { challenge: randomUUID() }, { auth: true }, { executorId: "other" }]) {
    await assert.rejects(f.localReview.decide({ ...review.binding, ...patch }, "approve", Buffer.from(f.secret)));
  }
  await assert.rejects(f.localReview.decide(review.binding, "approve"), code("PASSWORD_REQUIRED"));
  const secret = Buffer.from(f.secret);
  const outcomes = await Promise.allSettled([f.localReview.decide(review.binding, "approve", secret), f.localReview.decide(review.binding, "approve", Buffer.from(f.secret))]);
  assert.deepEqual(outcomes.map(x => x.status), ["fulfilled", "rejected"]);
  assert.equal(secret.every(byte => byte === 0), true);
  assert.equal(f.calls(), 0);
});

test("G0 denial and three failed passwords are terminal, persisted, and do not dispatch", async t => {
  for (const deny of [true, false]) {
    const f = await fixture(t);
    const r = await f.broker.propose(f.input);
    const review = await f.localReview.open(r.request.requestId);
    if (deny) assert.equal((await f.localReview.decide(review.binding, "deny")).state, "DENIED");
    else {
      for (let i = 0; i < 2; i++) await assert.rejects(f.localReview.decide(review.binding, "approve", randomBytes(32)), code("PASSWORD_REJECTED"));
      assert.equal((await f.localReview.decide(review.binding, "approve", randomBytes(32))).reason, "AUTH_ATTEMPTS_EXHAUSTED");
    }
    await assert.rejects(f.localReview.decide(review.binding, "approve", Buffer.from(f.secret)), code("REVIEW_BINDING_REJECTED"));
    await assert.rejects(f.broker.execute(r.request.requestId), code("NOT_APPROVED"));
    assert.equal((await f.broker.propose(f.input)).state, "DENIED");
    assert.equal(f.calls(), 0);
  }
});

test("G0 request/challenge/approved TTL and backwards clock fail closed", async t => {
  for (const phase of ["proposal", "challenge", "approved"] as const) {
    const f = await fixture(t);
    const r = await f.broker.propose(f.input);
    if (phase === "proposal") { f.advance(TTL_MS); assert.equal((await f.broker.get(r.request.requestId)).state, "EXPIRED"); }
    else {
      const review = await f.localReview.open(r.request.requestId);
      if (phase === "challenge") {
        f.advance(CHALLENGE_TTL_MS);
        assert.equal((await f.localReview.decide(review.binding, "approve", Buffer.from(f.secret))).state, "EXPIRED");
      } else {
        await f.localReview.decide(review.binding, "approve", Buffer.from(f.secret));
        f.advance(TTL_MS);
        await assert.rejects(f.broker.execute(r.request.requestId), code("NOT_APPROVED"));
      }
    }
    assert.equal(f.calls(), 0);
  }
  const f = await fixture(t); await f.broker.propose(f.input); f.advance(-1);
  await assert.rejects(f.broker.propose({ ...f.input, idempotencyKey: randomUUID() }), code("CLOCK_UNTRUSTED"));
});

test("G0 restart expires unused approvals and marks durable dispatch UNKNOWN without retry", async t => {
  for (const phase of ["PROPOSED", "REVIEW_PENDING", "APPROVED", "DISPATCHING", "RUNNING"] as const) {
    const f = await fixture(t);
    let r = await f.broker.propose(f.input);
    if (phase !== "PROPOSED") {
      const review = await f.localReview.open(r.request.requestId); r = review.receipt;
      if (phase !== "REVIEW_PENDING") r = await f.localReview.decide(review.binding, "approve", Buffer.from(f.secret));
    }
    await f.close();
    if (phase === "DISPATCHING" || phase === "RUNNING") {
      const store = await ApprovalStore.open(f.options.directory);
      r = { ...r, state: "DISPATCHING", reason: "DELIVERY_INTENT", revision: r.revision + 1 };
      await store.append(r);
      if (phase === "RUNNING") await store.append({ ...r, state: "RUNNING", reason: "RUNNER_ENTERED", revision: r.revision + 1 });
      await store.close();
    }
    const reopened = await PowerShellApprovalBroker.offlineFixture({ ...f.options, enrollment: Buffer.from(f.secret) });
    t.after(() => reopened.broker.close());
    const recovered = await reopened.broker.get(r.request.requestId);
    assert.equal(recovered.state, ["RUNNING", "DISPATCHING"].includes(phase) ? "UNKNOWN" : "EXPIRED");
    if (recovered.state === "UNKNOWN") assert.deepEqual(await reopened.broker.execute(r.request.requestId), recovered);
    assert.equal(f.calls(), 0);
  }
});

test("G0 journal locks, corruption, immutable digest, and invalid transitions fail closed", async t => {
  const f = await fixture(t);
  const r = await f.broker.propose(f.input);
  await assert.rejects(ApprovalStore.open(f.options.directory), code("STORE_LOCKED"));
  assert.equal(receiptSchema.safeParse({ ...r, request: { ...r.request, cwd: "C:\\other" } }).success, false);
  assert.equal(receiptSchema.safeParse({ ...r, state: "SUCCEEDED" }).success, false);
  await f.close();
  const store = await ApprovalStore.open(f.options.directory);
  await assert.rejects(store.append({ ...r, state: "DENIED", revision: 2, reason: "HUMAN_DENIED" }), code("INVALID_TRANSITION"));
  await store.close();
  const path = join(f.options.directory, "receipts.jsonl");
  await writeFile(path, (await readFile(path, "utf8")) + "partial", "utf8");
  await assert.rejects(ApprovalStore.open(f.options.directory), code("STORE_CORRUPT"));
});

test("G0 evidence correlation and qualification reject before approval or dispatch", async t => {
  const f = await fixture(t);
  for (const variant of ["job", "classification", "unclassified"] as const) {
    const options = { ...f.options, directory: await directory(), enrollment: Buffer.from(f.secret), evidence: async (input: ProposalInput) => {
      const evidence = await f.options.evidence(input);
      if (variant === "job") return { ...evidence, jobId: randomUUID() };
      if (variant === "classification") return { ...evidence, classification: "OS_PERMISSION" as const };
      return { ...evidence, classification: "UNCLASSIFIED" as const, code: "FIXTURE_UNKNOWN" as const };
    } };
    const host = await PowerShellApprovalBroker.offlineFixture(options); t.after(() => host.broker.close());
    if (variant !== "unclassified") await assert.rejects(host.broker.propose(f.input), code("INVALID_INPUT"));
    else {
      const request = await host.broker.propose(f.input);
      const review = await host.localReview.open(request.request.requestId);
      await assert.rejects(host.localReview.decide(review.binding, "approve", Buffer.from(f.secret)), code("FAILURE_NOT_QUALIFIED"));
    }
  }
  assert.equal(f.calls(), 0);
});

test("G1 verified synthetic failure is terminal FAILED, not success or retry", async t => {
  const f = await fixture(t, async r => ({ ...result(r), outcome: "FAILED", exitCode: 1, marker: "", code: "NONZERO_EXIT" }));
  const { approved } = await f.approved();
  const done = await f.broker.execute(approved.request.requestId);
  assert.equal(done.state, "FAILED"); assert.equal(done.result?.exitCode, 1);
  assert.deepEqual(await f.broker.execute(approved.request.requestId), done); assert.equal(f.calls(), 1);
});

test("G1 forged/misbound/oversized/failed results become durable UNKNOWN; no automatic resend", async t => {
  const variants: Array<(r: RunnerResult) => unknown> = [r => ({ ...r, digest: "0".repeat(64) }), r => ({ ...r, requestId: randomUUID() }),
    r => ({ ...r, sid: "S-1-5-21-999" }), r => ({ ...r, elevated: true }), r => ({ ...r, executionMode: "ADMIN" }),
    r => ({ ...r, exitCode: 1 }), r => ({ ...r, marker: "" }), r => ({ ...r, stdoutBytes: OUTPUT_LIMIT, stderrBytes: 1 }),
    r => ({ ...r, rawOutput: "forbidden" })];
  for (const variant of variants) {
    const f = await fixture(t, async r => variant(result(r)) as RunnerResult);
    const { approved } = await f.approved();
    const done = await f.broker.execute(approved.request.requestId);
    assert.equal(done.state, "UNKNOWN");
    assert.deepEqual(await f.broker.execute(approved.request.requestId), done);
    assert.equal(f.calls(), 1);
  }
  const f = await fixture(t, async () => { throw new ApprovalError("TIMEOUT"); });
  const { approved } = await f.approved();
  const done = await f.broker.execute(approved.request.requestId);
  assert.equal(done.runnerError, "TIMEOUT"); assert.equal(done.state, "UNKNOWN");
});

test("ADMIN remains blocked at password approval and dispatch, with explicit mode in UI", async t => {
  const f = await fixture(t);
  const r = await f.broker.propose({ ...f.input, executionMode: "ADMIN" });
  const review = await f.localReview.open(r.request.requestId);
  const html = reviewHtml(review.receipt, review.binding);
  assert.match(html, /ADMIN \/ Elevated/); assert.match(html, /value="approve" disabled/);
  await assert.rejects(f.localReview.decide(review.binding, "approve", Buffer.from(f.secret)), code("BLOCKED_AWAITING_LOCAL_UAC"));
  await assert.rejects(f.broker.execute(r.request.requestId), code("BLOCKED_AWAITING_LOCAL_UAC"));
  assert.equal(f.calls(), 0);
  assert.equal(PowerShellApprovalBroker.status().enabled, false);
});

test("local UI synthetic E2E: session/Host/Origin/CSRF/strict form, password never in receipts", async t => {
  const f = await fixture(t);
  const r = await f.broker.propose(f.input);
  const session = randomBytes(32);
  let handler: ReturnType<typeof offlineLocalReviewHandler>;
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  handler = offlineLocalReviewHandler({ origin, session, requestId: r.request.requestId, review: f.localReview });
  const cookie = `local_review=${session.toString("hex")}`;
  assert.equal((await fetch(`${origin}/review`)).status, 403);
  // Node fetch normalizes Host; use HTTP directly so this negative case sends the actual forged header.
  const forgedHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(`${origin}/review`, { headers: { cookie, host: "evil.invalid" } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(forgedHost, 403);
  const page = await fetch(`${origin}/review`, { headers: { cookie } });
  assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /NORMAL \/ 普通使用者/); assert.match(html, new RegExp(r.digest));
  assert.equal(html.includes(f.secret), false);
  const challenge = /name="challenge" value="([^"]+)"/.exec(html)![1];
  const body = () => new URLSearchParams({ challenge, decision: "approve", password: f.secret }).toString();
  const headers = { cookie, origin, "content-type": "application/x-www-form-urlencoded" };
  assert.equal((await fetch(`${origin}/decision`, { method: "POST", headers: { ...headers, origin: "https://evil.invalid" }, body: body() })).status, 403);
  assert.equal((await fetch(`${origin}/decision`, { method: "POST", headers, body: `${body()}&auth=true` })).status, 403);
  assert.equal((await fetch(`${origin}/decision`, { method: "POST", headers, body: `${body()}&decision=approve` })).status, 403);
  assert.equal((await fetch(`${origin}/decision`, { method: "POST", headers, body: body().replace(challenge, randomUUID()) })).status, 403);
  const approved = await fetch(`${origin}/decision`, { method: "POST", headers, body: body() });
  assert.equal(approved.status, 200); assert.match(await approved.text(), /APPROVED/);
  assert.equal((await fetch(`${origin}/decision`, { method: "POST", headers, body: body() })).status, 403);
  const done = await f.broker.execute(r.request.requestId); assert.equal(done.state, "SUCCEEDED");
  const journal = await readFile(join(f.options.directory, "receipts.jsonl"), "utf8");
  assert.equal(journal.includes(f.secret), false); assert.equal(journal.includes(session.toString("hex")), false);
});

test("MCP registry separates read-only tools from explicit Host actions; unconfigured execution stays blocked", async t => {
  const blocked = new Proxy({}, { get: () => { throw new Error("Unexpected lifecycle/JobStore access"); } });
  const runtime = { privilegedBroker: RemotePrivilegedBroker.notConfigured(), controller: blocked, store: blocked, conversations: blocked, textBundles: blocked, widgetHtml: "" } as unknown as BridgeRuntime;
  const server = createCodexBridgeMcpServer(runtime);
  const client = new Client({ name: "powershell-offline-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(b); await client.connect(a);
  const tools = (await client.listTools()).tools.filter(x => x.name.startsWith("codex_powershell_"));
  assert.deepEqual(tools.map(x => x.name).sort(), ["codex_powershell_host_preflight", "codex_powershell_job_preview",
    "codex_powershell_normal_execute", "codex_powershell_preview", "codex_powershell_receipt", "codex_powershell_status"]);
  for (const tool of tools) {
    const effectful = ["codex_powershell_host_preflight", "codex_powershell_normal_execute"].includes(tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations?.readOnlyHint, !effectful);
    assert.equal(tool.annotations?.idempotentHint, !effectful);
    assert.equal(tool.annotations?.destructiveHint, tool.name === "codex_powershell_normal_execute");
  }
  const execution = await client.callTool({ name: "codex_powershell_normal_execute", arguments: {
    requestId: randomUUID(), digest: "a".repeat(64), userIntent: "EXPLICIT_USER_EXECUTION_REQUEST",
  } });
  assert.equal(execution.isError, true);
  assert.match(JSON.stringify(execution.structuredContent), /REVIEW_UNAVAILABLE/);
  const status = await client.callTool({ name: "codex_powershell_status", arguments: {} });
  assert.equal((status.structuredContent as Record<string, unknown>).enabled, false);
  for (const mode of ["NORMAL", "ADMIN"]) {
    const preview = await client.callTool({ name: "codex_powershell_preview", arguments: { artifactId: "fixture.marker.v1", executionMode: mode } });
    assert.equal((preview.structuredContent as Record<string, unknown>).createsRequest, false);
  }
  for (const extra of [{ command: "whoami" }, { path: "C:\\" }, { env: {} }, { password: true }, { auth: true }, { source: "app" }]) {
    assert.equal((await client.callTool({ name: "codex_powershell_preview", arguments: { artifactId: "fixture.marker.v1", executionMode: "NORMAL", ...extra } })).isError, true);
  }
  for (const name of ["request", "approve", "execute", "review", "receipt_get"]) {
    assert.equal((await client.callTool({ name: `codex_powershell_${name}`, arguments: { auth: true } })).isError, true);
  }
});

test("HTTP targeted smoke: existing bearer boundary and no local review/execute route on Bridge", async t => {
  const blocked = new Proxy({}, { get: () => { throw new Error("Unexpected lifecycle access"); } });
  const runtime = { privilegedBroker: RemotePrivilegedBroker.notConfigured(), controller: blocked, store: blocked,
    conversations: blocked, textBundles: blocked, widgetHtml: "", close: async () => undefined } as unknown as BridgeRuntime;
  const token = randomBytes(32).toString("hex");
  const http = await startBridgeHttpServer(runtime, { host: "127.0.0.1", port: 0, bearerToken: token });
  const client = new Client({ name: "powershell-http-offline", version: "1" });
  t.after(async () => { await client.close(); await http.close(); });
  assert.equal((await fetch(http.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const status = await client.callTool({ name: "codex_powershell_status", arguments: {} });
  assert.equal((status.structuredContent as Record<string, unknown>).enabled, false);
  for (const path of ["/review", "/decision", "/powershell/execute"]) {
    assert.equal((await fetch(new URL(path, http.url), { method: "POST", headers: { authorization: `Bearer ${token}` } })).status, 404);
  }
});

function mockChild() {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid: 1234, stdout: new PassThrough(), stderr: new PassThrough() });
  let kills = 0;
  child.kill = () => { kills++; queueMicrotask(() => child.emit("close", null)); return true; };
  return { child, kills: () => kills };
}
test("G1 observer validates identity/PID/exit/marker and bounds timeout and combined output", async t => {
  const f = await fixture(t); const { approved } = await f.approved();
  const delivery: Receipt = { ...approved, state: "RUNNING" };
  validateDelivery(delivery);
  assert.throws(() => validateDelivery({ ...delivery, request: { ...delivery.request, executionMode: "ADMIN" } }));
  for (const scenario of ["valid", "sid", "pid", "elevated", "exit", "timeout", "output", "stderr", "malformed", "spawn"] as const) {
    const mock = mockChild();
    const promise = observeOfflineMarkerChild(mock.child, delivery, 20);
    if (scenario === "timeout") { await assert.rejects(promise, code("TIMEOUT")); assert.equal(mock.kills(), 1); continue; }
    if (scenario === "spawn") { mock.child.emit("error", new Error("private error")); await assert.rejects(promise, code("SPAWN_FAILED")); continue; }
    if (scenario === "output" || scenario === "stderr") {
      mock.child.stdout!.emit("data", Buffer.alloc(OUTPUT_LIMIT));
      (scenario === "stderr" ? mock.child.stderr! : mock.child.stdout!).emit("data", Buffer.from("x"));
      await assert.rejects(promise, code("OUTPUT_LIMIT")); assert.equal(mock.kills(), 1); continue;
    }
    const output = { marker: "CODEX_NORMAL_SYNTHETIC_V1", sid: scenario === "sid" ? "S-1-5-99" : SID,
      elevated: scenario === "elevated", pid: scenario === "pid" ? 999 : 1234 };
    mock.child.stdout!.emit("data", Buffer.from(scenario === "malformed" ? "not json" : JSON.stringify(output)));
    mock.child.emit("close", scenario === "exit" ? 1 : 0);
    if (scenario === "valid") assert.equal((await promise).outcome, "SUCCEEDED");
    else await assert.rejects(promise);
  }
});

test("G1 local inherited fixed PowerShell marker E2E (never out-of-job or host authorization)", { skip: process.platform !== "win32" }, async t => {
  // Read current SID using a fixed OS utility; it is never a model argument or credential.
  const identity = await promisify(execFile)("C:\\Windows\\System32\\whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true });
  const sid = /S-1-5-(?:\d+-)*\d+/.exec(identity.stdout)?.[0]; assert(sid);
  const f = await fixture(t, runOfflineNormalMarker, sid);
  const { approved } = await f.approved();
  const done = await f.broker.execute(approved.request.requestId);
  // This test requires actual NORMAL success; an elevated/restricted host must be reported as blocked.
  assert.equal(done.state, "SUCCEEDED", done.runnerError ?? done.reason);
  assert.equal(done.result?.evidence, "LOCAL_INHERITED_PROCESS");
  assert.equal(done.result?.ownership, "INHERITED_NOT_HOST_ACCEPTED");
  assert.equal(done.result?.sid, sid); assert.equal(done.result?.elevated, false);
  assert.equal(f.calls(), 1);
  t.diagnostic(`evidence=LOCAL_INHERITED_PROCESS; state=${done.state}; protectedHost=UNVERIFIED; externalAuthorization=OFF`);
});
