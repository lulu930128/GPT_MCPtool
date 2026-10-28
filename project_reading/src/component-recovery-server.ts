import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { componentRecoverySchemas } from "./component-recovery.js";
import { createReadOnlyRecovery } from "./cc-readonly.js";
import { componentUpdateSchemas } from "./component-update-contract.js";

const descriptions = {
  mcp_component_update_status: "Read source-update capabilities from the existing Control Center owner for nine fixed targets. This v2 contract is separate from the seven-target runtime reload contract. Unsupported components explicitly return NOT_SUPPORTED. No build, stage or update is dispatched.",
  mcp_component_update_preview: "Preview update_from_source for a fixed target/version through Control Center. Returns the owner-observed sourceDigest required by update. SOURCE_NOT_OBSERVED means no usable digest is available yet. Preview creates no request and never builds, stages, selects or reloads a runtime.",
  mcp_component_update: "Explicit user-authorized source Build/Stage/Update through the existing Control Center and component owner. Requires a stable UUID requestId, immutable versionId, preview sourceDigest, action=update_from_source, idlePolicy=wait_for_idle and confirmation=interrupt_current_requests. CC durably records parameters and canonical operation before dispatch; identical IDs return the original result and conflicting parameters are rejected. Bridge waits for active jobs to become idle; self-update follows the independent bootstrap owner. Accepted transport or QUEUED/RUNNING is not deployment. After disconnect or timeout, query mcp_component_update_receipt with the same requestId; never replace the ID to retry. No arbitrary paths, commands, shell, ADMIN or force controls.",
  mcp_component_update_receipt: "Read the durable v2 source-update receipt and canonical operationId by the original requestId. Reports QUEUED, RUNNING, ACCEPTED, REJECTED or RECOVERY_REQUIRED and available loaded-version/Ready evidence. Missing/unavailable is not proof of non-execution; preserve the original ID. No dispatch or retry.",
  mcp_component_status: "Read seven allowlisted MCP statuses from the existing local Control Center tray snapshot. No probes or writes are triggered in CC. If unavailable, clearly labeled fixed TCP observations are returned. Local IPC is not independent owner attestation or ChatGPT E2E. Self and Control Center are excluded.",
  mcp_component_preview: "Read a fixed-action preview from Control Center. No request is created or executed. Reports capability, observed target state and manual interruption confirmation or component-policy limits. Manual reload of any of the seven targets can interrupt current requests; exact ownership and component-specific active-work refusal remain checked by its controller.",
  mcp_component_receipt: "Read a durable requestId receipt from Control Center. Missing/unavailable is not completion. UNKNOWN after timeout or owner exit must be investigated; never resend using a new requestId. No writes or restarts.",
  mcp_component_restart: "Explicit single-component MANUAL MAINTENANCE only: reload one of the seven allowlisted MCPs through its existing Control Center/component controller. Only call after the user explicitly requests this restart and confirms interrupting current requests. Requires action=reload_runtime, confirmation=interrupt_current_requests and a stable UUID requestId. No separate identity proof. Accepted is not completed; query receipt after timeout and never retry with a new requestId. Self, CC and unknown targets cannot be restarted with this tool. Component ownership and active-work refusals remain enforced. A UUID bound to another target is rejected as REQUEST_CONFLICT.",
};

export function registerComponentRecoveryTools(server: McpServer, handlers = createReadOnlyRecovery()): void {
  const schemas = { ...componentRecoverySchemas, ...componentUpdateSchemas };
  for (const name of Object.keys(handlers) as (keyof typeof handlers)[]) {
    const mutation = name === "mcp_component_restart" || name === "mcp_component_update";
    server.registerTool(name, {
      title: name, description: descriptions[name], inputSchema: schemas[name],
      outputSchema: z.object({ ok: z.boolean(), code: z.string() }).passthrough(),
      annotations: { readOnlyHint: !mutation, destructiveHint: mutation, openWorldHint: name === "mcp_component_status", idempotentHint: true },
    }, async (args: unknown) => {
      try { return result(await handlers[name](args)); }
      catch (error) {
        return result({ ok: false, code: error instanceof z.ZodError ? "INVALID_INPUT" : "OBSERVATION_FAILED" });
      }
    });
  }
}

function result(value: Record<string, unknown>) {
  return { isError: value.ok === false, structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
