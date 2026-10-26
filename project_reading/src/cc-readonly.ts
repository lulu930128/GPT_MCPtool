import net from "node:net";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { COMPONENT_IDS, PREVIEW_ACTIONS, componentRecoverySchemas, componentStatus, componentPreview, componentReceipt } from "./component-recovery.js";
import { componentDiagnosticsInput, diagnosticsResponseSchema } from "./runtime-diagnostics-contract.js";

const pipe = "\\\\.\\pipe\\mcpcc-workspace-local-v1";
export const CC_READONLY_LIMITS = Object.freeze({ maxConcurrent: 2, timeoutMs: 1800, maxBytes: 16384 });
const unavailableCodes = z.enum(["UNSUPPORTED_PLATFORM", "CHANNEL_UNAVAILABLE", "NOT_CONNECTED", "SNAPSHOT_UNAVAILABLE", "IPC_TIMEOUT", "IPC_INVALID_RESPONSE", "IPC_BUSY"]);
type FailureCode = z.infer<typeof unavailableCodes>;
type Operation = "status" | "preview" | "receipt" | "restart";
export type ReadOnlyQuery = (operation: Operation | "diagnostics", args: Record<string, unknown>) => Promise<unknown>;
const row = z.object({
  componentId: z.enum(COMPONENT_IDS),
  status: z.enum(["Ready", "Degraded", "BlockedUpstream", "Stopped", "Unhealthy", "OwnershipMismatch", "OwnershipUnknown", "Misconfigured", "NotInstalled", "UNVERIFIED"]),
  observedAt: z.string().datetime({ offset: true }),
  capabilities: z.array(z.enum(PREVIEW_ACTIONS)).max(5),
}).strict();
const receiptSchema = z.object({
  requestId: z.string().uuid(), componentId: z.enum(COMPONENT_IDS), action: z.literal("reload_runtime"),
  confirmation: z.literal("interrupt_current_requests"), outcome: z.enum(["UNKNOWN", "COMPLETED"]),
  createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
}).strict();
const responseSchema = z.object({
  v: z.literal("1"), nonce: z.string().regex(/^[0-9a-f]{64}$/), operation: z.enum(["status", "preview", "receipt", "restart"]),
  componentId: z.string(), action: z.string(), requestId: z.string(),
  code: z.enum(["OWNER_OBSERVATION", "READ_ONLY_PREVIEW", "RECEIPT_SOURCE_UNAVAILABLE", "SNAPSHOT_UNAVAILABLE", "ACTION_ACCEPTED", "ACTION_BUSY", "REQUEST_REPLAY", "REQUEST_CONFLICT", "OWNER_CLOSING", "RECEIPT_NOT_FOUND", "RECEIPT_OBSERVED", "RECEIPT_UNAVAILABLE", "RECEIPT_CAPACITY"]),
  components: z.array(row).max(7),
  supported: z.boolean().nullable(),
  mutationEnabled: z.boolean(), allowed: z.literal(false), executable: z.literal(false),
  found: z.boolean().nullable(), completed: z.boolean().nullable(), receipt: receiptSchema.nullable(),
}).strict();
type OwnerResponse = z.infer<typeof responseSchema>;

// Local same-user IPC is sourced observation, not independent process attestation.
// Service process ownership stays in the component controller. No retries.
let active = 0;
export const queryReadOnlyOwner: ReadOnlyQuery = async (operation, args) => {
  const parsed = (operation === "diagnostics" ? componentDiagnosticsInput : componentRecoverySchemas[`mcp_component_${operation}`]).parse(args);
  if (active >= CC_READONLY_LIMITS.maxConcurrent) return { unavailable: "IPC_BUSY" };
  active++;
  try {
    if (process.platform !== "win32") return { unavailable: "UNSUPPORTED_PLATFORM" };
    const nonce = randomBytes(32).toString("hex");
    const componentId = "componentId" in parsed && typeof parsed.componentId === "string" ? parsed.componentId : "";
    const action = "action" in parsed && typeof parsed.action === "string" ? parsed.action : "";
    const requestId = "requestId" in parsed && typeof parsed.requestId === "string" ? parsed.requestId : "";
    const confirmation = "confirmation" in parsed && typeof parsed.confirmation === "string" ? parsed.confirmation : "";
    return await exchangePipe({ v: "1", operation, componentId, action, requestId, nonce, confirmation });
  } catch { return { unavailable: "CHANNEL_UNAVAILABLE" }; }
  finally { active--; }
};

// Socket factory is a test-only seam, never supplied by tool input/config/env.
export function exchangePipe(request: Record<string, string>, connect = () => net.createConnection(pipe)): Promise<unknown> {
  return new Promise((resolve) => {
    let socket: net.Socket | undefined;
    let done = false, challenged = false, buffered = Buffer.alloc(0), total = 0;
    const finish = (value: unknown) => { if (done) return; done = true; clearTimeout(timer); socket?.destroy(); resolve(value); };
    const fail = (unavailable: FailureCode) => finish({ unavailable });
    const timer = setTimeout(() => fail("IPC_TIMEOUT"), CC_READONLY_LIMITS.timeoutMs);
    try {
      socket = connect();
      socket.on("error", (error: NodeJS.ErrnoException) => fail(["ENOENT", "ECONNREFUSED"].includes(error.code ?? "") ? "NOT_CONNECTED" : "CHANNEL_UNAVAILABLE"));
      socket.on("close", () => fail("NOT_CONNECTED"));
      socket.on("data", (chunk: Buffer) => {
        if (done) return;
        total += chunk.length;
        if (total > CC_READONLY_LIMITS.maxBytes + 72) return fail("IPC_INVALID_RESPONSE");
        buffered = Buffer.concat([buffered, chunk]);
        while (!done && buffered.length >= 4) {
          const size = buffered.readUInt32LE(0);
          if (size < 1 || size > (challenged ? CC_READONLY_LIMITS.maxBytes : 64)) return fail("IPC_INVALID_RESPONSE");
          if (buffered.length < size + 4) return;
          const bytes = buffered.subarray(4, size + 4); buffered = buffered.subarray(size + 4);
          let text: string;
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail("IPC_INVALID_RESPONSE"); }
          if (!challenged) {
            if (!/^[0-9a-f]{64}$/.test(text) || buffered.length !== 0) return fail("IPC_INVALID_RESPONSE");
            challenged = true;
            const body = Buffer.from(JSON.stringify({ ...request, challenge: text }));
            const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
            socket!.write(Buffer.concat([header, body]));
          } else {
            try {
              const response = (request.operation === "diagnostics" ? diagnosticsResponseSchema : responseSchema).parse(JSON.parse(text));
              if (buffered.length || response.nonce !== request.nonce) return fail("IPC_INVALID_RESPONSE");
              finish(response);
            } catch { fail("IPC_INVALID_RESPONSE"); }
          }
        }
      });
    } catch { fail("NOT_CONNECTED"); }
  });
}

function validate(value: unknown, operation: Operation, args: Record<string, unknown>): OwnerResponse | FailureCode {
  if (value && typeof value === "object" && "unavailable" in value) {
    const code = unavailableCodes.safeParse(value.unavailable);
    return code.success ? code.data : "IPC_INVALID_RESPONSE";
  }
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) return "IPC_INVALID_RESPONSE";
  const r = parsed.data;
  if (r.operation !== operation || r.componentId !== (args.componentId ?? "") || r.action !== (args.action ?? "") || r.requestId !== (args.requestId ?? "")) return "IPC_INVALID_RESPONSE";
  if (r.operation === "restart" || r.operation === "receipt") {
    const codes = r.operation === "restart" ? ["ACTION_ACCEPTED", "ACTION_BUSY", "REQUEST_REPLAY"] : ["RECEIPT_NOT_FOUND", "RECEIPT_OBSERVED"];
    if (!r.mutationEnabled || r.components.length || r.supported !== null) return "IPC_INVALID_RESPONSE";
    if (["REQUEST_CONFLICT", "OWNER_CLOSING"].includes(r.code)) return operation === "restart" && r.found === null && r.completed === null && r.receipt === null ? r : "IPC_INVALID_RESPONSE";
    if (["RECEIPT_UNAVAILABLE", "RECEIPT_CAPACITY"].includes(r.code)) return r.found === null && r.completed === null && r.receipt === null ? r : "IPC_INVALID_RESPONSE";
    if (!codes.includes(r.code)) return "IPC_INVALID_RESPONSE";
    if (r.receipt) {
      if (operation === "restart" && (r.receipt.componentId !== args.componentId || r.receipt.action !== args.action ||
          r.receipt.confirmation !== args.confirmation)) return "IPC_INVALID_RESPONSE";
      if (r.receipt.requestId.toLowerCase() !== String(args.requestId).toLowerCase() || r.found !== true ||
          r.completed !== (r.receipt.outcome === "COMPLETED" ? true : null) || ["ACTION_BUSY", "RECEIPT_NOT_FOUND"].includes(r.code)) return "IPC_INVALID_RESPONSE";
    } else if (!["ACTION_BUSY", "RECEIPT_NOT_FOUND"].includes(r.code) || r.found !== false || r.completed !== null) return "IPC_INVALID_RESPONSE";
    return r;
  }
  if (r.mutationEnabled || r.found !== null || r.completed !== null || r.receipt !== null) return "IPC_INVALID_RESPONSE";
  if (r.code === "SNAPSHOT_UNAVAILABLE") return "SNAPSHOT_UNAVAILABLE";
  if (r.code !== ({ status: "OWNER_OBSERVATION", preview: "READ_ONLY_PREVIEW", receipt: "RECEIPT_SOURCE_UNAVAILABLE", restart: "ACTION_ACCEPTED" } as const)[operation]) return "IPC_INVALID_RESPONSE";
  const expected = args.componentId ? [args.componentId] : [...COMPONENT_IDS];
  if (r.components.length !== expected.length || new Set(r.components.map((c) => c.componentId)).size !== expected.length ||
      r.components.some((c) => !expected.includes(c.componentId) || new Set(c.capabilities).size !== c.capabilities.length ||
        Date.now() - Date.parse(c.observedAt) > 90_000 || Date.parse(c.observedAt) - Date.now() > 1000)) return "IPC_INVALID_RESPONSE";
  if (operation === "preview" ? r.supported !== r.components[0].capabilities.includes(args.action as typeof PREVIEW_ACTIONS[number]) : r.supported !== null) return "IPC_INVALID_RESPONSE";
  return r;
}

// Self diagnostics observe only the existing channel, without TCP fallback or recursion.
export async function observeControlChannel(query: ReadOnlyQuery = queryReadOnlyOwner) {
  let result: OwnerResponse | FailureCode;
  let snapshotUnavailableReply = false;
  try {
    const raw = await query("status", {});
    result = validate(raw, "status", {});
    snapshotUnavailableReply = result === "SNAPSHOT_UNAVAILABLE" && responseSchema.safeParse(raw).success;
  }
  catch { result = "CHANNEL_UNAVAILABLE"; }
  // A valid unavailable-snapshot reply still establishes channel connectivity.
  return { connection: typeof result !== "string" || snapshotUnavailableReply ? "CONNECTED" as const : "UNVERIFIED" as const,
    code: typeof result === "string" ? result : "LOCAL_CHANNEL_RESPONSE",
    source: "SAME_USER_LOCAL_IPC" as const, observedAt: new Date().toISOString(), independentOwnerAttestation: false as const };
}

// Dependency seam for isolated tests only; never settable through MCP/config/env.
export function createReadOnlyRecovery(query: ReadOnlyQuery = queryReadOnlyOwner, authenticatedMaintenance = false) {
  async function read(operation: Operation, args: Record<string, unknown>) {
    try { return validate(await query(operation, args), operation, args); }
    catch { return "NOT_CONNECTED" as const; }
  }
  function connected(result: OwnerResponse) {
    return {
      contract: "mcp-component-local-v1", ok: true, code: result.code,
      authority: { owner: "mcp_control_center", deployment: "LOCAL_CHANNEL", connection: "CONNECTED", source: ["receipt", "restart"].includes(result.operation) ? "CC_DURABLE_RECEIPT" : "CC_TRAY_SNAPSHOT" },
      ownerVerified: false, ownerChannel: { code: "LOCAL_CHANNEL_RESPONSE", verified: false, trust: "SAME_USER_LOCAL_IPC" },
      ownership: "COMPONENT_CONTROLLER_REQUIRED", chatgptE2e: "UNVERIFIED", mutationEnabled: result.mutationEnabled,
    };
  }
  return {
    async mcp_component_status(input: unknown) {
      const args = componentRecoverySchemas.mcp_component_status.parse(input);
      const result = await read("status", args);
      if (typeof result === "string") return { ...await componentStatus(args), ownerVerified: false, ownerChannel: { code: result, verified: false } };
      return { ...connected(result), components: result.components, maxSnapshotAgeMs: 90_000 };
    },
    async mcp_component_preview(input: unknown) {
      const args = componentRecoverySchemas.mcp_component_preview.parse(input);
      const result = await read("preview", args);
      if (typeof result === "string") return { ...componentPreview(args), ok: true, ownerChannel: { code: result, verified: false } };
      const component = result.components[0];
      const manualRestart = args.action === "reload_runtime";
      const blockedState = ["OwnershipUnknown", "OwnershipMismatch", "Misconfigured", "NotInstalled", "UNVERIFIED"].includes(component.status);
      const reason = !result.supported ? "ACTION_UNSUPPORTED" : blockedState ? "TARGET_REQUIRES_ATTENTION" : manualRestart ? (authenticatedMaintenance ? "INTERRUPTION_CONFIRMATION_REQUIRED" : "AUTHENTICATED_TRANSPORT_REQUIRED") : "COMPONENT_POLICY_NOT_ENABLED";
      return { ...connected(result), ...args, supported: result.supported, component,
        previewStatus: "OBSERVED", allowed: false, executable: false, requestCreated: false,
        manualRestartAvailable: authenticatedMaintenance && manualRestart && result.supported === true && !blockedState,
        reason, activeWork: "NOT_OBSERVED", consequence: "Restart interrupts current requests; component controller rechecks exact process ownership.",
        requiredConfirmation: manualRestart ? "interrupt_current_requests" : null };
    },
    async mcp_component_receipt(input: unknown) {
      const args = componentRecoverySchemas.mcp_component_receipt.parse(input);
      const result = await read("receipt", args);
      if (typeof result === "string") return { ...componentReceipt(args), ok: true, ownerVerified: false, ownerChannel: { code: result, verified: false } };
      return { ...connected(result), ...args, found: result.found, completed: result.completed, receipt: result.receipt };
    },
    async mcp_component_restart(input: unknown) {
      const args = componentRecoverySchemas.mcp_component_restart.parse(input);
      if (!authenticatedMaintenance) return { contract: "mcp-component-local-v1", ok: true, code: "AUTHENTICATED_TRANSPORT_REQUIRED", ...args, completed: null, receipt: null };
      const result = await read("restart", args);
      if (typeof result === "string") return {
        contract: "mcp-component-local-v1", ok: true, code: "DELIVERY_UNKNOWN", ...args,
        ownerChannel: { code: result, verified: false }, completed: null, receipt: null,
        instruction: "Query mcp_component_receipt using the same requestId. Never issue a replacement requestId after timeout.",
      };
      return { ...connected(result), ...args, found: result.found, completed: result.completed, receipt: result.receipt,
        instruction: "Accepted is not completed. Query receipt with the same requestId; UNKNOWN must not be retried with a new id." };
    },
  };
}
