import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalStore } from "../src/powershell-approval/store.js";
import { PowerShellApprovalBroker } from "../src/powershell-approval/broker.js";
import { REVIEW_KIND } from "../src/powershell-approval/review-contract.js";
import { ApprovalError, digest, MARKER_SCRIPT, OUTPUT_LIMIT, POLICY, PRODUCTION_POLICY,
  productionBindingOf, productionBindingSchema, productionReceiptSchema, productionRequestSchema, receiptSchema, requestSchema,
  legacyProductionReceiptSchema, productionJournalReceiptSchema,
  RECEIPT_TTL_MS, RUN_TIMEOUT_MS, sha256, TTL_MS, validateProductionTransition,
  type ProductionReceipt, type ProductionRequest, type ProductionJournalReceipt, type Receipt } from "../src/powershell-approval/contract.js";

const rejects = (expected: string) => (e: unknown) => e instanceof ApprovalError && e.code === expected;
// Untrusted data vectors ONLY. No Host implementation, password, signing, IPC or runner.
function records(mode: "NORMAL" | "ADMIN" = "NORMAL", origin: ProductionRequest["origin"] = "CODEX_DERIVED") {
  const at = Date.now() - 1000;
  const jobId = randomUUID(), turnId = "turn-data-only";
  const authority = { hostId: randomUUID(), instanceId: randomUUID(), sid: "S-1-5-21-1000", logonId: "0000000000000001",
    pid: 100, processStartedAt: at - 1000, imageSha256: sha256("authority-description"), tokenId: "token-description", integrity: "MEDIUM" as const };
  const executor = { ...authority, instanceId: randomUUID(), pid: 101,
    integrity: mode === "ADMIN" ? "HIGH" as const : "MEDIUM" as const };
  const evidence = (peer = authority, observedAt = at) => ({ source: "WINDOWS_HOST_PEER" as const,
    observationId: randomUUID(), channelBinding: sha256("untrusted-channel-description"), observedAt, peer });
  const request = productionRequestSchema.parse({ version: 2, evidence: "PRODUCTION", policy: PRODUCTION_POLICY,
    requestId: randomUUID(), receiptId: randomUUID(), idempotencyKey: randomUUID(), bootId: randomUUID(),
    origin, ...(origin === "DIRECT" ? {} : { jobId, turnId, failureEvidence: {
      source: "BRIDGE_CANONICAL_JOB_EVENT", eventId: randomUUID(), jobId, turnId, projectId: "contract",
      threadId: "thread-data-only", itemId: "item-data-only", observedAt: at - 1, evidenceSha256: sha256("untrusted-fault-description"),
      fault: { classification: "OS_PERMISSION", code: "OS_ACCESS_DENIED" },
    } }), projectId: "contract", executionMode: mode, target: "data-only-target",
    scriptSnapshot: "# inert contract data\r\n", scriptSha256: sha256("# inert contract data\r\n"), scriptEncoding: "UTF8_EXACT",
    cwd: "C:\\contract-data", args: [], environmentPolicyDigest: sha256("no-environment"), sideEffects: "data only", risk: "no execution",
    createdAt: at, ttlMs: TTL_MS, expiresAt: at + TTL_MS, nonce: randomUUID(),
    approvalIdentity: { authority, subjectSid: authority.sid, ceremonyId: randomUUID(),
      interface: "CHATGPT_APP_ONLY", authentication: "FRESH_PASSWORD_EACH_REQUEST" }, executorIdentity: executor, admission: evidence() });
  const proposed: ProductionReceipt = { request, digest: digest(request), state: "PROPOSED", reason: "CREATED", revision: 1, updatedAt: at };
  const binding = productionBindingOf(request);
  const approved: ProductionReceipt = { ...proposed, state: "APPROVED", reason: "HOST_APPROVED", revision: 2, updatedAt: at + 1,
    grant: { grantId: randomUUID(), binding, approvedAt: at + 1, approval: evidence(authority, at + 1),
      osAuthorization: mode === "ADMIN" ? "WINDOWS_UAC_ELEVATED_TOKEN" : "WINDOWS_STANDARD_TOKEN" } };
  const consumed: ProductionReceipt = { ...approved, state: "CONSUMED", reason: "GRANT_CONSUMED", revision: 3, updatedAt: at + 2,
    consumption: { consumptionId: randomUUID(), grantId: approved.grant!.grantId, binding, consumedAt: at + 2,
      receiptDeadline: at + 2 + RECEIPT_TTL_MS, executor: { ...evidence(authority, at + 2), peer: executor } } };
  const completed: ProductionReceipt = { ...consumed, state: "SUCCEEDED", reason: "RECEIPT_INGESTED", revision: 4, updatedAt: at + 3,
    result: { grantId: approved.grant!.grantId, consumptionId: consumed.consumption!.consumptionId, binding,
      executor: { ...evidence(authority, at + 3), peer: executor }, completedAt: at + 3, outcome: "SUCCEEDED", exitCode: 0, outputSha256: sha256("") } };
  return { proposed, approved, consumed, completed };
}
function offline(): Receipt {
  const at = Date.now(), jobId = randomUUID();
  const request = { version: 1 as const, evidence: "OFFLINE_ONLY" as const, policy: POLICY,
    requestId: randomUUID(), receiptId: randomUUID(), bootId: randomUUID(), idempotencyKey: randomUUID(),
    jobId, turnId: "offline-turn", projectId: "contract", executionMode: "NORMAL" as const, artifactId: "fixture.marker.v1" as const,
    createdAt: at, expiresAt: at + TTL_MS, failureEvidence: { source: "OFFLINE_FIXTURE" as const, eventId: randomUUID(),
      jobId, turnId: "offline-turn", classification: "SANDBOX_POLICY" as const, code: "FIXTURE_SANDBOX_DENIED" as const,
      observedAt: at, evidenceSha256: sha256("description") }, executorId: "offline-normal-marker" as const,
    expectedSid: "S-1-5-21-1000", cwd: "C:\\contract-data", target: "isolated-fixture-process" as const,
    scriptSnapshot: MARKER_SCRIPT, scriptSha256: sha256(MARKER_SCRIPT), args: [] as [], environmentPolicy: "WINDOWS_SYSTEM_ONLY" as const,
    sideEffects: "stdout marker only; no file/network/system mutation" as const, risk: "offline fixture; no host authorization" as const,
    timeoutMs: RUN_TIMEOUT_MS, outputLimitBytes: OUTPUT_LIMIT };
  const normalized = requestSchema.parse(request);
  return receiptSchema.parse({ request: normalized, digest: digest(normalized), state: "PROPOSED", reason: "CREATED", revision: 1, updatedAt: at });
}
async function directory() {
  const root = join(process.cwd(), ".tmp", "powershell-approval-tests");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "contract-"));
}
// Replay input is deliberately untrusted disk data. Hash validity is never Host authority.
async function writeJournal(dir: string, values: Array<ProductionJournalReceipt | Receipt>, normalize = true) {
  let previous = "GENESIS";
  const lines = values.map((value, index) => {
    const receipt = !normalize ? value : value.request.evidence === "PRODUCTION" ? productionJournalReceiptSchema.parse(value) : receiptSchema.parse(value);
    const entry = { seq: index + 1, previous, receipt };
    previous = digest(entry);
    return JSON.stringify({ ...entry, hash: previous });
  });
  await writeFile(join(dir, "receipts.jsonl"), lines.join("\n") + "\n", "utf8");
}
async function verifyChain(dir: string) {
  const lines = (await readFile(join(dir, "receipts.jsonl"), "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
  let previous = "GENESIS";
  for (const [i, { hash, ...entry }] of lines.entries()) {
    assert.equal(entry.seq, i + 1); assert.equal(entry.previous, previous); assert.equal(hash, digest(entry)); previous = hash;
  }
  return lines;
}

test("shared Store: V1, legacy V2, current V2 and nonexecuting review preserve one journal and recovery", async () => {
  const dir = await directory(), old = offline(), legacy = legacyRecords(), modern = records("ADMIN", "DIRECT");
  await writeJournal(dir, [old, ...legacy, productionReceiptSchema.parse(modern.proposed)], false);
  const path = join(dir, "receipts.jsonl"), original = await readFile(path, "utf8");
  let store = await ApprovalStore.open(dir);
  let requestId = "";
  try {
    const review = await store.createReview({ origin: "DIRECT", projectId: "contract", dataClassification: "public",
      userIntent: "EXPLICIT_USER_REQUEST", contentPolicy: "PERSONAL_PUBLIC_NO_SECRETS_OR_REGULATED_ORDERS",
      idempotencyKey: randomUUID(), target: "inert review", executionMode: "ADMIN", cwd: "C:\\contract-data",
      scriptSnapshot: "# inert review only\r\n", args: [""], risk: "data only", sideEffects: "none" });
    requestId = review.request.requestId;
    await store.decideReview(requestId, review.digest, "ACCEPTED");
    assert.deepEqual(store.list(), [old]);
    assert.equal(store.listProduction().length, 2);
    assert.equal(store.getProduction(modern.proposed.request.requestId)?.state, "EXPIRED");
    assert.equal(store.getProduction(legacy[0]!.request.requestId)?.state, "SUCCEEDED");
    await assert.rejects(store.appendProduction(modern.proposed, true), rejects("INVALID_TRANSITION"));
  } finally { await store.close(); }
  const chain = await verifyChain(dir);
  assert.ok((await readFile(path, "utf8")).startsWith(original));
  assert.equal(chain.at(-1).receipt.kind, REVIEW_KIND);
  store = await ApprovalStore.open(dir);
  try { assert.equal((await store.readReview(requestId)).state, "ACCEPTED"); assert.deepEqual(store.list(), [old]); }
  finally { await store.close(); }
  assert.deepEqual(await verifyChain(dir), chain);
});

test("production contract: exact UTF-8 and strict separation; all immutable fields bind digest", () => {
  const { proposed, approved } = records();
  assert.equal(proposed.request.origin, "CODEX_DERIVED");
  if (proposed.request.origin !== "CODEX_DERIVED") throw new Error("test requires derived data");
  const fault = proposed.request.failureEvidence;
  assert.equal(receiptSchema.safeParse(proposed).success, false);
  assert.equal(productionReceiptSchema.safeParse(offline()).success, false);
  for (const patch of [{ evidence: "OFFLINE_ONLY" }, { trusted: true }, { signature: "synthetic" },
    { scriptSnapshot: proposed.request.scriptSnapshot.replaceAll("\r\n", "\n") },
    { scriptSnapshot: "\uD800", scriptSha256: sha256("\uD800") }, { ttlMs: TTL_MS + 1 }]) {
    assert.equal(productionRequestSchema.safeParse({ ...proposed.request, ...patch }).success, false);
  }
  const otherJob = randomUUID();
  const changes: Partial<ProductionRequest>[] = [
    { jobId: otherJob, failureEvidence: { ...fault, jobId: otherJob } },
    { turnId: "other", failureEvidence: { ...fault, turnId: "other" } },
    { projectId: "other", failureEvidence: { ...fault, projectId: "other" } },
    { nonce: randomUUID() }, { target: "other" }, { cwd: "other" }, { args: ["other"] }, { environmentPolicyDigest: sha256("other") },
    { scriptSnapshot: "# changed", scriptSha256: sha256("# changed") }, { bootId: randomUUID() },
    { receiptId: randomUUID() }, { idempotencyKey: randomUUID() },
    { executorIdentity: { ...proposed.request.executorIdentity, pid: 888 } },
    { approvalIdentity: { ...proposed.request.approvalIdentity, ceremonyId: randomUUID() } }];
  for (const patch of changes) {
    const request = productionRequestSchema.parse({ ...proposed.request, ...patch });
    const changed = { ...approved, request, digest: digest(request), grant: { ...approved.grant!, binding: productionBindingOf(request) } };
    assert.throws(() => validateProductionTransition(proposed, changed), rejects("INVALID_TRANSITION"));
  }
  const switchedRequest = productionRequestSchema.parse({ ...proposed.request, executionMode: "ADMIN",
    executorIdentity: { ...proposed.request.executorIdentity, integrity: "HIGH" } });
  assert.throws(() => validateProductionTransition(proposed, { ...approved, request: switchedRequest, digest: digest(switchedRequest),
    grant: { ...approved.grant!, binding: productionBindingOf(switchedRequest), osAuthorization: "WINDOWS_UAC_ELEVATED_TOKEN" } }), rejects("INVALID_TRANSITION"));
});

test("production contract: one consume, exact identity, mode, grant and receipt binding", () => {
  for (const origin of ["DIRECT", "CODEX_DERIVED"] as const) for (const mode of ["NORMAL", "ADMIN"] as const) {
    const r = records(mode, origin);
    validateProductionTransition(undefined, r.proposed);
    validateProductionTransition(r.proposed, r.approved);
    validateProductionTransition(r.approved, r.consumed);
    validateProductionTransition(r.consumed, r.completed);
    assert.throws(() => validateProductionTransition(r.consumed, { ...r.consumed, revision: 4 }), rejects("INVALID_TRANSITION"));
    assert.throws(() => validateProductionTransition(r.completed, { ...r.completed, revision: 5 }), rejects("INVALID_TRANSITION"));
    const patches = [{ grantId: randomUUID() }, { consumptionId: randomUUID() }, { binding: { ...r.completed.result!.binding, nonce: randomUUID() } },
      { binding: { ...r.completed.result!.binding, executionMode: mode === "ADMIN" ? "NORMAL" : "ADMIN" } },
      { executor: { ...r.completed.result!.executor, peer: { ...r.completed.result!.executor.peer, pid: 999 } } },
      { executor: { ...r.completed.result!.executor, peer: { ...r.completed.result!.executor.peer, tokenId: "other" } } },
      { executor: { ...r.completed.result!.executor, peer: { ...r.completed.result!.executor.peer, processStartedAt: 0 } } },
      { exitCode: 1 }, { trusted: true }, { signature: "synthetic" }];
    for (const patch of patches) assert.equal(productionReceiptSchema.safeParse({ ...r.completed, result: { ...r.completed.result!, ...patch } }).success, false);
    assert.equal(productionReceiptSchema.safeParse({ ...r.approved, grant: { ...r.approved.grant!, osAuthorization: "UNKNOWN" } }).success, false);
  }
});

test("production contract: expired consume, late result, UNKNOWN and fabricated expiry grant reject", () => {
  const r = records();
  assert.equal(productionReceiptSchema.safeParse({ ...r.consumed, updatedAt: r.proposed.request.expiresAt }).success, false);
  assert.equal(productionReceiptSchema.safeParse({ ...r.completed, updatedAt: r.consumed.consumption!.receiptDeadline }).success, false);
  const unknown = { ...r.consumed, state: "UNKNOWN" as const, reason: "DELIVERY_UNCERTAIN" as const, revision: 4 };
  validateProductionTransition(r.consumed, unknown);
  assert.throws(() => validateProductionTransition(unknown, { ...r.completed, revision: 5 }), rejects("INVALID_TRANSITION"));
  assert.throws(() => validateProductionTransition(r.proposed, { ...r.approved, state: "EXPIRED", reason: "RESTART_EXPIRED" }), rejects("INVALID_TRANSITION"));
  assert.throws(() => validateProductionTransition(r.approved, { ...r.approved, state: "EXPIRED", reason: "RESTART_EXPIRED",
    revision: 3, grant: undefined }), rejects("INVALID_TRANSITION"));
});

test("production origins: DIRECT forbids job context; derived requires traceable, matched fault descriptions", () => {
  const direct = records("NORMAL", "DIRECT").proposed.request;
  const derived = records().proposed.request;
  assert.ok(derived.origin === "CODEX_DERIVED");
  const binding = productionBindingOf(direct), e = derived.failureEvidence;
  assert.equal(binding.origin, "DIRECT");
  for (const key of ["jobId", "turnId", "failureEvidence"] as const) {
    assert.equal(Object.hasOwn(direct, key), false);
    assert.equal(Object.hasOwn(binding, key), false);
    const forbiddenValues: unknown[] = [undefined, derived[key]];
    for (const value of forbiddenValues) {
      assert.equal(productionRequestSchema.safeParse({ ...direct, [key]: value }).success, false);
      assert.equal(productionBindingSchema.safeParse({ ...binding, [key]: value }).success, false);
    }
  }
  assert.equal(productionBindingSchema.safeParse({ ...binding, failureEvidenceDigest: digest(e) }).success, false);
  for (const request of [direct, derived]) for (const origin of [undefined, "", "UNKNOWN", "OFFLINE_FIXTURE"]) {
    assert.equal(productionRequestSchema.safeParse({ ...request, origin }).success, false);
    assert.equal(productionBindingSchema.safeParse({ ...productionBindingOf(request), origin }).success, false);
  }
  for (const patch of [{ jobId: undefined }, { jobId: "" }, { turnId: undefined }, { turnId: "" }, { turnId: "   " },
    { failureEvidence: undefined }, { jobId: randomUUID() }, { turnId: "other" }, { projectId: "other" }]) {
    assert.equal(productionRequestSchema.safeParse({ ...derived, ...patch }).success, false);
  }
  for (const patch of [{ source: "OFFLINE_FIXTURE" }, { source: "MCP_REQUEST" }, { source: undefined },
    { eventId: undefined }, { threadId: "" }, { itemId: undefined }, { evidenceSha256: undefined },
    { jobId: randomUUID() }, { turnId: "other" }, { projectId: "other" },
    { observedAt: derived.createdAt + 1 }, { observedAt: derived.createdAt - TTL_MS - 1 },
    { fault: { classification: "UNVERIFIED", code: "NONZERO_EXIT" } },
    { fault: { classification: "OS_PERMISSION", code: "SANDBOX_POLICY_DENIED" } },
    { fault: undefined, exitCode: 1 }, { trusted: true }]) {
    const request: unknown = { ...derived, failureEvidence: { ...e, ...patch } };
    assert.equal(productionRequestSchema.safeParse(request).success, false);
    assert.equal(productionReceiptSchema.safeParse({ request, digest: digest(request), state: "PROPOSED",
      reason: "CREATED", revision: 1, updatedAt: derived.createdAt }).success, false);
  }
  for (const fault of [{ classification: "SANDBOX_POLICY", code: "SANDBOX_POLICY_DENIED" },
    { classification: "JOB_OBJECT", code: "JOB_OBJECT_RESTRICTION" }, { classification: "OS_PERMISSION", code: "OS_ACCESS_DENIED" }]) {
    assert.equal(productionRequestSchema.safeParse({ ...derived, failureEvidence: { ...e, fault } }).success, true);
  }
});

test("production origins: every grant/consume/result binds origin, request, digest and derived provenance", () => {
  for (const origin of ["DIRECT", "CODEX_DERIVED"] as const) {
    const r = records("NORMAL", origin), request = r.proposed.request, binding = productionBindingOf(request);
    const other = productionBindingOf(records("NORMAL", origin === "DIRECT" ? "CODEX_DERIVED" : "DIRECT").proposed.request);
    for (const phase of ["approved", "consumed", "completed"] as const) {
      const value = r[phase], key = phase === "approved" ? "grant" : phase === "consumed" ? "consumption" : "result";
      for (const patch of [{ requestId: randomUUID() }, { digest: sha256("other") }, { origin: undefined },
        { origin: other.origin }, { executionMode: "ADMIN" },
        ...(origin === "CODEX_DERIVED" ? [{ jobId: randomUUID() }, { turnId: "other" },
          { failureEvidenceDigest: sha256("other") }, { failureEvidenceDigest: undefined }] : [])]) {
        assert.equal(productionReceiptSchema.safeParse({ ...value,
          [key]: { ...value[key], binding: { ...binding, ...patch } } }).success, false);
      }
      // Even a structurally valid other-origin binding with the same request/digest is rejected.
      assert.equal(productionReceiptSchema.safeParse({ ...value,
        [key]: { ...value[key], binding: { ...other, requestId: request.requestId, digest: r.proposed.digest } } }).success, false);
    }
    // Attempt to switch the entire request and all bindings coherently across a transition.
    const derived = records().proposed.request;
    assert.ok(derived.origin === "CODEX_DERIVED");
    let switched: ProductionRequest;
    if (request.origin === "DIRECT") {
      switched = productionRequestSchema.parse({ ...request, origin: "CODEX_DERIVED", jobId: derived.jobId, turnId: derived.turnId,
        failureEvidence: { ...derived.failureEvidence, observedAt: request.createdAt } });
    } else {
      const { jobId, turnId, failureEvidence, ...common } = request;
      switched = productionRequestSchema.parse({ ...common, origin: "DIRECT" });
    }
    const switchedBinding = productionBindingOf(switched);
    const changed = { ...r.completed, request: switched, digest: digest(switched),
      grant: { ...r.completed.grant!, binding: switchedBinding }, consumption: { ...r.completed.consumption!, binding: switchedBinding },
      result: { ...r.completed.result!, binding: switchedBinding } };
    assert.equal(productionReceiptSchema.safeParse(changed).success, true);
    assert.throws(() => validateProductionTransition(r.consumed, changed), rejects("INVALID_TRANSITION"));
    assert.throws(() => validateProductionTransition(r.proposed, { ...r.approved, request: switched, digest: digest(switched),
      grant: { ...r.approved.grant!, binding: switchedBinding } }), rejects("INVALID_TRANSITION"));
    if (request.origin === "CODEX_DERIVED") {
      for (const patch of [{ eventId: randomUUID() }, { threadId: "other" }, { itemId: "other" }, { evidenceSha256: sha256("other") },
        { observedAt: request.createdAt }, { fault: { classification: "JOB_OBJECT", code: "JOB_OBJECT_RESTRICTION" } }]) {
        const changedRequest = productionRequestSchema.parse({ ...request, failureEvidence: { ...request.failureEvidence, ...patch } });
        assert.notEqual(digest(changedRequest), digest(request));
        assert.notDeepEqual(productionBindingOf(changedRequest), binding);
        assert.equal(productionReceiptSchema.safeParse({ ...r.approved, request: changedRequest, digest: digest(changedRequest) }).success, false);
        assert.throws(() => validateProductionTransition(r.proposed, { ...r.approved, request: changedRequest, digest: digest(changedRequest),
          grant: { ...r.approved.grant!, binding: productionBindingOf(changedRequest) } }), rejects("INVALID_TRANSITION"));
      }
    }
  }
});

// Historical V2 field ordering is constructed independently of the compatibility
// parser. Hash raw bytes first, so an accidental normalization breaks replay.
function legacyRecords() {
  const r = records(), current = r.proposed.request;
  assert.ok(current.origin === "CODEX_DERIVED");
  const { version, evidence, policy, requestId, receiptId, idempotencyKey, bootId,
    origin, jobId, turnId, failureEvidence, ...rest } = current;
  const request = { version, evidence, policy, requestId, receiptId, idempotencyKey, bootId, jobId, turnId, ...rest };
  const binding = { requestId, receiptId, digest: digest(request), jobId, turnId, projectId: request.projectId,
    executionMode: request.executionMode, target: request.target, scriptSha256: request.scriptSha256,
    expiresAt: request.expiresAt, nonce: request.nonce, approvalIdentity: request.approvalIdentity, executorIdentity: request.executorIdentity };
  return [r.proposed, r.approved, r.consumed, r.completed].map(value => {
    const { grant, consumption, result } = value;
    return { request, digest: digest(request), state: value.state, revision: value.revision, updatedAt: value.updatedAt, reason: value.reason,
      ...(grant ? { grant: { ...grant, binding } } : {}),
      ...(consumption ? { consumption: { ...consumption, binding } } : {}), ...(result ? { result: { ...result, binding } } : {}) };
  });
}

test("production legacy V2: raw hashed journal replays without origin upgrade; only recovery may append", async () => {
  for (const length of [1, 2, 3, 4]) {
    const dir = await directory(), values = legacyRecords().slice(0, length), last = values.at(-1)!;
    for (const value of values) {
      assert.equal(JSON.stringify(legacyProductionReceiptSchema.parse(value)), JSON.stringify(value));
      assert.equal(productionReceiptSchema.safeParse(value).success, false);
      assert.equal(productionRequestSchema.safeParse(value.request).success, false);
    }
    const old = offline(), current = records("NORMAL", "DIRECT");
    const modern = [current.proposed, current.approved, current.consumed, current.completed].map(value => productionReceiptSchema.parse(value));
    await writeJournal(dir, [old, ...values, ...modern], false);
    const path = join(dir, "receipts.jsonl"), original = await readFile(path, "utf8");
    const store = await ApprovalStore.open(dir);
    try {
      const recovered = store.getProduction(last.request.requestId)!;
      assert.equal("origin" in recovered.request, false);
      assert.deepEqual(recovered.request, last.request); assert.equal(recovered.digest, last.digest);
      assert.equal(recovered.state, length === 4 ? "SUCCEEDED" : length === 3 ? "UNKNOWN" : "EXPIRED");
      assert.deepEqual(store.list(), [old]);
      await assert.rejects(store.appendProduction(last as unknown as ProductionReceipt, true), rejects("INVALID_INPUT"));
      const legacy = legacyRecords();
      await assert.rejects(store.consumeProduction(legacy[2].consumption! as unknown as NonNullable<ProductionReceipt["consumption"]>, true), rejects("INVALID_INPUT"));
      await assert.rejects(store.ingestProductionReceipt(legacy[3].result! as unknown as NonNullable<ProductionReceipt["result"]>, true), rejects("INVALID_INPUT"));
    } finally { await store.close(); }
    assert.ok((await readFile(path, "utf8")).startsWith(original));
    const first = await verifyChain(dir);
    assert.equal(first.length, 1 + length + 4 + (length === 4 ? 0 : 1));
    const reopened = await ApprovalStore.open(dir); await reopened.close();
    assert.deepEqual(await verifyChain(dir), first);
  }
});

test("production Store: caller booleans/signatures/verifiers never enable Host admission", async t => {
  const dir = await directory(), store = await ApprovalStore.open(dir);
  t.after(() => store.close());
  for (const origin of ["DIRECT", "CODEX_DERIVED"] as const) {
    const r = records("NORMAL", origin);
    for (const evidence of [undefined, true, { trusted: true }, { signature: "synthetic" }, r.proposed.request.admission,
      { verifyTransition: async () => undefined }]) {
      await assert.rejects(store.appendProduction(r.proposed, evidence), rejects("BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED"));
    }
    await assert.rejects(store.consumeProduction(r.consumed.consumption!, true), rejects("REQUEST_UNKNOWN"));
    await assert.rejects(store.ingestProductionReceipt(r.completed.result!, true), rejects("REQUEST_UNKNOWN"));
    await assert.rejects(store.append(r.proposed as unknown as Receipt), rejects("INVALID_INPUT"));
  }
  assert.throws(() => PowerShellApprovalBroker.production(), rejects("BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED"));
  assert.equal(PowerShellApprovalBroker.status().enabled, false);
  assert.equal(await readFile(join(dir, "receipts.jsonl"), "utf8"), "");
});

test("production Store: restart expires unused records, consumed becomes durable UNKNOWN in the same chain", async () => {
  for (const origin of ["DIRECT", "CODEX_DERIVED"] as const) for (const phase of ["proposed", "approved", "consumed", "completed"] as const) {
    const dir = await directory(), r = records("NORMAL", origin), old = offline();
    const values = [r.proposed, r.approved, r.consumed, r.completed].slice(0, ["proposed", "approved", "consumed", "completed"].indexOf(phase) + 1);
    await writeJournal(dir, [old, ...values]);
    const store = await ApprovalStore.open(dir);
    const recovered = store.getProduction(r.proposed.request.requestId)!;
    assert.equal(recovered.state, phase === "completed" ? "SUCCEEDED" : phase === "consumed" ? "UNKNOWN" : "EXPIRED");
    assert.equal(store.get(r.proposed.request.requestId), undefined);
    assert.deepEqual(store.list(), [old]); assert.equal(store.getProduction(old.request.requestId), undefined);
    if (phase === "consumed") {
      await assert.rejects(store.consumeProduction(r.consumed.consumption!, true));
      await assert.rejects(store.ingestProductionReceipt(r.completed.result!, true), rejects("INVALID_TRANSITION"));
    }
    await store.close();
    const first = await verifyChain(dir);
    assert.equal(first.length, values.length + 1 + (phase === "completed" ? 0 : 1));
    const reopened = await ApprovalStore.open(dir);
    assert.deepEqual(reopened.getProduction(r.proposed.request.requestId), recovered);
    await reopened.close(); assert.deepEqual(await verifyChain(dir), first);
  }
});

test("production Store: duplicate nonce/ceremony/grant/observation and cross-contract identities reject replay", async () => {
  for (const field of ["nonce", "ceremony", "grant", "observation", "idempotency", "receipt"] as const) {
    const dir = await directory(), a = records(), b = records("NORMAL", "DIRECT");
    const br = b.proposed.request;
    if (field === "nonce") br.nonce = a.proposed.request.nonce;
    if (field === "ceremony") br.approvalIdentity.ceremonyId = a.proposed.request.approvalIdentity.ceremonyId;
    if (field === "observation") br.admission.observationId = a.proposed.request.admission.observationId;
    if (field === "idempotency") br.idempotencyKey = a.proposed.request.idempotencyKey;
    if (field === "receipt") br.receiptId = a.proposed.request.receiptId;
    b.proposed.digest = digest(br); b.approved.digest = digest(br); b.approved.grant!.binding = productionBindingOf(br);
    if (field === "grant") b.approved.grant!.grantId = a.approved.grant!.grantId;
    await writeJournal(dir, [a.proposed, a.approved, b.proposed, b.approved]);
    await assert.rejects(ApprovalStore.open(dir), rejects("IDENTITY_REPLAY"));
  }
  const dir = await directory(), old = offline(), r = records();
  r.proposed.request.requestId = old.request.requestId; r.proposed.digest = digest(r.proposed.request);
  await writeJournal(dir, [old, r.proposed]);
  await assert.rejects(ApprovalStore.open(dir), rejects("CONTRACT_MISMATCH"));
});

test("production Store: corrupt tail/hash, sequence gap and replayed consume fail closed", async () => {
  for (const corruption of ["tail", "hash", "sequence", "consume"] as const) {
    const dir = await directory(), r = records();
    await writeJournal(dir, [r.proposed, r.approved, r.consumed, ...(corruption === "consume" ? [{ ...r.consumed, revision: 4 }] : [])]);
    const path = join(dir, "receipts.jsonl"), content = await readFile(path, "utf8");
    if (corruption !== "consume") await writeFile(path, corruption === "tail" ? content + "partial"
      : corruption === "sequence" ? content.replace('"seq":2', '"seq":9') : content.replace('"hash":"', '"hash":"0'), "utf8");
    await assert.rejects(ApprovalStore.open(dir));
  }
});

test("shared Store: concurrent writes serialize and detach caller data; close waits for fsync", async t => {
  const dir = await directory(), store = await ApprovalStore.open(dir), r = offline();
  t.after(() => store.close());
  const a = store.append(r), b = store.append(r);
  r.request.turnId = "mutated-after-call";
  const settled = await Promise.allSettled([a, b]);
  assert.deepEqual(settled.map(x => x.status), ["fulfilled", "rejected"]);
  const second = store.append(offline());
  await store.close(); await second;
  assert.equal((await verifyChain(dir)).length, 2);
  const reopened = await ApprovalStore.open(dir);
  assert.equal(reopened.list()[0].request.turnId, "offline-turn"); await reopened.close();
});

test("shared Store: fsync failure faults the owner, retains lock and cannot retry", async t => {
  const dir = await directory(), store = await ApprovalStore.open(dir);
  t.after(() => store.close());
  const probe = await open(join(dir, "sync-probe"), "wx");
  const prototype = Object.getPrototypeOf(probe); await probe.close();
  const sync = t.mock.method(prototype, "sync", async () => { throw new Error("injected fsync failure"); });
  await assert.rejects(store.append(offline()), rejects("PERSISTENCE_UNCERTAIN"));
  sync.mock.restore();
  await assert.rejects(store.append(offline()), rejects("STORE_UNAVAILABLE"));
  assert.throws(() => store.list(), rejects("STORE_UNAVAILABLE"));
  await store.close();
  await assert.rejects(ApprovalStore.open(dir), rejects("STORE_LOCKED"));
});
