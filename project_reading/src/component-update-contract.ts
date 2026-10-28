import { createHash } from "node:crypto";
import { z } from "zod";
import { COMPONENT_IDS } from "./component-recovery.js";

// This is separate from the seven-target v1 status/reload contract.
export const UPDATE_COMPONENT_IDS = Object.freeze([...COMPONENT_IDS, "project_reading", "mcp_control_center"] as const);
export const UPDATE_OPERATIONS = ["update_status", "update_preview", "update", "update_receipt"] as const;
export type UpdateOperation = typeof UPDATE_OPERATIONS[number];
const componentId = z.enum(UPDATE_COMPONENT_IDS);
const versionId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/);
const action = z.literal("update_from_source");
const idlePolicy = z.literal("wait_for_idle");
export const componentUpdateSchemas = {
  mcp_component_update_status: z.object({ componentId: componentId.optional() }).strict(),
  mcp_component_update_preview: z.object({ componentId, action, versionId, expectedSourceDigest: digest.optional(), idlePolicy }).strict(),
  mcp_component_update: z.object({ componentId, action, versionId, expectedSourceDigest: digest, idlePolicy,
    confirmation: z.literal("interrupt_current_requests"), requestId: z.string().uuid() }).strict(),
  mcp_component_update_receipt: z.object({ requestId: z.string().uuid() }).strict(),
};
export const updateReceiptSchema = z.object({
  requestId: z.string().uuid(), componentId, action, versionId, expectedSourceDigest: digest, idlePolicy,
  parameterDigest: digest, operationId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  blockedByOperationId: z.string().regex(/^[0-9a-f]{32}$/).nullable(),
  phase: z.enum(["QUEUED", "RUNNING", "ACCEPTED", "REJECTED", "RECOVERY_REQUIRED"]), code,
  createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
  selectedVersion: versionId.nullable(), observedVersion: z.string().min(1).max(80).nullable(),
  preparedBuildId: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/).nullable(),
  observedBuildId: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/).nullable(), ready: z.boolean().nullable(),
}).strict();
export const updateResponseSchema = z.object({
  v: z.literal("2"), nonce: digest, operation: z.enum(UPDATE_OPERATIONS), componentId: z.string().max(40),
  action: z.string().max(40), requestId: z.string().max(36), code,
  targets: z.array(z.object({ componentId, supported: z.boolean(),
    owner: z.enum(["daily_code", "component_controller", "independent_bootstrap"]).nullable(), reason: code.nullable() }).strict()).max(9),
  sourceDigest: digest.nullable(), receipt: updateReceiptSchema.nullable(), mutationEnabled: z.boolean(),
}).strict();
export type UpdateResponse = z.infer<typeof updateResponseSchema>;

export function updateParameterDigest(value: Pick<z.infer<typeof updateReceiptSchema>, "componentId" | "action" | "versionId" | "expectedSourceDigest" | "idlePolicy">): string {
  return createHash("sha256").update([value.componentId, value.action, value.versionId, value.expectedSourceDigest,
    value.idlePolicy, "interrupt_current_requests"].join("\n"), "utf8").digest("hex");
}
