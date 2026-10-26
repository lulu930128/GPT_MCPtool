import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { componentRecoverySchemas } from "./component-recovery.js";
import { createReadOnlyRecovery } from "./cc-readonly.js";

const descriptions = {
  mcp_component_status: "Read seven allowlisted MCP statuses from the existing local Control Center tray snapshot. No probes or writes are triggered in CC. If unavailable, clearly labeled fixed TCP observations are returned. Local IPC is not independent owner attestation or ChatGPT E2E. Self and Control Center are excluded.",
  mcp_component_preview: "Read a fixed-action preview from Control Center. No request is created or executed. Reports capability, observed target state and manual interruption confirmation or component-policy limits. Manual reload of any of the seven targets can interrupt current requests; exact ownership and component-specific active-work refusal remain checked by its controller.",
  mcp_component_receipt: "Read a durable requestId receipt from Control Center. Missing/unavailable is not completion. UNKNOWN after timeout or owner exit must be investigated; never resend using a new requestId. No writes or restarts.",
  mcp_component_restart: "Explicit single-component MANUAL MAINTENANCE only: reload one of the seven allowlisted MCPs through its existing Control Center/component controller. Only call after the user explicitly requests this restart and confirms interrupting current requests. Requires action=reload_runtime, confirmation=interrupt_current_requests and a stable UUID requestId. No separate identity proof. Accepted is not completed; query receipt after timeout and never retry with a new requestId. Self, CC and unknown targets cannot be restarted with this tool. Component ownership and active-work refusals remain enforced. A UUID bound to another target is rejected as REQUEST_CONFLICT.",
};

export function registerComponentRecoveryTools(server: McpServer, handlers = createReadOnlyRecovery()): void {
  for (const name of Object.keys(handlers) as (keyof typeof handlers)[]) {
    server.registerTool(name, {
      title: name, description: descriptions[name], inputSchema: componentRecoverySchemas[name],
      outputSchema: z.object({ ok: z.boolean(), code: z.string() }).passthrough(),
      annotations: { readOnlyHint: name !== "mcp_component_restart", destructiveHint: name === "mcp_component_restart", openWorldHint: name === "mcp_component_status", idempotentHint: true },
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
