import { z } from "zod";
import type { ServerConfig } from "./config.js";
import { writeCapabilities } from "./write-policy.js";
import { observeControlChannel, queryReadOnlyOwner, type ReadOnlyQuery } from "./cc-readonly.js";
import { channelSchema, componentDiagnosticsInput, componentDiagnosticsOutput, diagnosticsResponseSchema,
  evidenceSchema, runtimeStatusInput, timestamp } from "./runtime-diagnostics-contract.js";

type Evidence<T> = { source: "CC_TRAY_SNAPSHOT" | "CC_PROVIDER_HEALTH_SUMMARY" | "WORKSPACE_RUNTIME_IDENTITY" | "WORKSPACE_CONFIG" | "WORKSPACE_HTTP_CONTEXT" | "WORKSPACE_MCP_CONTEXT" | "NONE";
  observedAt: string | null; value: T | null; reason: "OBSERVED" | "UNVERIFIED" | "NOT_PUBLISHED" | "NO_PROVIDER" | "NO_TRANSPORT_CONTEXT" };
function observed<T>(value: T, source: Evidence<T>["source"], observedAt: string): Evidence<T> {
  return { value, source, observedAt, reason: "OBSERVED" };
}
function unknown(reason: Evidence<null>["reason"] = "UNVERIFIED"): Evidence<null> {
  return { value: null, source: "NONE", observedAt: null, reason };
}

export function createComponentDiagnostics(query: ReadOnlyQuery = queryReadOnlyOwner) {
  return async (input: unknown) => {
    const { componentId } = componentDiagnosticsInput.parse(input);
    let raw: unknown;
    try { raw = await query("diagnostics", { componentId }); }
    catch { raw = { unavailable: "CHANNEL_UNAVAILABLE" }; }
    const checkedAt = new Date().toISOString();
    const parsed = diagnosticsResponseSchema.safeParse(raw);
    const response = parsed.success && parsed.data.componentId === componentId ? parsed.data : null;
    let code = "IPC_INVALID_RESPONSE";
    if (raw && typeof raw === "object" && "unavailable" in raw &&
        ["UNSUPPORTED_PLATFORM", "CHANNEL_UNAVAILABLE", "NOT_CONNECTED", "IPC_TIMEOUT", "IPC_INVALID_RESPONSE", "IPC_BUSY"].includes(String(raw.unavailable))) code = String(raw.unavailable);
    let sample = response?.detail ?? null;
    const observedAt = response?.observedAt ?? null;
    const ageMs = observedAt ? Date.parse(checkedAt) - Date.parse(observedAt) : null;
    const stale = ageMs !== null && (ageMs > 90_000 || ageMs < -1000);
    const coherent = response && (response.code === "DIAGNOSTICS_OBSERVATION"
      ? sample !== null && sample.componentId === componentId && sample.observedAt === observedAt
      : sample === null);
    if (!coherent) sample = null;
    else code = response.code;
    if (stale) { sample = null; code = "SNAPSHOT_STALE"; }
    if (code !== "DIAGNOSTICS_OBSERVATION") sample = null;
    const workload = sample?.probes.filter(p => p.role === "core" && p.activeJobs !== null && p.pendingApproval !== null) ?? [];
    const workloadOwnerMatched = workload.length === 1 && workload[0].ownerKnown && workload[0].matchesExpected === true &&
      sample !== null && !["OwnershipUnknown", "OwnershipMismatch", "UNVERIFIED"].includes(sample.status) &&
      !["OwnershipUnknown", "OwnershipMismatch", "UNVERIFIED"].includes(sample.localStatus);
    let workloadState: "ACTIVE" | "IDLE" | "UNVERIFIED" = "UNVERIFIED";
    if (workloadOwnerMatched) {
      if (workload[0].activeJobs! > 0 || workload[0].pendingApproval! > 0) workloadState = "ACTIVE";
      else if (["ready", "idle"].includes(workload[0].controller ?? "")) workloadState = "IDLE";
    }
    const builds = sample?.probes.filter(p => p.runtimeBuildId !== null).map(p => ({ role: p.role, buildId: p.runtimeBuildId! })) ?? [];
    const result = {
      ok: true, code: sample ? "DIAGNOSTICS_OBSERVATION" : "UNVERIFIED", contract: "mcp-component-diagnostics-v1", componentId,
      channel: { connection: coherent ? "CONNECTED" : "UNVERIFIED", code, source: "SAME_USER_LOCAL_IPC", observedAt: checkedAt, independentOwnerAttestation: false },
      state: sample ? observed({ status: sample.status, localStatus: sample.localStatus, readinessScope: sample.readinessScope }, "CC_TRAY_SNAPSHOT", sample.observedAt) : unknown(),
      locality: sample ? observed("LOCAL_MACHINE", "CC_TRAY_SNAPSHOT", sample.observedAt) : unknown(),
      connectivity: sample && sample.probes.length ? observed(sample.probes.map(p => ({ role: p.role, success: p.success, tcpOpen: p.tcpOpen })), "CC_TRAY_SNAPSHOT", sample.observedAt) : unknown(),
      ownership: sample && sample.probes.length ? observed({ trust: "CC_PROBE_OBSERVATION_CONTROLLER_RECHECK_REQUIRED", roles: sample.probes.map(p => ({ role: p.role, known: p.ownerKnown, pid: p.pid, matchesExpected: p.matchesExpected })) }, "CC_TRAY_SNAPSHOT", sample.observedAt) : unknown(),
      workload: workload.length === 1 ? observed({ state: workloadState, activeJobs: workload[0].activeJobs, pendingApproval: workload[0].pendingApproval,
        controller: workload[0].controller, scope: "all", ownershipMatched: workloadOwnerMatched, maintenanceAuthorized: false }, "CC_PROVIDER_HEALTH_SUMMARY", sample!.observedAt) : unknown("NO_PROVIDER"),
      runtimeBuild: builds.length ? observed(builds, "CC_PROVIDER_HEALTH_SUMMARY", sample!.observedAt) : unknown("NO_PROVIDER"),
      sourceBuild: unknown("NOT_PUBLISHED"), maintenance: unknown("NOT_PUBLISHED"),
      componentIpc: unknown("NOT_PUBLISHED"), chatgptE2e: unknown("UNVERIFIED"),
      freshness: { source: "CC_TRAY_SNAPSHOT", observedAt: coherent ? observedAt : null, checkedAt,
        ageMs: coherent ? ageMs : null, maxAgeMs: 90000, state: coherent && stale ? "STALE" : sample ? "FRESH" : "UNVERIFIED" },
    };
    return componentDiagnosticsOutput.parse(result);
  };
}

export interface WorkspaceRuntimeContext {
  transport: "stdio" | "streamable-http";
  httpListening: boolean | null;
}
export interface WorkspaceRuntimeOptions {
  authenticatedMaintenance?: boolean;
  runtimeContext?: () => WorkspaceRuntimeContext;
}
const identitySchema = z.object({ applicationVersion: z.string().max(64), toolContractVersion: z.string().max(64),
  buildId: z.string().max(64).nullable(), buildTime: timestamp.nullable(), gitCommit: z.string().max(64).nullable(),
  dirty: z.boolean().nullable(), runtimeStartedAt: timestamp }).strict();
export const workspaceRuntimeOutput = z.object({
  ok: z.literal(true), code: z.literal("SELF_OBSERVATION"), contract: z.literal("workspace-runtime-status-v1"),
  identity: evidenceSchema(identitySchema),
  permissions: evidenceSchema(z.object({ mode: z.enum(["operate", "read-only"]), writeEnabled: z.boolean(), manualMaintenanceEnabled: z.boolean() }).strict()),
  coreHttp: evidenceSchema(z.object({ listening: z.boolean() }).strict()),
  mcp: evidenceSchema(z.object({ transport: z.enum(["stdio", "streamable-http", "UNVERIFIED"]), state: z.literal("TOOL_HANDLER_RUNNING") }).strict()),
  controlChannel: channelSchema, sourceBuild: evidenceSchema(z.null()), chatgptE2e: evidenceSchema(z.null()),
  observedAt: timestamp,
}).strict();

export function createWorkspaceRuntimeStatus(config: ServerConfig, options: WorkspaceRuntimeOptions = {}, query: ReadOnlyQuery = queryReadOnlyOwner) {
  return async (input: unknown) => {
    runtimeStatusInput.parse(input);
    const [permissions, controlChannel] = await Promise.all([writeCapabilities(config.writePolicy), observeControlChannel(query)]);
    const at = new Date().toISOString();
    const identity = config.runtimeIdentity;
    const context = options.runtimeContext?.();
    return workspaceRuntimeOutput.parse({
      ok: true, code: "SELF_OBSERVATION", contract: "workspace-runtime-status-v1", observedAt: at,
      identity: observed({ applicationVersion: identity.applicationVersion, toolContractVersion: identity.toolContractVersion,
        buildId: identity.buildId, buildTime: identity.buildTime, gitCommit: identity.gitCommit, dirty: identity.dirty,
        runtimeStartedAt: identity.runtimeStartedAt }, "WORKSPACE_RUNTIME_IDENTITY", at),
      permissions: observed({ mode: permissions.enabled ? "operate" : "read-only", writeEnabled: permissions.enabled,
        manualMaintenanceEnabled: options.authenticatedMaintenance === true }, "WORKSPACE_CONFIG", at),
      coreHttp: typeof context?.httpListening === "boolean" ? observed({ listening: context.httpListening }, "WORKSPACE_HTTP_CONTEXT", at) : unknown("NO_TRANSPORT_CONTEXT"),
      mcp: observed({ transport: context?.transport ?? "UNVERIFIED", state: "TOOL_HANDLER_RUNNING" }, "WORKSPACE_MCP_CONTEXT", at),
      controlChannel, sourceBuild: unknown("NOT_PUBLISHED"), chatgptE2e: unknown(),
    });
  };
}
