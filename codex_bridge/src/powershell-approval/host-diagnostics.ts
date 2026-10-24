import type { InstalledBridgeBinding } from "../installed-runtime.js";
import { HOST_PREFLIGHT_TIMEOUT_MS, type createNativeHostTransport } from "./host-transport.js";
import { HOST_FRAME_BYTES } from "./host-receiver.js";

/** Narrow capability: no inspect, HostPort, Store, candidate or dispatch access. */
export interface HostDiagnostics {
  transport?: Pick<ReturnType<typeof createNativeHostTransport>, "preflight" | "status">;
  installedBinding?: InstalledBridgeBinding;
}

const codes = new Set(["NOT_CHECKED", "NOT_DEPLOYED", "HOST_TRANSPORT_UNAVAILABLE", "HOST_TRANSPORT_UNKNOWN",
  "HOST_TRANSPORT_BUSY", "HOST_TRANSPORT_CLOSED", "HOST_PREFLIGHT_TIMEOUT", "BLOCKED_PLATFORM_CAPABILITY", "HOST_READY"]);
export function preflightCode(code: unknown): string {
  return typeof code === "string" && codes.has(code) ? code : "HOST_TRANSPORT_UNKNOWN";
}

/** Cached runtime observation only. No filesystem, native probe or owner assertion. */
export function hostDiagnosticsStatus(context?: HostDiagnostics) {
  let snapshot;
  try { snapshot = context?.transport?.status(); } catch { /* Unknown, never raw exception text. */ }
  const timestamp = snapshot?.preflight.observedAt;
  const code = snapshot ? preflightCode(snapshot.preflight.code) : "HOST_TRANSPORT_UNAVAILABLE";
  return {
    installedRuntime: { evidence: "LOADED_RUNTIME_BINDING", binding: context?.installedBinding ? "PRESENT" : "ABSENT",
      activationAtStartup: context?.installedBinding?.activationReady === true ? "DECLARED_READY" : "NOT_VERIFIED",
      currentInstallation: "NOT_PROBED" },
    authenticatedOwner: "UNVERIFIED",
    nativeTransport: { available: !!context?.transport, active: snapshot?.active ?? null, closed: snapshot?.closed ?? null,
      observation: "CACHED_PREFLIGHT_ONLY", code,
      checkState: code === "NOT_CHECKED" ? "NOT_CHECKED" : code === "HOST_READY" ? "SUCCEEDED"
        : code === "HOST_TRANSPORT_BUSY" ? "BUSY" : "FAILED",
      observedAt: typeof timestamp === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(timestamp) ? timestamp : null,
      provesCurrentReadiness: false },
    // Lack of observation is not a failed precheck, but must not look ready.
    // Even a prior successful preflight cannot attest the current owner/session.
    externalBlockers: [code === "NOT_CHECKED" ? "HOST_READINESS_NOT_CHECKED"
      : code === "HOST_READY" ? "CURRENT_HOST_UNVERIFIED" : code],
    separateModes: { CODEX_DERIVED: "FAILURE_ATTRIBUTION_UNVERIFIED", ADMIN: "BLOCKED_AWAITING_LOCAL_UAC" },
    normalExecution: { entry: "codex_powershell_normal_execute", consent: "AUTHENTICATED_DIRECT_REQUEST",
      configured: !!context?.installedBinding && !!context.transport, localConfirmation: "NOT_REQUIRED",
      currentHostVerified: false, outputLimitBytes: null, outputRetentionMs: 600000, automaticRetry: false },
    bounds: { timeoutMs: HOST_PREFLIGHT_TIMEOUT_MS, frameBytes: HOST_FRAME_BYTES, concurrency: 1, automaticRetry: false },
  };
}
