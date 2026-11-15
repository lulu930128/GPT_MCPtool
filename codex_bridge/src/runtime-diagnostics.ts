import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "./config.js";

type Event = "runtime_start" | "runtime_ready" | "heartbeat" | "http_error" | "startup_failed"
  | "uncaught_exception" | "unhandled_rejection" | "shutdown_requested" | "shutdown_failed"
  | "cooperative_shutdown" | "cooperative_closed" | "cooperative_failed" | "cooperative_host_exit" | "runtime_exit";
type Details = { error?: unknown; exitCode?: number | null; signal?: string | null };
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "EvalError", "AggregateError"]);
const ERROR_CODES = new Set(["EACCES", "EPERM", "ENOENT", "ENOSPC", "ENOMEM", "EMFILE", "EIO", "EPIPE", "ECONNRESET",
  "ECONNREFUSED", "ETIMEDOUT", "EADDRINUSE", "ERR_INVALID_URL", "ERR_HTTP_HEADERS_SENT", "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END", "ERR_OUT_OF_RANGE", "ERR_INVALID_ARG_TYPE", "ERR_UNHANDLED_REJECTION"]);
const RUNTIME_CODES = new Set(["RUNTIME_CLOSE_FAILED", "RUNTIME_CLOSE_UNKNOWN", "HTTP_CLOSE_UNKNOWN", "HTTP_TRANSPORT_CLOSE_UNKNOWN",
  "COOPERATIVE_CHANNEL_UNAVAILABLE", "COOPERATIVE_CHANNEL_START_TIMEOUT", "COOPERATIVE_CHANNEL_CLOSE_UNKNOWN",
  "COOPERATIVE_SHUTDOWN_UNKNOWN", "STORE_LOCKED", "STORE_CLOSED", "STORE_CORRUPT", "HTTP_CLOSING"]);
const SIGNALS = new Set(["SIGINT", "SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGHUP"]);

/** Never persist error messages, arbitrary properties, request bodies, env or raw stderr. */
export function diagnosticError(error: unknown, codeRoot: string) {
  let name = "Unknown", code: string | undefined;
  const frames: Array<{ file: string; line: number; column: number }> = [];
  try {
    if (!(error instanceof Error)) return { name, frames };
    if (ERROR_NAMES.has(error.name)) name = error.name;
    const value = (error as NodeJS.ErrnoException).code;
    if (typeof value === "string" && ERROR_CODES.has(value)) code = value;
    if (!code && RUNTIME_CODES.has(error.message)) code = error.message;
    // No function names or message lines: either can contain user-controlled text.
    for (const frame of (error.stack ?? "").slice(0, 32_768).split("\n").slice(1, 33)) {
      const match = /^\s+at (?:[^\r\n]*\()?((?:file:\/\/\/|[A-Za-z]:[\\/]|\/)[^\r\n()]+):(\d{1,8}):(\d{1,8})\)?$/.exec(frame);
      if (!match) continue;
      let file = match[1].startsWith("file:") ? fileURLToPath(match[1]) : match[1];
      if (!isAbsolute(file)) continue;
      file = relative(resolve(codeRoot), resolve(file)).split(sep).join("/");
      if (!/^(?:dist\/src|src|node_modules)\/[A-Za-z0-9_@./-]+\.[cm]?[jt]s$/.test(file)
        || file.split("/").includes("..") || file.length > 240) continue;
      if (!existsSync(resolve(codeRoot, file))) continue;
      frames.push({ file, line: Number(match[2]), column: Number(match[3]) });
      if (frames.length === 8) break;
    }
  } catch { /* Hostile getters/stacks must not break the fatal-error observer. */ }
  return { name, ...(code ? { code } : {}), frames };
}

function regularFile(path: string) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("DIAGNOSTIC_PATH_REJECTED");
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** One core owns this bounded operational log; it is not a process supervisor. */
export class RuntimeDiagnostics {
  readonly path: string;
  private readonly instance = randomUUID();
  private readonly startedAt = new Date().toISOString();
  private failed = false;
  private window = Date.now();
  private errors = 0;
  private dropped = 0;
  private timer?: NodeJS.Timeout;
  private readonly fatal = (error: Error, origin: string) => {
    this.record(origin === "unhandledRejection" ? "unhandled_rejection" : "uncaught_exception", { error });
  };
  private readonly exiting = (exitCode: number) => this.record("runtime_exit", { exitCode });

  constructor(private readonly config: Pick<BridgeConfig, "dataDir" | "projectRoot" | "buildId">) {
    const directory = join(config.dataDir, "diagnostics");
    for (let cursor = resolve(directory); ; cursor = dirname(cursor)) {
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error("DIAGNOSTIC_PATH_REJECTED");
      if (dirname(cursor) === cursor) break;
    }
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, "runtime.jsonl");
    if (!this.record("runtime_start")) throw new Error("RUNTIME_DIAGNOSTICS_UNAVAILABLE");
    // Monitor preserves Node's default fatal behavior, including rejected promises.
    process.on("uncaughtExceptionMonitor", this.fatal);
    process.on("exit", this.exiting);
    this.timer = setInterval(() => this.record("heartbeat"), 60_000);
    this.timer.unref();
  }

  record(event: Event, details: Details = {}): boolean {
    try {
      if (event === "http_error") {
        if (Date.now() - this.window >= 60_000) { this.window = Date.now(); this.errors = 0; }
        if (++this.errors > 60) { this.dropped++; return true; }
      }
      const memory = process.memoryUsage();
      const row = { contract: "bridge-runtime-diagnostic-v1", at: new Date().toISOString(), event,
        instance: this.instance, pid: process.pid, startedAt: this.startedAt, buildId: this.config.buildId,
        uptimeSeconds: Math.floor(process.uptime()), memory: { rss: memory.rss, heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal, external: memory.external }, droppedHttpErrors: this.dropped,
        ...(details.error !== undefined ? { error: diagnosticError(details.error, this.config.projectRoot) } : {}),
        ...(Number.isInteger(details.exitCode) ? { exitCode: details.exitCode } : {}),
        ...(details.signal && SIGNALS.has(details.signal) ? { signal: details.signal } : {}),
      };
      const bytes = Buffer.from(JSON.stringify(row) + "\n", "utf8");
      const directory = lstatSync(dirname(this.path));
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("DIAGNOSTIC_PATH_REJECTED");
      // Active file plus three generations: at most 4 MiB. Only these fixed files rotate.
      if ((regularFile(this.path)?.size ?? 0) + bytes.length > 1_048_576) {
        for (let n = 1; n <= 3; n++) regularFile(`${this.path}.${n}`);
        if (existsSync(`${this.path}.3`)) unlinkSync(`${this.path}.3`);
        for (let n = 2; n >= 1; n--) if (existsSync(`${this.path}.${n}`)) renameSync(`${this.path}.${n}`, `${this.path}.${n + 1}`);
        renameSync(this.path, `${this.path}.1`);
      }
      const before = regularFile(this.path);
      const fd = openSync(this.path, "a", 0o600);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || (before && (opened.ino !== before.ino || opened.dev !== before.dev))) {
          throw new Error("DIAGNOSTIC_PATH_CHANGED");
        }
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
        if (event !== "heartbeat" && event !== "http_error") fsyncSync(fd);
      } finally { closeSync(fd); }
      return true;
    } catch (error) {
      if (!this.failed) {
        this.failed = true;
        const code = diagnosticError(error, this.config.projectRoot).code ?? "IO_FAILURE";
        try { process.stderr.write(`RUNTIME_DIAGNOSTICS_WRITE_FAILED ${code}\n`); } catch {}
      }
      return false;
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    process.off("uncaughtExceptionMonitor", this.fatal);
    process.off("exit", this.exiting);
  }
}
