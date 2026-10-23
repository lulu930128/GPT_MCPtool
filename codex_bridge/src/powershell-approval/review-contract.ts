import { z } from "zod";
import { ApprovalError, digest, modeSchema, sha256 } from "./contract.js";
import { redactString } from "../redaction.js";
import { savedFailureEvidenceSchema } from "./failure-evidence.js";

export const REVIEW_KIND = "REVIEW_ONLY_NONEXECUTABLE";
export const REVIEW_TTL_MS = 10 * 60_000;
const id = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
// Reject rather than redact: review must preserve exact bytes. This is a bounded
// detector, not a proof that arbitrary text contains no secrets.
const sensitive = /password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|authorization|credential|private[ _-]?key|BEGIN .*PRIVATE KEY|\b(?:token|secret|cookie)\b|https?:\/\/[^\s/]+:[^\s/]+@|\b(?:place[_-]?order|submit[_-]?order|broker\.execute)\b|正式下單|受管制|-enc(?:odedcommand)?\b/i;
const text = (max: number) => z.string().min(1).max(max).refine(value =>
  redactString(value) === value && !sensitive.test(value) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value), "Unsafe review text");

export const reviewInputSchema = z.object({
  origin: z.enum(["DIRECT", "CODEX_DERIVED"]),
  projectId: text(32), dataClassification: z.enum(["personal", "public"]),
  jobId: id.optional(), turnId: text(128).optional(),
  sourceFailureItemId: text(128).optional(),
  userIntent: z.literal("EXPLICIT_USER_REQUEST"),
  contentPolicy: z.literal("PERSONAL_PUBLIC_NO_SECRETS_OR_REGULATED_ORDERS"),
  idempotencyKey: id,
  target: text(256), executionMode: modeSchema, cwd: text(1024),
  scriptSnapshot: text(8000), args: z.array(z.union([text(512), z.literal("")])).max(32),
  risk: text(2000), sideEffects: text(2000),
}).strict();
export type ReviewInput = z.infer<typeof reviewInputSchema>;
export function validateReviewOrigin(input: ReviewInput): void {
  if (input.origin === "DIRECT" ? input.jobId !== undefined || input.turnId !== undefined || input.sourceFailureItemId !== undefined : !input.jobId || !input.turnId)
    throw new ApprovalError("REVIEW_ORIGIN_MISMATCH");
}
export const reviewBindingSchema = z.object({ requestId: id, digest: hash }).strict();
export const reviewDecisionSchema = reviewBindingSchema.extend({
  decision: z.enum(["ACCEPTED", "DECLINED"]),
  // Required caller declaration; never evidence of a host modal or human identity.
  userIntent: z.literal("EXPLICIT_USER_DECISION"),
}).strict();
export const reviewRequestSchema = reviewInputSchema.extend({
  version: z.literal(1), evidence: z.literal(REVIEW_KIND), requestId: id, receiptId: id,
  createdAt: z.number().int().safe().nonnegative(), ttlMs: z.literal(REVIEW_TTL_MS), expiresAt: z.number().int().safe(),
  scriptSha256: hash, scriptEncoding: z.literal("UTF8_EXACT"),
  cause: z.literal("UNKNOWN"), permissionAttribution: z.literal("UNVERIFIED"),
  sourceFailure: savedFailureEvidenceSchema.optional(),
}).strict().superRefine((r, ctx) => {
  if (r.expiresAt !== r.createdAt + REVIEW_TTL_MS || r.scriptSha256 !== sha256(r.scriptSnapshot)
    || (r.origin === "DIRECT" ? r.jobId !== undefined || r.turnId !== undefined || r.sourceFailureItemId !== undefined || r.sourceFailure !== undefined : !r.jobId || !r.turnId)
    || (r.sourceFailureItemId !== undefined) !== (r.sourceFailure !== undefined)
    || (r.sourceFailure && (r.sourceFailure.jobId !== r.jobId || r.sourceFailure.projectId !== r.projectId
      || r.sourceFailure.turnId !== r.turnId || r.sourceFailure.itemId !== r.sourceFailureItemId)))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid review binding" });
});
export const reviewReasons = {
  PENDING: "REVIEW_PENDING_NONEXECUTABLE", ACCEPTED: "REVIEW_ACCEPTED_NONEXECUTABLE",
  DECLINED: "REVIEW_DECLINED_NONEXECUTABLE", EXPIRED: "REVIEW_EXPIRED_NONEXECUTABLE",
} as const;
export const reviewReceiptSchema = z.object({
  kind: z.literal(REVIEW_KIND), request: reviewRequestSchema, digest: hash,
  state: z.enum(["PENDING", "ACCEPTED", "DECLINED", "EXPIRED"]),
  reason: z.enum([reviewReasons.PENDING, reviewReasons.ACCEPTED, reviewReasons.DECLINED, reviewReasons.EXPIRED]),
  revision: z.number().int().min(1).max(2), updatedAt: z.number().int().safe(),
  executionDispatched: z.literal(false), productionAuthorized: z.literal(false),
  executionPolicy: z.object({ NORMAL: z.literal("OFF"), ADMIN: z.literal("OFF") }).strict(),
}).strict().superRefine((r, ctx) => {
  if (r.digest !== digest(r.request) || r.reason !== reviewReasons[r.state] || r.updatedAt < r.request.createdAt
    || (r.state === "PENDING" ? r.revision !== 1 || r.updatedAt !== r.request.createdAt : r.revision !== 2)
    || (r.state === "EXPIRED" ? r.updatedAt < r.request.expiresAt : r.updatedAt >= r.request.expiresAt))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid review receipt" });
});
export type ReviewReceipt = z.infer<typeof reviewReceiptSchema>;
export function validateReviewTransition(prior: ReviewReceipt | undefined, next: ReviewReceipt): void {
  if (!prior ? next.state !== "PENDING" : prior.state !== "PENDING" || next.state === "PENDING"
    || next.digest !== prior.digest || next.revision !== prior.revision + 1 || next.updatedAt < prior.updatedAt)
    throw new ApprovalError("INVALID_TRANSITION");
}
export function reviewSummary(r: ReviewReceipt) {
  const now = Date.now();
  const effectiveState = r.state === "PENDING" && now >= r.request.expiresAt ? "EXPIRED" : r.state;
  return { kind: r.kind, requestId: r.request.requestId, receiptId: r.request.receiptId, digest: r.digest,
    origin: r.request.origin, state: r.state, reason: r.reason, revision: r.revision,
    effectiveState, effectiveReason: reviewReasons[effectiveState],
    decisionAllowed: effectiveState === "PENDING" && Number.isSafeInteger(now) && now >= r.updatedAt,
    createdAt: r.request.createdAt, expiresAt: r.request.expiresAt, ttlMs: r.request.ttlMs, updatedAt: r.updatedAt,
    executionDispatched: r.executionDispatched, productionAuthorized: r.productionAuthorized,
    executionPolicy: r.executionPolicy, cause: r.request.cause, permissionAttribution: r.request.permissionAttribution };
}
