import { z } from "zod";
import { COMPONENT_IDS } from "./component-recovery.js";

export const componentDiagnosticsInput = z.object({ componentId: z.enum(COMPONENT_IDS) }).strict();
export const runtimeStatusInput = z.object({}).strict();
export const statusSchema = z.enum(["Ready", "Degraded", "BlockedUpstream", "Stopped", "Unhealthy", "OwnershipMismatch", "OwnershipUnknown", "Misconfigured", "NotInstalled", "UNVERIFIED"]);
export const timestamp = z.string().datetime({ offset: true });
const count = z.number().int().min(0).max(2147483647);
export const probeSchema = z.object({
  role: z.enum(["core", "connectivity", "dependency"]),
  success: z.boolean().nullable(), tcpOpen: z.boolean().nullable(),
  ownerKnown: z.boolean(), pid: z.number().int().positive().max(2147483647).nullable(),
  matchesExpected: z.boolean().nullable(),
  runtimeBuildId: z.string().regex(/^[a-fA-F0-9]{7,64}$/).nullable(),
  activeJobs: count.nullable(), pendingApproval: count.nullable(),
  controller: z.enum(["ready", "idle", "starting", "unavailable"]).nullable(),
}).strict().superRefine((p, ctx) => {
  if ((!p.ownerKnown && (p.pid !== null || p.matchesExpected !== null)) ||
      (p.ownerKnown && p.pid === null) ||
      ((p.activeJobs === null) !== (p.pendingApproval === null)) ||
      (p.success !== true && (p.runtimeBuildId !== null || p.activeJobs !== null || p.controller !== null)) ||
      (p.role !== "core" && (p.activeJobs !== null || p.controller !== null))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Inconsistent observation" });
  }
});
export const detailSchema = z.object({
  componentId: z.enum(COMPONENT_IDS), status: statusSchema,
  localStatus: statusSchema, observedAt: timestamp,
  readinessScope: z.enum(["none", "local", "remote_registration", "end_to_end", "UNVERIFIED"]),
  probes: z.array(probeSchema).max(8),
}).strict().superRefine((d, ctx) => {
  if (d.componentId !== "codex_bridge" && d.probes.some(p => p.activeJobs !== null || p.controller !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Unsupported workload provider" });
  }
});
export const diagnosticsResponseSchema = z.object({
  v: z.literal("1"), nonce: z.string().regex(/^[0-9a-f]{64}$/),
  operation: z.literal("diagnostics"), componentId: z.enum(COMPONENT_IDS),
  diagnosticsVersion: z.literal("1"),
  code: z.enum(["DIAGNOSTICS_OBSERVATION", "SNAPSHOT_UNAVAILABLE", "SNAPSHOT_STALE"]),
  observedAt: timestamp.nullable(), detail: detailSchema.nullable(),
}).strict();

export const evidenceSources = z.enum(["CC_TRAY_SNAPSHOT", "CC_PROVIDER_HEALTH_SUMMARY", "WORKSPACE_RUNTIME_IDENTITY", "WORKSPACE_CONFIG", "WORKSPACE_HTTP_CONTEXT", "WORKSPACE_MCP_CONTEXT", "SAME_USER_LOCAL_IPC", "NONE"]);
export function evidenceSchema<T extends z.ZodTypeAny>(value: T) {
  return z.object({ source: evidenceSources, observedAt: timestamp.nullable(), value: value.nullable(),
    reason: z.enum(["UNVERIFIED", "OBSERVED", "NOT_PUBLISHED", "STALE", "CHANNEL_UNAVAILABLE", "NO_PROVIDER", "NO_TRANSPORT_CONTEXT"]) }).strict();
}
export const channelSchema = z.object({
  connection: z.enum(["CONNECTED", "UNVERIFIED"]), code: z.string().regex(/^[A-Z_]+$/).max(64),
  source: z.literal("SAME_USER_LOCAL_IPC"), observedAt: timestamp,
  independentOwnerAttestation: z.literal(false),
}).strict();
export const componentDiagnosticsOutput = z.object({
  ok: z.literal(true), code: z.enum(["DIAGNOSTICS_OBSERVATION", "UNVERIFIED"]),
  contract: z.literal("mcp-component-diagnostics-v1"), componentId: z.enum(COMPONENT_IDS),
  channel: channelSchema,
  state: evidenceSchema(z.object({ status: statusSchema, localStatus: statusSchema, readinessScope: z.string().max(32) }).strict()),
  locality: evidenceSchema(z.literal("LOCAL_MACHINE")),
  connectivity: evidenceSchema(z.array(z.object({ role: z.enum(["core", "connectivity", "dependency"]), success: z.boolean().nullable(), tcpOpen: z.boolean().nullable() }).strict()).max(8)),
  ownership: evidenceSchema(z.object({ trust: z.literal("CC_PROBE_OBSERVATION_CONTROLLER_RECHECK_REQUIRED"), roles: z.array(z.object({ role: z.enum(["core", "connectivity", "dependency"]), known: z.boolean(), pid: z.number().int().positive().nullable(), matchesExpected: z.boolean().nullable() }).strict()).max(8) }).strict()),
  workload: evidenceSchema(z.object({ state: z.enum(["ACTIVE", "IDLE", "UNVERIFIED"]), activeJobs: count, pendingApproval: count, controller: z.enum(["ready", "idle", "starting", "unavailable"]).nullable(), scope: z.literal("all"), ownershipMatched: z.boolean(), maintenanceAuthorized: z.literal(false) }).strict()),
  runtimeBuild: evidenceSchema(z.array(z.object({ role: z.enum(["core", "connectivity", "dependency"]), buildId: z.string().max(64) }).strict()).max(8)),
  sourceBuild: evidenceSchema(z.null()), maintenance: evidenceSchema(z.null()),
  componentIpc: evidenceSchema(z.null()), chatgptE2e: evidenceSchema(z.null()),
  freshness: z.object({ source: z.literal("CC_TRAY_SNAPSHOT"), observedAt: timestamp.nullable(), checkedAt: timestamp,
    ageMs: z.number().nullable(), maxAgeMs: z.literal(90000), state: z.enum(["FRESH", "STALE", "UNVERIFIED"]) }).strict(),
}).strict();
