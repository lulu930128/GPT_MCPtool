import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApprovalError } from "./contract.js";
import type { ApprovalStore } from "./store.js";
import type { FailureJob } from "./failure-evidence.js";
import { projectRequestReceipt } from "./job-projection.js";

/** Reads the runtime's sole ApprovalStore. No broker, controller or execution capability. */
export function registerPowerShellReceiptTools(server: McpServer, store?: ApprovalStore,
  readJob?: (id: string) => Promise<FailureJob>): void {
  server.registerTool("codex_powershell_receipt", {
    title: "依 Request 查詢 PowerShell 收據（唯讀）",
    description: "Read canonical Request/Receipt correlation from the existing ApprovalStore by original requestId. DIRECT needs no job. NONEXECUTABLE review opinion and saved OS execution receipt are separate fields. Saved PRODUCTION state is not verified Host/OS success. Missing job, changed turn, unknown delivery or UNVERIFIED evidence never authorizes execution, retry, resume or another grant. Output pages retain all captured text for 10 minutes. Follow output.nextOffset using outputOffset until null. No script input, dispatch or writes.",
    inputSchema: z.object({ requestId: z.string().uuid(), outputOffset: z.number().safe().int().nonnegative().optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ requestId, outputOffset }) => {
    try {
      if (!store) throw new ApprovalError("RECEIPT_SOURCE_UNAVAILABLE");
      const result = await projectRequestReceipt(store, requestId, readJob, outputOffset);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const allowed = ["REQUEST_UNKNOWN", "LEGACY_ORIGIN_UNVERIFIED", "REQUEST_CORRELATION_REJECTED", "OUTPUT_OFFSET_INVALID"];
      const code = error instanceof ApprovalError && allowed.includes(error.code) ? error.code
        : error instanceof ApprovalError && error.code === "INVALID_INPUT" ? "RECEIPT_DATA_INVALID" : "RECEIPT_SOURCE_UNAVAILABLE";
      return { isError: true, content: [{ type: "text", text: `Receipt unavailable: ${code}; UNVERIFIED; no retry or execution.` }],
        structuredContent: { availability: "UNAVAILABLE", requestId, error: { code }, evidence: "UNVERIFIED",
          productionEnabled: false, automaticResume: false, retryAllowed: false } };
    }
  });
}
