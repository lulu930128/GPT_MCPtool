import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type AppServerStatus = "idle" | "starting" | "ready" | "unavailable";

export interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcServerRequest extends JsonRpcNotification {
  id: string | number;
}

export interface AppServerTransport {
  readonly status: AppServerStatus;
  ensureStarted(): Promise<void>;
  close(): Promise<void>;
  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  notify(method: string, params?: Record<string, unknown>): void;
  respond(id: string | number, result: Record<string, unknown>): void;
  on(event: "notification", listener: (message: JsonRpcNotification) => void): this;
  on(event: "serverRequest", listener: (message: JsonRpcServerRequest) => void): this;
  on(event: "stderr", listener: (line: string) => void): this;
  on(event: "exit", listener: (error: Error) => void): this;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface AppServerClientOptions {
  command: string;
  args: string[];
  requestTimeoutMs?: number;
}

export class CodexAppServerClient extends EventEmitter implements AppServerTransport {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private startPromise?: Promise<void>;
  private currentStatus: AppServerStatus = "idle";
  private closing = false;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: AppServerClientOptions) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  get status(): AppServerStatus {
    return this.currentStatus;
  }

  async ensureStarted(): Promise<void> {
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

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.closing = true;
    this.currentStatus = "idle";
    if (!child || child.killed) {
      this.closing = false;
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    this.closing = false;
  }

  async request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    await this.ensureStarted();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request '${method}' timed out after ${this.requestTimeoutMs} ms.`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        method,
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

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id: string | number, result: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private async start(): Promise<void> {
    this.closing = false;
    this.currentStatus = "starting";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.command, this.options.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: process.env,
      });
    } catch (error) {
      this.currentStatus = "unavailable";
      throw new Error(`Unable to start Codex App Server: ${asError(error).message}`);
    }
    this.child = child;
    child.stdin.setDefaultEncoding("utf8");

    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdout.on("line", (line) => this.handleLine(line));
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderr.on("line", (line) => this.emit("stderr", line.slice(0, 4_000)));

    const spawnReady = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.once("exit", (code, signal) => {
      const error = new Error(`Codex App Server exited (code=${String(code)}, signal=${String(signal)}).`);
      this.child = undefined;
      this.currentStatus = this.closing ? "idle" : "unavailable";
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
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
      this.currentStatus = "ready";
    } catch (error) {
      this.currentStatus = "unavailable";
      child.kill();
      throw new Error(`Unable to initialize Codex App Server: ${asError(error).message}`);
    }
  }

  private requestWithoutStart<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request '${method}' timed out after ${this.requestTimeoutMs} ms.`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write({ jsonrpc: "2.0", id, method, params });
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
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(numericId);
      if (isObject(message.error)) {
        pending.reject(new Error(`${pending.method} failed: ${rpcErrorMessage(message.error)}`));
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
      this.emit("notification", { method: message.method, params });
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
