import { z } from "zod";
import { sanitizeForStorage } from "../redaction.js";
import type { JobSnapshot } from "../types.js";
import { resolveSavedFailure } from "./failure-evidence.js";

// Only a read capability is injected; no controller, request store or runner.
export type JobPreviewReader = (jobId: string) => Promise<Pick<JobSnapshot,
  "id" | "turnId" | "dataClassification" | "directActionHistoryEligible" | "commandFailureDiagnostics"> &
  Partial<Pick<JobSnapshot, "projectId" | "threadId">>>;
export const jobPreviewInputSchema = z.object({ jobId: z.string().uuid() }).strict();
const safeId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).refine((id) => sanitizeForStorage(id) === id);
const diagnosticsSchema = z.object({
  evidenceStatus: z.literal("OBSERVED_NONZERO"),
  scope: z.literal("bounded_saved_conversation"),
  scannedItems: z.number().int().min(0).max(2000), truncated: z.boolean(),
  failures: z.array(z.object({
    jobId: z.string().uuid(), turnId: safeId, itemId: safeId,
    exitCode: z.number().int().safe().refine((code) => code !== 0),
    observedStatus: z.literal("completed"), evidenceStatus: z.literal("OBSERVED_NONZERO"),
  })).min(1).max(50),
});

export async function previewJobFailure(input: unknown, readSnapshot?: JobPreviewReader) {
  const parsed = jobPreviewInputSchema.safeParse(input);
  const unavailable = { availability: "UNAVAILABLE", evidenceStatus: "UNVERIFIED",
    cause: "UNKNOWN", permissionAttribution: "UNVERIFIED", createsRequest: false,
    createsGrant: false, requiresPassword: false,
    requiresSeparateHumanReview: true, executes: false } as const;
  if (!parsed.success || !readSnapshot) return unavailable;
  const { jobId } = parsed.data;
  let snapshot: Awaited<ReturnType<JobPreviewReader>>;
  try {
    snapshot = await readSnapshot(jobId);
  } catch {
    // Missing jobs and failed reads share one non-disclosing response.
    return unavailable;
  }
  if (!snapshot || snapshot.id !== jobId || snapshot.directActionHistoryEligible !== true ||
      !["personal", "public"].includes(snapshot.dataClassification)) return unavailable;
  const evidence = diagnosticsSchema.safeParse(snapshot.commandFailureDiagnostics);
  const bound = evidence.success && evidence.data.failures.every((failure) => failure.jobId === jobId);
  const diagnostics = {
    evidenceStatus: bound ? "OBSERVED_NONZERO" : "UNVERIFIED",
    cause: "UNKNOWN", permissionAttribution: "UNVERIFIED", scope: "bounded_saved_conversation",
    scannedItems: bound ? evidence.data.scannedItems : null,
    truncated: bound ? evidence.data.truncated : null,
    failures: bound ? evidence.data.failures.map((failure) => {
      const sourceFailure = resolveSavedFailure({ ...snapshot, projectId: snapshot.projectId ?? "" }, failure.turnId, failure.itemId);
      return { ...failure, cause: "UNKNOWN", permissionAttribution: "UNVERIFIED",
        ...(sourceFailure ? { sourceFailure } : {}) };
    }) : [],
  };
  // Snapshot turn identity is context only; saved failures retain their event turn IDs.
  const currentTurn = safeId.safeParse(snapshot.turnId);
  return { availability: "AVAILABLE", jobId, currentTurnId: currentTurn.success ? currentTurn.data : null,
    commandFailureDiagnostics: diagnostics,
    executionPolicy: { NORMAL: "OFF", ADMIN: "OFF" },
    createsRequest: false, createsGrant: false, requiresPassword: false,
    requiresSeparateHumanReview: true, executes: false };
}
