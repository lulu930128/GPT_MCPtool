import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { BridgeRuntime } from "./runtime.js";
import type { BridgeHttpServerHandle } from "./http-server.js";
import { waitForClose } from "./close-resources.js";

export function closeIdleRuntime(runtime: BridgeRuntime, http: BridgeHttpServerHandle, requestId: string): Promise<"CLOSED" | "ACTIVE_WORK_PRESENT"> {
  const observation = { canRelease: true };
  return waitForClose(drainAndClose(runtime, http, requestId, observation), 20000, "COOPERATIVE_SHUTDOWN_UNKNOWN")
    .catch(error => { observation.canRelease = false; throw error; });
}

async function drainAndClose(runtime: BridgeRuntime, http: BridgeHttpServerHandle, requestId: string,
  observation: { canRelease: boolean }): Promise<"CLOSED" | "ACTIVE_WORK_PRESENT"> {
  if (runtime.store.selfReloadDrain) return "ACTIVE_WORK_PRESENT";
  await runtime.store.beginSelfReload(requestId, new Date(Date.now() + 60_000).toISOString());
  if (!observation.canRelease) throw new Error("COOPERATIVE_SHUTDOWN_UNKNOWN");
  const jobs = runtime.store.listAll();
  if (!http.isIdle() || !["idle", "ready"].includes(runtime.controller.status) || jobs.some(job =>
    ["queued", "preparing", "running", "awaiting_approval"].includes(job.status) || job.pendingApprovalCount > 0)) {
    await runtime.store.endSelfReload(requestId, () => observation.canRelease);
    if (!observation.canRelease) throw new Error("COOPERATIVE_SHUTDOWN_UNKNOWN");
    return "ACTIVE_WORK_PRESENT";
  }
  // Stop HTTP admission before any asynchronous cleanup. Keep the lease on error;
  // a timeout or lost acknowledgement must never re-enable new work.
  await http.close();
  return "CLOSED";
}

/** Runtime receiver only. Existing component controller remains lifecycle owner. */
export function startCooperativeShutdown(runtime: BridgeRuntime, http: BridgeHttpServerHandle) {
  if (process.platform !== "win32") return { ready: Promise.resolve(), close: async () => {} };
  const instance = randomUUID();
  const child = spawn("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("../../scripts/cooperative-shutdown-host.ps1", import.meta.url)), "-CoreId", String(process.pid), "-Instance", instance],
  { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: {
    SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", TEMP: process.env.TEMP, TMP: process.env.TMP,
    PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
  } });
  let pending = false, used = false, buffer = "", ended = false;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = waitForClose(new Promise<void>((resolve, reject) => {
    readyResolve = resolve; readyReject = reject;
  }), 8000, "COOPERATIVE_CHANNEL_START_TIMEOUT");
  // main awaits readiness; keep an immediate rejection handler for spawn failures.
  void ready.catch(() => undefined);
  const seen = new Set<string>();
  const exit = new Promise<void>(resolve => {
    child.once("exit", () => { ended = true; readyReject(new Error("COOPERATIVE_CHANNEL_UNAVAILABLE")); resolve(); });
    child.once("error", () => { ended = true; readyReject(new Error("COOPERATIVE_CHANNEL_UNAVAILABLE")); resolve(); });
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    const detail = /COOPERATIVE_CHANNEL_UNAVAILABLE stage=(LOAD_NATIVE|INSPECT_CORE|VERIFY_PARENT_CIM|CREATE_LOCAL_PIPE) hresult=(-?\d+)/.exec(text);
    console.error(detail ? detail[0] : "COOPERATIVE_CHANNEL_UNAVAILABLE");
  });
  child.stdin.on("error", () => { /* Lost acknowledgement remains UNKNOWN to the controller. */ });
  const respond = (requestId: string, nonce: string, code: string) => {
    if (!ended) child.stdin.write(JSON.stringify({ requestId, nonce, code }) + "\n");
  };
  const consumeLine = (line: string) => {
    let request: Record<string, unknown>;
    try { request = JSON.parse(line); } catch { child.stdin.end(); return; }
    if (!request || typeof request !== "object" || Array.isArray(request)) { child.stdin.end(); return; }
    if (request.type === "ready") { readyResolve(); return; }
    if (pending || used || seen.size >= 256 || request.contract !== "bridge-cooperative-close-v1"
      || request.instance !== instance || request.pid !== process.pid || request.action !== "shutdown"
      || typeof request.requestId !== "string" || typeof request.nonce !== "string" || seen.has(request.requestId)) {
      child.stdin.end(); return;
    }
    const requestId = request.requestId, nonce = request.nonce;
    seen.add(requestId); pending = true;
    void (async () => {
      try {
        const code = await closeIdleRuntime(runtime, http, requestId);
        respond(requestId, nonce, code);
        if (code === "ACTIVE_WORK_PRESENT") { pending = false; return; }
        used = true; child.stdin.end();
      } catch {
        used = true; respond(requestId, nonce, "UNKNOWN"); child.stdin.end();
      }
    })();
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 8192) { child.stdin.end(); return; }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      consumeLine(line);
    }
  });
  return { ready, close: async () => {
    child.stdin.end(); await waitForClose(exit, 5000, "COOPERATIVE_CHANNEL_CLOSE_UNKNOWN");
  } };
}
