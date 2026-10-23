import { randomUUID } from "node:crypto";
import { ApprovalError, digest, parse, productionRequestSchema, productionResultSchema, normalExecutionObservationSchema,
  productionBindingOf } from "./contract.js";
import { ApprovalStore } from "./store.js";
import { reviewBindingSchema } from "./review-contract.js";
import { validatePowerShellScope, type ReviewContext } from "./review-tools.js";
import { projectRequestReceipt } from "./job-projection.js";
import type { NormalOutput } from "./normal-output.js";

// This is the single runtime's in-process Host port, not an MCP execution tool,
// listener, store or lifecycle owner. Deployment is verified by the installed
// transport. No public method manufactures transport authority from JSON.
export const NORMAL_ENVIRONMENT = Object.freeze({
  SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
});
export const NORMAL_POLICY = Object.freeze({ contract: "powershell-normal-execution-v1",
  authorization: "AUTHENTICATED_DIRECT_REQUEST",
  executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  environment: NORMAL_ENVIRONMENT, timeoutMs: 30_000, outputLimitBytes: null,
  descendantPolicy: "OWNED_JOB_KILL_ON_CLOSE", automaticRetry: false });

export function hostReadiness() {
  return { enabled: false, authority: "BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED",
    humanApproval: "AUTHENTICATED_DIRECT_REQUEST", reviewOpinionIsAuthorization: false,
    authenticatedReceiver: "SOURCE_IMPLEMENTED_NOT_DEPLOYED", protectedInstallation: "NOT_VERIFIED",
    normalRunner: "AUTHENTICATED_REQUEST_AND_DURABLE_CLAIM", admin: "BLOCKED_AWAITING_LOCAL_UAC",
    journal: "EXISTING_APPROVAL_STORE_ONLY", automaticRetry: false } as const;
}

export function createPowerShellHostPort(context: ReviewContext) {
  const store = context.store;
  const bootId = randomUUID();
  const read = async (requestId: string, exactDigest: string) => {
    parse(reviewBindingSchema, { requestId, digest: exactDigest });
    const review = await ApprovalStore.prototype.readReview.call(store, requestId);
    if (review.digest !== exactDigest) throw new ApprovalError("DIGEST_MISMATCH");
    await validatePowerShellScope(review.request, context);
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < review.updatedAt) throw new ApprovalError("CLOCK_UNTRUSTED");
    return review;
  };
  return Object.freeze({
    readiness: hostReadiness,
    // Internal native receiver only. Exact source bytes never become consent.
    async snapshot(requestId: string, exactDigest: string) {
      const review = await read(requestId, exactDigest);
      if (Date.now() >= review.request.expiresAt || review.state === "EXPIRED") throw new ApprovalError("TTL_EXPIRED");
      if (review.state === "DECLINED") throw new ApprovalError("REVIEW_DECLINED");
      return { requestJson: JSON.stringify(review.request), digest: review.digest, bootId, policy: NORMAL_POLICY,
        policyDigest: digest(NORMAL_POLICY), hostApproval: "NOT_OBSERVED" as const };
    },
    receipt(requestId: string) { return projectRequestReceipt(store, requestId, context.readJob); },
    /** Read exact canonical bytes for the future protected receiver. The reviewed
     * digest binds risk/cwd/args/source too; an ACCEPTED opinion does not mint a Grant. */
    async prepare(requestId: string, exactDigest: string) {
      const review = await read(requestId, exactDigest);
      const expired = Date.now() >= review.request.expiresAt;
      const sourceReady = review.request.origin === "DIRECT" || !!review.request.sourceFailure;
      const blocker = expired ? "TTL_EXPIRED" : review.state === "DECLINED" ? "REVIEW_DECLINED"
        : review.state === "EXPIRED" ? "TTL_EXPIRED" : !sourceReady ? "SOURCE_EVIDENCE_REQUIRED"
        : "AUTHENTICATED_DIRECT_REQUEST_REQUIRED";
      return { ...hostReadiness(), blocker, requestId, digest: exactDigest, bootId,
        origin: review.request.origin, executionMode: review.request.executionMode,
        expiresAt: review.request.expiresAt, policy: NORMAL_POLICY, policyDigest: digest(NORMAL_POLICY),
        reviewOpinion: review.state, permissionAttribution: "UNVERIFIED",
        hostApproval: "NOT_OBSERVED", grant: "NOT_ISSUED", executionDispatched: false };
    },
    /** Native receiver must supply an independent Host admission and its original
     * exact Review binding. Reject mismatched or stale proposals BEFORE Host proof.
     * The Store requires the retained authenticated channel for this exact DIRECT
     * request; no callback, review opinion or caller flag can replace it. */
    async admit(requestId: string, exactDigest: string, value: unknown, transport: unknown) {
      const review = await read(requestId, exactDigest);
      if (Date.now() >= review.request.expiresAt || review.state === "EXPIRED") throw new ApprovalError("TTL_EXPIRED");
      if (review.state === "DECLINED") throw new ApprovalError("REVIEW_DECLINED");
      const request = parse(productionRequestSchema, value);
      const source = review.request;
      // All command-bearing fields come from the canonical snapshot, not the IPC caller.
      for (const field of ["origin", "projectId", "executionMode", "target", "cwd", "scriptSnapshot", "scriptSha256",
        "scriptEncoding", "args", "risk", "sideEffects"] as const) {
        if (digest(request[field]) !== digest(source[field])) throw new ApprovalError("HOST_REQUEST_MISMATCH");
      }
      if (request.sourceReview?.requestId !== requestId || request.sourceReview.digest !== exactDigest
        || request.bootId !== bootId || request.environmentPolicyDigest !== digest(NORMAL_POLICY)
        || request.expiresAt > source.expiresAt) throw new ApprovalError("HOST_REQUEST_MISMATCH");
      if (request.origin === "CODEX_DERIVED") {
        if (request.jobId !== source.jobId || request.turnId !== source.turnId || !source.sourceFailure
          || request.failureEvidence.itemId !== source.sourceFailure.itemId
          || request.failureEvidence.threadId !== source.sourceFailure.threadId) throw new ApprovalError("HOST_REQUEST_MISMATCH");
        // Bounded nonzero completion cannot substantiate V2's structured permission
        // fault. Until a canonical full-fault resolver exists, never upgrade it.
        throw new ApprovalError("FAILURE_ATTRIBUTION_UNVERIFIED");
      }
      return ApprovalStore.prototype.admitProduction.call(store, request, transport);
    },
    async decide(requestId: string, exactDigest: string, decision: "APPROVED" | "DENIED", observation: unknown, transport: unknown) {
      const prior = store.getProduction(requestId);
      if (!prior || !("origin" in prior.request) || !prior.request.sourceReview) throw new ApprovalError("SOURCE_REVIEW_REQUIRED");
      await read(prior.request.sourceReview.requestId, prior.request.sourceReview.digest);
      return ApprovalStore.prototype.decideProduction.call(store, requestId, exactDigest, decision, observation, transport);
    },
    async claim(requestId: string, exactDigest: string, observation: unknown, transport: unknown) {
      const prior = store.getProduction(requestId);
      if (!prior || !("origin" in prior.request) || !prior.request.sourceReview) throw new ApprovalError("SOURCE_REVIEW_REQUIRED");
      await read(prior.request.sourceReview.requestId, prior.request.sourceReview.digest);
      return ApprovalStore.prototype.claimProduction.call(store, requestId, exactDigest, observation, transport);
    },
    async ingest(value: unknown, transport: unknown) {
      const result = parse(productionResultSchema, value);
      const prior = ApprovalStore.prototype.getProduction.call(store, result.binding.requestId);
      if (!prior) throw new ApprovalError("REQUEST_UNKNOWN");
      if (prior.state !== "CONSUMED") throw new ApprovalError("INVALID_TRANSITION");
      if (!("origin" in prior.request) || digest(productionBindingOf(prior.request)) !== digest(result.binding))
        throw new ApprovalError("HOST_REQUEST_MISMATCH");
      await ApprovalStore.prototype.ingestProductionReceipt.call(store, result, transport);
      return ApprovalStore.prototype.readRequestReceipt.call(store, result.binding.requestId);
    },
    async ingestNormal(value: unknown, executorObservation: unknown, transport: unknown, output?: NormalOutput) {
      const os = parse(normalExecutionObservationSchema, value);
      const prior = ApprovalStore.prototype.getProduction.call(store, os.requestId);
      if (!prior || !("origin" in prior.request)) throw new ApprovalError("REQUEST_UNKNOWN");
      if (prior.state !== "CONSUMED") throw new ApprovalError("INVALID_TRANSITION");
      const result = parse(productionResultSchema, { grantId: os.grantId, consumptionId: os.consumptionId,
        binding: productionBindingOf(prior.request), executor: executorObservation,
        completedAt: os.completedAt, outcome: os.outcome, exitCode: os.exitCode,
        outputSha256: os.outputSha256, windowsExecution: os });
      // Validate against the consumed record before reaching the mandatory Host
      // verifier. UNKNOWN/late receipts cannot rewrite a terminal result.
      if (prior.digest !== os.digest || prior.grant?.grantId !== os.grantId
        || prior.consumption?.consumptionId !== os.consumptionId) throw new ApprovalError("HOST_REQUEST_MISMATCH");
      await ApprovalStore.prototype.ingestProductionReceipt.call(store, result, transport, output);
      return ApprovalStore.prototype.readRequestReceipt.call(store, os.requestId);
    },
    deliveryUncertain(requestId: string) {
      return ApprovalStore.prototype.markProductionUnknown.call(store, requestId);
    },
  });
}
export type PowerShellHostPort = ReturnType<typeof createPowerShellHostPort>;
