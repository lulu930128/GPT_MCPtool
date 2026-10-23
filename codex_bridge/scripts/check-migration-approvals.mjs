import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ApprovalError, TTL_MS } from "../dist/src/powershell-approval/contract.js";
import { REVIEW_KIND, REVIEW_TTL_MS, reviewSummary } from "../dist/src/powershell-approval/review-contract.js";
import { inspectApprovalJournal } from "../dist/src/powershell-approval/store.js";

export function checkMigrationApprovals(content) {
  const started = Date.now();
  const journal = inspectApprovalJournal(content);
  const floor = Math.max(0, ...journal.receipts.map(receipt => receipt.updatedAt));
  const validClock = now => Number.isSafeInteger(now) && now >= floor && now >= started
    && now <= Number.MAX_SAFE_INTEGER - Math.max(TTL_MS, REVIEW_TTL_MS);
  if (!validClock(started)) throw new ApprovalError("CLOCK_UNTRUSTED");
  let expiredReviews = 0;
  for (const receipt of journal.receipts) {
    if (receipt.request.evidence === REVIEW_KIND) {
      // Schema validation proves both non-executable flags, identity, digest and TTL.
      // Use the same projection as the live Review API, without persisting expiry.
      const summary = reviewSummary(receipt);
      const now = Date.now();
      if (!validClock(now) || (summary.effectiveState === "EXPIRED" && now < receipt.request.expiresAt))
        throw new ApprovalError("CLOCK_UNTRUSTED");
      if (summary.effectiveState === "PENDING" || summary.decisionAllowed)
        throw new ApprovalError("MIGRATION_APPROVAL_NOT_TERMINAL");
      if (receipt.state === "PENDING") expiredReviews++;
    } else if (!["DENIED", "EXPIRED", "SUCCEEDED", "FAILED"].includes(receipt.state)) {
      // Production and legacy executable requests never inherit Review expiry semantics.
      // UNKNOWN remains unresolved even if its TTL has elapsed.
      throw new ApprovalError("MIGRATION_APPROVAL_NOT_TERMINAL");
    }
  }
  if (!validClock(Date.now())) throw new ApprovalError("CLOCK_UNTRUSTED");
  return { ok: true, entries: journal.entries, requests: journal.receipts.length, expiredReviews };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const path = process.argv[2];
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
      throw new ApprovalError("STORE_UNSAFE");
    console.log(JSON.stringify(checkMigrationApprovals(readFileSync(path, "utf8"))));
  } catch (error) {
    // Never print schema diagnostics, receipt payloads or private paths.
    console.log(JSON.stringify({ ok: false, code: error instanceof ApprovalError ? error.code : "MIGRATION_JOURNAL_INVALID" }));
    process.exitCode = 1;
  }
}
