import type { JobStore } from "../job-store.js";
import type { PowerShellApprovalBroker } from "./broker.js";
import { z } from "zod";
import { sanitizeForStorage } from "../redaction.js";
import { ApprovalStore } from "./store.js";
import { ApprovalError, parse, receiptSchema, productionJournalReceiptSchema, productionReceiptSchema } from "./contract.js";
import { REVIEW_KIND, reviewReceiptSchema, reviewSummary } from "./review-contract.js";
import { resolveSavedFailure, type FailureJob } from "./failure-evidence.js";
import { hostReadiness } from "./host-admission.js";

/** Read-only adapter over existing owners. No result write, dispatch, resume, or new JobStore. */
export async function projectApprovalResult(jobs: Pick<JobStore, "get">,
  approvals: Pick<PowerShellApprovalBroker, "get">, requestId: string) {
  const receipt = parse(receiptSchema, await approvals.get(requestId));
  const job = jobs.get(receipt.request.jobId);
  if (!job || job.id !== receipt.request.jobId || job.project.id !== receipt.request.projectId
    || job.turnId !== receipt.request.turnId) throw new ApprovalError("JOB_CORRELATION_REJECTED");
  return Object.freeze({ requestId: receipt.request.requestId, receiptId: receipt.request.receiptId,
    jobId: job.id, turnId: job.turnId, projectId: job.project.id, digest: receipt.digest,
    state: receipt.state, approvalEventId: receipt.approvalEventId,
    result: receipt.result ? structuredClone(receipt.result) : undefined,
    runnerError: receipt.runnerError, automaticResume: false, retryAllowed: false,
    hostAcceptance: "UNVERIFIED", productionEnabled: false });
}

/** Saved journal projection only, never Host attestation or business success.
 * The caller supplies the existing canonical JobStore.get capability for derived
 * requests. Matching saved provenance is not independent fault/OS verification.
 * No store open/recovery, write, approval, execution, retry or continuation. */
export function projectProductionApprovalResult(approvals: Pick<ApprovalStore, "getProduction">,
  requestId: string, jobs?: Pick<JobStore, "get">) {
  parse(z.string().uuid(), requestId);
  let saved: unknown;
  try {
    // Invoke the canonical method, not a caller callback/boolean or overridden
    // getter. Its private record access rejects objects without the Store brand.
    saved = ApprovalStore.prototype.getProduction.call(approvals, requestId);
  } catch {
    throw new ApprovalError("RECEIPT_SOURCE_UNAVAILABLE");
  }
  if (saved === undefined) throw new ApprovalError("REQUEST_UNKNOWN");
  const journal = parse(productionJournalReceiptSchema, saved);
  if (journal.request.requestId !== requestId) throw new ApprovalError("REQUEST_CORRELATION_REJECTED");
  if (!("origin" in journal.request)) throw new ApprovalError("LEGACY_ORIGIN_UNVERIFIED");
  const receipt = parse(productionReceiptSchema, journal), request = receipt.request;
  let correlation: { jobId: string; projectId: string; turnId: string; threadId: string } | undefined;
  if (request.origin === "CODEX_DERIVED") {
    try {
      const job = jobs?.get(request.jobId), evidence = request.failureEvidence;
      const safeId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
        .refine(value => sanitizeForStorage(value) === value);
      if (!job || job.id !== request.jobId || job.project.id !== request.projectId
        || job.workPackage.projectId !== request.projectId || job.turnId !== request.turnId
        || evidence.jobId !== job.id || evidence.projectId !== job.project.id || evidence.turnId !== job.turnId
        || (job.threadId !== undefined && job.threadId !== evidence.threadId)
        || !safeId.safeParse(job.turnId).success || !safeId.safeParse(evidence.threadId).success
        || !["personal", "public"].includes(job.workPackage.dataClassification)
        || !["personal", "public"].includes(job.currentDataClassification ?? job.workPackage.dataClassification)) {
        throw new ApprovalError("JOB_CORRELATION_REJECTED");
      }
      correlation = { jobId: job.id, projectId: job.project.id, turnId: job.turnId!, threadId: evidence.threadId };
    } catch {
      // Never forward saved job payloads or reader exception text.
      throw new ApprovalError("JOB_CORRELATION_REJECTED");
    }
  }
  return Object.freeze({ requestId, receiptId: request.receiptId, origin: request.origin,
    state: receipt.state, executionMode: request.executionMode, digest: receipt.digest, reason: receipt.reason,
    ...(correlation ?? {}),
    result: receipt.result ? Object.freeze({ outcome: receipt.result.outcome,
      exitCode: receipt.result.exitCode, outputSha256: receipt.result.outputSha256 }) : undefined,
    evidence: "SAVED_JOURNAL_ONLY" as const, hostAcceptance: "UNVERIFIED" as const,
    osSideEffects: "UNVERIFIED" as const, businessSuccess: "UNVERIFIED" as const,
    productionEnabled: false, automaticResume: false, retryAllowed: false });
}

/** Public request-first receipt. Saved Request remains readable after a job advances
 * or disappears. Job correlation is a separate bounded observation, never a Grant. */
export async function projectRequestReceipt(approvals: Pick<ApprovalStore, "readRequestReceipt">,
  requestId: string, readJob?: (id: string) => Promise<FailureJob>, outputOffset = 0) {
  parse(z.string().uuid(), requestId);
  let saved;
  try { saved = await ApprovalStore.prototype.readRequestReceipt.call(approvals, requestId); }
  catch (error) {
    throw new ApprovalError(error instanceof ApprovalError && error.code === "REQUEST_UNKNOWN"
      ? "REQUEST_UNKNOWN" : "RECEIPT_SOURCE_UNAVAILABLE");
  }
  if (!saved) throw new ApprovalError("REQUEST_UNKNOWN");
  const receipt = saved.request.evidence === REVIEW_KIND ? parse(reviewReceiptSchema, saved)
    : parse(productionJournalReceiptSchema, saved);
  if (receipt.request.requestId !== requestId) throw new ApprovalError("REQUEST_CORRELATION_REJECTED");
  if (!("origin" in receipt.request)) throw new ApprovalError("LEGACY_ORIGIN_UNVERIFIED");
  const review = "kind" in receipt ? receipt : undefined;
  let production = review ? undefined : parse(productionReceiptSchema, receipt);
  if (review) {
    try { production = await ApprovalStore.prototype.readReviewExecution.call(approvals, requestId); }
    catch (error) {
      throw new ApprovalError(error instanceof ApprovalError && error.code === "IDENTITY_REPLAY"
        ? "REQUEST_CORRELATION_REJECTED" : "RECEIPT_SOURCE_UNAVAILABLE");
    }
  }
  if (review && production && production.request.sourceReview?.digest !== review.digest)
    throw new ApprovalError("REQUEST_CORRELATION_REJECTED");
  const request = review?.request ?? production!.request;
  const sourceFailure = review?.request.sourceFailure;
  const failure = sourceFailure ?? (production?.request.origin === "CODEX_DERIVED" ? production.request.failureEvidence : undefined);
  let jobCorrelation = request.origin === "DIRECT" ? "NOT_APPLICABLE" : "UNVERIFIED";
  let completionCorrelation = "UNVERIFIED";
  let currentTurnMatches: boolean | null = null;
  if (request.origin === "CODEX_DERIVED" && readJob) {
    try {
      const job = await readJob(request.jobId!);
      if (job.id === request.jobId && job.projectId === request.projectId && job.directActionHistoryEligible === true
        && ["personal", "public"].includes(job.dataClassification)
        && (!failure || job.threadId === failure.threadId)) {
        jobCorrelation = "MATCHED_JOB_PROJECT";
        currentTurnMatches = job.turnId === request.turnId;
        if (failure) {
          const observed = resolveSavedFailure(job, request.turnId!, failure.itemId);
          // Production evidence has a different full-event digest and fault provenance.
          // A matching bounded completion alone cannot validate that assertion.
          if (observed && (!sourceFailure || observed.evidenceSha256 === sourceFailure.evidenceSha256))
            completionCorrelation = "MATCHED_SAVED_COMPLETION";
        }
      }
    } catch { /* Read failure never discards the canonical request or leaks Job payload. */ }
  }
  const summary = review && reviewSummary(review);
  return Object.freeze({ availability: "AVAILABLE", kind: review ? REVIEW_KIND : "PRODUCTION",
    requestId, receiptId: request.receiptId, origin: request.origin, projectId: request.projectId,
    digest: receipt.digest, state: receipt.state, reason: receipt.reason,
    revision: receipt.revision, updatedAt: receipt.updatedAt, executionMode: request.executionMode,
    createdAt: request.createdAt, expiresAt: request.expiresAt,
    reviewOpinion: summary ? { state: summary.state, effectiveState: summary.effectiveState,
      reason: summary.reason, effectiveReason: summary.effectiveReason, evidence: REVIEW_KIND } : null,
    hostApproval: { ...hostReadiness(), state: production?.state ?? "NOT_ADMITTED",
      recordedInterface: production?.request.approvalIdentity.interface ?? null,
      requestId: production?.request.requestId ?? null, reviewRequestId: production?.request.sourceReview?.requestId ?? (review ? requestId : null),
      grant: production?.grant ? "RECORDED" : "NOT_ISSUED", consumption: production?.consumption ? "RECORDED" : "NOT_CONSUMED",
      verification: "UNVERIFIED" },
    osExecutionReceipt: production?.result ? { requestId: production.request.requestId, receiptId: production.request.receiptId,
      outcome: production.result.outcome, exitCode: production.result.exitCode,
      outputSha256: production.result.outputSha256, completedAt: production.result.completedAt,
      output: ApprovalStore.prototype.readProductionOutput.call(approvals, production.request.requestId, outputOffset),
      ...(production.result.windowsExecution ? { observation: {
        processId: production.result.windowsExecution.processId, reason: production.result.windowsExecution.reason,
        stdoutBytes: production.result.windowsExecution.stdoutBytes, stderrBytes: production.result.windowsExecution.stderrBytes,
        outputTruncated: production.result.windowsExecution.outputTruncated,
      } } : {}),
      verification: "UNVERIFIED" } : null,
    correlation: { request: "MATCHED_CANONICAL_REQUEST", job: jobCorrelation,
      completion: completionCorrelation, currentTurnMatches,
      ...(request.origin === "CODEX_DERIVED" ? { jobId: request.jobId, turnId: request.turnId } : {}),
      cause: "UNKNOWN", permissionAttribution: "UNVERIFIED", fullFaultEvidence: "UNVERIFIED",
      candidateCommandMatch: "UNVERIFIED" },
    evidence: "SAVED_JOURNAL_ONLY", hostAcceptance: "UNVERIFIED", osSideEffects: "UNVERIFIED", businessSuccess: "UNVERIFIED",
    productionEnabled: false, automaticResume: false, retryAllowed: false });
}
