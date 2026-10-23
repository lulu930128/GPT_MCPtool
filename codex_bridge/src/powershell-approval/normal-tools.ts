import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BridgeRuntime } from "../runtime.js";
import { ApprovalError } from "./contract.js";
import { reviewBindingSchema } from "./review-contract.js";
import { validatePowerShellScope } from "./review-tools.js";
import { projectRequestReceipt } from "./job-projection.js";

const codes = new Set(["STORE_LOCKED", "STORE_UNAVAILABLE", "REVIEW_UNAVAILABLE", "REQUEST_UNKNOWN",
  "DIGEST_MISMATCH", "TTL_EXPIRED", "REVIEW_DECLINED", "REVIEW_SCOPE_REJECTED", "CLOCK_UNTRUSTED",
  "BLOCKED_AWAITING_LOCAL_UAC", "FAILURE_ATTRIBUTION_UNVERIFIED", "NOT_DEPLOYED",
  "HOST_TRANSPORT_BUSY", "HOST_TRANSPORT_CLOSED", "HOST_TRANSPORT_UNKNOWN", "HOST_TRANSPORT_UNAVAILABLE",
  "RECEIPT_RECORDED", "HOST_APPROVAL_DECLINED", "EXECUTION_ALREADY_REQUESTED"]);

/** Executes an explicit DIRECT request through the existing authenticated Host.
 * Exact saved bytes and durable consumption bind the single execution. */
export function registerPowerShellNormalTools(server: McpServer, runtime: BridgeRuntime): void {
  server.registerTool("codex_powershell_normal_execute", {
    title: "執行 Windows PowerShell NORMAL 並回傳結果",
    description: "Execute the user's explicit DIRECT PowerShell request already saved by review_request, using its exact requestId and digest. The authenticated MCP request authorizes execution and stdout/stderr return through the existing installed Windows Host; no local dialog or manual arming is required. Never bypass a platform/workspace denial or relabel CODEX_DERIVED as DIRECT. ADMIN is unavailable. Invoke once; after timeout/unknown/lost response query codex_powershell_receipt with the original requestId instead of redispatching. Large output is returned in complete retrievable pages; follow output.nextOffset with receipt outputOffset until null.",
    inputSchema: reviewBindingSchema.extend({ userIntent: z.literal("EXPLICIT_USER_EXECUTION_REQUEST") }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ requestId, digest }) => {
    try {
      const store = runtime.approvalStore;
      if (!store) throw new ApprovalError(runtime.powershellReviewUnavailable ?? "REVIEW_UNAVAILABLE");
      const review = await store.readReview(requestId);
      if (review.digest !== digest) throw new ApprovalError("DIGEST_MISMATCH");
      const readJob = (id: string) => runtime.store.snapshot(id);
      // Return an existing durable attempt even if its original TTL has elapsed.
      // Never issue another Grant for the same review, including UNKNOWN.
      const existing = await store.readReviewExecution(requestId);
      if (existing) {
        const result = { code: "EXECUTION_ALREADY_REQUESTED", retryAllowed: false,
          receipt: await projectRequestReceipt(store, requestId, readJob) };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      }
      if (review.request.executionMode !== "NORMAL") throw new ApprovalError("BLOCKED_AWAITING_LOCAL_UAC");
      if (review.request.origin !== "DIRECT") throw new ApprovalError("FAILURE_ATTRIBUTION_UNVERIFIED");
      if (review.state === "DECLINED") throw new ApprovalError("REVIEW_DECLINED");
      if (Date.now() < review.updatedAt) throw new ApprovalError("CLOCK_UNTRUSTED");
      if (Date.now() >= review.request.expiresAt || review.state === "EXPIRED") throw new ApprovalError("TTL_EXPIRED");
      await validatePowerShellScope(review.request, { store, projects: runtime.config.projects, readJob });
      if (!runtime.config.installedBinding || !runtime.powershellHostTransport) throw new ApprovalError("NOT_DEPLOYED");
      const observed = await runtime.powershellHostTransport.inspect(requestId, digest);
      const code = codes.has(observed.code) ? observed.code : "HOST_TRANSPORT_UNKNOWN";
      const result = { code, retryAllowed: false, automaticResume: false,
        receipt: await projectRequestReceipt(store, requestId, readJob) };
      return { isError: code !== "RECEIPT_RECORDED" && code !== "HOST_APPROVAL_DECLINED",
        content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const code = error instanceof ApprovalError && codes.has(error.code) ? error.code : "HOST_TRANSPORT_UNKNOWN";
      const result = { code, requestId, retryAllowed: false, nextAction: "READ_ORIGINAL_REQUEST_RECEIPT" };
      return { isError: true, content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    }
  });
}
