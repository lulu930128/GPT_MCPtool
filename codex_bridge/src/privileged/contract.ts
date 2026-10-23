import { createHash } from "node:crypto";
import { z } from "zod";

export const operationIds = ["diagnostics.os_summary", "diagnostics.memory_summary"] as const;
export const operationSchema = z.enum(operationIds);
export const previewSchema = z.object({ operationId: operationSchema }).strict();
export const requestSchema = previewSchema.extend({ requestId: z.string().uuid() }).strict();
export const lookupSchema = z.object({ requestId: z.string().uuid() }).strict();
export const decisionSchema = z.object({
  requestId: z.string().uuid(), approvalId: z.string().uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(["approve", "deny"]),
}).strict();

export const POLICY_VERSION = "remote-privileged-broker-v1";
export const TTL_MS = 120_000;
export const MAX_REQUESTS = 1_000;
export type OperationId = z.infer<typeof operationSchema>;

// No command, path, flags, environment or caller-selected target exists in this contract.
export function operationPolicy(operationId: OperationId) {
  return {
    operationId, policyVersion: POLICY_VERSION, targetId: "local_machine" as const,
    effect: "read_only" as const, requiredPrivilege: "standard_user" as const,
    requiresExactApproval: true, ttlMs: TTL_MS, mutationEnabled: false,
    resultFields: operationId === "diagnostics.os_summary" ? ["platform", "architecture"] : ["totalMiB", "availableMiB"],
  };
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class BrokerError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BrokerError"; }
}

// Do not reflect parser issues, worker exceptions, raw OS output or unknown fields.
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BrokerError("BROKER_INVALID_INPUT");
  return parsed.data;
}

const osResult = z.object({ platform: z.literal("windows"), architecture: z.enum(["x64", "arm64"]) }).strict();
const memoryResult = z.object({ totalMiB: z.number().int().min(1).max(16_777_216), availableMiB: z.number().int().min(0).max(16_777_216) })
  .strict().refine((value) => value.availableMiB <= value.totalMiB);
export const resultSchema = z.discriminatedUnion("operationId", [
  z.object({ operationId: z.literal("diagnostics.os_summary"), data: osResult }).strict(),
  z.object({ operationId: z.literal("diagnostics.memory_summary"), data: memoryResult }).strict(),
]);
export type DiagnosticResult = z.infer<typeof resultSchema>;

export const receiptSchema = z.object({
  version: z.literal(1), evidence: z.literal("SYNTHETIC_ONLY"),
  requestId: z.string().uuid(), approvalId: z.string().uuid(), bootId: z.string().uuid(),
  operationId: operationSchema, digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  approval: z.enum(["pending", "approved", "denied", "expired"]),
  execution: z.enum(["not_executed", "executing", "executed", "unknown"]),
  reason: z.enum(["REQUESTED", "HUMAN_FIXTURE_APPROVED", "HUMAN_FIXTURE_DENIED", "TTL_EXPIRED", "RESTART_EXPIRED", "DELIVERY_STARTED", "SYNTHETIC_COMPLETED", "RESULT_REJECTED", "WORKER_UNCERTAIN", "RESTART_UNCERTAIN"]),
  result: resultSchema.optional(),
}).strict().superRefine((receipt, ctx) => {
  if (receipt.expiresAt !== receipt.createdAt + TTL_MS
    || (receipt.execution !== "not_executed" && receipt.approval !== "approved")
    || (receipt.execution === "executed") !== (receipt.result !== undefined)
    || (receipt.result && receipt.result.operationId !== receipt.operationId)
    || receipt.digest !== requestDigest(receipt)) {
    ctx.addIssue({ code: "custom", message: "Invalid receipt" });
  }
});
export type BrokerReceipt = z.infer<typeof receiptSchema>;

export function requestDigest(input: Pick<BrokerReceipt, "requestId" | "approvalId" | "bootId" | "operationId" | "createdAt" | "expiresAt">): string {
  return digest({ policy: operationPolicy(input.operationId), requestId: input.requestId,
    approvalId: input.approvalId, bootId: input.bootId, createdAt: input.createdAt, expiresAt: input.expiresAt });
}

export function deploymentPreflight() {
  return {
    deployment: "NOT DEPLOYED" as const, writeProtection: "NOT ENFORCED" as const,
    state: "not_configured" as const, enabled: false,
    checks: [
      { id: "native_executor", status: "missing" },
      { id: "protected_executable_policy_dependencies", status: "unverified" },
      { id: "workspace_and_bridge_no_write_or_service_control", status: "unverified" },
      { id: "independent_human_approval_authority", status: "missing" },
      { id: "authenticated_local_ipc_and_executor_revalidation", status: "missing" },
    ],
  };
}
