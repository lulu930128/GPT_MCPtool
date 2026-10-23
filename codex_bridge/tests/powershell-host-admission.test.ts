import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ApprovalStore } from "../src/powershell-approval/store.js";
import { ApprovalError, digest, sha256, TTL_MS, RECEIPT_TTL_MS, PRODUCTION_POLICY, productionRequestSchema,
  productionBindingOf, productionReceiptSchema } from "../src/powershell-approval/contract.js";
import { createPowerShellHostPort, NORMAL_POLICY } from "../src/powershell-approval/host-admission.js";
import { projectRequestReceipt } from "../src/powershell-approval/job-projection.js";
import type { ReviewInput } from "../src/powershell-approval/review-contract.js";
import { resolveSavedFailure, type FailureJob } from "../src/powershell-approval/failure-evidence.js";
import { registerPowerShellReviewTools } from "../src/powershell-approval/review-tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
const code = (expected: string) => (e: unknown) => e instanceof ApprovalError && e.code === expected;

async function setup(t: TestContext) {
  const base = resolve(".tmp", "powershell-host-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-"));
  const store = await ApprovalStore.open(join(root, "approval")); t.after(() => store.close());
  const project = { id: "personal", name: "Personal", path: root };
  const job: FailureJob = { id: randomUUID(), projectId: "personal", threadId: "thread-a", turnId: "turn-a",
    dataClassification: "personal", directActionHistoryEligible: true,
    commandFailureDiagnostics: { scope: "bounded_saved_conversation", evidenceStatus: "OBSERVED_NONZERO", scannedItems: 1,
      failures: [], truncated: false, cause: "UNKNOWN", permissionAttribution: "UNVERIFIED" } };
  job.commandFailureDiagnostics!.failures.push({ jobId: job.id, turnId: "turn-a", itemId: "item-a", exitCode: 1,
    observedStatus: "completed", evidenceStatus: "OBSERVED_NONZERO", cause: "UNKNOWN", permissionAttribution: "UNVERIFIED" });
  let reads = 0;
  const context = { store, projects: new Map([[project.id, project]]), readJob: async () => { reads++; return job; } };
  const host = createPowerShellHostPort(context);
  const candidate = (origin: "DIRECT" | "CODEX_DERIVED" = "DIRECT"): ReviewInput => ({ origin,
    ...(origin === "CODEX_DERIVED" ? { jobId: job.id, turnId: "turn-a", sourceFailureItemId: "item-a" } : {}),
    projectId: project.id, dataClassification: "personal", idempotencyKey: randomUUID(),
    userIntent: "EXPLICIT_USER_REQUEST", contentPolicy: "PERSONAL_PUBLIC_NO_SECRETS_OR_REGULATED_ORDERS",
    target: "read-only host acceptance", executionMode: "NORMAL", cwd: root,
    scriptSnapshot: "[Console]::Out.WriteLine('NORMAL_READ_ONLY_ACCEPTANCE')\r\n", args: ["literal", ""],
    risk: "Read-only stdout; independent host approval required", sideEffects: "stdout only" });
  const create = (origin: "DIRECT" | "CODEX_DERIVED" = "DIRECT") => store.createReview(candidate(origin),
    origin === "CODEX_DERIVED" ? resolveSavedFailure(job, "turn-a", "item-a") : undefined);
  const journal = () => readFile(join(root, "approval", "receipts.jsonl"), "utf8");
  return { root, store, context, host, create, job, journal, reads: () => reads };
}

// These are UNTRUSTED data vectors submitted to the actual production call path.
// There is no test Host, verifier override, transport capability or executable grant.
async function proposal(f: Awaited<ReturnType<typeof setup>>, origin: "DIRECT" | "CODEX_DERIVED" = "DIRECT") {
  const review = await f.create(origin), prepared = await f.host.prepare(review.request.requestId, review.digest);
  const at = Date.now(), r = review.request;
  const authority = { hostId: randomUUID(), instanceId: randomUUID(), sid: "S-1-5-21-1000", logonId: "0000000000000001",
    pid: 100, processStartedAt: at - 1000, imageSha256: sha256("untrusted identity"), tokenId: "untrusted token", integrity: "MEDIUM" };
  const request = productionRequestSchema.parse({ version: 2, evidence: "PRODUCTION", policy: PRODUCTION_POLICY,
    requestId: randomUUID(), receiptId: randomUUID(), idempotencyKey: randomUUID(), bootId: prepared.bootId,
    origin, projectId: r.projectId, executionMode: r.executionMode, target: r.target, scriptSnapshot: r.scriptSnapshot,
    scriptSha256: r.scriptSha256, scriptEncoding: "UTF8_EXACT", cwd: r.cwd, args: r.args,
    environmentPolicyDigest: digest(NORMAL_POLICY), sideEffects: r.sideEffects, risk: r.risk,
    createdAt: at, ttlMs: TTL_MS, expiresAt: at + TTL_MS, nonce: randomUUID(),
    sourceReview: { requestId: r.requestId, digest: review.digest },
    approvalIdentity: { authority, subjectSid: authority.sid, ceremonyId: randomUUID(), interface: "CHATGPT_APP_ONLY", authentication: "FRESH_PASSWORD_EACH_REQUEST" },
    executorIdentity: { ...authority, instanceId: randomUUID(), pid: 101 },
    admission: { source: "WINDOWS_HOST_PEER", observationId: randomUUID(), channelBinding: sha256("untrusted channel"), observedAt: at, peer: authority },
    ...(origin === "CODEX_DERIVED" ? { jobId: r.jobId, turnId: r.turnId, failureEvidence: {
      source: "BRIDGE_CANONICAL_JOB_EVENT", eventId: randomUUID(), jobId: r.jobId, turnId: r.turnId, projectId: r.projectId,
      threadId: "thread-a", itemId: "item-a", observedAt: at, evidenceSha256: sha256("claimed fault"),
      fault: { classification: "OS_PERMISSION", code: "OS_ACCESS_DENIED" } } } : {}) });
  return { review, request, prepared };
}

test("actual Host port: DIRECT reuses canonical Store, never reads JobStore or writes on prepare", async t => {
  const f = await setup(t), { review } = await proposal(f), before = await f.journal();
  const result = await f.host.prepare(review.request.requestId, review.digest);
  assert.equal(result.hostApproval, "NOT_OBSERVED"); assert.equal(result.grant, "NOT_ISSUED");
  assert.equal(f.reads(), 0); assert.equal(await f.journal(), before);
  assert.equal((await projectRequestReceipt(f.store, review.request.requestId)).hostApproval.state, "NOT_ADMITTED");
});
test("actual Host admission: model ACCEPTED and forged transport never create production records", async t => {
  const f = await setup(t), { review, request } = await proposal(f);
  await f.store.decideReview(review.request.requestId, review.digest, "ACCEPTED");
  const before = await f.journal();
  for (const transport of [true, { trusted: true, accepted: true }, { source: "WINDOWS_HOST_PEER", signature: "claimed" }])
    await assert.rejects(f.host.admit(review.request.requestId, review.digest, request, transport), code("BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED"));
  assert.equal(f.store.listProduction().length, 0); assert.equal(await f.journal(), before);
});
test("actual Host admission: exact fields, source binding, policy and boot are checked", async t => {
  const f = await setup(t), { review, request } = await proposal(f);
  for (const patch of [{ args: ["changed"] }, { risk: "changed" }, { cwd: "C:\\different" }, { bootId: randomUUID() },
    { environmentPolicyDigest: sha256("other") }, { sourceReview: { requestId: randomUUID(), digest: review.digest } }])
    await assert.rejects(f.host.admit(review.request.requestId, review.digest, { ...request, ...patch }, true), code("HOST_REQUEST_MISMATCH"));
});
test("actual Host admission: declined and stale Review never creates Grant", async t => {
  const f = await setup(t), { review, request } = await proposal(f);
  await f.store.decideReview(review.request.requestId, review.digest, "DECLINED");
  assert.equal((await f.host.prepare(review.request.requestId, review.digest)).blocker, "REVIEW_DECLINED");
  await assert.rejects(f.host.admit(review.request.requestId, review.digest, request, true), code("REVIEW_DECLINED"));
  t.mock.method(Date, "now", () => review.request.expiresAt + 1);
  assert.equal((await f.host.prepare(review.request.requestId, review.digest)).blocker, "TTL_EXPIRED");
  await assert.rejects(f.host.admit(review.request.requestId, review.digest, request, true), code("TTL_EXPIRED"));
});
test("actual derived admission: saved nonzero stays UNVERIFIED; forged fault classification rejected", async t => {
  const f = await setup(t), { review, request, prepared } = await proposal(f, "CODEX_DERIVED");
  assert.equal(prepared.permissionAttribution, "UNVERIFIED");
  await assert.rejects(f.host.admit(review.request.requestId, review.digest, request, true), code("FAILURE_ATTRIBUTION_UNVERIFIED"));
  f.job.turnId = "different";
  await assert.rejects(f.host.prepare(review.request.requestId, review.digest), code("REVIEW_JOB_REJECTED"));
  const receipt = await projectRequestReceipt(f.store, review.request.requestId, f.context.readJob);
  assert.equal(receipt.correlation.currentTurnMatches, false); assert.equal(receipt.correlation.permissionAttribution, "UNVERIFIED");
});
test("actual Store Host APIs reject missing source, unknown claims and invalid decisions before writes", async t => {
  const f = await setup(t), { request } = await proposal(f), before = await f.journal();
  await assert.rejects(f.store.admitProduction({ ...request, sourceReview: undefined }, true), code("SOURCE_REVIEW_REQUIRED"));
  await assert.rejects(f.host.claim(randomUUID(), digest(request), request.admission, true), code("SOURCE_REVIEW_REQUIRED"));
  await assert.rejects(f.store.decideProduction(request.requestId, digest(request), "ACCEPTED" as "APPROVED", request.admission, true), code("INVALID_INPUT"));
  assert.equal(await f.journal(), before);
});
test("MCP review_get exposes the same runtime Host preparation, no new execution or secret input tool", async t => {
  const f = await setup(t), { review } = await proposal(f);
  const server = new McpServer({ name: "host-port-check", version: "1" }), client = new Client({ name: "read", version: "1" });
  registerPowerShellReviewTools(server, { ...f.context, host: f.host });
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const response = await client.callTool({ name: "codex_powershell_review_get", arguments: { requestId: review.request.requestId, digest: review.digest } });
  const admission = (response.structuredContent as Record<string, unknown>).hostAdmission as Record<string, unknown>;
  assert.equal(admission.humanApproval, "AUTHENTICATED_DIRECT_REQUEST"); assert.equal(admission.executionDispatched, false);
  assert.equal((await client.listTools()).tools.length, 4);
});

test("new sourceReview linkage replays in the sole Journal and original Request returns UNVERIFIED OS receipt", async t => {
  const f = await setup(t), { review, request } = await proposal(f), now = request.createdAt;
  const observation = (at: number, executor = false) => ({ ...request.admission, observationId: randomUUID(), observedAt: at,
    peer: executor ? request.executorIdentity : request.approvalIdentity.authority });
  const proposed = productionReceiptSchema.parse({ request, digest: digest(request), state: "PROPOSED", reason: "CREATED", revision: 1, updatedAt: now });
  const binding = productionBindingOf(request);
  const approved = productionReceiptSchema.parse({ ...proposed, state: "APPROVED", reason: "HOST_APPROVED", revision: 2, updatedAt: now + 1,
    grant: { grantId: randomUUID(), binding, approvedAt: now + 1, approval: observation(now + 1), osAuthorization: "WINDOWS_STANDARD_TOKEN" } });
  const consumed = productionReceiptSchema.parse({ ...approved, state: "CONSUMED", reason: "GRANT_CONSUMED", revision: 3, updatedAt: now + 2,
    consumption: { consumptionId: randomUUID(), grantId: approved.grant!.grantId, binding, consumedAt: now + 2,
      receiptDeadline: now + 2 + RECEIPT_TTL_MS, executor: observation(now + 2, true) } });
  const completed = productionReceiptSchema.parse({ ...consumed, state: "SUCCEEDED", reason: "RECEIPT_INGESTED", revision: 4, updatedAt: now + 3,
    result: { grantId: approved.grant!.grantId, consumptionId: consumed.consumption!.consumptionId, binding,
      executor: observation(now + 3, true), completedAt: now + 3, outcome: "SUCCEEDED", exitCode: 0, outputSha256: sha256("inert output") } });
  // Replay-only data, not successful production admission. Close the sole owner
  // before seeding its isolated journal; never create a concurrent or shadow Store.
  const original = await f.journal(); await f.store.close();
  let previous = JSON.parse(original.trim()).hash;
  const entries = [proposed, approved, consumed, completed].map((receipt, i) => {
    const entry = { seq: i + 2, previous, receipt }; previous = digest(entry);
    return JSON.stringify({ ...entry, hash: previous }) + "\n";
  }).join("");
  await writeFile(join(f.root, "approval", "receipts.jsonl"), original + entries, "utf8");
  const reopened = await ApprovalStore.open(join(f.root, "approval")); t.after(() => reopened.close());
  const result = await projectRequestReceipt(reopened, review.request.requestId);
  assert.equal(result.requestId, review.request.requestId);
  assert.equal(result.reviewOpinion?.state, "PENDING");
  assert.equal(result.osExecutionReceipt?.requestId, request.requestId);
  assert.equal(result.osExecutionReceipt?.verification, "UNVERIFIED");
  assert.equal(result.hostApproval.enabled, false);
  assert.equal(await f.journal(), original + entries);
});
