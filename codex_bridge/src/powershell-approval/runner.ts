import { spawn, type ChildProcess } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { ApprovalError, digest, MARKER_SCRIPT, OUTPUT_LIMIT, requestSchema, resultSchema, RUN_TIMEOUT_MS, type Receipt, type RunnerResult } from "./contract.js";

export const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
export const SYSTEM_ENVIRONMENT = Object.freeze({ SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" });
export type OfflineRunner = (receipt: Readonly<Receipt>) => Promise<RunnerResult>;

export function validateDelivery(receipt: Receipt): void {
  const request = requestSchema.parse(receipt.request);
  if (receipt.state !== "RUNNING" || !receipt.approvalEventId || receipt.digest !== digest(request)) throw new ApprovalError("DELIVERY_REJECTED");
  if (request.executionMode !== "NORMAL") throw new ApprovalError("BLOCKED_AWAITING_LOCAL_UAC");
  if (request.failureEvidence.classification !== "SANDBOX_POLICY" && request.failureEvidence.classification !== "JOB_OBJECT") throw new ApprovalError("FAILURE_NOT_QUALIFIED");
}

/** Fixed harmless artifact; never exported through MCP. This child inherits the current Job Object.
 * It cannot satisfy host acceptance, launch an external operator, elevate, or run dynamic scripts. */
export const runOfflineNormalMarker: OfflineRunner = async (receipt) => {
  validateDelivery(receipt);
  if (process.platform !== "win32") throw new ApprovalError("WINDOWS_REQUIRED");
  const request = receipt.request;
  const cwd = await realpath(request.cwd);
  if (cwd !== request.cwd || (await lstat(cwd)).isSymbolicLink() || !(await lstat(cwd)).isDirectory()) throw new ApprovalError("SCOPE_REJECTED");
  if ((await realpath(POWERSHELL)).toLowerCase() !== POWERSHELL.toLowerCase()) throw new ApprovalError("EXECUTABLE_REJECTED");
  if (Date.now() >= request.expiresAt) throw new ApprovalError("TTL_EXPIRED");
  // -Command is a module-owned constant, not caller input; no password/args/env interpolation.
  const child = spawn(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", MARKER_SCRIPT], {
    cwd, env: SYSTEM_ENVIRONMENT, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  return observeOfflineMarkerChild(child, receipt);
};

/** Bounded child observer; exported for deterministic pipe/timeout tests, not a launch capability. */
export function observeOfflineMarkerChild(child: ChildProcess, receipt: Receipt, timeoutMs = RUN_TIMEOUT_MS): Promise<RunnerResult> {
  if (!child.stdout || !child.stderr || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RUN_TIMEOUT_MS) throw new ApprovalError("RUNNER_CONFIGURATION_REJECTED");
  const request = receipt.request;
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stopped: "TIMEOUT" | "OUTPUT_LIMIT" | undefined;
    let settled = false;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: ApprovalError, result?: RunnerResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer); if (terminationTimer) clearTimeout(terminationTimer);
      stdout.fill(0);
      if (error) reject(error); else resolve(result!);
    };
    const stop = (code: "TIMEOUT" | "OUTPUT_LIMIT") => {
      if (stopped || settled) return;
      stopped = code;
      child.kill(); // exact child handle; this fixed artifact creates no descendants.
      terminationTimer = setTimeout(() => finish(new ApprovalError(code)), 1000);
    };
    const timer = setTimeout(() => stop("TIMEOUT"), timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBytes = Math.min(OUTPUT_LIMIT + 1, stdoutBytes + chunk.length);
      if (stdoutBytes + stderrBytes > OUTPUT_LIMIT) stop("OUTPUT_LIMIT");
      else if (!stopped) stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBytes = Math.min(OUTPUT_LIMIT + 1, stderrBytes + chunk.length);
      if (stdoutBytes + stderrBytes > OUTPUT_LIMIT) stop("OUTPUT_LIMIT");
      // Never retain or relay raw stderr (may contain runtime paths/ambient values).
    });
    child.on("error", () => finish(new ApprovalError("SPAWN_FAILED")));
    child.on("close", (exitCode) => {
      if (stopped) return finish(new ApprovalError(stopped));
      // An elevated parent is blocked inside PowerShell before producing any marker.
      if (exitCode === 77) return finish(new ApprovalError("IDENTITY_REJECTED"));
      if (exitCode !== 0) return finish(new ApprovalError("NONZERO_EXIT"));
      try {
        const data = JSON.parse(stdout.toString("utf8").trim());
        if (Object.keys(data).sort().join(",") !== "elevated,marker,pid,sid" || data.pid !== child.pid
          || data.sid !== request.expectedSid || data.elevated !== false || data.marker !== "CODEX_NORMAL_SYNTHETIC_V1") throw new ApprovalError("IDENTITY_REJECTED");
        const result = resultSchema.parse({ evidence: "LOCAL_INHERITED_PROCESS", requestId: request.requestId,
          digest: receipt.digest, executionMode: "NORMAL", executorId: request.executorId,
          sid: data.sid, elevated: false, pid: child.pid, ownership: "INHERITED_NOT_HOST_ACCEPTED",
          exitCode, outcome: "SUCCEEDED", code: "MARKER_CONFIRMED", marker: data.marker, stdoutBytes, stderrBytes });
        finish(undefined, result);
      } catch { finish(new ApprovalError("RESULT_REJECTED")); }
    });
  });
}
