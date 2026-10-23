import { createHash } from "node:crypto";
import { z } from "zod";

export const TTL_MS = 120_000;
export const CHALLENGE_TTL_MS = 30_000;
export const OUTPUT_LIMIT = 4096;
export const RUN_TIMEOUT_MS = 5000;
export const MAX_REQUESTS = 100;
export const POLICY = "powershell-approval-fixture-v1";
export const modeSchema = z.enum(["NORMAL", "ADMIN"]);
const id = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export const digest = (value: unknown) => sha256(JSON.stringify(value));
export class ApprovalError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ApprovalError"; }
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApprovalError("INVALID_INPUT");
  return result.data;
}

// Immutable harmless artifact only. No caller-selected command, file, args, path or environment.
// Identity is checked before emitting the marker; NORMAL never attempts elevation.
export const MARKER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
  "$principal = New-Object Security.Principal.WindowsPrincipal($identity)",
  "$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
  "if ($elevated) { exit 77 }",
  "[Console]::Out.WriteLine((@{ marker = 'CODEX_NORMAL_SYNTHETIC_V1'; sid = $identity.User.Value; elevated = $elevated; pid = $PID } | ConvertTo-Json -Compress))",
].join("\n");

export const proposalInputSchema = z.object({
  idempotencyKey: id, projectId: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
  jobId: id, turnId: z.string().min(1).max(128), executionMode: modeSchema,
  artifactId: z.literal("fixture.marker.v1"),
}).strict();
export type ProposalInput = z.infer<typeof proposalInputSchema>;
// Supplied by a local evidence adapter, never from MCP request text or an auth boolean.
export const failureSchema = z.object({
  source: z.literal("OFFLINE_FIXTURE"), eventId: id, jobId: id, turnId: z.string().min(1).max(128),
  classification: z.enum(["SANDBOX_POLICY", "JOB_OBJECT", "OS_PERMISSION", "UNCLASSIFIED"]),
  code: z.enum(["FIXTURE_SANDBOX_DENIED", "FIXTURE_JOB_RESTRICTED", "FIXTURE_OS_DENIED", "FIXTURE_UNKNOWN"]),
  observedAt: z.number().int().nonnegative(), evidenceSha256: hash,
}).strict().superRefine((e, ctx) => {
  const classification = { FIXTURE_SANDBOX_DENIED: "SANDBOX_POLICY", FIXTURE_JOB_RESTRICTED: "JOB_OBJECT",
    FIXTURE_OS_DENIED: "OS_PERMISSION", FIXTURE_UNKNOWN: "UNCLASSIFIED" }[e.code];
  if (classification !== e.classification) ctx.addIssue({ code: "custom", message: "Failure evidence mismatch" });
});
export type FailureEvidence = z.infer<typeof failureSchema>;
export const requestSchema = proposalInputSchema.extend({
  version: z.literal(1), evidence: z.literal("OFFLINE_ONLY"), policy: z.literal(POLICY),
  requestId: id, receiptId: id, bootId: id, createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  failureEvidence: failureSchema, executorId: z.literal("offline-normal-marker"),
  expectedSid: z.string().regex(/^S-1-5-(?:\d+-)*\d+$/).max(184),
  cwd: z.string().min(1).max(512), target: z.literal("isolated-fixture-process"),
  scriptSnapshot: z.literal(MARKER_SCRIPT), scriptSha256: z.literal(sha256(MARKER_SCRIPT)),
  args: z.tuple([]), environmentPolicy: z.literal("WINDOWS_SYSTEM_ONLY"),
  sideEffects: z.literal("stdout marker only; no file/network/system mutation"),
  risk: z.literal("offline fixture; no host authorization"),
  timeoutMs: z.literal(RUN_TIMEOUT_MS), outputLimitBytes: z.literal(OUTPUT_LIMIT),
}).strict().superRefine((r, ctx) => {
  if (r.expiresAt !== r.createdAt + TTL_MS || r.jobId !== r.failureEvidence.jobId
    || r.turnId !== r.failureEvidence.turnId || r.failureEvidence.observedAt > r.createdAt
    || r.createdAt - r.failureEvidence.observedAt > TTL_MS) ctx.addIssue({ code: "custom", message: "Binding mismatch" });
});
export type ExecutionRequest = z.infer<typeof requestSchema>;
export const states = ["PROPOSED", "REVIEW_PENDING", "APPROVED", "DENIED", "EXPIRED", "DISPATCHING", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN"] as const;
export const resultSchema = z.object({
  evidence: z.enum(["SYNTHETIC", "LOCAL_INHERITED_PROCESS"]),
  requestId: id, digest: hash, executionMode: z.literal("NORMAL"), executorId: z.literal("offline-normal-marker"),
  sid: z.string().regex(/^S-1-5-(?:\d+-)*\d+$/).max(184), elevated: z.literal(false), pid: z.number().int().positive(),
  ownership: z.literal("INHERITED_NOT_HOST_ACCEPTED"), exitCode: z.number().int(),
  outcome: z.enum(["SUCCEEDED", "FAILED", "UNKNOWN"]),
  code: z.enum(["MARKER_CONFIRMED", "NONZERO_EXIT", "TIMEOUT", "OUTPUT_LIMIT", "IDENTITY_REJECTED", "RESULT_REJECTED", "SPAWN_FAILED"]),
  marker: z.enum(["CODEX_NORMAL_SYNTHETIC_V1", ""]),
  stdoutBytes: z.number().int().min(0).max(OUTPUT_LIMIT + 1), stderrBytes: z.number().int().min(0).max(OUTPUT_LIMIT + 1),
}).strict().superRefine((r, ctx) => {
  const valid = r.outcome === "SUCCEEDED" ? r.exitCode === 0 && r.marker === "CODEX_NORMAL_SYNTHETIC_V1" && r.code === "MARKER_CONFIRMED"
    : r.outcome === "FAILED" ? r.exitCode !== 0 && r.marker === "" && r.code === "NONZERO_EXIT"
      : r.marker === "" && r.code !== "MARKER_CONFIRMED";
  if (!valid || r.stdoutBytes + r.stderrBytes > OUTPUT_LIMIT) ctx.addIssue({ code: "custom", message: "Inconsistent result" });
});
export type RunnerResult = z.infer<typeof resultSchema>;
export const receiptSchema = z.object({
  request: requestSchema, digest: hash, state: z.enum(states),
  revision: z.number().int().positive(), updatedAt: z.number().int().nonnegative(),
  reason: z.enum(["CREATED", "REVIEW_OPENED", "PASSWORD_VERIFIED_OFFLINE", "HUMAN_DENIED", "AUTH_ATTEMPTS_EXHAUSTED", "TTL_EXPIRED", "RESTART_EXPIRED", "DELIVERY_INTENT", "RUNNER_ENTERED", "RESULT_RETURNED", "RUNNER_UNCERTAIN", "RESTART_UNCERTAIN"]),
  approvalEventId: id.optional(), result: resultSchema.optional(),
  runnerError: z.enum(["TIMEOUT", "OUTPUT_LIMIT", "IDENTITY_REJECTED", "RESULT_REJECTED", "SPAWN_FAILED", "NONZERO_EXIT", "TTL_EXPIRED", "FAILURE_NOT_QUALIFIED", "SCOPE_REJECTED", "EXECUTABLE_REJECTED", "RUNNER_UNCERTAIN"]).optional(),
}).strict().superRefine((r, ctx) => {
  const executed = ["DISPATCHING", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(r.state);
  const allowedReasons: Record<typeof states[number], readonly string[]> = {
    PROPOSED: ["CREATED"], REVIEW_PENDING: ["REVIEW_OPENED"], APPROVED: ["PASSWORD_VERIFIED_OFFLINE"],
    DENIED: ["HUMAN_DENIED", "AUTH_ATTEMPTS_EXHAUSTED"], EXPIRED: ["TTL_EXPIRED", "RESTART_EXPIRED"],
    DISPATCHING: ["DELIVERY_INTENT"], RUNNING: ["RUNNER_ENTERED"], SUCCEEDED: ["RESULT_RETURNED"], FAILED: ["RESULT_RETURNED"],
    UNKNOWN: ["RESULT_RETURNED", "RUNNER_UNCERTAIN", "RESTART_UNCERTAIN"],
  };
  if (r.digest !== digest(r.request) || r.updatedAt < r.request.createdAt
    || !allowedReasons[r.state].includes(r.reason)
    || (r.runnerError && r.state !== "UNKNOWN")
    || (r.approvalEventId && ["PROPOSED", "REVIEW_PENDING", "DENIED"].includes(r.state))
    || ((r.state === "APPROVED" || executed) && r.request.executionMode !== "NORMAL")
    || ((r.state === "APPROVED" || executed) && !r.approvalEventId)
    || (r.result && (r.result.requestId !== r.request.requestId || r.result.digest !== r.digest
      || r.result.sid !== r.request.expectedSid || r.result.executionMode !== r.request.executionMode
      || r.result.outcome !== r.state || (r.result.outcome === "SUCCEEDED" && (r.result.exitCode !== 0 || r.result.marker !== "CODEX_NORMAL_SYNTHETIC_V1" || r.result.code !== "MARKER_CONFIRMED"))))
    || (["SUCCEEDED", "FAILED"].includes(r.state) && !r.result)
    || (r.result && !["SUCCEEDED", "FAILED", "UNKNOWN"].includes(r.state))) ctx.addIssue({ code: "custom", message: "Invalid receipt" });
});
export type Receipt = z.infer<typeof receiptSchema>;
// V1 names and OFFLINE_ONLY wire values remain unchanged for existing fixtures.
export const offlineFixtureRequestSchema = requestSchema;
export const offlineFixtureReceiptSchema = receiptSchema;

export const PRODUCTION_POLICY = "powershell-approval-production-v1";
export const RECEIPT_TTL_MS = 120_000;
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - TTL_MS - RECEIPT_TTL_MS);
const sid = z.string().regex(/^S-1-5-(?:\d+-)*\d+$/).max(184);
export const identity = z.object({
  hostId: id, instanceId: id, sid, logonId: z.string().regex(/^[a-f0-9]{16}$/),
  pid: z.number().int().positive(), processStartedAt: timestamp,
  imageSha256: hash, tokenId: z.string().min(1).max(128),
  integrity: z.enum(["MEDIUM", "HIGH"]),
}).strict();
// These are audit descriptions, NOT proof. Parsing or signing them confers no authority.
export const hostPeerEvidenceSchema = z.object({
  source: z.literal("WINDOWS_HOST_PEER"), observationId: id,
  channelBinding: hash, observedAt: timestamp, peer: identity,
}).strict();
export type HostPeerEvidence = z.infer<typeof hostPeerEvidenceSchema>;
const approvalIdentityBase = z.object({
  authority: identity, subjectSid: sid, ceremonyId: id,
});
const approvalIdentitySchema = z.union([
  approvalIdentityBase.extend({ interface: z.literal("CHATGPT_APP_ONLY"), authentication: z.literal("FRESH_PASSWORD_EACH_REQUEST") }).strict(),
  approvalIdentityBase.extend({ interface: z.literal("WINDOWS_LOCAL_HOST"), authentication: z.literal("EXACT_REQUEST_CONFIRMATION") }).strict(),
  approvalIdentityBase.extend({ interface: z.literal("REMOTE_MCP_REQUEST"), authentication: z.literal("AUTHENTICATED_DIRECT_REQUEST") }).strict(),
]);
// Missing origin identifies the historical, undeployed V2 wire format. Preserve its
// key order for hashed journal replay; never default/transform it into a new origin.
const legacyProductionRequestObject = z.object({
  version: z.literal(2), evidence: z.literal("PRODUCTION"), policy: z.literal(PRODUCTION_POLICY),
  requestId: id, receiptId: id, idempotencyKey: id, bootId: id,
  jobId: id, turnId: z.string().min(1).max(128), projectId: proposalInputSchema.shape.projectId,
  executionMode: modeSchema, target: z.string().min(1).max(1024),
  // Exact UTF-8 bytes: no trim, line-ending conversion or Unicode normalization.
  scriptSnapshot: z.string().min(1).max(65536).refine(s => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s)),
  scriptSha256: hash, scriptEncoding: z.literal("UTF8_EXACT"),
  cwd: z.string().min(1).max(1024), args: z.array(z.string().max(4096)).max(64),
  environmentPolicyDigest: hash, sideEffects: z.string().min(1).max(4096), risk: z.string().min(1).max(4096),
  createdAt: timestamp, ttlMs: z.literal(TTL_MS), expiresAt: timestamp, nonce: id,
  approvalIdentity: approvalIdentitySchema, executorIdentity: identity,
  admission: hostPeerEvidenceSchema,
}).strict();
function validateProductionRequest(r: z.infer<typeof legacyProductionRequestObject> | ProductionRequestData, ctx: z.RefinementCtx) {
  if (r.scriptSha256 !== sha256(r.scriptSnapshot) || r.expiresAt !== r.createdAt + r.ttlMs
    || r.admission.observedAt !== r.createdAt
    || digest(r.admission.peer) !== digest(r.approvalIdentity.authority)
    || r.executorIdentity.hostId !== r.approvalIdentity.authority.hostId
    || r.executorIdentity.sid !== r.approvalIdentity.subjectSid
    || r.executorIdentity.integrity !== (r.executionMode === "ADMIN" ? "HIGH" : "MEDIUM")
    || r.executorIdentity.processStartedAt > r.createdAt || r.admission.peer.processStartedAt > r.createdAt) {
    ctx.addIssue({ code: "custom", message: "Production request binding mismatch" });
  }
}
const legacyProductionRequestSchema = legacyProductionRequestObject.superRefine(validateProductionRequest);
const eventIdentity = z.string().min(1).max(128).refine(value => value.trim().length > 0);
/** Required provenance descriptions, NOT trusted evidence by virtue of parsing.
 * A future canonical Host must resolve the exact saved event, verify its digest,
 * Job/Turn/Project/Thread/Item and structured fault attribution independently.
 * OBSERVED_NONZERO, free-form errors and the offline adapter are not qualified. */
export const productionFailureEvidenceSchema = z.object({
  source: z.literal("BRIDGE_CANONICAL_JOB_EVENT"), eventId: id,
  jobId: id, turnId: eventIdentity, projectId: proposalInputSchema.shape.projectId,
  threadId: eventIdentity, itemId: eventIdentity, observedAt: timestamp, evidenceSha256: hash,
  fault: z.discriminatedUnion("classification", [
    z.object({ classification: z.literal("SANDBOX_POLICY"), code: z.literal("SANDBOX_POLICY_DENIED") }).strict(),
    z.object({ classification: z.literal("JOB_OBJECT"), code: z.literal("JOB_OBJECT_RESTRICTION") }).strict(),
    z.object({ classification: z.literal("OS_PERMISSION"), code: z.literal("OS_ACCESS_DENIED") }).strict(),
  ]),
}).strict();
const productionRequestBase = legacyProductionRequestObject.omit({ jobId: true, turnId: true }).extend({
  // Additive for journal compatibility. New Host-port admission requires this
  // canonical link; historical V2 remains readable, never newly executable.
  sourceReview: z.object({ requestId: id, digest: hash }).strict().optional(),
});
const productionRequestDataSchema = z.discriminatedUnion("origin", [
  productionRequestBase.extend({ origin: z.literal("DIRECT") }).strict(),
  productionRequestBase.extend({ origin: z.literal("CODEX_DERIVED"), jobId: id, turnId: eventIdentity,
    failureEvidence: productionFailureEvidenceSchema }).strict(),
]);
type ProductionRequestData = z.infer<typeof productionRequestDataSchema>;
export const productionRequestSchema = productionRequestDataSchema.superRefine((r, ctx) => {
  validateProductionRequest(r, ctx);
  if (r.origin === "CODEX_DERIVED") {
    const e = r.failureEvidence;
    if (e.jobId !== r.jobId || e.turnId !== r.turnId || e.projectId !== r.projectId
      || e.observedAt > r.createdAt || r.createdAt - e.observedAt > TTL_MS) {
      ctx.addIssue({ code: "custom", message: "Production fault evidence binding mismatch" });
    }
  }
});
export type ProductionRequest = z.infer<typeof productionRequestSchema>;
const legacyProductionBindingSchema = z.object({
  requestId: id, receiptId: id, digest: hash, jobId: id, turnId: z.string().min(1).max(128),
  projectId: proposalInputSchema.shape.projectId, executionMode: modeSchema,
  target: z.string().min(1).max(1024), scriptSha256: hash, expiresAt: timestamp, nonce: id,
  approvalIdentity: approvalIdentitySchema, executorIdentity: identity,
}).strict();
function legacyProductionBindingOf(r: z.infer<typeof legacyProductionRequestSchema>) {
  return parse(legacyProductionBindingSchema, { requestId: r.requestId, receiptId: r.receiptId, digest: digest(r),
    jobId: r.jobId, turnId: r.turnId, projectId: r.projectId, executionMode: r.executionMode,
    target: r.target, scriptSha256: r.scriptSha256, expiresAt: r.expiresAt, nonce: r.nonce,
    approvalIdentity: r.approvalIdentity, executorIdentity: r.executorIdentity });
}
const productionBindingBase = legacyProductionBindingSchema.omit({ jobId: true, turnId: true });
export const productionBindingSchema = z.discriminatedUnion("origin", [
  productionBindingBase.extend({ origin: z.literal("DIRECT") }).strict(),
  productionBindingBase.extend({ origin: z.literal("CODEX_DERIVED"), jobId: id, turnId: eventIdentity,
    failureEvidenceDigest: hash }).strict(),
]);
export function productionBindingOf(request: ProductionRequest) {
  const r = parse(productionRequestSchema, request);
  return parse(productionBindingSchema, { requestId: r.requestId, receiptId: r.receiptId, digest: digest(r),
    projectId: r.projectId, executionMode: r.executionMode, target: r.target, scriptSha256: r.scriptSha256,
    expiresAt: r.expiresAt, nonce: r.nonce, approvalIdentity: r.approvalIdentity, executorIdentity: r.executorIdentity,
    ...(r.origin === "DIRECT" ? { origin: r.origin } : { origin: r.origin, jobId: r.jobId, turnId: r.turnId,
      failureEvidenceDigest: digest(r.failureEvidence) }) });
}
const legacyProductionGrantSchema = z.object({
  grantId: id, binding: legacyProductionBindingSchema, approvedAt: timestamp,
  approval: hostPeerEvidenceSchema,
  osAuthorization: z.enum(["WINDOWS_STANDARD_TOKEN", "WINDOWS_UAC_ELEVATED_TOKEN"]),
}).strict();
const legacyProductionConsumptionSchema = z.object({
  consumptionId: id, grantId: id, binding: legacyProductionBindingSchema,
  consumedAt: timestamp, receiptDeadline: timestamp, executor: hostPeerEvidenceSchema,
}).strict();
const legacyProductionResultObject = z.object({
  grantId: id, consumptionId: id, binding: legacyProductionBindingSchema, executor: hostPeerEvidenceSchema,
  completedAt: timestamp, outcome: z.enum(["SUCCEEDED", "FAILED", "UNKNOWN"]),
  exitCode: z.number().int().nullable(), outputSha256: hash,
}).strict();
function validateProductionResult(r: { outcome: string; exitCode: number | null }, ctx: z.RefinementCtx) {
  if ((r.outcome === "SUCCEEDED" && r.exitCode !== 0)
    || (r.outcome === "FAILED" && (r.exitCode === null || r.exitCode === 0))) {
    ctx.addIssue({ code: "custom", message: "Inconsistent production result" });
  }
}
const legacyProductionResultSchema = legacyProductionResultObject.superRefine(validateProductionResult);
const productionGrantSchema = legacyProductionGrantSchema.extend({ binding: productionBindingSchema });
export const productionConsumptionSchema = legacyProductionConsumptionSchema.extend({ binding: productionBindingSchema });
/** Native observation is still untrusted data until verified by the installed Host.
 * Store only bounded counters/hash, never raw stdout, stderr or secrets. */
export const normalExecutionObservationSchema = z.object({
  requestId: id, digest: hash, grantId: id, consumptionId: id,
  outcome: z.enum(["SUCCEEDED", "FAILED", "UNKNOWN"]),
  reason: z.enum(["PROCESS_EXITED", "OUTPUT_LIMIT", "TIMEOUT", "TERMINATION_UNCERTAIN", "OUTPUT_UNCERTAIN"]),
  exitCode: z.number().int().nullable(), outputSha256: hash, sid, logonId: identity.shape.logonId,
  processId: z.number().int().positive(), session: z.number().int().positive(),
  startedUtcTicks: z.string().regex(/^[1-9][0-9]{16,18}$/), completedAt: timestamp,
  elevated: z.literal(false), stdoutBytes: z.number().int().min(0).max(0xffffffff),
  stderrBytes: z.number().int().min(0).max(0xffffffff), outputTruncated: z.boolean(),
  verification: z.literal("OS_OBSERVATION_ONLY_NOT_INGESTED"),
}).strict().superRefine((r, ctx) => {
  validateProductionResult(r, ctx);
  if ((r.reason !== "PROCESS_EXITED" && r.outcome !== "UNKNOWN")
    || (r.outputTruncated && (r.reason !== "OUTPUT_LIMIT" || r.stdoutBytes + r.stderrBytes <= 16384
      || r.stdoutBytes + r.stderrBytes > 18432))
    || (r.reason === "OUTPUT_LIMIT" && !r.outputTruncated)) ctx.addIssue({ code: "custom", message: "Invalid native observation" });
});
export const productionResultSchema = legacyProductionResultObject.extend({ binding: productionBindingSchema,
  windowsExecution: normalExecutionObservationSchema.optional() }).superRefine((r, ctx) => {
  validateProductionResult(r, ctx);
  const os = r.windowsExecution;
  if (os && (r.binding.executionMode !== "NORMAL" || os.requestId !== r.binding.requestId || os.digest !== r.binding.digest
    || os.grantId !== r.grantId || os.consumptionId !== r.consumptionId || os.completedAt !== r.completedAt
    || os.outcome !== r.outcome || os.exitCode !== r.exitCode || os.outputSha256 !== r.outputSha256
    || os.sid !== r.binding.executorIdentity.sid || os.logonId !== r.binding.executorIdentity.logonId))
    ctx.addIssue({ code: "custom", message: "Native receipt binding mismatch" });
});
export const productionStates = ["PROPOSED", "APPROVED", "CONSUMED", "DENIED", "EXPIRED", "SUCCEEDED", "FAILED", "UNKNOWN"] as const;
const legacyProductionReceiptObject = z.object({
  request: legacyProductionRequestSchema, digest: hash, state: z.enum(productionStates),
  revision: z.number().int().positive(), updatedAt: timestamp,
  reason: z.enum(["CREATED", "HOST_APPROVED", "HOST_DENIED", "GRANT_CONSUMED", "RECEIPT_INGESTED",
    "TTL_EXPIRED", "RESTART_EXPIRED", "DELIVERY_UNCERTAIN", "RESTART_UNCERTAIN"]),
  grant: legacyProductionGrantSchema.optional(), consumption: legacyProductionConsumptionSchema.optional(),
  result: legacyProductionResultSchema.optional(), denial: hostPeerEvidenceSchema.optional(),
}).strict();
const productionReceiptObject = legacyProductionReceiptObject.extend({ request: productionRequestSchema,
  grant: productionGrantSchema.optional(), consumption: productionConsumptionSchema.optional(), result: productionResultSchema.optional() });
function validateProductionReceipt(r: z.infer<typeof legacyProductionReceiptObject> | z.infer<typeof productionReceiptObject>, ctx: z.RefinementCtx) {
  // A nested refinement may already have failed. Do not throw from safeParse by
  // attempting to derive a binding for that invalid request.
  if ("origin" in r.request && !productionRequestSchema.safeParse(r.request).success) return;
  const reasons: Record<typeof productionStates[number], readonly string[]> = {
    PROPOSED: ["CREATED"], APPROVED: ["HOST_APPROVED"], CONSUMED: ["GRANT_CONSUMED"],
    DENIED: ["HOST_DENIED"], EXPIRED: ["TTL_EXPIRED", "RESTART_EXPIRED"],
    SUCCEEDED: ["RECEIPT_INGESTED"], FAILED: ["RECEIPT_INGESTED"],
    UNKNOWN: ["RECEIPT_INGESTED", "DELIVERY_UNCERTAIN", "RESTART_UNCERTAIN"],
  };
  const binding = digest("origin" in r.request ? productionBindingOf(r.request) : legacyProductionBindingOf(r.request));
  const consumed = ["CONSUMED", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(r.state);
  const g = r.grant, c = r.consumption, result = r.result;
  let invalid = r.digest !== digest(r.request) || r.updatedAt < r.request.createdAt || !reasons[r.state].includes(r.reason)
    || (!!g !== (["APPROVED", "CONSUMED", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(r.state) || (r.state === "EXPIRED" && !!g)))
    || !!c !== consumed || !!r.denial !== (r.state === "DENIED")
    || !!result !== (r.reason === "RECEIPT_INGESTED")
    || (r.reason === "TTL_EXPIRED" && r.updatedAt < r.request.expiresAt)
    || (["PROPOSED", "APPROVED", "CONSUMED", "DENIED"].includes(r.state) && r.updatedAt >= r.request.expiresAt);
  if (g) invalid ||= digest(g.binding) !== binding || g.approvedAt < r.request.createdAt || g.approvedAt >= r.request.expiresAt
    || g.approvedAt > r.updatedAt || g.approval.observedAt !== g.approvedAt
    || digest(g.approval.peer) !== digest(r.request.approvalIdentity.authority)
    || g.approval.observationId === r.request.admission.observationId
    || (r.state === "APPROVED" && g.approvedAt !== r.updatedAt)
    || g.osAuthorization !== (r.request.executionMode === "ADMIN" ? "WINDOWS_UAC_ELEVATED_TOKEN" : "WINDOWS_STANDARD_TOKEN");
  if (c) invalid ||= !g || c.grantId !== g.grantId || digest(c.binding) !== binding
    || c.consumedAt < g.approvedAt || c.consumedAt >= r.request.expiresAt || c.consumedAt > r.updatedAt
    || c.receiptDeadline !== c.consumedAt + RECEIPT_TTL_MS || c.executor.observedAt !== c.consumedAt
    || digest(c.executor.peer) !== digest(r.request.executorIdentity);
  if (result) invalid ||= !c || result.grantId !== c.grantId || result.consumptionId !== c.consumptionId
    || digest(result.binding) !== binding || result.outcome !== r.state
    || digest(result.executor.peer) !== digest(r.request.executorIdentity)
    || result.completedAt < c.consumedAt || result.executor.observedAt !== result.completedAt
    || result.completedAt > r.updatedAt || r.updatedAt >= c.receiptDeadline;
  if (r.denial) invalid ||= digest(r.denial.peer) !== digest(r.request.approvalIdentity.authority)
    || r.denial.observedAt !== r.updatedAt;
  if (invalid) ctx.addIssue({ code: "custom", message: "Invalid production receipt" });
}
export const productionReceiptSchema = productionReceiptObject.superRefine(validateProductionReceipt);
export type ProductionReceipt = z.infer<typeof productionReceiptSchema>;
// Journal-only compatibility. No legacy wire value is accepted by new admission,
// consume or result APIs; replay/recovery retains the original request and digests.
export const legacyProductionReceiptSchema = legacyProductionReceiptObject.superRefine(validateProductionReceipt);
export const productionJournalReceiptSchema = z.union([productionReceiptSchema, legacyProductionReceiptSchema]);
export type ProductionJournalReceipt = z.infer<typeof productionJournalReceiptSchema>;
const productionTransitions: Record<ProductionReceipt["state"], readonly ProductionReceipt["state"][]> = {
  PROPOSED: ["APPROVED", "DENIED", "EXPIRED"], APPROVED: ["CONSUMED", "EXPIRED"],
  CONSUMED: ["SUCCEEDED", "FAILED", "UNKNOWN"], DENIED: [], EXPIRED: [], SUCCEEDED: [], FAILED: [], UNKNOWN: [],
};
/** Pure data validation only; NEVER a grant, peer verifier, signature or execution capability. */
export function validateProductionTransition(prior: ProductionReceipt | undefined, value: unknown): ProductionReceipt {
  const next = parse(productionReceiptSchema, value);
  validateProductionJournalTransition(prior && parse(productionReceiptSchema, prior), next);
  return next;
}
/** Replay/reducing-authority recovery only; this does not admit legacy writes. */
export function validateProductionJournalTransition(prior: ProductionJournalReceipt | undefined, value: unknown): ProductionJournalReceipt {
  const next = parse(productionJournalReceiptSchema, value);
  if (!prior) {
    if (next.state !== "PROPOSED" || next.revision !== 1 || next.updatedAt !== next.request.createdAt) throw new ApprovalError("INVALID_TRANSITION");
  } else if (prior.digest !== next.digest || digest(prior.request) !== digest(next.request)
    || next.revision !== prior.revision + 1 || next.updatedAt < prior.updatedAt
    || !productionTransitions[prior.state].includes(next.state)
    || (!prior.grant && next.grant && next.state !== "APPROVED")
    || (prior.grant && (!next.grant || digest(prior.grant) !== digest(next.grant)))
    || (prior.consumption && (!next.consumption || digest(prior.consumption) !== digest(next.consumption)))) throw new ApprovalError("INVALID_TRANSITION");
  return next;
}

/** Future protected Host must verify OS peer/token, installed owner, authenticated IPC,
 * fresh app-only human ceremony and exact binding. No password or credential enters this API.
 * This interface is NOT caller-injectable and has no operational implementation in this release. */
export interface TrustedProductionHost {
  verifyTransition(receipt: Readonly<ProductionReceipt>, transportEvidence: unknown): Promise<void>;
}
export function requireProductionHost(): never {
  throw new ApprovalError("BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED");
}

export const transitions: Record<Receipt["state"], readonly Receipt["state"][]> = {
  PROPOSED: ["REVIEW_PENDING", "EXPIRED"], REVIEW_PENDING: ["APPROVED", "DENIED", "EXPIRED"],
  APPROVED: ["DISPATCHING", "EXPIRED"], DISPATCHING: ["RUNNING", "UNKNOWN"], RUNNING: ["SUCCEEDED", "FAILED", "UNKNOWN"],
  DENIED: [], EXPIRED: [], SUCCEEDED: [], FAILED: [], UNKNOWN: [],
};
export function deploymentStatus() {
  return { contract: POLICY, enabled: false, deployment: "NOT_DEPLOYED", protectedHost: "UNVERIFIED",
    // Source declarations only; native Codex app visibility is not PowerShell approval or secret-channel proof.
    readiness: { evidence: "SOURCE_DECLARATION", appOnlyReview: "NATIVE_CODEX_ONLY",
      passwordChannel: "UNVERIFIED", windowsHost: "NOT_DEPLOYED", osAttestation: "UNVERIFIED" },
    executionPolicy: { NORMAL: "OFF", ADMIN: "OFF" },
    NORMAL: "BLOCKED_HOST_ACCEPTANCE", ADMIN: "BLOCKED_AWAITING_LOCAL_UAC",
    passwordStorage: "NOT_PROVISIONED", approval: "LOCAL_FIXTURE_ONLY", dynamicScripts: false,
    automaticResume: false, failureCapture: "OFFLINE_ADAPTER_ONLY" } as const;
}
