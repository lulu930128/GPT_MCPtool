import { spawn } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { InstalledBridgeBinding } from "../installed-runtime.js";
import { assertInstalledRuntimeActivation } from "../installed-runtime.js";
import { ApprovalError, digest, identity, type ProductionReceipt } from "./contract.js";
import { waitForClose } from "../close-resources.js";
import type { PowerShellHostPort } from "./host-admission.js";
import { createHostReceiver, HOST_FRAME_BYTES, HOST_RPC, hostInitialSchema } from "./host-receiver.js";

const channels = new WeakMap<object, { session: string; binding: string; peer: unknown;
  review?: { requestId: string; digest: string }; current: () => boolean }>();
/** Only the installed helper can issue this capability. JSON/a saved journal is
 * never an issuer. Identity is observed independently by the retained native peer. */
export function verifyNativeHostTransition(receipt: ProductionReceipt, evidence: unknown): void {
  const channel = evidence && typeof evidence === "object" ? channels.get(evidence) : undefined;
  const r = receipt.request;
  if (!channel?.current() || !channel.review || !r.sourceReview
    || digest(channel.review) !== digest(r.sourceReview)
    || r.origin !== "DIRECT" || r.executionMode !== "NORMAL"
    || r.approvalIdentity.interface !== "REMOTE_MCP_REQUEST"
    || r.approvalIdentity.authentication !== "AUTHENTICATED_DIRECT_REQUEST"
    || digest(r.approvalIdentity.authority) !== digest(channel.peer)
    || digest(r.executorIdentity) !== digest(channel.peer))
    throw new ApprovalError("BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED");
  const observations = [r.admission, receipt.grant?.approval, receipt.denial,
    receipt.consumption?.executor, receipt.result?.executor].filter(o => o !== undefined);
  if (observations.some(o => o.channelBinding !== channel.binding || digest(o.peer) !== digest(channel.peer)))
    throw new ApprovalError("HOST_REQUEST_MISMATCH");
}
// Includes installed activation, helper startup and both peers' protected-tree
// verification. Those checks alone can exceed 20 seconds on the installed host.
// Keep the whole diagnostic bounded below the unchanged 120-second session TTL.
export const HOST_PREFLIGHT_TIMEOUT_MS = 60_000;
// Read-only capability lookup. There is deliberately no exported issuer/setter,
// test issuer, JSON verifier, environment override or caller-supplied trust flag.
export function observedNativeChannel(value: unknown, session: string): string {
  const proof = value && typeof value === "object" ? channels.get(value) : undefined;
  if (!proof || proof.session !== session || !proof.current()) throw new ApprovalError("IPC_NATIVE_CHANNEL_REQUIRED");
  return proof.binding;
}

/** Owned stdio is the Node/native boundary. Only the fixed protected helper can
 * reach it; no HTTP route, tool JSON auth field, socket address or verifier option.
 * The helper authenticates the installed Tray and its own retained Node parent. */
export function createNativeHostTransport(port: PowerShellHostPort, installed?: InstalledBridgeBinding) {
  let active: Promise<{ code: string }> | undefined, stopping = false;
  let cancel: (() => void) | undefined;
  let retainedExit: Promise<void> | undefined;
  let lastCode = "NOT_DEPLOYED";
  let preflightObservation = { code: "NOT_CHECKED", observedAt: null as string | null };
  const run = (review?: { requestId: string; digest: string }): Promise<{ code: string }> => {
      if (stopping) return Promise.resolve({ code: "HOST_TRANSPORT_CLOSED" });
      if (!installed || process.platform !== "win32") return Promise.resolve({ code: "NOT_DEPLOYED" });
      if (active) return Promise.resolve({ code: "HOST_TRANSPORT_BUSY" });
      active = (async () => {
        await assertInstalledRuntimeActivation(installed);
        if (stopping) return { code: "HOST_TRANSPORT_CLOSED" };
        const receiver = review ? createHostReceiver(port, review) : undefined;
        const session = receiver?.session ?? randomUUID(), expiresAt = receiver?.expiresAt ?? Date.now() + 120_000;
        const child = spawn("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
          join(installed.codeRoot, "scripts", "powershell-host-transport.ps1"), "-CoreId", String(process.pid)], {
          cwd: installed.codeRoot, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
          env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules" },
        });
        let buffer = Buffer.alloc(0), pending = false, ended = false, final: string | undefined, failed = false;
        let dispatch: Promise<void> = Promise.resolve();
        let nativeChannel: object | undefined;
        const stop = () => { failed = true; child.stdin.destroy(); void receiver?.close().catch(() => undefined); };
        cancel = stop;
        const timer = setTimeout(stop, 120_000);
        const complete = new Promise<void>(resolve => {
          child.once("exit", code => { ended = true; if (code !== 0) failed = true; resolve(); });
          child.once("error", () => { ended = true; failed = true; resolve(); });
        });
        retainedExit = complete;
        void complete.then(() => { if (retainedExit === complete) retainedExit = undefined; });
        child.stdin.on("error", stop);
        child.stderr.on("data", () => stop()); // Never forward raw native errors/output.
        child.stdout.on("data", (chunk: Buffer) => {
          if (failed || ended) return;
          if (buffer.length + chunk.length > HOST_FRAME_BYTES) { stop(); return; }
          buffer = Buffer.concat([buffer, chunk]);
          const newline = buffer.indexOf(10);
          if (newline < 0) return;
          const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
          if (pending || final || buffer.length) { stop(); return; }
          pending = true;
          dispatch = (async () => {
            try {
              const message = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(line));
              if (message?.kind === "channel") {
                if (nativeChannel || Object.keys(message).sort().join() !== "binding,kind,peer,session"
                  || message.session !== session || typeof message.binding !== "string" || !/^[a-f0-9]{64}$/.test(message.binding))
                  throw new ApprovalError("IPC_FRAME_REJECTED");
                nativeChannel = Object.freeze({});
                const peer = identity.parse(message.peer);
                channels.set(nativeChannel, { session, binding: message.binding, peer, review,
                  current: () => !failed && !ended && !stopping && child.exitCode === null && !!child.pid && Date.now() < expiresAt });
                // Acknowledge before the helper emits any RPC, keeping bounded
                // one-frame-at-a-time stdio even when OS reads coalesce chunks.
                child.stdin.write(JSON.stringify({ kind: "channel-bound", session }) + "\n");
                return;
              }
              if (message?.kind === "complete") {
                if (!nativeChannel || Object.keys(message).sort().join() !== "code,kind,session" || message.session !== session
                  || !(review ? ["HOST_APPROVAL_DECLINED", "BLOCKED_AWAITING_LOCAL_UAC", "FAILURE_ATTRIBUTION_UNVERIFIED", "RECEIPT_RECORDED"]
                    : ["HOST_READY"]).includes(message.code))
                  throw new ApprovalError("IPC_FRAME_REJECTED");
                final = message.code; child.stdin.end(); return;
              }
              let response: unknown;
              try {
                if (!receiver) throw new ApprovalError("HOST_PREFLIGHT_READ_ONLY");
                response = await receiver.receive(line, nativeChannel);
              }
              catch (error) {
                if (!(error instanceof ApprovalError)) throw error;
                response = { contract: HOST_RPC, session, sequence: message.sequence, error: error.code };
                failed = true;
              }
              if (!ended && !child.stdin.destroyed) {
                const value = JSON.stringify(response) + "\n";
                if (Buffer.byteLength(value) > HOST_FRAME_BYTES) throw new ApprovalError("IPC_FRAME_REJECTED");
                await new Promise<void>((resolve, reject) => child.stdin.write(value, error => error ? reject(error) : resolve()));
                if (failed) child.stdin.end();
              }
            } catch { stop(); } finally { pending = false; }
          })();
        });
        const initial = hostInitialSchema.parse({ contract: HOST_RPC, session, expiresAt,
          ...(receiver ? { operation: "review", review: receiver.review } : { operation: "preflight" }) });
        child.stdin.write(JSON.stringify(initial) + "\n");
        try {
          try { await waitForClose(complete, 125_000, "HOST_TRANSPORT_CLOSE_UNKNOWN"); }
          catch { stopping = true; stop(); throw new ApprovalError("HOST_TRANSPORT_CLOSE_UNKNOWN"); }
          await dispatch;
          // A completed helper failure closes only this exchange. New requests
          // may use a fresh channel; an uncertain still-running helper seals it.
          return { code: !failed && final ? final : "HOST_TRANSPORT_UNKNOWN" };
        } finally { clearTimeout(timer); if (nativeChannel) channels.delete(nativeChannel); await receiver?.close(); cancel = undefined; }
      })().catch(() => ({ code: "HOST_TRANSPORT_UNAVAILABLE" })).then(value => { lastCode = value.code; return value; })
        .finally(() => { active = undefined; });
      return active;
  };
  return Object.freeze({
    // Explicit diagnostic only. The deadline includes installed activation checks.
    // A timeout seals this transport; retain the outstanding child/operation for
    // close(), without retry, force kill or a replacement owner.
    async preflight() {
      if (active && !stopping) return { code: "HOST_TRANSPORT_BUSY" };
      let result: { code: string };
      try { result = await waitForClose(run(), HOST_PREFLIGHT_TIMEOUT_MS, "HOST_PREFLIGHT_TIMEOUT"); }
      catch {
        stopping = true; cancel?.();
        result = { code: "HOST_PREFLIGHT_TIMEOUT" };
      }
      preflightObservation = { code: result.code, observedAt: new Date().toISOString() };
      return result;
    },
    inspect: (requestId: string, digest: string) => run({ requestId, digest }),
    status: () => ({ code: lastCode, active: !!active, closed: stopping,
      preflight: { ...preflightObservation }, authorization: "AUTHENTICATED_DIRECT_REQUEST" }),
    async close() {
      stopping = true; cancel?.();
      if (active) await waitForClose(active, 5000, "HOST_TRANSPORT_CLOSE_UNKNOWN");
      if (retainedExit) await waitForClose(retainedExit, 5000, "HOST_TRANSPORT_CLOSE_UNKNOWN");
    },
  });
}
