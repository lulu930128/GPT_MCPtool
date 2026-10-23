import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JobStore } from "../src/job-store.js";
import type { JobRecord } from "../src/types.js";
import { ApprovalStore } from "../src/powershell-approval/store.js";
import { projectProductionApprovalResult as project, projectRequestReceipt } from "../src/powershell-approval/job-projection.js";
import { registerPowerShellReceiptTools } from "../src/powershell-approval/receipt-tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApprovalError, digest, sha256, PRODUCTION_POLICY, TTL_MS, RECEIPT_TTL_MS,
  productionRequestSchema, productionBindingOf, productionJournalReceiptSchema,
  requestSchema, receiptSchema, POLICY, MARKER_SCRIPT, RUN_TIMEOUT_MS, OUTPUT_LIMIT,
  type ProductionReceipt } from "../src/powershell-approval/contract.js";

const rejects = (code: string) => (error: unknown) => error instanceof ApprovalError && error.code === code;
// Inert, untrusted replay descriptions, NOT real identities, secrets or Host attestations.
function records(origin: "DIRECT" | "CODEX_DERIVED" = "DIRECT", job?: JobRecord) {
  const at = Date.now() - 1000, jobId = job?.id ?? randomUUID(), turnId = job?.turnId ?? "turn-data-only";
  const authority = { hostId: randomUUID(), instanceId: randomUUID(), sid: "S-1-5-21-1000",
    logonId: "0000000000000001", pid: 100, processStartedAt: at - 1000,
    imageSha256: sha256("untrusted identity description"), tokenId: "inert-description", integrity: "MEDIUM" as const };
  const evidence = (observedAt: number) => ({ source: "WINDOWS_HOST_PEER" as const,
    observationId: randomUUID(), channelBinding: sha256("untrusted channel"), observedAt, peer: authority });
  const request = productionRequestSchema.parse({ version: 2, evidence: "PRODUCTION", policy: PRODUCTION_POLICY,
    requestId: randomUUID(), receiptId: randomUUID(), idempotencyKey: randomUUID(), bootId: randomUUID(), origin,
    ...(origin === "DIRECT" ? {} : { jobId, turnId, failureEvidence: { source: "BRIDGE_CANONICAL_JOB_EVENT",
      eventId: randomUUID(), jobId, turnId, projectId: "projection", threadId: job?.threadId ?? "thread-data-only",
      itemId: "item-data-only", observedAt: at - 1, evidenceSha256: sha256("untrusted saved fault"),
      fault: { classification: "OS_PERMISSION", code: "OS_ACCESS_DENIED" } } }),
    projectId: "projection", executionMode: "NORMAL", target: "inert-target", scriptSnapshot: "# inert data only",
    scriptSha256: sha256("# inert data only"), scriptEncoding: "UTF8_EXACT", cwd: "C:\\inert-data",
    args: ["inert-private-argument"], environmentPolicyDigest: sha256("no environment"), sideEffects: "none", risk: "data only",
    createdAt: at, ttlMs: TTL_MS, expiresAt: at + TTL_MS, nonce: randomUUID(),
    approvalIdentity: { authority, subjectSid: authority.sid, ceremonyId: randomUUID(),
      interface: "CHATGPT_APP_ONLY", authentication: "FRESH_PASSWORD_EACH_REQUEST" },
    executorIdentity: authority, admission: evidence(at) });
  const proposed: ProductionReceipt = { request, digest: digest(request), state: "PROPOSED", reason: "CREATED", revision: 1, updatedAt: at };
  const binding = productionBindingOf(request);
  const approved: ProductionReceipt = { ...proposed, state: "APPROVED", reason: "HOST_APPROVED", revision: 2, updatedAt: at + 1,
    grant: { grantId: randomUUID(), binding, approvedAt: at + 1, approval: evidence(at + 1), osAuthorization: "WINDOWS_STANDARD_TOKEN" } };
  const consumed: ProductionReceipt = { ...approved, state: "CONSUMED", reason: "GRANT_CONSUMED", revision: 3, updatedAt: at + 2,
    consumption: { consumptionId: randomUUID(), grantId: approved.grant!.grantId, binding,
      consumedAt: at + 2, receiptDeadline: at + 2 + RECEIPT_TTL_MS, executor: evidence(at + 2) } };
  const completed: ProductionReceipt = { ...consumed, state: "SUCCEEDED", reason: "RECEIPT_INGESTED", revision: 4, updatedAt: at + 3,
    result: { grantId: approved.grant!.grantId, consumptionId: consumed.consumption!.consumptionId, binding,
      executor: evidence(at + 3), completedAt: at + 3, outcome: "SUCCEEDED", exitCode: 0, outputSha256: sha256("") } };
  return [proposed, approved, consumed, completed];
}
async function directory() {
  const root = join(process.cwd(), ".tmp", "powershell-projection-tests");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "projection-"));
}
async function journal(values: unknown[]) {
  const dir = await directory();
  let previous = "GENESIS";
  const lines = values.map((value, index) => {
    const receipt = productionJournalReceiptSchema.parse(value);
    const entry = { seq: index + 1, previous, receipt };
    previous = digest(entry);
    return JSON.stringify({ ...entry, hash: previous });
  });
  const path = join(dir, "receipts.jsonl");
  await writeFile(path, lines.join("\n") + "\n", "utf8");
  return { dir, path };
}
async function saved(t: TestContext, values: unknown[]) {
  const { dir, path } = await journal(values);
  const store = await ApprovalStore.open(dir);
  t.after(() => store.close());
  return { store, path };
}
async function jobFixture() {
  const jobs = new JobStore(await directory());
  await jobs.initialize();
  const { record } = await jobs.create({ idempotencyKey: randomUUID(), previewDigest: sha256("inert job"),
    project: { id: "projection", name: "inert job", path: process.cwd() }, workPackage: {
      projectId: "projection", title: "inert job", objective: "no execution", context: "",
      acceptanceCriteria: [], constraints: [], executionMode: "plan", approvalReviewer: "user",
      dataClassification: "personal", inputBundleIds: [] } });
  await jobs.setThread(record.id, "thread-data-only");
  await jobs.setTurn(record.id, "turn-data-only");
  return { jobs, job: jobs.get(record.id)! };
}
function nonExecuting(value: ReturnType<typeof project>) {
  assert.equal(value.evidence, "SAVED_JOURNAL_ONLY");
  assert.equal(value.hostAcceptance, "UNVERIFIED");
  assert.equal(value.osSideEffects, "UNVERIFIED");
  assert.equal(value.businessSuccess, "UNVERIFIED");
  assert.equal(value.productionEnabled, false);
  assert.equal(value.automaticResume, false);
  assert.equal(value.retryAllowed, false);
}

test("DIRECT: canonical saved receipt, bounded output, no JobStore or journal mutation", async t => {
  const values = records(), last = values.at(-1)!, { store, path } = await saved(t, values);
  const before = await readFile(path, "utf8"), stored = store.getProduction(last.request.requestId);
  const output = project(store, last.request.requestId, { get: () => { throw new Error("DIRECT must not read jobs"); } });
  assert.equal(output.origin, "DIRECT"); assert.equal(output.requestId, last.request.requestId);
  assert.equal(output.receiptId, last.request.receiptId); assert.equal(output.digest, last.digest);
  assert.equal(output.state, "SUCCEEDED"); assert.equal(output.reason, "RECEIPT_INGESTED");
  assert.equal(output.executionMode, "NORMAL");
  assert.deepEqual(output.result, { outcome: "SUCCEEDED", exitCode: 0, outputSha256: sha256("") });
  assert.equal("jobId" in output, false); assert.equal("projectId" in output, false);
  assert.equal(Object.isFrozen(output), true); assert.equal(Object.isFrozen(output.result), true);
  assert.doesNotMatch(JSON.stringify(output), /script|inert-|args|cwd|authority|executor|admission|password|token|"sid"|hostId|grantId/i);
  nonExecuting(output);
  assert.deepEqual(project(store, last.request.requestId), output);
  assert.deepEqual(store.getProduction(last.request.requestId), stored);
  assert.equal(await readFile(path, "utf8"), before);
});

test("CODEX_DERIVED: exact canonical JobStore read correlates saved provenance without changing job", async t => {
  const { jobs, job } = await jobFixture(), values = records("CODEX_DERIVED", job);
  const { store, path } = await saved(t, values), request = values[0].request;
  const before = jobs.get(job.id), journalBefore = await readFile(path, "utf8");
  let reads = 0;
  const output = project(store, request.requestId, { get: id => { reads++; assert.equal(id, job.id); return jobs.get(id); } });
  assert.equal(reads, 1); assert.equal(output.origin, "CODEX_DERIVED");
  assert.equal(output.jobId, job.id); assert.equal(output.projectId, job.project.id);
  assert.equal(output.turnId, job.turnId); assert.equal(output.threadId, job.threadId);
  nonExecuting(output);
  assert.deepEqual(jobs.get(job.id), before); assert.equal(await readFile(path, "utf8"), journalBefore);
});

test("derived missing/mismatched job, project, turn, thread and unauthorized records reject without disclosure", async t => {
  const { job } = await jobFixture(), values = records("CODEX_DERIVED", job);
  const { store } = await saved(t, values), id = values[0].request.requestId;
  assert.throws(() => project(store, id), rejects("JOB_CORRELATION_REJECTED"));
  const candidates = [undefined, { ...job, id: randomUUID() }, { ...job, project: { ...job.project, id: "other" } },
    { ...job, turnId: "other" }, { ...job, turnId: undefined }, { ...job, threadId: "other" }, { ...job, threadId: "" },
    { ...job, workPackage: { ...job.workPackage, projectId: "other" } },
    { ...job, workPackage: { ...job.workPackage, dataClassification: "company_approved" as const } },
    { ...job, currentDataClassification: "company_approved" as const }];
  for (const candidate of candidates) {
    const before = structuredClone(candidate);
    assert.throws(() => project(store, id, { get: () => candidate }), rejects("JOB_CORRELATION_REJECTED"));
    assert.deepEqual(candidate, before);
  }
  assert.throws(() => project(store, id, { get: () => { throw new Error("inert-private-error"); } }), rejects("JOB_CORRELATION_REJECTED"));
  // A historical job may lack a thread field; the bound saved evidence still supplies it.
  assert.equal(project(store, id, { get: () => ({ ...job, threadId: undefined }) }).threadId, job.threadId);
});

test("UNKNOWN, failure, denial and restart expiry report saved state only, never retry or infer effects", async t => {
  for (const origin of ["DIRECT", "CODEX_DERIVED"] as const) {
    const { jobs, job } = await jobFixture();
    for (const phase of ["proposed", "approved", "consumed", "failed", "denied", "unknown-result"] as const) {
      const values = records(origin, job), last = values[3];
      let chain = values.slice(0, phase === "proposed" ? 1 : phase === "approved" ? 2 : 3);
      if (phase === "failed" || phase === "unknown-result") {
        const state = phase === "failed" ? "FAILED" : "UNKNOWN";
        chain.push({ ...last, state, result: { ...last.result!, outcome: state, exitCode: phase === "failed" ? 5 : null } });
      } else if (phase === "denied") {
        chain = [values[0], { ...values[0], state: "DENIED", reason: "HOST_DENIED", revision: 2,
          updatedAt: values[0].updatedAt + 1, denial: { ...values[0].request.admission,
            observationId: randomUUID(), observedAt: values[0].updatedAt + 1 } }];
      }
      const { store, path } = await saved(t, chain), before = await readFile(path, "utf8");
      const output = project(store, last.request.requestId, jobs);
      assert.equal(output.state, phase === "failed" ? "FAILED" : phase === "denied" ? "DENIED"
        : phase === "consumed" || phase === "unknown-result" ? "UNKNOWN" : "EXPIRED");
      if (phase === "unknown-result") assert.equal(output.result?.exitCode, null);
      nonExecuting(output); assert.deepEqual(project(store, last.request.requestId, jobs), output);
      const requestFirst = await projectRequestReceipt(store, last.request.requestId, id => jobs.snapshot(id));
      assert.equal(requestFirst.state, output.state);
      assert.equal(requestFirst.retryAllowed, false); assert.equal(requestFirst.automaticResume, false);
      assert.equal(requestFirst.osExecutionReceipt?.outcome, output.result?.outcome);
      assert.equal(requestFirst.reviewOpinion, null);
      assert.equal(await readFile(path, "utf8"), before);
    }
  }
});

test("legacy V2 replay stays origin-unverified and does not consult JobStore", async t => {
  const values = records("CODEX_DERIVED"), current = values[0].request;
  assert.ok(current.origin === "CODEX_DERIVED");
  // Preserve historical request key order before hashing, as required by V2 replay.
  const { version, evidence, policy, requestId, receiptId, idempotencyKey, bootId,
    origin, jobId, turnId, failureEvidence, ...rest } = current;
  const request = { version, evidence, policy, requestId, receiptId, idempotencyKey, bootId, jobId, turnId, ...rest };
  const legacy = productionJournalReceiptSchema.parse({ ...values[0], request, digest: digest(request) });
  const { store, path } = await saved(t, [legacy]), before = await readFile(path, "utf8");
  assert.throws(() => project(store, request.requestId, { get: () => { assert.fail("legacy must not correlate"); } }), rejects("LEGACY_ORIGIN_UNVERIFIED"));
  assert.equal("origin" in store.getProduction(request.requestId)!.request, false);
  await assert.rejects(projectRequestReceipt(store, request.requestId), rejects("LEGACY_ORIGIN_UNVERIFIED"));
  assert.equal(await readFile(path, "utf8"), before);
});

test("invalid IDs, missing receipt, fake Store/boolean and instance overrides cannot provide receipts", async t => {
  const values = records(), { store } = await saved(t, values), id = values[0].request.requestId;
  for (const invalid of ["", "../private", "not-a-uuid", ` ${id}`, `${id} `]) {
    assert.throws(() => project(store, invalid), rejects("INVALID_INPUT"));
  }
  assert.throws(() => project(store, randomUUID()), rejects("REQUEST_UNKNOWN"));
  let called = false;
  const fake = { getProduction: () => { called = true; return values[3]; }, trusted: true };
  assert.throws(() => project(fake, id), rejects("RECEIPT_SOURCE_UNAVAILABLE"));
  assert.equal(called, false);
  assert.throws(() => project(true as unknown as ApprovalStore, id), rejects("RECEIPT_SOURCE_UNAVAILABLE"));
  t.mock.method(store, "getProduction", () => { throw new Error("instance override must not run"); });
  assert.equal(project(store, id).state, "SUCCEEDED");
  await store.close();
  assert.throws(() => project(store, id), rejects("RECEIPT_SOURCE_UNAVAILABLE"));
});

test("a valid V1 fixture in the same canonical Store is never a production result", async t => {
  const store = await ApprovalStore.open(await directory());
  t.after(() => store.close());
  const at = Date.now(), jobId = randomUUID(), turnId = "offline-turn";
  const request = requestSchema.parse({ version: 1, evidence: "OFFLINE_ONLY", policy: POLICY,
    requestId: randomUUID(), receiptId: randomUUID(), bootId: randomUUID(), idempotencyKey: randomUUID(),
    jobId, turnId, projectId: "projection", executionMode: "NORMAL", artifactId: "fixture.marker.v1",
    createdAt: at, expiresAt: at + TTL_MS, failureEvidence: { source: "OFFLINE_FIXTURE", eventId: randomUUID(),
      jobId, turnId, classification: "SANDBOX_POLICY", code: "FIXTURE_SANDBOX_DENIED", observedAt: at,
      evidenceSha256: sha256("inert description") }, executorId: "offline-normal-marker",
    expectedSid: "S-1-5-21-1000", cwd: "C:\\inert-data", target: "isolated-fixture-process",
    scriptSnapshot: MARKER_SCRIPT, scriptSha256: sha256(MARKER_SCRIPT), args: [], environmentPolicy: "WINDOWS_SYSTEM_ONLY",
    sideEffects: "stdout marker only; no file/network/system mutation", risk: "offline fixture; no host authorization",
    timeoutMs: RUN_TIMEOUT_MS, outputLimitBytes: OUTPUT_LIMIT });
  const receipt = receiptSchema.parse({ request, digest: digest(request), state: "PROPOSED", reason: "CREATED", revision: 1, updatedAt: at });
  await store.append(receipt); // Offline test setup only; no runner is called.
  assert.deepEqual(store.get(request.requestId), receipt);
  assert.throws(() => project(store, request.requestId), rejects("REQUEST_UNKNOWN"));
  await assert.rejects(projectRequestReceipt(store, request.requestId), rejects("REQUEST_UNKNOWN"));
  assert.deepEqual(store.get(request.requestId), receipt);
});

test("pre-recovery state vectors are reported verbatim without authority or execution inference", async t => {
  const values = records(), { store } = await saved(t, values);
  // The disabled Host cannot admit these states live; test the read seam only.
  for (const receipt of values.slice(0, 3)) {
    const mock = t.mock.method(ApprovalStore.prototype, "getProduction", () => receipt);
    try {
      const output = project(store, receipt.request.requestId);
      assert.equal(output.state, receipt.state); assert.equal(output.reason, receipt.reason);
      assert.equal(output.result, undefined); nonExecuting(output);
    } finally { mock.mock.restore(); }
  }
});

test("projection revalidates wrong-request, V1, malformed and tampered getter results", async t => {
  const values = records(), { store } = await saved(t, values), id = values[0].request.requestId;
  // Test-only corruption at the canonical method seam. Production has no injection option.
  for (const value of [{ ...values[3], digest: sha256("tampered") },
    { ...values[3], result: { ...values[3].result!, exitCode: 9 } },
    { ...values[3], trusted: true }, { ...values[3], request: { ...values[3].request, credential: "inert-extra-field" } },
    { request: { version: 1, evidence: "OFFLINE_ONLY" } }, null]) {
    const mock = t.mock.method(ApprovalStore.prototype, "getProduction", () => value as ReturnType<ApprovalStore["getProduction"]>);
    try { assert.throws(() => project(store, id), rejects("INVALID_INPUT")); } finally { mock.mock.restore(); }
  }
  const mock = t.mock.method(ApprovalStore.prototype, "getProduction", () => records()[3]);
  try { assert.throws(() => project(store, id), rejects("REQUEST_CORRELATION_REJECTED")); } finally { mock.mock.restore(); }
});

test("saved evidence mismatch or unsafe correlation IDs fail closed even with a recomputed digest", async t => {
  const { jobs, job } = await jobFixture(), values = records("CODEX_DERIVED", job), original = values[0];
  assert.ok(original.request.origin === "CODEX_DERIVED");
  const { store } = await saved(t, values);
  for (const patch of [{ jobId: randomUUID() }, { turnId: "other" }, { projectId: "other" }]) {
    const request = { ...original.request, failureEvidence: { ...original.request.failureEvidence, ...patch } };
    const mock = t.mock.method(ApprovalStore.prototype, "getProduction", () => ({ ...original, request, digest: digest(request) }));
    try { assert.throws(() => project(store, request.requestId, jobs), rejects("INVALID_INPUT")); } finally { mock.mock.restore(); }
  }
  for (const threadId of ["other", "C:\\inert-private-path"]) {
    const request = productionRequestSchema.parse({ ...original.request,
      failureEvidence: { ...original.request.failureEvidence, threadId } });
    const { store: mismatched } = await saved(t, [{ ...original, request, digest: digest(request) }]);
    assert.throws(() => project(mismatched, request.requestId, jobs), rejects("JOB_CORRELATION_REJECTED"));
  }
});

test("request-first canonical reads are branded, detached and never consult a DIRECT job", async t => {
  const values = records(), { store, path } = await saved(t, values), id = values[0].request.requestId;
  const before = await readFile(path, "utf8");
  const cloned = await store.readRequestReceipt(id);
  cloned!.state = "UNKNOWN";
  assert.equal((await store.readRequestReceipt(id))!.state, "SUCCEEDED");
  const output = await projectRequestReceipt(store, id, async () => { assert.fail("DIRECT accessed JobStore"); });
  assert.equal(output.origin, "DIRECT"); assert.equal(output.projectId, "projection");
  assert.equal(output.reviewOpinion, null); assert.equal(output.osExecutionReceipt?.outcome, "SUCCEEDED");
  assert.equal(output.osExecutionReceipt?.verification, "UNVERIFIED");
  assert.equal(output.correlation.job, "NOT_APPLICABLE");
  assert.equal(output.productionEnabled, false); assert.equal(output.retryAllowed, false);
  assert.equal(await readFile(path, "utf8"), before);
  let called = false;
  await assert.rejects(projectRequestReceipt({ readRequestReceipt: async () => { called = true; return values[3]; } }, id), rejects("RECEIPT_SOURCE_UNAVAILABLE"));
  assert.equal(called, false);
  t.mock.method(store, "readRequestReceipt", async () => { throw new Error("instance override must not run"); });
  assert.equal((await projectRequestReceipt(store, id)).state, "SUCCEEDED");
  await store.close();
  await assert.rejects(projectRequestReceipt(store, id), rejects("RECEIPT_SOURCE_UNAVAILABLE"));
});

test("production MCP handler reads original request after turn advance or missing job without asserting fault authority", async t => {
  const { jobs, job } = await jobFixture(), values = records("CODEX_DERIVED", job), request = values[0].request;
  const { store, path } = await saved(t, values);
  await jobs.applyConversationNotification(job.id, { method: "item/completed", params: {
    threadId: job.threadId, turnId: job.turnId, item: { id: "item-data-only", type: "commandExecution", status: "completed", exitCode: 5 },
  } });
  await jobs.setTurn(job.id, "new-turn");
  const server = new McpServer({ name: "receipt-handler-test", version: "1" });
  registerPowerShellReceiptTools(server, store, id => jobs.snapshot(id));
  const client = new Client({ name: "receipt-handler-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const before = await readFile(path, "utf8"), response = await client.callTool({ name: "codex_powershell_receipt", arguments: { requestId: request.requestId } }) as CallToolResult;
  assert.notEqual(response.isError, true);
  const output = response.structuredContent!;
  assert.equal(output.kind, "PRODUCTION"); assert.equal(output.reviewOpinion, null);
  assert.equal((output.correlation as any).currentTurnMatches, false);
  assert.equal((output.correlation as any).completion, "MATCHED_SAVED_COMPLETION");
  assert.equal((output.correlation as any).permissionAttribution, "UNVERIFIED");
  assert.equal((output.correlation as any).fullFaultEvidence, "UNVERIFIED");
  assert.equal((output.osExecutionReceipt as any).verification, "UNVERIFIED");
  assert.equal(await readFile(path, "utf8"), before);
  const missing = await projectRequestReceipt(store, request.requestId, async () => { throw new Error("private missing job details"); });
  assert.equal(missing.requestId, request.requestId); assert.equal(missing.correlation.job, "UNVERIFIED");
  assert.doesNotMatch(JSON.stringify(missing), /private missing|scriptSnapshot|inert-private|grantId|tokenId/);
  for (const patch of [{ id: randomUUID() }, { projectId: "other" }, { threadId: "other" }, { directActionHistoryEligible: false }]) {
    const snapshot = await jobs.snapshot(job.id);
    assert.equal((await projectRequestReceipt(store, request.requestId, async () => ({ ...snapshot, ...patch }))).correlation.job, "UNVERIFIED");
  }
  const unknown = await client.callTool({ name: "codex_powershell_receipt", arguments: { requestId: randomUUID() } }) as CallToolResult;
  assert.equal(unknown.isError, true); assert.equal((unknown.structuredContent!.error as any).code, "REQUEST_UNKNOWN");
});

test("request-first MCP preserves safe errors and separates invalid saved data from unavailable source", async t => {
  const { store, path } = await saved(t, records());
  const server = new McpServer({ name: "receipt-errors", version: "1" });
  registerPowerShellReceiptTools(server, store);
  const client = new Client({ name: "receipt-errors-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const requestId = randomUUID(), before = await readFile(path, "utf8");
  for (const [error, expected] of [[new ApprovalError("REQUEST_UNKNOWN"), "REQUEST_UNKNOWN"],
    [new ApprovalError("STORE_UNAVAILABLE"), "RECEIPT_SOURCE_UNAVAILABLE"],
    [new Error("PRIVATE-EXCEPTION"), "RECEIPT_SOURCE_UNAVAILABLE"]] as const) {
    const mock = t.mock.method(ApprovalStore.prototype, "readRequestReceipt", async () => { throw error; });
    const response = await client.callTool({ name: "codex_powershell_receipt", arguments: { requestId } }) as CallToolResult;
    assert.equal((response.structuredContent?.error as any).code, expected);
    assert.equal(response.structuredContent?.requestId, requestId);
    assert.equal(response.structuredContent?.retryAllowed, false);
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE-EXCEPTION/);
    mock.mock.restore();
  }
  const mock = t.mock.method(ApprovalStore.prototype, "readRequestReceipt", async () =>
    ({ request: { evidence: "PRODUCTION" } }) as Awaited<ReturnType<ApprovalStore["readRequestReceipt"]>>);
  const invalid = await client.callTool({ name: "codex_powershell_receipt", arguments: { requestId } }) as CallToolResult;
  assert.equal((invalid.structuredContent?.error as any).code, "RECEIPT_DATA_INVALID");
  mock.mock.restore();
  assert.equal(await readFile(path, "utf8"), before);
});

test("linked review receipt source errors are normalized without journal mutation", async t => {
  const { store, path } = await saved(t, records());
  const review = await store.createReview({ origin: "DIRECT", projectId: "projection", dataClassification: "personal",
    idempotencyKey: randomUUID(), userIntent: "EXPLICIT_USER_REQUEST", contentPolicy: "PERSONAL_PUBLIC_NO_SECRETS_OR_REGULATED_ORDERS",
    target: "inert receipt fixture", executionMode: "NORMAL", cwd: "C:\\inert-data",
    scriptSnapshot: "# inert fixture, never executed", args: [], risk: "none", sideEffects: "none" });
  const before = await readFile(path, "utf8");
  for (const [error, expected] of [[new ApprovalError("IDENTITY_REPLAY"), "REQUEST_CORRELATION_REJECTED"],
    [new ApprovalError("STORE_UNAVAILABLE"), "RECEIPT_SOURCE_UNAVAILABLE"],
    [new Error("PRIVATE-LINKED-ERROR"), "RECEIPT_SOURCE_UNAVAILABLE"]] as const) {
    const mock = t.mock.method(ApprovalStore.prototype, "readReviewExecution", async () => { throw error; });
    await assert.rejects(projectRequestReceipt(store, review.request.requestId), rejects(expected));
    mock.mock.restore();
  }
  assert.equal(await readFile(path, "utf8"), before);
});
