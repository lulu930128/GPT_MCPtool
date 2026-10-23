import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { checkMigrationApprovals } from "../scripts/check-migration-approvals.mjs";
import { inspectApprovalJournal } from "../dist/src/powershell-approval/store.js";
import { digest, sha256, TTL_MS, RECEIPT_TTL_MS, PRODUCTION_POLICY,
  productionBindingOf, productionRequestSchema, productionJournalReceiptSchema } from "../dist/src/powershell-approval/contract.js";
import { REVIEW_KIND, REVIEW_TTL_MS, reviewRequestSchema, reviewReceiptSchema } from "../dist/src/powershell-approval/review-contract.js";

const at = 1_700_000_000_000;
function review() {
  const scriptSnapshot = "# inert migration fixture";
  const request = reviewRequestSchema.parse({ version: 1, evidence: REVIEW_KIND, requestId: randomUUID(), receiptId: randomUUID(),
    idempotencyKey: randomUUID(), origin: "DIRECT", projectId: "fixture", dataClassification: "personal",
    userIntent: "EXPLICIT_USER_REQUEST", contentPolicy: "PERSONAL_PUBLIC_NO_SECRETS_OR_REGULATED_ORDERS",
    target: "fixture", executionMode: "NORMAL", cwd: "C:\\fixture", scriptSnapshot, scriptSha256: sha256(scriptSnapshot),
    scriptEncoding: "UTF8_EXACT", args: [], risk: "no execution", sideEffects: "none", createdAt: at,
    ttlMs: REVIEW_TTL_MS, expiresAt: at + REVIEW_TTL_MS, cause: "UNKNOWN", permissionAttribution: "UNVERIFIED" });
  return reviewReceiptSchema.parse({ kind: REVIEW_KIND, request, digest: digest(request), state: "PENDING",
    reason: "REVIEW_PENDING_NONEXECUTABLE", revision: 1, updatedAt: at, executionDispatched: false,
    productionAuthorized: false, executionPolicy: { NORMAL: "OFF", ADMIN: "OFF" } });
}
function journal(receipts) {
  let previous = "GENESIS";
  return receipts.map((receipt, index) => {
    const entry = { seq: index + 1, previous, receipt }; previous = digest(entry);
    return JSON.stringify({ ...entry, hash: previous }) + "\n";
  }).join("");
}
function production() {
  // Inert record shapes follow powershell-production-contract.test.ts; no Host or runner.
  const authority = { hostId: randomUUID(), instanceId: randomUUID(), sid: "S-1-5-21-1000", logonId: "0000000000000001",
    pid: 100, processStartedAt: at - 1000, imageSha256: sha256("image"), tokenId: "description", integrity: "MEDIUM" };
  const executor = { ...authority, instanceId: randomUUID(), pid: 101 };
  const evidence = (peer = authority, observedAt = at) => ({ source: "WINDOWS_HOST_PEER", observationId: randomUUID(),
    channelBinding: sha256("channel"), observedAt, peer });
  const request = productionRequestSchema.parse({ version: 2, evidence: "PRODUCTION", policy: PRODUCTION_POLICY,
    requestId: randomUUID(), receiptId: randomUUID(), idempotencyKey: randomUUID(), bootId: randomUUID(), origin: "DIRECT",
    projectId: "fixture", executionMode: "NORMAL", target: "fixture", scriptSnapshot: "# inert",
    scriptSha256: sha256("# inert"), scriptEncoding: "UTF8_EXACT", cwd: "C:\\fixture", args: [],
    environmentPolicyDigest: sha256("empty"), sideEffects: "none", risk: "no execution", createdAt: at,
    ttlMs: TTL_MS, expiresAt: at + TTL_MS, nonce: randomUUID(), approvalIdentity: { authority, subjectSid: authority.sid,
      ceremonyId: randomUUID(), interface: "CHATGPT_APP_ONLY", authentication: "FRESH_PASSWORD_EACH_REQUEST" },
    executorIdentity: executor, admission: evidence() });
  const proposed = { request, digest: digest(request), state: "PROPOSED", reason: "CREATED", revision: 1, updatedAt: at };
  const binding = productionBindingOf(request);
  const approved = { ...proposed, state: "APPROVED", reason: "HOST_APPROVED", revision: 2, updatedAt: at + 1,
    grant: { grantId: randomUUID(), binding, approvedAt: at + 1, approval: evidence(authority, at + 1), osAuthorization: "WINDOWS_STANDARD_TOKEN" } };
  const consumed = { ...approved, state: "CONSUMED", reason: "GRANT_CONSUMED", revision: 3, updatedAt: at + 2,
    consumption: { consumptionId: randomUUID(), grantId: approved.grant.grantId, binding, consumedAt: at + 2,
      receiptDeadline: at + 2 + RECEIPT_TTL_MS, executor: evidence(executor, at + 2) } };
  const succeeded = { ...consumed, state: "SUCCEEDED", reason: "RECEIPT_INGESTED", revision: 4, updatedAt: at + 3,
    result: { grantId: approved.grant.grantId, consumptionId: consumed.consumption.consumptionId, binding,
      executor: evidence(executor, at + 3), completedAt: at + 3, outcome: "SUCCEEDED", exitCode: 0, outputSha256: sha256("") } };
  const unknown = { ...consumed, state: "UNKNOWN", reason: "DELIVERY_UNCERTAIN", revision: 4, updatedAt: at + 3 };
  return Object.fromEntries(Object.entries({ proposed, approved, consumed, succeeded, unknown })
    .map(([key, value]) => [key, productionJournalReceiptSchema.parse(value)]));
}

test("expired persisted PENDING uses the existing effective expiry, without changing bytes", t => {
  const content = journal([review()]), before = sha256(content);
  t.mock.method(Date, "now", () => at + REVIEW_TTL_MS);
  assert.deepEqual(checkMigrationApprovals(content), { ok: true, entries: 1, requests: 1, expiredReviews: 1 });
  assert.equal(sha256(content), before);
});
test("a genuinely pending Review still blocks", t => {
  t.mock.method(Date, "now", () => at + REVIEW_TTL_MS - 1);
  assert.throws(() => checkMigrationApprovals(journal([review()])), /MIGRATION_APPROVAL_NOT_TERMINAL/);
});
test("untrusted or backward clocks cannot expire a Review", t => {
  const content = journal([review()]);
  for (const now of [NaN, Infinity, at - 1, Number.MAX_SAFE_INTEGER]) {
    const mock = t.mock.method(Date, "now", () => now);
    assert.throws(() => checkMigrationApprovals(content), /CLOCK_UNTRUSTED/); mock.mock.restore();
  }
  let calls = 0;
  t.mock.method(Date, "now", () => ++calls < 3 ? at + REVIEW_TTL_MS : at + REVIEW_TTL_MS - 1);
  assert.throws(() => checkMigrationApprovals(content), /CLOCK_UNTRUSTED/);
});
test("schema, identity, non-executable flags and TTL must all remain valid", () => {
  for (const mutate of [r => { r.productionAuthorized = true; }, r => { r.executionDispatched = true; },
    r => { r.executionPolicy.NORMAL = "ON"; }, r => { r.request.expiresAt++; r.digest = digest(r.request); },
    r => { r.request.requestId = "invalid"; r.digest = digest(r.request); }, r => { r.kind = "PRODUCTION"; },
    r => { r.state = "UNKNOWN"; }, r => { r.digest = "0".repeat(64); }]) {
    const r = review(); mutate(r); assert.throws(() => checkMigrationApprovals(journal([r])));
  }
});
test("corrupt chain, truncation, replayed identity and impossible transitions block", () => {
  const r = review(), content = journal([r]);
  assert.throws(() => inspectApprovalJournal(content.replace('"seq":1', '"seq":2')), /STORE_CORRUPT/);
  assert.throws(() => inspectApprovalJournal(content.slice(0, -1)), /STORE_CORRUPT/);
  assert.throws(() => inspectApprovalJournal(journal([r, r])), /INVALID_TRANSITION/);
  const second = review(); second.request.idempotencyKey = r.request.idempotencyKey; second.digest = digest(second.request);
  assert.throws(() => inspectApprovalJournal(journal([r, second])), /IDENTITY_REPLAY/);
});
test("latest terminal Review is accepted through canonical transition validation", () => {
  for (const state of ["ACCEPTED", "DECLINED", "EXPIRED"]) {
    const r = review();
    const next = { ...r, state, reason: `REVIEW_${state}_NONEXECUTABLE`, revision: 2,
      updatedAt: state === "EXPIRED" ? r.request.expiresAt : at + 1 };
    assert.equal(checkMigrationApprovals(journal([r, next])).requests, 1);
  }
});
test("Production PROPOSED, APPROVED, CONSUMED and UNKNOWN block even after TTL", () => {
  const p = production();
  for (const rows of [[p.proposed], [p.proposed, p.approved], [p.proposed, p.approved, p.consumed],
    [p.proposed, p.approved, p.consumed, p.unknown]]) {
    assert.throws(() => checkMigrationApprovals(journal(rows)), /MIGRATION_APPROVAL_NOT_TERMINAL/);
  }
  assert.equal(checkMigrationApprovals(journal([p.proposed, p.approved, p.consumed, p.succeeded])).ok, true);
});
test("CLI and PowerShell migration caller read the same journal without Store creation", () => {
  const root = mkdtempSync(join(tmpdir(), "migration-approvals-"));
  const directory = join(root, "powershell-approval"); mkdirSync(directory);
  const path = join(directory, "receipts.jsonl"), content = journal([review()]); writeFileSync(path, content);
  const check = spawnSync(process.execPath, [resolve("scripts/check-migration-approvals.mjs"), path], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const ps = spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-Command",
    `$ErrorActionPreference='Stop'; . ${quote(resolve("scripts/installed-runtime-migration.ps1"))}; Assert-MigrationApprovalsIdle ${quote(root)} ${quote(process.execPath)}`], { encoding: "utf8" });
  assert.equal(ps.status, 0, ps.stdout + ps.stderr);
  assert.equal(readFileSync(path, "utf8"), content); assert.equal(existsSync(join(directory, "approval.lock")), false);
});
