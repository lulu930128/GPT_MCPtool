import type { ReadOnlyQuery } from "./cc-readonly.js";
import { componentUpdateSchemas, updateParameterDigest, updateResponseSchema, UPDATE_COMPONENT_IDS,
  type UpdateOperation, type UpdateResponse } from "./component-update-contract.js";

const channelCodes = new Set(["UNSUPPORTED_PLATFORM", "CHANNEL_UNAVAILABLE", "NOT_CONNECTED", "IPC_TIMEOUT", "IPC_INVALID_RESPONSE", "IPC_BUSY"]);
const receiptCodes = new Set(["UPDATE_QUEUED", "REQUEST_REPLAY", "RECEIPT_OBSERVED"]);

export function validateUpdateResponse(value: unknown, operation: UpdateOperation, args: Record<string, unknown>): UpdateResponse | string {
  if (value && typeof value === "object" && "unavailable" in value) {
    return typeof value.unavailable === "string" && channelCodes.has(value.unavailable) ? value.unavailable : "IPC_INVALID_RESPONSE";
  }
  const parsed = updateResponseSchema.safeParse(value);
  if (!parsed.success) return "IPC_INVALID_RESPONSE";
  const result = parsed.data;
  if (result.operation !== operation || result.componentId !== (args.componentId ?? "") ||
      result.action !== (args.action ?? "") || result.requestId !== (args.requestId ?? "")) return "IPC_INVALID_RESPONSE";
  if (operation === "update_status" || operation === "update_preview") {
    const expected = args.componentId ? [args.componentId] : [...UPDATE_COMPONENT_IDS];
    if (result.receipt || result.mutationEnabled || result.targets.length !== expected.length ||
        new Set(result.targets.map(t => t.componentId)).size !== expected.length ||
        result.targets.some(t => !expected.includes(t.componentId) || (t.supported && t.owner === null))) return "IPC_INVALID_RESPONSE";
  } else {
    if (result.targets.length || !result.mutationEnabled || result.sourceDigest !== null) return "IPC_INVALID_RESPONSE";
    const receipt = result.receipt;
    if (receipt) {
      if (!receiptCodes.has(result.code) || receipt.requestId.toLowerCase() !== String(args.requestId).toLowerCase() ||
          receipt.parameterDigest !== updateParameterDigest(receipt) || Date.parse(receipt.updatedAt) < Date.parse(receipt.createdAt)) return "IPC_INVALID_RESPONSE";
      if (operation === "update" && (receipt.componentId !== args.componentId || receipt.action !== args.action ||
          receipt.versionId !== args.versionId || receipt.expectedSourceDigest !== args.expectedSourceDigest ||
          receipt.idlePolicy !== args.idlePolicy)) return "IPC_INVALID_RESPONSE";
      // A terminal acceptance must carry the loaded identity and Ready observation.
      if (receipt.phase === "ACCEPTED" && (receipt.ready !== true || receipt.selectedVersion !== receipt.versionId ||
          receipt.blockedByOperationId !== null ||
          !receipt.observedVersion || !receipt.preparedBuildId || receipt.preparedBuildId !== receipt.observedBuildId ||
          (["codex_bridge", "mcp_control_center"].includes(receipt.componentId) && receipt.observedVersion !== receipt.versionId))) return "IPC_INVALID_RESPONSE";
    } else if (receiptCodes.has(result.code)) return "IPC_INVALID_RESPONSE";
  }
  return result;
}

export function createComponentUpdates(query: ReadOnlyQuery, authenticatedMaintenance: boolean) {
  async function read(operation: UpdateOperation, args: Record<string, unknown>) {
    try { return validateUpdateResponse(await query(operation, args), operation, args); }
    catch { return "CHANNEL_UNAVAILABLE"; }
  }
  function unavailable(code: string, requestId?: string) {
    return { contract: "mcp-component-update-v2", ok: true, code, requestId: requestId ?? null,
      authority: { owner: "mcp_control_center", connection: "UNVERIFIED", source: "SAME_USER_LOCAL_IPC" },
      ownerVerified: false, chatgptE2e: "UNVERIFIED", mutationEnabled: false, receipt: null,
      completed: null, terminal: null, finished: null, succeeded: null, requiresRecovery: null };
  }
  function connected(result: UpdateResponse) {
    const terminal = result.receipt ? ["ACCEPTED", "REJECTED"].includes(result.receipt.phase) : null;
    return { contract: "mcp-component-update-v2", ok: true, code: result.code,
      authority: { owner: "mcp_control_center", connection: "CONNECTED", source: result.receipt ? "CC_DURABLE_RECEIPT" : "CC_UPDATE_SNAPSHOT" },
      ownerVerified: false, chatgptE2e: "UNVERIFIED", mutationEnabled: result.mutationEnabled,
      sourceDigest: result.sourceDigest, targets: result.targets, receipt: result.receipt,
      completed: terminal, terminal, finished: terminal,
      succeeded: terminal ? result.receipt!.phase === "ACCEPTED" : null,
      requiresRecovery: result.receipt ? result.receipt.phase === "RECOVERY_REQUIRED" : null };
  }
  return {
    async mcp_component_update_status(input: unknown) {
      const args = componentUpdateSchemas.mcp_component_update_status.parse(input);
      const result = await read("update_status", args);
      return typeof result === "string" ? unavailable(result) : connected(result);
    },
    async mcp_component_update_preview(input: unknown) {
      const args = componentUpdateSchemas.mcp_component_update_preview.parse(input);
      const result = await read("update_preview", args);
      return { ...(typeof result === "string" ? unavailable(result) : connected(result)), ...args,
        requestCreated: false, executable: false, authenticatedMaintenance,
        requiredConfirmation: "interrupt_current_requests", requiredIdlePolicy: "wait_for_idle" };
    },
    async mcp_component_update(input: unknown) {
      const args = componentUpdateSchemas.mcp_component_update.parse(input);
      if (!authenticatedMaintenance) return unavailable("AUTHENTICATED_TRANSPORT_REQUIRED", args.requestId);
      const result = await read("update", args);
      return { ...(typeof result === "string" ? { ...unavailable("DELIVERY_UNKNOWN", args.requestId), ownerChannel: { code: result } } : connected(result)), ...args,
        instruction: "Query mcp_component_update_receipt with this same requestId. QUEUED/RUNNING are not completion. Never issue a new requestId after timeout; CC must preserve the original operation and active-work gates." };
    },
    async mcp_component_update_receipt(input: unknown) {
      const args = componentUpdateSchemas.mcp_component_update_receipt.parse(input);
      const result = await read("update_receipt", args);
      return { ...(typeof result === "string" ? unavailable(result, args.requestId) : connected(result)), ...args,
        instruction: "Missing or unavailable receipt does not prove the update was never dispatched. Preserve requestId and inspect the canonical operation before any continuation." };
    },
  };
}
