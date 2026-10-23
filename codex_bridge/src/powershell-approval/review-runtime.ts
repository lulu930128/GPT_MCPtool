import { join } from "node:path";
import { ApprovalError } from "./contract.js";
import { ApprovalStore } from "./store.js";
import type { LockDiagnostics } from "./store.js";

export interface ReviewStoreDiagnostics {
  startup: { status: "OPEN" | "FAILED"; errorCode: string | null; source: "CACHE_ON_STARTUP" };
  current: LockDiagnostics;
  automaticRecovery: false;
  recoveryAuthorization: "VERIFY_STALE_THEN_SEPARATE_AUTHORIZATION";
}

/** Optional review subsystem. Never repair, unlock, or fall back to another journal. */
export async function initializePowerShellReview(dataDir: string): Promise<{
  approvalStore?: ApprovalStore; powershellReviewUnavailable?: string;
  reviewStoreDiagnostics: () => Promise<ReviewStoreDiagnostics>;
}> {
  const directory = join(dataDir, "powershell-approval");
  try {
    const approvalStore = await ApprovalStore.open(directory);
    return { approvalStore, reviewStoreDiagnostics: async () => ({
      startup: { status: "OPEN", errorCode: null, source: "CACHE_ON_STARTUP" },
      current: await approvalStore.lockDiagnostics(), automaticRecovery: false,
      recoveryAuthorization: "VERIFY_STALE_THEN_SEPARATE_AUTHORIZATION",
    }) };
  } catch (error) {
    const code = error instanceof ApprovalError ? error.code : "REVIEW_UNAVAILABLE";
    return { powershellReviewUnavailable: code, reviewStoreDiagnostics: async () => ({
      startup: { status: "FAILED", errorCode: code, source: "CACHE_ON_STARTUP" },
      current: await ApprovalStore.inspectLock(directory), automaticRecovery: false,
      recoveryAuthorization: "VERIFY_STALE_THEN_SEPARATE_AUTHORIZATION",
    }) };
  }
}
