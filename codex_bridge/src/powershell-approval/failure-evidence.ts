import { z } from "zod";
import type { JobSnapshot } from "../types.js";
import { sanitizeForStorage } from "../redaction.js";
import { digest } from "./contract.js";

const safeId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).refine(value => sanitizeForStorage(value) === value);
const completionSchema = z.object({
  source: z.literal("BRIDGE_JOBSTORE_BOUNDED_COMPLETION"),
  jobId: z.string().uuid(), projectId: safeId, threadId: safeId, turnId: safeId, itemId: safeId,
  exitCode: z.number().int().safe().refine(code => code !== 0),
  observedStatus: z.literal("completed"), evidenceStatus: z.literal("OBSERVED_NONZERO"),
  cause: z.literal("UNKNOWN"), permissionAttribution: z.literal("UNVERIFIED"),
}).strict();
export const savedFailureEvidenceSchema = completionSchema.extend({ evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .superRefine(({ evidenceSha256, ...completion }, ctx) => {
    if (evidenceSha256 !== digest(completion)) ctx.addIssue({ code: "custom", message: "Completion digest mismatch" });
  });
export type SavedFailureEvidence = z.infer<typeof savedFailureEvidenceSchema>;
export type FailureJob = Pick<JobSnapshot, "id" | "projectId" | "threadId" | "turnId" |
  "dataClassification" | "directActionHistoryEligible" | "commandFailureDiagnostics">;

/** Resolve only an exact saved completion. Nonzero/output text never attests a permission fault. */
export function resolveSavedFailure(job: FailureJob, turnId: string, itemId: string): SavedFailureEvidence | undefined {
  if (job.directActionHistoryEligible !== true || !["personal", "public"].includes(job.dataClassification)) return;
  const diagnostics = job.commandFailureDiagnostics;
  if (diagnostics?.scope !== "bounded_saved_conversation" || diagnostics.evidenceStatus !== "OBSERVED_NONZERO"
    || !Number.isInteger(diagnostics.scannedItems) || diagnostics.scannedItems < 0 || diagnostics.scannedItems > 2000
    || !Array.isArray(diagnostics.failures) || diagnostics.failures.length > 50) return;
  const matches = diagnostics.failures.filter(f => f.jobId === job.id && f.turnId === turnId && f.itemId === itemId);
  if (matches.length !== 1) return;
  const f = matches[0]!;
  const parsed = completionSchema.safeParse({ source: "BRIDGE_JOBSTORE_BOUNDED_COMPLETION", jobId: job.id,
    projectId: job.projectId, threadId: job.threadId, turnId, itemId, exitCode: f.exitCode,
    observedStatus: f.observedStatus, evidenceStatus: f.evidenceStatus, cause: "UNKNOWN", permissionAttribution: "UNVERIFIED" });
  if (!parsed.success) return;
  return { ...parsed.data, evidenceSha256: digest(parsed.data) };
}
