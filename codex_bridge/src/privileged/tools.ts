import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RemotePrivilegedBroker } from "./broker.js";
import { BrokerError, previewSchema } from "./contract.js";

/** No request/decide/execute tool until a trusted human UI and protected executor exist. */
export function registerPrivilegedBrokerTools(server: McpServer, broker: RemotePrivilegedBroker): void {
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool("codex_privileged_status", {
    title: "Privileged broker deployment status",
    description: "Read independent Broker policy and missing deployment gates. NOT DEPLOYED; write protection NOT ENFORCED. No Codex job or system operation.",
    annotations, inputSchema: z.object({}).strict(),
  }, async (args) => respond(() => broker.status(args)));
  server.registerTool("codex_privileged_preview", {
    title: "Preview fixed local diagnostic policy",
    description: "Dry-run policy preview only. Enum operationId, no arguments, paths, commands, flags or environment. Creates no request and runs no diagnostics. Human approval and execution are unavailable.",
    annotations, inputSchema: previewSchema,
  }, async (args) => respond(() => broker.preview(args)));
}

function respond(read: () => unknown) {
  try {
    return { content: [{ type: "text" as const, text: "NOT DEPLOYED. Preview/status only; no system action. Write protection NOT ENFORCED." }],
      structuredContent: read() as Record<string, unknown> };
  } catch (error) {
    const code = error instanceof BrokerError ? error.code : "BROKER_UNAVAILABLE";
    return { isError: true, content: [{ type: "text" as const, text: code }], structuredContent: { error: { code } } };
  }
}
