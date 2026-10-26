import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerConfig } from "./config.js";
import type { ReadOnlyQuery } from "./cc-readonly.js";
import { componentDiagnosticsInput, componentDiagnosticsOutput, runtimeStatusInput } from "./runtime-diagnostics-contract.js";
import { createComponentDiagnostics, createWorkspaceRuntimeStatus, workspaceRuntimeOutput, type WorkspaceRuntimeOptions } from "./runtime-status.js";

export function registerRuntimeStatusTools(server: McpServer, config: ServerConfig, options: WorkspaceRuntimeOptions = {}, query?: ReadOnlyQuery) {
  const definitions = [
    { name: "workspace_runtime_status", input: runtimeStatusInput, output: workspaceRuntimeOutput,
      description: "Read this Workspace boot identity, current permissions, service-owned HTTP listener context, MCP transport and local CC channel separately. No self HTTP probe or lifecycle action. Build is boot-loaded, not current source; listener/IPC observations do not prove ChatGPT E2E or independent ownership.",
      handler: createWorkspaceRuntimeStatus(config, options, query) },
    { name: "mcp_component_diagnostics", input: componentDiagnosticsInput, output: componentDiagnosticsOutput,
      description: "Read detailed diagnostics for exactly one of seven allowlisted MCPs from Control Center's existing in-memory snapshot. Source/time-labeled state, connectivity, ownership observations, provider workload/build, maintenance availability and freshness. Ready does not mean Idle. Missing/stale/old CC is UNVERIFIED, with no TCP fallback, provider calls, writes or restart. Ownership requires controller recheck; IPC trust is not independent attestation. Workspace and CC are excluded.",
      handler: createComponentDiagnostics(query) },
  ];
  for (const d of definitions) server.registerTool(d.name, {
    title: d.name, description: d.description, inputSchema: d.input,
    outputSchema: d.output,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async (input: unknown) => {
    let value: Record<string, unknown>;
    try { value = await d.handler(input); }
    catch (error) { value = { ok: false, code: error instanceof z.ZodError ? "INVALID_INPUT" : "OBSERVATION_FAILED" }; }
    return { isError: value.ok === false, structuredContent: value, content: [{ type: "text" as const, text: JSON.stringify(value) }] };
  });
}
