import { z } from "zod";
import { checkTcpPort } from "./diagnostics.js";

// Source-reviewed registry-v3 snapshot (2026-10-13), not runtime authority.
// Never load paths, commands, capabilities or endpoints from mutable registry data.
export const COMPONENT_IDS = Object.freeze([
  "codex_bridge", "omi_search", "japanese_study", "memory_core",
  "personal_asset_os", "english_study", "listening_audio",
] as const);
export const PREVIEW_ACTIONS = Object.freeze([
  "ensure_running", "repair_connectivity", "restart_core", "reload_runtime", "shutdown_runtime",
] as const);
type ComponentId = typeof COMPONENT_IDS[number];
const ports: Readonly<Record<ComponentId, number>> = Object.freeze({
  codex_bridge: 18828, omi_search: 18797, japanese_study: 18790, memory_core: 18818,
  personal_asset_os: 18876, english_study: 18886, listening_audio: 18810,
});
const componentId = z.enum(COMPONENT_IDS);
export const componentRecoverySchemas = {
  mcp_component_status: z.object({ componentId: componentId.optional() }).strict(),
  mcp_component_preview: z.object({ componentId, action: z.enum(PREVIEW_ACTIONS) }).strict(),
  mcp_component_receipt: z.object({ requestId: z.string().uuid() }).strict(),
  mcp_component_restart: z.object({
    componentId, action: z.literal("reload_runtime"),
    confirmation: z.literal("interrupt_current_requests"), requestId: z.string().uuid(),
  }).strict(),
};
export const RECOVERY_LIMITS = Object.freeze({ timeoutMs: 750, maxConcurrent: 2, maxComponents: 7 });

function boundary() {
  return {
    contract: "mcp-component-recovery-g1-v1",
    authority: { owner: "mcp_control_center", deployment: "NOT_DEPLOYED", connection: "NOT_CONNECTED" },
    ownership: "UNVERIFIED",
    chatgptE2e: "UNVERIFIED",
    mutationEnabled: false,
  } as const;
}

// Process-wide across sessions. Sequential sampling caps sockets at two and a
// seven-component request at seven 750ms probes. No queues, retries or children.
let active = 0;
export async function componentStatus(input: unknown, probe: typeof checkTcpPort = checkTcpPort) {
  const args = componentRecoverySchemas.mcp_component_status.parse(input);
  if (active >= RECOVERY_LIMITS.maxConcurrent) {
    return { ...boundary(), ok: false, code: "OBSERVATION_BUSY", components: [] };
  }
  active++;
  try {
    const components = [];
    for (const id of args.componentId ? [args.componentId] : COMPONENT_IDS) {
      let state: "TCP_CONNECTED" | "TCP_NOT_CONNECTED" | "OBSERVATION_FAILED" = "OBSERVATION_FAILED";
      let code: string | null = null;
      const startedAt = new Date().toISOString();
      try {
        const sample = await probe({ host: "127.0.0.1", port: ports[id], timeoutMs: RECOVERY_LIMITS.timeoutMs });
        if (sample.ok === true && typeof sample.connected === "boolean") {
          state = sample.connected ? "TCP_CONNECTED" : "TCP_NOT_CONNECTED";
          if (!sample.connected) {
            code = ["TIMEOUT", "ECONNREFUSED", "EACCES", "EPERM"].includes(String(sample.code))
              ? String(sample.code) : "CONNECTION_FAILED";
          }
        } else { code = "OBSERVATION_FAILED"; }
      } catch { code = "OBSERVATION_FAILED"; }
      components.push({
        componentId: id, status: "UNVERIFIED",
        localObservation: {
          source: "SOURCE_FIXED_LOOPBACK_TCP", mappingVersion: "2026-10-13.1",
          host: "127.0.0.1", port: ports[id], scope: "primary_mcp_port_only",
          state, code, startedAt, observedAt: new Date().toISOString(),
          serviceIdentity: "UNVERIFIED", health: "UNVERIFIED",
        },
        ownership: "UNVERIFIED", chatgptE2e: "UNVERIFIED",
      });
    }
    return { ...boundary(), ok: true, code: "LOCAL_OBSERVATION_ONLY", components };
  } finally { active--; }
}

export function componentPreview(input: unknown) {
  const args = componentRecoverySchemas.mcp_component_preview.parse(input);
  return {
    ...boundary(), ok: false, code: "AUTHORITY_NOT_DEPLOYED", ...args,
    previewStatus: "NOT_CONNECTED", allowed: false, executable: false,
    ownerVerified: false, approvalRequired: true, approvalAvailable: false,
    requestCreated: false,
  };
}

export function componentReceipt(input: unknown) {
  const args = componentRecoverySchemas.mcp_component_receipt.parse(input);
  return {
    ...boundary(), ok: false, code: "AUTHORITY_NOT_DEPLOYED", ...args,
    receiptStatus: "NOT_CONNECTED", found: null, completed: null, receipt: null,
  };
}
