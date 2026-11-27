import type { RuntimeDiagnostics } from "./runtime-diagnostics.js";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type AppServerStatus = "idle" | "starting" | "ready" | "unavailable";

export interface JsonRpcNotification {
  wireBytes?: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcServerRequest extends JsonRpcNotification {
  id: string | number;
}

export interface AppServerTransport {
  readonly status: AppServerStatus;
  /** App Server build reported by initialize; unknown until a successful handshake. */
  readonly protocolVersion?: string | null;
  setNotificationBacklog?(bytes: number): void;
  ensureStarted(): Promise<void>;
  close(): Promise<void>;
  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, late?: (result: unknown, rejected: boolean) => void): Promise<T>;
  notify(method: string, params?: Record<string, unknown>): void;
  respond(id: string | number, result: Record<string, unknown>): void;
  on(event: "notification", listener: (message: JsonRpcNotification) => void): this;
  off(event: "notification", listener: (message: JsonRpcNotification) => void): this;
  on(event: "serverRequest", listener: (message: JsonRpcServerRequest) => void): this;
  off(event: "exit", listener: (error: Error) => void): this;
  on(event: "stderr", listener: (line: string) => void): this;
  on(event: "exit", listener: (error: Error) => void): this;
}

export class NativeDeliveryUnknown extends Error {}
export class NativeRpcRejected extends Error {
  constructor(method: string, error: Record<string, unknown>) {
    super(`${method} failed: ${rpcErrorMessage(error)}`);
  }
}

interface PendingRequest {
  started: number;
  threadId?: string;
  turnId?: string;
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface AppServerClientOptions {
  diagnostics?: RuntimeDiagnostics;
  command: string;
  args: string[];
  requestTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  beforeSpawn?: () => Promise<void>;
}

export class CodexAppServerClient extends EventEmitter implements AppServerTransport {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly lateReplies = new Map<number,(result:unknown,rejected:boolean)=>void>();
  private pending = new Map<number, PendingRequest>();
  private startPromise?: Promise<void>;
  private currentStatus: AppServerStatus = "idle";
  private currentProtocolVersion: string | null = null;
  private closing = false;
  private pausedAt?: number;

  setNotificationBacklog(bytes: number) {
    const stream = this.child?.stdout;
    if (!stream || this.currentStatus !== "ready") return;
    if (bytes >= stream.readableHighWaterMark && !this.pending.size && !this.closing) {
      if (this.pausedAt !== undefined) return;
      this.pausedAt = performance.now();
      stream.pause();
      this.options.diagnostics?.observe("queue","stdio_paused",{bytes});
    } else if (this.pausedAt !== undefined) {
      stream.resume();
      this.options.diagnostics?.observe("queue","stdio_resumed",{bytes,elapsedMs:performance.now()-this.pausedAt});
      this.pausedAt = undefined;
    }
  }
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: AppServerClientOptions) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  get status(): AppServerStatus {
    return this.currentStatus;
  }

  workload() {
    const oldest = this.pending.entries().next().value;
    return {status:this.status, pid:this.child?.pid, inflight:this.pending.size, oldestRpc:oldest?.[0],
      oldestRpcMs:oldest ? performance.now()-oldest[1].started : 0, paused:this.pausedAt !== undefined,
      stdoutBufferedBytes:this.child?.stdout.readableLength, stdinBufferedBytes:this.child?.stdin.writableLength};
  }

  get protocolVersion(): string | null {
    return this.currentProtocolVersion;
  }

  async ensureStarted(): Promise<void> {
    if (this.closing) throw new Error("APP_SERVER_CLOSING");
    if (this.currentStatus === "ready" && this.child && !this.child.killed) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  /** Component-scoped shutdown for the one App Server shared by every Bridge thread and turn. */
  async close(): Promise<void> {
    const child = this.child;
    this.closing = true;
    this.setNotificationBacklog(0);
    if (!child) {
      this.closing = false;
      return;
    }
    // EOF closes the owned stdio transport. Windows child.kill() is forced
    // termination, not a graceful close; an uncertain child must remain owned.
    await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.child = undefined; this.currentStatus = "idle"; this.closing = false; resolve(); };
      const timer = setTimeout(() => {
        child.off("close", done);
        reject(new Error("APP_SERVER_CLOSE_UNKNOWN"));
      }, 5000);
      child.once("close", done);
      child.stdin.end();
    });
  }

  async request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    late?: (result:unknown,rejected:boolean) => void,
  ): Promise<T> {
    await this.ensureStarted();
    return this.requestWithoutStart(method, params, late);
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id: string | number, result: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private async start(): Promise<void> {
    this.closing = false;
    this.currentStatus = "starting";
    this.currentProtocolVersion = null;
    let child: ChildProcessWithoutNullStreams;
    try {
      await this.options.beforeSpawn?.();
      child = spawn(this.options.command, this.options.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: this.options.environment ?? process.env,
      });
    } catch (error) {
      this.currentStatus = "unavailable";
      throw new Error(`Unable to start Codex App Server: ${asError(error).message}`);
    }
    this.child = child;
    this.options.diagnostics?.observe("native_session","spawned",{nativePid:child.pid});
    child.stdin.setDefaultEncoding("utf8");

    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdout.on("line", (line) => this.handleLine(line));
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderr.on("line", (line) => this.emit("stderr", line.slice(0, 4_000)));

    const spawnReady = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    // exit can precede the last buffered notification. Resume the pipe to
    // deliver all lines, then settle requests and disconnect on close.
    child.once("exit", () => { child.stdout.resume(); });
    child.once("close", (code, signal) => {
      if (this.child !== child) return;
      this.options.diagnostics?.observe("native_session", this.closing ? "closing" : "disconnected", {nativePid:child.pid,depth:this.pending.size});
      this.options.diagnostics?.record("native_exit", {exitCode:code,signal});
      const error = new NativeDeliveryUnknown(`Codex App Server exited (code=${String(code)}, signal=${String(signal)}).`);
      this.child = undefined;
      this.pausedAt = undefined;
      this.currentProtocolVersion = null;
      this.currentStatus = this.closing ? "idle" : "unavailable";
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.lateReplies.clear();
      if (!this.closing) {
        this.emit("exit", error);
      }
    });

    try {
      await spawnReady;
      const result = await this.requestWithoutStart<Record<string, unknown>>("initialize", {
        clientInfo: { name: "codex-handoff-bridge", version: "1.1.0" },
        capabilities: { experimentalApi: true },
      });
      if (!result || typeof result !== "object") {
        throw new Error("Codex App Server returned an invalid initialize response.");
      }
      this.notify("initialized", {});
      // initialize has no protocol-version field. Its userAgent reports the
      // running server build, even when a custom launcher is configured.
      // Return only the version, never the raw user agent or Codex home.
      this.currentProtocolVersion = typeof result.userAgent === "string"
        ? /^codex-handoff-bridge\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(result.userAgent)?.[1] ?? null
        : null;
      this.currentStatus = "ready";
      this.options.diagnostics?.observe("native_session","ready",{nativePid:child.pid});
    } catch (error) {
      this.currentStatus = "unavailable";
      child.kill();
      throw new Error(`Unable to initialize Codex App Server: ${asError(error).message}`);
    }
  }

  private requestWithoutStart<T>(method: string, params: Record<string, unknown>, late?: (result:unknown,rejected:boolean) => void): Promise<T> {
    this.setNotificationBacklog(0); // Responses share stdout with notifications.
    const started = performance.now();
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (late) this.lateReplies.set(id, late);
        this.pending.delete(id);
        this.options.diagnostics?.observe("native_rpc", "timeout", {rpc:id, threadId,turnId,elapsedMs:performance.now()-started}, true);
        reject(new NativeDeliveryUnknown(`Codex App Server request '${method}' timed out after ${this.requestTimeoutMs} ms.`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        method, started, threadId, turnId,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asError(error));
      }
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("stderr", `Ignored non-JSON App Server stdout: ${line.slice(0, 500)}`);
      return;
    }
    if (!isObject(message)) {
      return;
    }
    if ((typeof message.id === "number" || typeof message.id === "string") && !("method" in message)) {
      const numericId = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = Number.isSafeInteger(numericId) ? this.pending.get(numericId) : undefined;
      if (!pending) {
        const late = this.lateReplies.get(numericId);
        if (late) {
          this.lateReplies.delete(numericId);
          late(message.result,isObject(message.error));
        }
        return;
      }
      this.options.diagnostics?.observe("native_rpc", isObject(message.error) ? "failed" :
        pending.method === "thread/turns/list" ? "turn_page" : pending.method === "thread/read" ? "thread_read" : "response",
        {rpc:numericId,threadId:pending.threadId,turnId:pending.turnId,elapsedMs:performance.now()-pending.started,depth:this.pending.size}, isObject(message.error));
      clearTimeout(pending.timer);
      this.pending.delete(numericId);
      if (isObject(message.error)) {
        pending.reject(new NativeRpcRejected(pending.method, message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") {
      return;
    }
    const params = isObject(message.params) ? message.params : undefined;
    if (typeof message.id === "number" || typeof message.id === "string") {
      this.emit("serverRequest", { id: message.id, method: message.method, params });
    } else {
      this.emit("notification", { method: message.method, params, wireBytes:Buffer.byteLength(line)+1 });
    }
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      throw new Error("Codex App Server is not writable.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

function rpcErrorMessage(error: Record<string, unknown>): string {
  const message = typeof error.message === "string" ? error.message : "unknown JSON-RPC error";
  const code = typeof error.code === "number" ? ` (${error.code})` : "";
  return `${message}${code}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
