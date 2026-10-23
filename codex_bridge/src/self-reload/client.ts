import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { JobStore } from "../job-store.js";

export const RELOAD_CONTRACT = "remote-self-reload-r1";
export const RELOAD_PIPE = "\\\\.\\pipe\\McpCc.CodexBridge.Reload.R1";
export type ReloadReply = Record<string, any>;
export type ReloadTransport = (operation: string, args: Record<string, unknown>) => Promise<ReloadReply>;

export class ReloadError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Fixed endpoint only. No child process, executable, shell, caller path or env. */
export async function callReloadPipe(operation: string, args: Record<string, unknown>): Promise<ReloadReply> {
  const request = Buffer.from(JSON.stringify({ contract: RELOAD_CONTRACT, operation, arguments: args }) + "\n");
  if (request.length > 16384) throw new ReloadError("MESSAGE_LIMIT");
  return new Promise((resolve, reject) => {
    const helper = fileURLToPath(new URL("../../../scripts/self-reload-pipe-client.ps1", import.meta.url));
    const socket = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper], { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"] });
    let bytes = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, value?: ReloadReply) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.stdin.destroy(); socket.stdout.destroy();
      if (socket.exitCode === null) socket.kill(); // only this bounded IPC helper, never Bridge/owner
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new ReloadError("OWNER_UNAVAILABLE")), 12000);
    socket.stdin.on("error", () => finish(new ReloadError("OWNER_UNAVAILABLE")));
    socket.stdin.end(request);
    socket.once("error", () => finish(new ReloadError("OWNER_UNAVAILABLE")));
    socket.once("exit", () => { if (!settled) finish(new ReloadError("OWNER_UNAVAILABLE")); });
    socket.stdout.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 32768) return finish(new ReloadError("INVALID_OWNER_RESPONSE"));
      const end = bytes.indexOf(10);
      if (end < 0) return;
      try {
        const value = JSON.parse(bytes.subarray(0, end).toString("utf8"));
        if (!value || value.contract !== RELOAD_CONTRACT || typeof value.ok !== "boolean") throw new Error();
        if (!value.ok) {
          const code = typeof value.code === "string" && /^[A-Z_]{3,64}$/.test(value.code) ? value.code : "RELOAD_UNAVAILABLE";
          return finish(new ReloadError(code));
        }
        if (!value.result || typeof value.result !== "object" || Array.isArray(value.result)) throw new Error();
        finish(undefined, value.result);
      } catch { finish(new ReloadError("INVALID_OWNER_RESPONSE")); }
    });
  });
}

export class SelfReloadClient {
  private poll?: ReturnType<typeof setInterval>;
  private polling = false;
  private approving = new Set<string>();
  constructor(private readonly store: Pick<JobStore, "beginSelfReload" | "endSelfReload" | "selfReloadDrain">,
    private readonly transport: ReloadTransport = callReloadPipe) {}

  async call(operation: string, args: Record<string, unknown>): Promise<ReloadReply> {
    const id = String(args.requestId);
    if (operation === "approve") {
      if (this.approving.has(id)) throw new ReloadError("APPROVAL_IN_FLIGHT");
      this.approving.add(id);
      try {
      // The owner still verifies the signed assertion. This fence carries no grant authority.
      const receipt = await this.transport("receipt", { requestId: args.requestId });
      if (receipt.state !== "accepted" && receipt.state !== "approved") { this.approving.delete(id); return receipt; }
      if (receipt.digest !== args.digest || typeof receipt.expiresAt !== "string" || Date.parse(receipt.expiresAt) <= Date.now())
        throw new ReloadError("REQUEST_EXPIRED");
      await this.store.beginSelfReload(String(args.requestId), receipt.expiresAt);
      this.startPolling();
      } catch (error) { this.approving.delete(id); throw error; }
    }
    try {
      const result = await this.transport(operation, args);
      if (["receipt", "approve"].includes(operation) && ["failed", "completed"].includes(result.state)) {
        await this.store.endSelfReload(String(args.requestId));
      }
      return result;
    } catch (error) {
      // A transport timeout might have delivered approval. Keep the fence until an authoritative receipt.
      throw error;
    } finally {
      if (operation === "approve") {
        this.approving.delete(id);
        // An atomic owner resolution closes an undelivered approval before releasing admission.
        // It cannot revoke approved/running/unknown work and prevents a late packet from approving.
        try { await this.reconcile(id); } catch { /* Owner unavailable: retain fence and keep polling. */ }
      }
    }
  }
  private async reconcile(requestId: string) {
    if (this.approving.has(requestId)) return;
    const result = await this.transport("resolve", { requestId });
    if (["failed", "completed"].includes(result.state)) await this.store.endSelfReload(requestId);
  }
  private startPolling() {
    if (this.poll) return;
    this.poll = setInterval(async () => {
      const lease = this.store.selfReloadDrain;
      if (!lease || this.polling) return;
      this.polling = true;
      try { await this.reconcile(lease.requestId); } catch { /* Unknown delivery stays fenced. */ }
      finally { this.polling = false; }
    }, 3000);
    this.poll.unref();
  }
  close() { if (this.poll) clearInterval(this.poll); }
}
