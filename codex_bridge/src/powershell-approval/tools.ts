import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deploymentStatus, MARKER_SCRIPT, modeSchema, sha256 } from "./contract.js";
import { jobPreviewInputSchema, previewJobFailure, type JobPreviewReader } from "./job-preview.js";
import type { ReviewStoreDiagnostics } from "./review-runtime.js";
import { hostReadiness } from "./host-admission.js";
import { hostDiagnosticsStatus, preflightCode, type HostDiagnostics } from "./host-diagnostics.js";

/** Nonexecuting previews/status plus one explicit fixed native diagnostic. */
export function registerPowerShellApprovalTools(server: McpServer, readSnapshot?: JobPreviewReader,
  reviewStoreDiagnostics?: () => Promise<ReviewStoreDiagnostics>, hostDiagnostics?: HostDiagnostics): void {
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool("codex_powershell_job_preview", {
    title: "工作失敗唯讀預覽（不可執行）",
    description: "Read saved nonzero completion IDs/exit codes for an eligible personal/public Bridge job. Cause UNKNOWN; permission attribution UNVERIFIED. NORMAL/ADMIN remain OFF. Creates no request and never executes.",
    annotations, inputSchema: jobPreviewInputSchema,
  }, async (input) => {
    const preview = await previewJobFailure(input, readSnapshot);
    return { content: [{ type: "text", text: preview.availability === "AVAILABLE"
      ? "Saved evidence only; cause UNKNOWN, permission attribution UNVERIFIED. NORMAL/ADMIN OFF; not executable; separate human review required."
      : "Job preview unavailable; evidence UNVERIFIED." }], structuredContent: preview };
  });
  server.registerTool("codex_powershell_status", {
    title: "PowerShell Host 與來源宣告狀態（唯讀）", description: "Read source declarations, loaded installed binding, cached native preflight and durable Store metadata separately. A configured NORMAL entry accepts authenticated DIRECT requests without local confirmation; it is not proof of current Host readiness. ADMIN remains OFF. No helper launch or owner verification.",
    annotations, inputSchema: z.object({}).strict(),
  }, async () => {
    let reviewStore: ReviewStoreDiagnostics | { availability: "UNAVAILABLE" } = { availability: "UNAVAILABLE" };
    try { if (reviewStoreDiagnostics) reviewStore = await reviewStoreDiagnostics(); } catch { /* No raw storage error. */ }
    const diagnostics = hostDiagnosticsStatus(hostDiagnostics);
    const configured = diagnostics.normalExecution.configured && diagnostics.nativeTransport.closed === false
      && "startup" in reviewStore && reviewStore.startup.status === "OPEN" && reviewStore.current.lifecycle === "OPEN";
    const status = { ...deploymentStatus(), deployment: configured ? "AUTHENTICATED_DIRECT_REQUEST_REQUIRED" : "EXECUTION_DISABLED",
      ...(configured ? { enabled: true, executionPolicy: { NORMAL: "AUTHENTICATED_DIRECT_REQUEST", ADMIN: "OFF" },
        NORMAL: "AUTHENTICATED_DIRECT_REQUEST_REQUIRED", approval: "REMOTE_MCP_REQUEST", dynamicScripts: true } : {}),
      sourceDeclaration: deploymentStatus(), host: { ...hostReadiness(), evidence: "SOURCE_DECLARATION" },
      ...diagnostics, reviewStore };
    return { content: [{ type: "text", text: JSON.stringify(status) }], structuredContent: status };
  });
  server.registerTool("codex_powershell_host_preflight", {
    title: "固定 Host preflight 診斷（需明確指示）",
    description: "Only on explicit user instruction, invoke the existing fixed installed NativeHostTransport.preflight(). Starts a bounded helper; effectful, not a status getter. No review candidate, script, args, Grant, Run, Host transition or authorization. No automatic retry. A blocker is not readiness or OS execution proof.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: z.object({ userIntent: z.literal("EXPLICIT_USER_DIAGNOSTIC") }).strict(),
  }, async () => {
    let code = "HOST_TRANSPORT_UNAVAILABLE";
    try { if (hostDiagnostics?.transport) code = preflightCode((await hostDiagnostics.transport.preflight()).code); }
    catch { /* No exception messages, native output, paths or binding values. */ }
    const result = { operation: "FIXED_INSTALLED_PREFLIGHT", code, ...hostDiagnosticsStatus(hostDiagnostics),
      executionDispatched: false, productionEnabled: false, createsRequest: false, createsGrant: false, retryAllowed: false };
    return { isError: !["BLOCKED_PLATFORM_CAPABILITY", "HOST_READY"].includes(code), content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  });
  server.registerTool("codex_powershell_preview", {
    title: "固定 PowerShell 操作預覽（不建立請求）", description: "Preview only the immutable offline marker and mode. Does not capture a failure, create a request, approve or execute.",
    annotations, inputSchema: z.object({ artifactId: z.literal("fixture.marker.v1"), executionMode: modeSchema }).strict(),
  }, async ({ artifactId, executionMode }) => ({ content: [{ type: "text", text: "Preview only; approval requires an independent protected local host, not MCP/app visibility." }],
    structuredContent: { ...deploymentStatus(), artifactId, executionMode, scriptSnapshot: MARKER_SCRIPT, scriptSha256: sha256(MARKER_SCRIPT),
      createsRequest: false, sideEffects: "stdout marker only; no file/network/system mutation" } }));
}
