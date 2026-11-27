import { open } from "node:fs/promises";
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { BridgeConfig } from "./config.js";

type Event = "runtime_start" | "runtime_ready" | "heartbeat" | "http_error" | "startup_failed"
  | "uncaught_exception" | "unhandled_rejection" | "shutdown_requested" | "shutdown_failed"
  | "cooperative_shutdown" | "cooperative_closed" | "cooperative_failed" | "cooperative_host_exit" | "runtime_exit" | "pipeline_fault" | "native_exit" | "maintenance_transition";
type Stage = "notification" | "queue" | "service" | "unmatched" | "stderr" | "native_rpc" | "native_read"
  | "reconcile" | "journal" | "checkpoint" | "replay" | "host_poll" | "widget_ack" | "http_poll" | "manifest" | "index" | "maintenance" | "http_session" | "native_session" | "delivered";
type Sample = {
  jobId?: string; threadId?: string; turnId?: string; connection?: string; poll?: string; instance?: string; intentId?:string; nativePid?:number; session?:string;
  revision?: number; seq?: number; rpc?: number; bytes?: number; elapsedMs?: number; depth?: number;
  applied?: number; renderMs?: number; observedAtMs?: number; hidden?: boolean;
};
function diagnosticId(value: string) {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value :
    createHash("sha256").update(value).digest("hex").slice(0, 16);
}
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
  readonly instance = randomUUID();
  private readonly startedAt = new Date().toISOString();
  private failed = false;
  private window = Date.now();
  private errors = 0;
  private dropped = 0;
  private rotations = 0;
  private overwrittenBytes = 0;
  private failedWrites = 0;
  private unreported = 0;
  private readonly reportedFaults = new Set<string>();
  private gc = { count: 0, durationMs: 0 };
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  private readonly observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) { this.gc.count++; this.gc.durationMs += entry.duration; }
  });
  private readonly polls = new Map<string, { started?:number; service?:number; http?:number; bytes?:number; rpc?:number; delivery?:string; seq?:number; revision?:number }>();
  private expiredPolls = 0;
  private groups = new Map<string, {stage: Stage; reason: string; count: number; firstMs: number;
    lastMs: number; maxMs: number; totalMs: number; totalBytes: number; sample: Sample}>();
  workload?: () => object;
  private sampleWorkload() {
    try { return this.workload?.(); } catch { return {status:"sampling_failed"}; }
  }
  // Reasons are fixed call-site codes. Incoming RPC method names and error messages
  // never become grouping keys. High-cardinality ids only appear in bounded samples.
  observe(stage: Stage, reason: string, sample: Sample = {}, anomaly = false, error?: unknown) {
    if (sample.poll) {
      const trace = this.polls.get(sample.poll) ?? {};
      if (stage === "widget_ack") {
        sample = {...trace, ...sample};
        this.polls.delete(sample.poll!);
      } else {
        if (stage === "host_poll") {
          trace.service = sample.elapsedMs;
          trace.delivery = reason;
          trace.seq = sample.seq;
          trace.revision = sample.revision;
        }
        if (stage === "http_poll" && reason === "received") { trace.started = performance.now(); trace.rpc = sample.rpc; }
        if (stage === "http_poll" && reason !== "received") {
          trace.http = sample.elapsedMs;
          trace.bytes = sample.bytes;
          if (reason === "response_finished" && trace.delivery) {
            this.observe("delivered",trace.delivery,{jobId:sample.jobId,bytes:sample.bytes,seq:trace.seq,revision:trace.revision});
          }
        }
        this.polls.set(sample.poll,trace);
        // Trace metadata only. The limit matches the existing durable delta entry budget.
        if (this.polls.size > 256) { this.polls.delete(this.polls.keys().next().value!); this.expiredPolls++; }
      }
    }
    const key = [stage, reason, sample.jobId ?? (stage === "native_rpc" ? sample.threadId : undefined)].join("|");
    let group = this.groups.get(key);
    const now = performance.now();
    if (!group) {
      if (this.groups.size >= 512) { this.unreported++; return; }
      group = {stage, reason, count:0, firstMs:now, lastMs:now, maxMs:0, totalMs:0, totalBytes:0, sample:{}};
      this.groups.set(key, group);
    }
    group.count++;
    group.lastMs = now;
    group.totalMs += sample.elapsedMs ?? 0;
    group.maxMs = Math.max(group.maxMs, sample.elapsedMs ?? 0);
    group.totalBytes += sample.bytes ?? 0;
    group.sample = { ...sample };
    const cause = stage + "|" + reason;
    if (anomaly && !this.reportedFaults.has(cause) && this.record("pipeline_fault", {error})) this.reportedFaults.add(cause);
  }

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
    this.observer.observe({entryTypes:["gc"]});
    this.loop.enable();
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
      const groups = event === "http_error" ? [] : Array.from(this.groups.values(), group => {
        const sample = { ...group.sample };
        for (const key of ["threadId","turnId","connection","poll","jobId","instance","intentId","session"] as const) {
          if (sample[key]) sample[key] = diagnosticId(sample[key]!);
        }
        return { ...group, sample };
      });
      const row = { contract: "bridge-runtime-diagnostic-v1", at: new Date().toISOString(), event,
        instance: this.instance, pid: process.pid, startedAt: this.startedAt, buildId: this.config.buildId,
        monotonicMs: performance.now(), rotations: this.rotations, overwrittenBytes: this.overwrittenBytes,
        unacknowledgedPollTraces:this.polls.size, evictedPollTraces:this.expiredPolls,
        writeFailures: this.failedWrites, droppedGroups: this.unreported,
        gc: this.gc, loopP99Ms: this.loop.count ? this.loop.percentile(99)/1e6 : null,
        loopMaxMs: this.loop.count ? this.loop.max/1e6 : null,
        ...(event !== "http_error" ? {groups, workload: this.sampleWorkload()} : {}),
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
        this.rotations++;
        const oldest = regularFile(`${this.path}.3`);
        if (oldest) { this.overwrittenBytes += oldest.size; unlinkSync(`${this.path}.3`); }
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
      if (["runtime_exit","native_exit","uncaught_exception","unhandled_rejection"].includes(event)) {
        // Retain the most recent exit per owner, independent of heartbeat rotation.
        const target = join(dirname(this.path), "last-" + event + ".json");
        regularFile(target);
        const temp = target + "." + randomUUID() + ".tmp";
        const summary = {event,at:row.at,instance:row.instance,pid:row.pid,buildId:row.buildId,exitCode:row.exitCode,signal:row.signal,error:row.error};
        writeFileSync(temp,JSON.stringify(summary),{encoding:"utf8",flag:"wx",flush:true,mode:0o600});
        try { renameSync(temp,target); } catch (error) { unlinkSync(temp); throw error; }
      }
      if (event === "heartbeat") { this.groups.clear(); this.reportedFaults.clear(); this.loop.reset(); }
      return true;
    } catch (error) {
      this.failedWrites++;
      if (!this.failed) {
        this.failed = true;
        const code = diagnosticError(error, this.config.projectRoot).code ?? "IO_FAILURE";
        try { process.stderr.write(`RUNTIME_DIAGNOSTICS_WRITE_FAILED ${code}\n`); } catch {}
      }
      return false;
    }
  }

  // On-demand private Workspace readback. The files are operational state,
  // so rebuild the response from safe fields even for locally modified/old rows.
  async readRecent(limit: number, jobId?: string, pollId?: string, threadId?: string) {
    const records: object[] = [];
    let malformed = 0;
    for (const suffix of ["", ".1", ".2", ".3"]) {
      const path = this.path + suffix;
      const parent = lstatSync(dirname(path));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("DIAGNOSTIC_PATH_REJECTED");
      const before = regularFile(path);
      if (!before) continue;
      const file = await open(path,"r");
      try {
        const checked = await file.stat();
        if (!checked.isFile() || checked.nlink !== 1 || checked.ino !== before.ino || checked.dev !== before.dev ||
          checked.size > 1_048_576) throw new Error("DIAGNOSTIC_FILE_CHANGED");
        const buffer = Buffer.alloc(checked.size);
        let offset = 0;
        while (offset < buffer.length) {
          const read = await file.read(buffer,offset,buffer.length-offset,offset);
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        const lines = buffer.subarray(0,offset).toString("utf8").trimEnd().split("\n");
        for (const line of lines.reverse()) {
          if (!line) continue;
          let row;
          try { row = JSON.parse(line); } catch { malformed++; continue; }
          if (row?.contract !== "bridge-runtime-diagnostic-v1" || !safeClock(row.at) ||
            !safeUuid(row.instance) || !/^[0-9a-f]{16}$/i.test(String(row.buildId))) { malformed++; continue; }
          const groups = [];
          for (const group of Array.isArray(row.groups) ? row.groups : []) {
            const sample = group?.sample;
            if (!sample) continue;
            const sameThread = !sample.jobId && group.stage === "native_rpc" && threadId && sample.threadId === diagnosticId(threadId);
            if (!sameThread && (sample.jobId ? sample.jobId !== jobId : jobId !== undefined)) continue;
            if (pollId && sample.poll !== pollId) continue;
            if (!PUBLIC_STAGES.has(group.stage)) continue;
            groups.push({stage:group.stage,reason:PUBLIC_REASONS.has(group.reason) ? group.reason : "other",
              ...numbers(group,["count","totalBytes","maxMs","totalMs","firstMs","lastMs"]),
              sample:{...numbers(sample,["bytes","elapsedMs","depth","revision","seq","rpc","renderMs","observedAtMs","http","service","started","nativePid"]),
                ...(sample.jobId && jobId ? {jobId} : {}),delivery:PUBLIC_REASONS.has(sample.delivery) ? sample.delivery : undefined,poll:safeUuid(sample.poll),connection:safeUuid(sample.connection), instance:safeUuid(sample.instance),intentId:safeUuid(sample.intentId),
                hidden:typeof sample.hidden === "boolean" ? sample.hidden : undefined,
                threadId:jobId ? safeIdentifier(sample.threadId) : undefined,turnId:jobId ? safeIdentifier(sample.turnId) : undefined}});
          }
          if ((jobId || pollId) && !groups.length) continue;
          records.push({at:row.at,instance:row.instance,buildId:row.buildId,
            event:PUBLIC_EVENTS.has(row.event) ? row.event : "other",
            ...numbers(row,["pid","exitCode","monotonicMs","loopMaxMs","loopP99Ms","rotations","overwrittenBytes","writeFailures","droppedGroups","droppedHttpErrors","evictedPollTraces"]),
            signal:SIGNALS.has(row.signal) ? row.signal : undefined, memory:numbers(row.memory,["rss","heapUsed","heapTotal","external"]),
            gc:numbers(row.gc,["count","durationMs"]),
            error:row.error ? {name:ERROR_NAMES.has(row.error.name) ? row.error.name : "Unknown",
              code:ERROR_CODES.has(row.error.code) || RUNTIME_CODES.has(row.error.code) ? row.error.code : undefined} : undefined,
            workload:publicWorkload(row.workload),groups});
          if (records.length >= limit) return {records,malformed,retention:"rotating_window"};
        }
      } finally { await file.close(); }
    }
    return {records,malformed,retention:"rotating_window"};
  }

  dispose() {
    this.loop.disable();
    this.observer.disconnect();
    if (this.timer) clearInterval(this.timer);
    process.off("uncaughtExceptionMonitor", this.fatal);
    process.off("exit", this.exiting);
  }
}

const PUBLIC_EVENTS = new Set(["runtime_start","runtime_ready","heartbeat","http_error","startup_failed","uncaught_exception",
  "unhandled_rejection","shutdown_requested","shutdown_failed","cooperative_shutdown","cooperative_closed","cooperative_failed",
  "cooperative_host_exit","runtime_exit","pipeline_fault","native_exit","maintenance_transition"]);
const PUBLIC_STAGES = new Set(["notification","queue","service","unmatched","stderr","native_rpc","native_read","reconcile","journal",
  "checkpoint","replay","host_poll","widget_ack","http_poll","manifest","index","maintenance","http_session","native_session","delivered"]);
const PUBLIC_REASONS = new Set(["ingress","received","handled","committed","promoted","loaded","verified_offset","full_validation","timeout","failed",
  "applied","deferred","identity_mismatch","other_notification","unmapped_turn","unmapped_thread","missing_identity","already_terminal",
  "stdio_paused","stdio_resumed","shared_process","single_turn","no_mapped_turn","fatal","error","other","turn_page","thread_read","response",
  "native_identity_unconfirmed","detached_native_nonterminal","snapshot","delta","catch_up","client_recovery","cursor_outside_replay_budget",
  "transport_failed","gap","hidden","resumed","obsolete","response_finished","disconnected","unreadable","hint_write_failed",
  "reconciliation_failed","reconciled","persistence_failed","timer_flush_failed","native_snapshot","native_unchanged","connected","closed","spawned","closing","ready",
  "draining","restarting","cooldown","conversation_journal_gap","conversation_journal_corrupt","conversation_replay_failed",
  "conversation_checkpoint_write_failed","conversation_journal_write_failed","conversation_checkpoint_recovered"]);
function numbers(value: Record<string,unknown> | undefined, keys: string[]) {
  return Object.fromEntries(keys.filter(key=>Number.isFinite(value?.[key])).map(key=>[key,value![key]]));
}
function safeUuid(value:unknown) {
  return typeof value==="string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
}
function safeIdentifier(value:unknown) {
  return safeUuid(value) ?? (typeof value==="string" && /^[0-9a-f]{16}$/i.test(value) ? value : undefined);
}
function safeClock(value:unknown) {
  return typeof value==="string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}

function publicWorkload(input: Record<string, Record<string,unknown>> | undefined) {
  if (!input) return undefined;
  return {
    store:numbers(input.store,["manifestCount","hotManifests","metadataEntriesSampled","estimatedMetadataBytes","messageIndexEntries","estimatedMessageIndexBytes",
      "messagePayloadBytes","artifactDescriptors","eventCursors","observedJournalFiles","observedJournalBytes","estimatedColdBytes",
      "projectionCount","estimatedProjectionBytes","messageTailCount","journalAnchors","pendingConversations","pendingLocks","flushFailures","replayBufferBytes"]),
    controller:numbers(input.controller,["background","lockQueues","waiting","estimatedQueuedTextBytes","oldestWaitMs","recoveries","unmatched","mappedTurns","mappedThreads"]),
    appServer:numbers(input.appServer,["pid","inflight","oldestRpc","oldestRpcMs","stdoutBufferedBytes","stdinBufferedBytes"]),
    native:numbers(input.native,["entries","serializedBytes","inventory"]),
    maintenance:{...numbers(input.maintenance,["thresholdBytes","heapUsed","consecutiveSamples","sampleMs"]),
      intentId:safeUuid(input.maintenance?.intentId),phase:["monitoring","draining","ready","restarting","failed","cooldown"].includes(String(input.maintenance?.phase)) ? input.maintenance?.phase : undefined}
  };
}
