import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createCodexBridgeMcpServer } from "../src/server.js";
import type { BridgeRuntime } from "../src/runtime.js";
import type { BridgeConfig } from "../src/config.js";
import { JobStore } from "../src/job-store.js";
import { previewWorkPackage } from "../src/work-package.js";
import { ApprovalStore } from "../src/powershell-approval/store.js";
import { ApprovalError, digest, parse, requireProductionHost } from "../src/powershell-approval/contract.js";
import { REVIEW_KIND, REVIEW_TTL_MS, reviewInputSchema, reviewReceiptSchema, type ReviewInput } from "../src/powershell-approval/review-contract.js";

const LEGACY_REVIEW_URI = "ui://codex-bridge/powershell-review-v1.html";
const forbidden = new Proxy({}, { get() { throw new Error("Execution capability accessed"); } });
const errorCode = (code: string) => (error: unknown) => error instanceof ApprovalError && error.code === code;
function assertSafeError(response: CallToolResult, code: string) {
  assert.equal(response.isError, true);
  assert.deepEqual(response.content, [{ type: "text", text: `Review unavailable; error.code=${code}; no execution or authorization.` }]);
  assert.deepEqual(response.structuredContent, { error: { code }, executionDispatched: false,
    productionAuthorized: false, executionPolicy: { NORMAL: "OFF", ADMIN: "OFF" } });
}
async function fixture(t: TestContext) {
  const base = resolve(".tmp", "powershell-review-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "run-")), project = { id: "personal", name: "Personal", path: join(root, "project") };
  await mkdir(project.path);
  const jobs = new JobStore(join(root, "jobs"), join(root, "handoff")); await jobs.initialize();
  const directory = join(root, "powershell-approval");
  let store = await ApprovalStore.open(directory);
  const preview = previewWorkPackage({ projectId: project.id, title: "Review source fixture", objective: "Review only", dataClassification: "personal" });
  const { record } = await jobs.create({ project, workPackage: preview.workPackage, previewDigest: preview.previewDigest, idempotencyKey: randomUUID() });
  await jobs.setTurn(record.id, "turn-actual");
  const connections: Array<{ client: Client; server: ReturnType<typeof createCodexBridgeMcpServer> }> = [];
  async function connect() {
    const runtime = { store: jobs, approvalStore: store, config: { projects: new Map([[project.id, project]]) },
      widgetHtml: "", controller: forbidden, privilegedBroker: forbidden, conversations: forbidden, textBundles: forbidden } as unknown as BridgeRuntime;
    const server = createCodexBridgeMcpServer(runtime), client = new Client({ name: "review-protocol-fixture", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a); connections.push({ client, server });
    return client;
  }
  t.after(async () => {
    for (const connection of connections) { await connection.client.close(); await connection.server.close(); }
    await store.close();
  });
  const client = await connect();
  const candidate = (patch: Partial<ReviewInput> = {}): ReviewInput => ({ origin: "DIRECT", projectId: project.id, dataClassification: "personal",
    userIntent: "EXPLICIT_USER_REQUEST", contentPolicy: "PERSONAL_PUBLIC_NO_SECRETS_OR_REGULATED_ORDERS", idempotencyKey: randomUUID(),
    target: "personal source inspection", executionMode: "NORMAL", cwd: project.path, scriptSnapshot: "# proposal only\r\nWrite-Output 'review'\r\n",
    args: ["literal value"], risk: "No action in this review", sideEffects: "None from review", ...patch });
  const call = async (operation: string, args: object, caller = client) => await caller.callTool({
    name: "codex_powershell_review_" + operation, arguments: args as Record<string, unknown>,
  }) as CallToolResult;
  const request = async (patch: Partial<ReviewInput> = {}) => {
    const input = candidate(patch), response = await call("request", input);
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const summary = response.structuredContent!;
    return { input, response, summary, binding: { requestId: summary.requestId as string, digest: summary.digest as string } };
  };
  return { root, directory, project, jobs, jobId: record.id, client, candidate, call, request, get store() { return store; }, connect,
    restart: async () => { await store.close(); store = await ApprovalStore.open(directory); return connect(); } };
}

test("real Bridge MCP exposes strict model-visible review tools without a resource; native approvals stay app-only", async t => {
  const f = await fixture(t), listed = (await f.client.listTools()).tools;
  const tool = (name: string) => listed.find(t => t.name === "codex_powershell_review_" + name)!;
  for (const name of ["request", "get", "decide", "receipt"]) {
    assert.equal(tool(name)._meta, undefined);
    assert.deepEqual(tool(name).annotations, { readOnlyHint: ["get", "receipt"].includes(name),
      destructiveHint: name === "decide", idempotentHint: true, openWorldHint: false });
    assert.equal(tool(name).inputSchema.additionalProperties, false);
  }
  assert.deepEqual(tool("get").inputSchema.required, ["requestId", "digest"]);
  assert.deepEqual(tool("decide").inputSchema.required, ["requestId", "digest", "decision", "userIntent"]);
  assert.deepEqual(tool("receipt").inputSchema.required, ["requestId"]);
  const props = tool("decide").inputSchema.properties as Record<string, { enum?: string[]; const?: string }>;
  assert.deepEqual(props.decision!.enum, ["ACCEPTED", "DECLINED"]);
  assert.equal(props.userIntent!.const, "EXPLICIT_USER_DECISION");
  assert.match(tool("decide").description!, /separate explicit user instruction/);
  assert.match(tool("decide").description!, /Host confirmation is not guaranteed/);
  const resources = (await f.client.listResources()).resources;
  assert.equal(resources.some(r => r.uri === LEGACY_REVIEW_URI), false);
  await assert.rejects(f.client.readResource({ uri: LEGACY_REVIEW_URI }));
  assert.ok(resources.some(r => r.name === "codex-console"));
  assert.deepEqual((listed.find(t => t.name === "codex_approval_decide")!._meta?.ui as { visibility: string[] }).visibility, ["app"]);
});

test("DIRECT and CODEX_DERIVED accept/decline across distinct MCP sessions with exact model-visible preview", async t => {
  const f = await fixture(t);
  for (const origin of ["DIRECT", "CODEX_DERIVED"] as const) for (const decision of ["ACCEPTED", "DECLINED"] as const) {
    const r = await f.request({ origin, executionMode: origin === "DIRECT" ? "NORMAL" : "ADMIN",
      ...(origin === "CODEX_DERIVED" ? { jobId: f.jobId, turnId: "turn-actual" } : {}) });
    assert.doesNotMatch(JSON.stringify(r.response), /scriptSnapshot|literal value|Write-Output/);
    const path = join(f.directory, "receipts.jsonl"), before = await readFile(path, "utf8");
    const view = await f.call("get", r.binding, await f.connect());
    assert.notEqual(view.isError, true);
    assert.equal(view._meta, undefined);
    const original = view.structuredContent!.request as ReviewInput;
    for (const field of ["scriptSnapshot", "args", "cwd", "target", "executionMode", "risk", "sideEffects"] as const)
      assert.deepEqual(original[field], r.input[field]);
    assert.equal("jobId" in original, origin === "CODEX_DERIVED");
    assert.equal(view.structuredContent!.digest, r.binding.digest);
    assert.equal(view.structuredContent!.ttlMs, REVIEW_TTL_MS);
    assert.equal(view.structuredContent!.expiresAt, r.summary.expiresAt);
    assert.equal(digest(original), r.binding.digest);
    assert.deepEqual(JSON.parse((view.content[0] as { text: string }).text), view.structuredContent);
    assert.equal(await readFile(path, "utf8"), before);
    const decided = await f.call("decide", { ...r.binding, userIntent: "EXPLICIT_USER_DECISION", decision }, await f.connect());
    assert.equal(decided.structuredContent?.reason, "REVIEW_" + decision + "_NONEXECUTABLE");
    const after = await readFile(path, "utf8");
    const receipt = await f.call("receipt", { requestId: r.binding.requestId }, await f.connect());
    assert.deepEqual(receipt, decided);
    assert.equal(await readFile(path, "utf8"), after);
    assert.equal(receipt.structuredContent?.executionDispatched, false);
    assert.equal(receipt.structuredContent?.productionAuthorized, false);
    assert.deepEqual(receipt.structuredContent?.executionPolicy, { NORMAL: "OFF", ADMIN: "OFF" });
    assert.equal(receipt.structuredContent?.permissionAttribution, "UNVERIFIED");
    assert.doesNotMatch(JSON.stringify(receipt), /scriptSnapshot|Write-Output|literal value|cwd/);
    assert.deepEqual(f.store.list(), []); assert.deepEqual(f.store.listProduction(), []);
    assert.equal(f.store.get(r.binding.requestId), undefined); assert.equal(f.store.getProduction(r.binding.requestId), undefined);
  }
  assert.throws(() => requireProductionHost(), errorCode("BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED"));
});

test("strict MCP schema rejects malformed, forged authority, mixed origins and sensitive text without persisting", async t => {
  const f = await fixture(t), base = f.candidate();
  const bad = [{}, { ...base, origin: "OTHER" }, { ...base, jobId: f.jobId }, { ...base, origin: "CODEX_DERIVED" },
    { ...base, userIntent: "INFERRED" }, { ...base, contentPolicy: "company_approved" }, { ...base, dataClassification: "company_approved" },
    { ...base, productionAuthorized: true }, { ...base, trusted: true }, { ...base, host: {} }, { ...base, grant: {} },
    { ...base, ttlMs: 1 }, { ...base, scriptSnapshot: "x".repeat(8001) }, { ...base, args: ["-Password", "DO_NOT_STORE"] },
    { ...base, scriptSnapshot: "$api_key = 'DO_NOT_STORE'" }, { ...base, scriptSnapshot: "Write-Output sk-abcdefghijklmnopqrst" },
    { ...base, scriptSnapshot: "broker.execute('live')" }, { ...base, scriptSnapshot: "Write-Output \u202esecret" }];
  for (const args of bad) assert.equal((await f.call("request", args)).isError, true);
  assert.equal(await readFile(join(f.directory, "receipts.jsonl"), "utf8"), "");
});

test("valid UUID reaches review; schema, scope and store failures remain distinct and safe", async t => {
  const f = await fixture(t), input = f.candidate({ idempotencyKey: "c930eb1c-178d-48d3-8ea3-e6cc8b834350",
    target: "powershell.exe", scriptSnapshot: "Write-Output 'CODEX_BRIDGE_REVIEW_WINDOW_TEST_OK'", args: [] });
  assert.deepEqual(parse(reviewInputSchema, input), input);
  const invalid = { ...input, idempotencyKey: "not-a-uuid" };
  assert.throws(() => parse(reviewInputSchema, invalid), errorCode("INVALID_INPUT"));
  const schemaError = await f.call("request", invalid);
  assert.equal(schemaError.isError, true);
  assert.equal(schemaError.structuredContent, undefined); // SDK rejects before safe()/handler.
  assert.match(JSON.stringify(schemaError.content), /Input validation error.*Invalid uuid/);
  assertSafeError(await f.call("request", { ...input, projectId: "unknown" }), "REVIEW_SCOPE_REJECTED");
  assert.equal(await readFile(join(f.directory, "receipts.jsonl"), "utf8"), "");
  const accepted = await f.call("request", input);
  assert.notEqual(accepted.isError, true);
  assert.equal(accepted.structuredContent?.reason, "REVIEW_PENDING_NONEXECUTABLE");
  const before = await readFile(join(f.directory, "receipts.jsonl"), "utf8");
  for (const failure of [new ApprovalError("INVALID_INPUT"), new ApprovalError("STORE_UNAVAILABLE"),
    new Error("private-path credential stack"), new ApprovalError("private-path credential stack"),
    new ApprovalError("PRIVATE_CREDENTIAL")]) {
    const mock = t.mock.method(f.store, "createReview", async () => { throw failure; });
    try {
      assertSafeError(await f.call("request", input), failure instanceof ApprovalError
        && ["INVALID_INPUT", "STORE_UNAVAILABLE"].includes(failure.code) ? failure.code : "REVIEW_UNAVAILABLE");
    } finally { mock.mock.restore(); }
  }
  assert.equal(await readFile(join(f.directory, "receipts.jsonl"), "utf8"), before);
});

test("decision requires separate explicit intent; absent call leaves PENDING, never a persisted decline", async t => {
  const f = await fixture(t), r = await f.request(), path = join(f.directory, "receipts.jsonl");
  await f.call("get", r.binding, await f.connect());
  const before = await readFile(path, "utf8");
  for (const decision of ["ACCEPTED", "DECLINED"]) {
    for (const intent of [{}, { userIntent: "EXPLICIT_USER_REQUEST" }, { userIntent: "INFERRED" }, { userIntent: false }])
      assert.equal((await f.call("decide", { ...r.binding, decision, ...intent }, await f.connect())).isError, true);
  }
  // No tool call models an unavailable/cancelled host modal, not evidence of a real modal.
  assert.equal((await f.call("receipt", { requestId: r.binding.requestId })).structuredContent?.state, "PENDING");
  assert.equal(await readFile(path, "utf8"), before);
  const declined = await f.call("decide", { ...r.binding, decision: "DECLINED", userIntent: "EXPLICIT_USER_DECISION" }, await f.connect());
  assert.equal(declined.structuredContent?.reason, "REVIEW_DECLINED_NONEXECUTABLE");
});

test("unknown binding and mismatched digest reject without writes or proposal disclosure", async t => {
  const f = await fixture(t), r = await f.request(), path = join(f.directory, "receipts.jsonl");
  const before = await readFile(path, "utf8");
  for (const operation of ["get", "decide", "receipt"]) {
    const unknown = { requestId: randomUUID(), ...(operation === "receipt" ? {} : { digest: r.binding.digest }),
      ...(operation === "decide" ? { decision: "ACCEPTED", userIntent: "EXPLICIT_USER_DECISION" } : {}) };
    const response = await f.call(operation, unknown, await f.connect());
    assert.equal((response.structuredContent?.error as { code: string }).code, "REQUEST_UNKNOWN");
    assert.doesNotMatch(JSON.stringify(response), /scriptSnapshot|Write-Output|literal value/);
  }
  for (const operation of ["get", "decide"]) {
    const response = await f.call(operation, { ...r.binding, digest: "0".repeat(64),
      ...(operation === "decide" ? { decision: "ACCEPTED", userIntent: "EXPLICIT_USER_DECISION" } : {}) });
    assert.equal((response.structuredContent?.error as { code: string }).code, "DIGEST_MISMATCH");
  }
  assert.equal(await readFile(path, "utf8"), before);
});

test("scope checks use real JobStore and reject wrong project, job, turn, history and cwd", async t => {
  const f = await fixture(t), base = f.candidate({ origin: "CODEX_DERIVED", jobId: f.jobId, turnId: "turn-actual" });
  for (const patch of [{ jobId: randomUUID() }, { projectId: "unknown" }, { turnId: "turn-forged" }, { cwd: f.root },
    { cwd: "relative" }, { cwd: join(f.project.path, "missing") }, { dataClassification: "public" }])
    assert.equal((await f.call("request", { ...base, ...patch })).isError, true);
  const company = previewWorkPackage({ projectId: f.project.id, title: "Synthetic classification", objective: "No company payload", dataClassification: "company_approved" });
  const created = await f.jobs.create({ project: f.project, workPackage: company.workPackage, previewDigest: company.previewDigest, idempotencyKey: randomUUID() });
  await f.jobs.setTurn(created.record.id, "turn-company");
  assert.equal((await f.call("request", { ...base, jobId: created.record.id, turnId: "turn-company" })).isError, true);
  const r = await f.request({ origin: "CODEX_DERIVED", jobId: f.jobId, turnId: "turn-actual" });
  await f.call("get", r.binding);
  await f.jobs.setTurn(f.jobId, "turn-new");
  const before = await readFile(join(f.directory, "receipts.jsonl"), "utf8");
  assert.equal((await f.call("get", r.binding, await f.connect())).isError, true);
  assert.equal((await f.call("decide", { ...r.binding, userIntent: "EXPLICIT_USER_DECISION", decision: "ACCEPTED" })).isError, true);
  assert.equal((await f.call("receipt", { requestId: r.binding.requestId })).structuredContent?.state, "PENDING");
  assert.equal(await readFile(join(f.directory, "receipts.jsonl"), "utf8"), before);
});

test("idempotency is atomic, immutable and never extends TTL; digest mismatch and extra decision flags reject", async t => {
  const f = await fixture(t), input = f.candidate();
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.call("request", input)));
  responses.forEach(r => assert.deepEqual(r, responses[0]));
  const summary = responses[0]!.structuredContent!, binding = { requestId: summary.requestId, digest: summary.digest };
  for (const patch of [{ scriptSnapshot: input.scriptSnapshot + "\n" }, { executionMode: "ADMIN" }, { args: [] }, { risk: "other" }])
    assert.equal((await f.call("request", { ...input, ...patch })).isError, true);
  assert.equal((await f.call("get", { ...binding, digest: "0".repeat(64) })).isError, true);
  await f.call("get", binding);
  for (const patch of [{ digest: "0".repeat(64) }, { productionAuthorized: true }, { decision: "APPROVED" }, { human: true }, { execute: true }])
    assert.equal((await f.call("decide", { ...binding, userIntent: "EXPLICIT_USER_DECISION", decision: "ACCEPTED", ...patch })).isError, true);
  assert.equal((await f.call("receipt", { requestId: binding.requestId })).structuredContent?.state, "PENDING");
  assert.equal((await readFile(join(f.directory, "receipts.jsonl"), "utf8")).trim().split("\n").length, 1);
});

test("concurrent opposing decisions commit once; exact replay stays identical and other replay rejects", async t => {
  const f = await fixture(t), r = await f.request(); await f.call("get", r.binding);
  const callers = await Promise.all([f.connect(), f.connect()]);
  const decisions = await Promise.all(["ACCEPTED", "DECLINED"].map((decision, index) => f.call("decide", {
    ...r.binding, userIntent: "EXPLICIT_USER_DECISION", decision,
  }, callers[index])));
  assert.equal(decisions.filter(r => r.isError).length, 1);
  assert.equal((decisions.find(r => r.isError)!.structuredContent!.error as { code: string }).code, "REVIEW_ALREADY_DECIDED");
  const winner = decisions.find(r => !r.isError)!;
  assert.deepEqual(await f.call("decide", { ...r.binding, userIntent: "EXPLICIT_USER_DECISION", decision: winner.structuredContent!.state }), winner);
  const freshConnection = await f.connect();
  assert.deepEqual(await f.call("decide", { ...r.binding, userIntent: "EXPLICIT_USER_DECISION", decision: winner.structuredContent!.state }, freshConnection), winner);
  const lines = (await readFile(join(f.directory, "receipts.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  let previous = "GENESIS";
  for (const [i, line] of lines.entries()) { const { hash, ...entry } = JSON.parse(line); assert.equal(entry.seq, i + 1); assert.equal(entry.previous, previous); assert.equal(digest(entry), hash); previous = hash; }
});

test("normal reopen preserves accepted/declined/pending decisions and original bytes; exclusive owner lock", async t => {
  const f = await fixture(t), records = [];
  for (const decision of ["ACCEPTED", "DECLINED", "PENDING"]) {
    const r = await f.request(); records.push({ r, decision }); await f.call("get", r.binding);
    if (decision !== "PENDING") assert.notEqual((await f.call("decide", { ...r.binding, userIntent: "EXPLICIT_USER_DECISION", decision })).isError, true);
  }
  await assert.rejects(ApprovalStore.open(f.directory), errorCode("STORE_LOCKED"));
  const before = await readFile(join(f.directory, "receipts.jsonl"), "utf8"), client = await f.restart();
  for (const { r, decision } of records) {
    assert.equal((await f.call("receipt", { requestId: r.binding.requestId }, client)).structuredContent?.state, decision);
    const original = await f.store.readReview(r.binding.requestId);
    assert.equal(original.request.scriptSnapshot, r.input.scriptSnapshot);
    assert.equal(original.digest, r.binding.digest);
  }
  assert.equal(await readFile(join(f.directory, "receipts.jsonl"), "utf8"), before);
  const pending = records[2]!.r;
  await f.call("get", pending.binding, client);
  assert.equal((await f.call("decide", { ...pending.binding, userIntent: "EXPLICIT_USER_DECISION", decision: "DECLINED" }, client)).structuredContent?.state, "DECLINED");
});

test("expiration is durable on decide and restart, cannot decide or renew via retry", async t => {
  const f = await fixture(t), r = await f.request(); await f.call("get", r.binding);
  const at = r.summary.expiresAt as number;
  const clock = t.mock.method(Date, "now", () => at);
  const rejected = await f.call("decide", { ...r.binding, userIntent: "EXPLICIT_USER_DECISION", decision: "ACCEPTED" }, await f.connect());
  assert.equal((rejected.structuredContent?.error as { code: string }).code, "TTL_EXPIRED");
  const expired = await f.call("receipt", { requestId: r.binding.requestId });
  assert.equal(expired.structuredContent?.state, "EXPIRED");
  assert.equal((await f.call("request", r.input)).structuredContent?.expiresAt, at);
  assert.equal((await f.call("request", r.input)).structuredContent?.state, "EXPIRED");
  clock.mock.restore();
  // New isolated store, with only local fixture time advanced before opening.
  const g = await fixture(t), pending = await g.request();
  t.mock.method(Date, "now", () => (pending.summary.expiresAt as number) + 1);
  const client = await g.restart();
  assert.equal((await g.call("receipt", { requestId: pending.binding.requestId }, client)).structuredContent?.state, "EXPIRED");
});

test("review journal rejects forged execution/grants, mutation, tampered chain and torn tail", async t => {
  const f = await fixture(t), r = await f.request(), receipt = await f.store.readReview(r.binding.requestId);
  for (const patch of [{ kind: "PRODUCTION" }, { productionAuthorized: true }, { executionDispatched: true }, { grant: {} },
    { state: "APPROVED" }, { executionPolicy: { NORMAL: "ON", ADMIN: "OFF" } }])
    assert.equal(reviewReceiptSchema.safeParse({ ...receipt, ...patch }).success, false);
  receipt.request.scriptSnapshot = "mutated caller copy";
  assert.equal((await f.store.readReview(r.binding.requestId)).request.scriptSnapshot, r.input.scriptSnapshot);
  await assert.rejects(f.store.decideReview(r.binding.requestId, "0".repeat(64), "ACCEPTED"), errorCode("DIGEST_MISMATCH"));
  await f.store.close();
  const path = join(f.directory, "receipts.jsonl"), original = await readFile(path, "utf8");
  await writeFile(path, original.slice(0, -1));
  await assert.rejects(ApprovalStore.open(f.directory), errorCode("STORE_CORRUPT"));
  await writeFile(path, original.replace('"seq":1', '"seq":2'));
  await assert.rejects(ApprovalStore.open(f.directory), errorCode("STORE_CORRUPT"));
});

test("source boundary has no review execution capability and runtime owns exactly one journal", async () => {
  for (const path of ["review-contract.ts", "review-tools.ts"]) {
    const source = await readFile(join("src", "powershell-approval", path), "utf8");
    assert.doesNotMatch(source, /(?:from\s+["'].*(?:child_process|broker|runner|operator|native|password)|\.execute\(|\.dispatch\(|\.spawn\()/);
  }
  const runtime = await readFile(join("src", "runtime.ts"), "utf8");
  const initializer = await readFile(join("src", "powershell-approval", "review-runtime.ts"), "utf8");
  const tools = await readFile(join("src", "powershell-approval", "review-tools.ts"), "utf8");
  assert.doesNotMatch(initializer + tools + runtime, /powershell-review\.html|powershellReviewHtml|REVIEW_ASSET_UNAVAILABLE/);
  assert.doesNotMatch(tools, /registerAppResource|registerAppTool|resourceUri|widgetCSP|viewed\./);
  assert.equal((initializer.match(/ApprovalStore\.open\(/g) || []).length, 1);
  // The accepted cooperative lifecycle now closes all owners with closeResources;
  // the old finally-only spelling predates that change. Runtime tests below verify
  // the lock actually closes, independently of this source boundary check.
  assert.match(runtime, /closeResources\(\[/);
  assert.match(runtime, /await review\.approvalStore\.close\(\)/);
  assert.equal(REVIEW_KIND, "REVIEW_ONLY_NONEXECUTABLE"); assert.equal(REVIEW_TTL_MS, 600000);
});

test("request-first MCP reads the same DIRECT request across sessions without touching JobStore or writing", async t => {
  const f = await fixture(t), r = await f.request();
  const tool = (await f.client.listTools()).tools.find(tool => tool.name === "codex_powershell_receipt")!;
  assert.deepEqual(tool.inputSchema.required, ["requestId"]);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.equal(tool.annotations?.destructiveHint, false);
  const snapshot = t.mock.method(f.jobs, "snapshot", () => { throw new Error("DIRECT must not consult JobStore"); });
  const path = join(f.directory, "receipts.jsonl");
  for (const decision of [undefined, "ACCEPTED"] as const) {
    if (decision) await f.call("decide", { ...r.binding, decision, userIntent: "EXPLICIT_USER_DECISION" });
    const before = await readFile(path, "utf8");
    const response = await (await f.connect()).callTool({ name: tool.name, arguments: { requestId: r.binding.requestId } }) as CallToolResult;
    assert.notEqual(response.isError, true);
    const result = response.structuredContent!;
    assert.equal(result.kind, REVIEW_KIND); assert.equal(result.digest, r.binding.digest);
    assert.equal(result.origin, "DIRECT"); assert.equal(result.receiptId, r.summary.receiptId);
    assert.equal(result.osExecutionReceipt, null); assert.equal(result.productionEnabled, false);
    assert.equal((result.reviewOpinion as any).effectiveState, decision ?? "PENDING");
    assert.equal((result.correlation as any).job, "NOT_APPLICABLE");
    assert.equal("jobId" in (result.correlation as object), false);
    assert.equal(await readFile(path, "utf8"), before);
    assert.doesNotMatch(JSON.stringify(result), /scriptSnapshot|Write-Output|literal value|cwd|ceremonyId/);
  }
  assert.equal(snapshot.mock.callCount(), 0);
  for (const extra of [{ password: "not-accepted" }, { script: "Write-Output 'no'" }, { jobId: f.jobId }]) {
    assert.equal((await f.client.callTool({ name: tool.name, arguments: { requestId: r.binding.requestId, ...extra } })).isError, true);
  }
});

test("derived request saves exact bounded completion and keeps permission attribution unverified", async t => {
  const f = await fixture(t);
  await f.jobs.setThread(f.jobId, "thread-actual");
  const complete = async (exitCode: number) => f.jobs.applyConversationNotification(f.jobId, {
    method: "item/completed", params: { threadId: "thread-actual", turnId: "turn-actual",
      item: { id: "failed-command", type: "commandExecution", status: "completed", exitCode,
        command: "some original command", aggregatedOutput: "Access denied is text, not structured authority" } },
  });
  await complete(5);
  const r = await f.request({ origin: "CODEX_DERIVED", jobId: f.jobId, turnId: "turn-actual", sourceFailureItemId: "failed-command" });
  const stored = await f.store.readReview(r.binding.requestId), evidence = stored.request.sourceFailure!;
  assert.equal(evidence.jobId, f.jobId); assert.equal(evidence.projectId, f.project.id);
  assert.equal(evidence.threadId, "thread-actual"); assert.equal(evidence.itemId, "failed-command");
  assert.equal(evidence.exitCode, 5); assert.equal(evidence.permissionAttribution, "UNVERIFIED");
  assert.equal(evidence.cause, "UNKNOWN");
  const preview = await f.client.callTool({ name: "codex_powershell_job_preview", arguments: { jobId: f.jobId } }) as CallToolResult;
  assert.deepEqual((preview.structuredContent!.commandFailureDiagnostics as any).failures[0].sourceFailure, evidence);
  const receipt = async () => await f.client.callTool({ name: "codex_powershell_receipt", arguments: { requestId: r.binding.requestId } }) as CallToolResult;
  assert.equal(((await receipt()).structuredContent!.correlation as any).completion, "MATCHED_SAVED_COMPLETION");
  for (const patch of [{ sourceFailureItemId: "missing" }, { turnId: "other-turn" }, { jobId: randomUUID() }, { projectId: "other-project" }]) {
    const rejected = await f.call("request", f.candidate({ origin: "CODEX_DERIVED", jobId: f.jobId,
      turnId: "turn-actual", sourceFailureItemId: "failed-command", ...patch }));
    assert.equal(rejected.isError, true);
  }
  assert.equal((await f.call("request", { ...r.input, sourceFailure: evidence })).isError, true);
  assert.equal((await f.call("request", f.candidate({ sourceFailureItemId: "failed-command" }))).isError, true);
  // Exact persisted evidence changes cannot silently authorize a new decision.
  await complete(9);
  assertSafeError(await f.call("decide", { ...r.binding, decision: "ACCEPTED", userIntent: "EXPLICIT_USER_DECISION" }), "REVIEW_JOB_REJECTED");
  assert.equal(((await receipt()).structuredContent!.correlation as any).completion, "UNVERIFIED");
  await complete(5);
  await f.jobs.setTurn(f.jobId, "next-turn");
  const before = await readFile(join(f.directory, "receipts.jsonl"), "utf8"), historical = (await receipt()).structuredContent!;
  assert.equal((historical.correlation as any).currentTurnMatches, false);
  assert.equal((historical.correlation as any).completion, "MATCHED_SAVED_COMPLETION");
  assert.equal(historical.osExecutionReceipt, null); assert.equal(historical.automaticResume, false);
  assert.equal((await f.call("decide", { ...r.binding, decision: "ACCEPTED", userIntent: "EXPLICIT_USER_DECISION" })).isError, true);
  assert.equal(await readFile(join(f.directory, "receipts.jsonl"), "utf8"), before);
  const restarted = await f.restart();
  assert.deepEqual((await f.store.readReview(r.binding.requestId)).request.sourceFailure, evidence);
  assert.equal((await restarted.callTool({ name: "codex_powershell_receipt", arguments: { requestId: r.binding.requestId } })).isError, undefined);
});

test("expired Receipt/Get are byte-for-byte read-only across sessions; explicit create materializes expiry", async t => {
  const f = await fixture(t), r = await f.request(), path = join(f.directory, "receipts.jsonl");
  const before = await readFile(path, "utf8");
  t.mock.method(Date, "now", () => r.summary.expiresAt as number);
  for (const operation of ["receipt", "get"]) {
    const response = await f.call(operation, operation === "get" ? r.binding : { requestId: r.binding.requestId }, await f.connect());
    assert.equal(response.structuredContent?.state, "PENDING");
    assert.equal(response.structuredContent?.effectiveState, "EXPIRED");
    assert.equal(response.structuredContent?.decisionAllowed, false);
    assert.equal(response.structuredContent?.revision, 1);
  }
  assert.equal((await f.store.readReview(r.binding.requestId)).state, "PENDING");
  const combined = await f.client.callTool({ name: "codex_powershell_receipt", arguments: { requestId: r.binding.requestId } }) as CallToolResult;
  assert.equal(combined.structuredContent?.state, "PENDING");
  assert.equal((combined.structuredContent?.reviewOpinion as any).effectiveState, "EXPIRED");
  assert.equal(combined.structuredContent?.osExecutionReceipt, null);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal((await f.call("request", r.input)).structuredContent?.state, "EXPIRED");
  assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 2);
});

test("runtime isolates locked/corrupt journal failures and enables review with missing/blank legacy HTML; never dispatches or repairs", async t => {
  // All subprocess APIs are tripwires. No installed Host, Codex, PowerShell or IPC is used.
  let executions = 0;
  const traps = ["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"] as const;
  for (const method of traps) t.mock.method(childProcess, method, () => { executions++; throw new Error("Subprocess forbidden"); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { createBridgeRuntime } = await import("../src/runtime.js");
  for (const failure of ["locked", "corrupt", "missing-asset", "blank-asset"] as const) {
    const f = await fixture(t);
    const assetCase = failure === "missing-asset" || failure === "blank-asset";
    if (failure !== "locked") await f.store.close();
    if (failure === "corrupt") await writeFile(join(f.directory, "receipts.jsonl"), "corrupt-tail");
    const original = await readFile(join(f.directory, "receipts.jsonl"), "utf8");
    let projectRoot = process.cwd();
    if (assetCase) {
      projectRoot = f.root; await mkdir(join(projectRoot, "web"));
      await writeFile(join(projectRoot, "web", "self-reload.html"), "<p>fixture</p>");
      if (failure === "blank-asset") await writeFile(join(projectRoot, "web", "powershell-review.html"), "");
    }
    const widgetPath = join(f.root, "widget.html"); await writeFile(widgetPath, "<p>existing console fixture</p>");
    const config: BridgeConfig = { projectRoot, projectsFile: join(f.root, "unused-projects.json"), projects: new Map([[f.project.id, f.project]]),
      dataDir: f.root, jobsDir: join(f.root, "jobs"), stagingDir: join(f.root, "staging"), handoffDir: join(f.root, "runtime-handoff"),
      widgetPath, codexCommand: "MUST_NOT_START", codexArgs: [], httpHost: "127.0.0.1", httpPort: 0,
      maxRecentJobs: 10, buildId: "source-review-test", codexHome: join(f.root, "isolated-home") };
    const runtime = await createBridgeRuntime(config);
    try {
      if (assetCase) assert.ok(runtime.approvalStore);
      else assert.equal(runtime.approvalStore, undefined);
      assert.equal(runtime.powershellReviewUnavailable, failure === "locked" ? "STORE_LOCKED" : failure === "corrupt" ? "STORE_CORRUPT" : undefined);
      const server = createCodexBridgeMcpServer(runtime), client = new Client({ name: "unavailable-review-fixture", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
      try {
        const status = await client.callTool({ name: "codex_job_get", arguments: { jobId: f.jobId } });
        assert.notEqual(status.isError, true);
        const request = await client.callTool({ name: "codex_powershell_review_request", arguments: f.candidate() }) as CallToolResult;
        const receipt = await client.callTool({ name: "codex_powershell_receipt", arguments: {
          requestId: assetCase ? request.structuredContent!.requestId : randomUUID(),
        } }) as CallToolResult;
        if (assetCase) {
          assert.notEqual(receipt.isError, true);
          assert.equal(receipt.structuredContent?.kind, REVIEW_KIND);
        } else {
          assert.equal(receipt.isError, true);
          assert.equal((receipt.structuredContent?.error as any).code, "RECEIPT_SOURCE_UNAVAILABLE");
        }
        if (assetCase) {
          assert.notEqual(request.isError, true);
          assert.equal(request.structuredContent?.reason, "REVIEW_PENDING_NONEXECUTABLE");
          assert.deepEqual(request.structuredContent?.executionPolicy, { NORMAL: "OFF", ADMIN: "OFF" });
          assert.ok(runtime.powershellHost);
          const view = await client.callTool({ name: "codex_powershell_review_get", arguments: {
            requestId: request.structuredContent!.requestId, digest: request.structuredContent!.digest,
          } }) as CallToolResult;
          assert.equal((view.structuredContent?.hostAdmission as any).humanApproval, "LOCAL_HOST_CONFIRMATION_REQUIRED");
          assert.equal((view.structuredContent?.hostAdmission as any).executionDispatched, false);
        } else {
          assertSafeError(request, runtime.powershellReviewUnavailable!);
          for (const operation of ["get", "decide", "receipt"]) {
            const response = await client.callTool({ name: "codex_powershell_review_" + operation,
              arguments: { requestId: randomUUID(), ...(operation === "receipt" ? {} : { digest: "0".repeat(64) }),
                ...(operation === "decide" ? { decision: "ACCEPTED", userIntent: "EXPLICIT_USER_DECISION" } : {}) } }) as CallToolResult;
            assertSafeError(response, runtime.powershellReviewUnavailable!);
          }
        }
        assert.equal((await client.listResources()).resources.some(r => r.uri === LEGACY_REVIEW_URI), false);
        await assert.rejects(client.readResource({ uri: LEGACY_REVIEW_URI }));
        assert.ok((await client.listTools()).tools.some(tool => tool.name === "codex_job_preview"));
      } finally { await client.close(); await server.close(); }
    } finally { await runtime.close(); }
    const after = await readFile(join(f.directory, "receipts.jsonl"), "utf8");
    if (assetCase) assert.equal(after.trim().split("\n").length, 1);
    else assert.equal(after, original);
  }
  assert.equal(executions, 0);
});
