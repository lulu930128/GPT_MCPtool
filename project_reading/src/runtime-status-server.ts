import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { performance } from "node:perf_hooks";
import { UPDATE_COMPONENT_IDS } from "./component-update-contract.js";
import { observeControlChannel, queryReadOnlyOwner } from "./cc-readonly.js";
import { createComponentUpdates } from "./component-update.js";
import { componentPorts } from "./component-recovery.js";
import { inspectPortOwner, httpHealthCheck, checkTcpPort } from "./diagnostics.js";
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
  const sections = ["health","process","performance","dependencies","build","logs"] as const;
  server.registerTool("inspect_runtime", { description: "Sample a registered target with the health (default), performance or full profile. include selects sections. Coverage is point_sample even when windowMinutes is supplied. Missing measurements or owner evidence are reported as NOT_INSTRUMENTED or UNVERIFIED.",
    inputSchema: z.object({ target: z.enum(UPDATE_COMPONENT_IDS), profile: z.enum(["health","performance","full"]).default("health"),
      windowMinutes: z.number().positive().optional(), include: z.array(z.enum(sections)).optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false }
  }, async ({target,profile,windowMinutes,include}) => {
    const selected = new Set(include ?? (profile === "full" ? sections : profile === "performance" ?
      ["process","performance"] : ["health","process","dependencies","build"]));
    const self = target === "project_reading";
    const component = target !== "project_reading" && target !== "mcp_control_center" ? target : undefined;
    const local = self ? await createWorkspaceRuntimeStatus(config,options,query)({}) : undefined;
    const owner = component ? await createComponentDiagnostics(query)({componentId:component}) : undefined;
    const port = component ? componentPorts[component] : self ? options.runtimeContext?.().port : undefined;
    const at = new Date().toISOString();
    const measure = (value: unknown, source: string, scope: string) => ({ value, source, observedAt: at, identity: target, scope,
      conclusion: value == null ? "NOT_INSTRUMENTED" : "OBSERVED" });
    const missing = (scope: string) => measure(null,"NONE",scope);
    const result: Record<string,unknown> = { target, profile, requestedWindowMinutes: windowMinutes ?? null, coverage: "point_sample" };
    const cc = target === "mcp_control_center" ? await observeControlChannel(query ?? queryReadOnlyOwner) : undefined;
    if (selected.has("health")) result.health = { owner: owner?.state ?? local?.coreHttp ?? cc ?? missing("status"),
      port: measure(port ?? null, component ? "component registry" : "runtime listener", "listener"),
      tcp: port ? measure(await checkTcpPort({host:"127.0.0.1",port}),"check_tcp_port","loopback") : missing("tcp") };
    if (selected.has("dependencies")) result.dependencies = owner?.connectivity ?? local?.controlChannel ?? missing("dependencies");
    if (selected.has("build")) result.build = {
      source: local?.sourceBuild ?? owner?.sourceBuild ?? missing("source build identity"),
      installed: missing("installed release identity"),
      running: local?.identity ?? owner?.runtimeBuild ?? missing("running build"),
      release: await createComponentUpdates(query ?? queryReadOnlyOwner,false).mcp_component_update_status({componentId: target}) };
    if (selected.has("process")) result.process = { owner: self ? measure(process.pid,"process.pid","handler process") : owner?.ownership ?? missing("pid"),
      listener: port ? measure(await inspectPortOwner({port}),"inspect_port_owner","local port snapshot") : missing("listener") };
    if (selected.has("performance")) {
      const usage = self ? process.memoryUsage() : undefined;
      const sample = port ? await httpHealthCheck({url: "http://127.0.0.1:" + port + "/health",maxBodyBytes:0}) : null;
      result.performance = { cpuMicroseconds: self ? measure(process.cpuUsage(),"process.cpuUsage","process lifetime") : missing("cpu"),
        rssBytes: measure(usage?.rss ?? null,self ? "process.memoryUsage" : "NONE","resident memory"),
        heapUsedBytes: measure(usage?.heapUsed ?? null,self ? "process.memoryUsage" : "NONE","V8 heap"),
        eventLoop: self ? measure(performance.eventLoopUtilization(),"perf_hooks","process lifetime") : missing("event loop"),
        gc: missing("GC events"), http: sample ? measure(sample,"http_health_check","single GET /health on mapped port") : missing("http"),
        navigation: missing("browser navigation"), react: missing("React profiler"), mainThread: missing("browser trace") };
    }
    if (selected.has("logs")) result.logs = missing("owner-published logs");
    return { structuredContent: result, content:[{type:"text",text:JSON.stringify(result)}] };
  });
}
