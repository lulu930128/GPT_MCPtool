import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerConfig } from "./config.js";
import { WRITE_TOOLS } from "./write-policy.js";
import { operationIdSchema, writeInputSchemas } from "./write-inputs.js";
import { getWorkspaceWriter } from "./write-tools.js";
import { WorkspaceWriteError } from "./write-errors.js";

const descriptions = {
  create_text_file: "Create a new UTF-8 text file within an explicitly writable scope. Never overwrites. Parent directory must exist. JSON/JSONL must be valid.",
  append_text_file: "Append UTF-8 content, preserving the existing bytes. Bounded atomic publication; JSONL requires complete newline-terminated records. Reuse operation_id on retry to avoid duplicate append.",
  patch_text_file: "Apply exact find/replace operations to an authorized UTF-8 file. Requires its full raw-byte expected_sha256 from read_file(includeSha256=true). All match counts must agree before publication.",
  update_json_value: "Update one existing JSON Pointer under optional operator field constraints. Requires expected_sha256. Preserves indentation/newline/BOM conventions but reserializes JSON; rejects duplicate keys and unsafe integers.",
  make_directory: "Create an authorized directory. Each missing parent must independently allow make_directory. Existing directories are unchanged; partial creation after an I/O failure is reported as uncertain.",
};

export function registerWriteTools(server: McpServer, config: ServerConfig): void {
  if (!config.writePolicy.enabled) return;
  const writer = getWorkspaceWriter(config);
  for (const tool of WRITE_TOOLS) {
    server.registerTool(tool, {
      title: tool,
      description: descriptions[tool],
      inputSchema: writeInputSchemas[tool].shape,
      outputSchema: z.object({}).passthrough(),
      annotations: { readOnlyHint: false, destructiveHint: tool === "patch_text_file" || tool === "update_json_value",
        idempotentHint: true, openWorldHint: false },
    }, async (args: unknown) => toolResult(await writer.execute(tool, args)));
  }
  server.registerTool("get_write_operation", {
    title: "Write Operation Status",
    description: "Read the durable result for an operation UUID. Pending means outcome unknown; inspect the file and ask the operator to reconcile. Never rerun an uncertain operation with a new UUID.",
    inputSchema: { operation_id: operationIdSchema },
    outputSchema: z.object({}).passthrough(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ operation_id }) => {
    try { return toolResult(await writer.getOperation(operation_id)); }
    catch (error) { return toolResult({ ok: false, code: error instanceof WorkspaceWriteError ? error.code : "WRITE_FAILED" }); }
  });
}

function toolResult(value: Record<string, unknown>) {
  return { isError: value.ok === false, structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
