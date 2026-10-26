import net from "node:net";
import http from "node:http";
import https from "node:https";
import { Resolver } from "node:dns/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { diagnosticSchemas, DIAGNOSTIC_LIMITS } from "./diagnostic-inputs.js";
import { runBoundedProcess, type BoundedProcessResult } from "./process-runner.js";

type Result = Record<string, unknown>;
type Runner = typeof runBoundedProcess;

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "DIAGNOSTIC_FAILED";
}

export async function checkTcpPort(input: unknown): Promise<Result> {
  const args = diagnosticSchemas.check_tcp_port.parse(input);
  const started = performance.now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (connected: boolean, code?: string) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: true, ...args, connected, code, elapsedMs: Math.round(performance.now() - started) });
    };
    const timer = setTimeout(() => finish(false, "TIMEOUT"), args.timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(false, errorCode(error)));
    socket.connect({ host: args.host, port: args.port });
  });
}

export async function resolveDns(input: unknown): Promise<Result> {
  const args = diagnosticSchemas.resolve_dns.parse(input);
  const literalFamily = net.isIP(args.hostname);
  if (literalFamily) {
    const matches = args.family === "all" || args.family === (literalFamily === 4 ? "ipv4" : "ipv6");
    return { ok: true, ...args, source: "literal", addresses: matches ? [{ address: args.hostname, family: literalFamily }] : [], truncated: false };
  }
  // Dedicated resolver permits cancellation without affecting other requests. DNS, not hosts-file lookup.
  const resolver = new Resolver({ timeout: args.timeoutMs, tries: 1 });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; resolver.cancel(); }, args.timeoutMs);
  try {
    const families = args.family === "all" ? [4, 6] : [args.family === "ipv4" ? 4 : 6];
    const outcomes = await Promise.all(families.map(async (family) => {
      try {
        const values = await (family === 4 ? resolver.resolve4(args.hostname) : resolver.resolve6(args.hostname));
        return { family, values, code: undefined };
      } catch (error) { return { family, values: [] as string[], code: errorCode(error) }; }
    }));
    const addresses = outcomes.flatMap((item) => item.values.map((address) => ({ address, family: item.family })));
    const errors = outcomes.filter((item) => item.code).map(({ family, code }) => ({ family, code }));
    return { ok: !timedOut && errors.length === 0, ...args, source: "dns", addresses: addresses.slice(0, args.maxResults),
      errors, code: timedOut ? "TIMEOUT" : undefined, partial: errors.length > 0 && addresses.length > 0,
      truncated: addresses.length > args.maxResults };
  } finally { clearTimeout(timer); }
}

// Only these operator-owned Windows binaries are reachable. No PATH search or caller cwd/env.
async function windowsRead(executable: "netstat.exe" | "tasklist.exe" | "ping.exe", args: string[],
  timeoutMs: number, runner: Runner): Promise<BoundedProcessResult> {
  if (process.platform !== "win32") throw Object.assign(new Error(), { code: "UNSUPPORTED_PLATFORM" });
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[a-z]:\\/i.test(systemRoot)) throw Object.assign(new Error(), { code: "SYSTEM_ROOT_UNAVAILABLE" });
  const system32 = path.win32.join(systemRoot, "System32");
  return runner(path.win32.join(system32, executable), args, {
    cwd: system32, env: { SystemRoot: systemRoot, WINDIR: systemRoot }, timeoutMs,
    maxStdoutBytes: DIAGNOSTIC_LIMITS.maxStdoutBytes, maxStderrBytes: DIAGNOSTIC_LIMITS.maxStderrBytes,
  });
}

interface Listener { address: string; port: number; pid: number; family: "ipv4" | "ipv6" }
export function parseListeners(stdout: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)$/i);
    if (!match) continue;
    const endpoint = match[1].match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
    if (!endpoint) continue;
    const address = endpoint[1] ?? endpoint[2];
    const family = net.isIP(address);
    const port = Number(endpoint[3]);
    const pid = Number(match[2]);
    if (!family || port < 1 || port > 65_535 || !Number.isSafeInteger(pid) || pid < 0) continue;
    listeners.push({ address, port, pid, family: family === 4 ? "ipv4" : "ipv6" });
  }
  return listeners;
}

function processFailure(result: BoundedProcessResult): string | undefined {
  return result.terminationReason?.toUpperCase() ?? (result.code !== 0 ? "COMMAND_FAILED" : undefined);
}

function completeProcessLines(result: BoundedProcessResult): string {
  // A killed capture can end mid-PID/name; never parse that fragment as an identity.
  return result.terminationReason ? result.stdout.slice(0, result.stdout.lastIndexOf("\n") + 1) : result.stdout;
}

async function listenersSnapshot(args: { port?: number; address?: string; family?: string; maxResults: number; timeoutMs: number }, runner: Runner) {
  // -p tcp on Windows omits TCPv6. Read both families, then discard every non-TCP row.
  const result = await windowsRead("netstat.exe", ["-ano"], args.timeoutMs, runner);
  const code = processFailure(result);
  const matches = parseListeners(completeProcessLines(result)).filter((item) =>
    (args.port === undefined || item.port === args.port) && (!args.address || item.address === args.address)
    && (!args.family || item.family === args.family));
  return { ok: !code, code, listeners: matches.slice(0, args.maxResults),
    truncated: matches.length > args.maxResults || result.terminationReason === "output_limit",
    complete: !code && matches.length <= args.maxResults };
}

export async function listListeningPorts(input: unknown, runner: Runner = runBoundedProcess): Promise<Result> {
  const args = diagnosticSchemas.list_listening_ports.parse(input);
  try { return { ...await listenersSnapshot(args, runner), appliedLimits: args, protocol: "tcp" }; }
  catch (error) { return { ok: false, code: errorCode(error) }; }
}

export async function inspectPortOwner(input: unknown, runner: Runner = runBoundedProcess): Promise<Result> {
  const args = diagnosticSchemas.inspect_port_owner.parse(input);
  const deadline = performance.now() + args.timeoutMs;
  try {
    const snapshot = await listenersSnapshot(args, runner);
    if (!snapshot.listeners.length) return { ...snapshot, port: args.port,
      state: snapshot.complete ? "no_listener" : "unknown" };
    const remaining = Math.floor(deadline - performance.now());
    // One bounded snapshot avoids N subprocesses for many matching listeners.
    let processes: BoundedProcessResult | undefined;
    let identityCode: string | undefined;
    if (remaining <= 0) identityCode = "TIMEOUT";
    else {
      try {
        processes = await windowsRead("tasklist.exe", ["/FO", "CSV", "/NH"], remaining, runner);
        identityCode = processFailure(processes);
      } catch (error) { identityCode = errorCode(error); }
    }
    const identities = new Map<number, string>();
    for (const line of (processes ? completeProcessLines(processes) : "").split(/\r?\n/)) {
      const match = line.match(/^"((?:[^"]|"")*)","(\d+)"(?:,|$)/);
      if (match) identities.set(Number(match[2]), match[1].replace(/""/g, '"').slice(0, 260));
    }
    const identityComplete = !identityCode && snapshot.listeners.every((item) => identities.has(item.pid));
    return { ...snapshot, partial: !snapshot.complete || !identityComplete,
      identityComplete, identityCode,
      truncated: snapshot.truncated || processes?.terminationReason === "output_limit", port: args.port,
      identitySource: "tasklist_image_name", identityIsAtomic: false,
      listeners: snapshot.listeners.map((item) => ({ ...item, processName: identities.get(item.pid) ?? null,
        identityStatus: identities.has(item.pid) ? "observed" : "unavailable",
        identityCode: identities.has(item.pid) ? undefined : identityCode ?? "PROCESS_NOT_OBSERVED" })) };
  } catch (error) { return { ok: false, code: errorCode(error) }; }
}

export async function pingHost(input: unknown, runner: Runner = runBoundedProcess): Promise<Result> {
  const args = diagnosticSchemas.ping_host.parse(input);
  try {
    const result = await windowsRead("ping.exe", ["-n", "1", "-w", String(args.timeoutMs), args.host], args.timeoutMs, runner);
    const code = processFailure(result);
    // Windows can exit 0 for ICMP destination-unreachable. Echo replies include a TTL/hop-limit.
    const echoReplyObserved = result.code === 0 && /\b(?:TTL|hlim)[= ]\d+/i.test(result.stdout);
    return { ok: !result.terminationReason, ...args, probeCount: 1, exitCode: result.code,
      echoReplyObserved, code, output: result.stdout.slice(0, 2_048),
      truncated: result.stdout.length > 2_048 || result.terminationReason === "output_limit" };
  } catch (error) { return { ok: false, code: errorCode(error) }; }
}

export async function httpHealthCheck(input: unknown): Promise<Result> {
  const args = diagnosticSchemas.http_health_check.parse(input);
  const target = new URL(args.url);
  const started = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    let statusCode: number | null = null;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const request = (target.protocol === "https:" ? https : http).request(target, {
      method: "GET", agent: false, maxHeaderSize: 8_192,
      headers: { accept: "text/plain, application/json", "accept-encoding": "identity" },
    });
    const finish = (code?: string, truncated = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve({ ok: !code, statusCode, healthy: !code && statusCode !== null && statusCode >= 200 && statusCode < 300,
        code, bodyPreview: new StringDecoder("utf8").write(Buffer.concat(chunks)), bodyBytes: bytes, truncated,
        elapsedMs: Math.round(performance.now() - started), timeoutMs: args.timeoutMs, maxBodyBytes: args.maxBodyBytes });
    };
    const timer = setTimeout(() => finish("TIMEOUT", true), args.timeoutMs);
    request.once("error", (error) => finish(errorCode(error), bytes > 0));
    request.once("response", (response) => {
      statusCode = response.statusCode ?? null;
      response.on("error", (error) => finish(errorCode(error), true));
      response.on("aborted", () => finish("RESPONSE_ABORTED", true));
      response.on("data", (chunk: Buffer) => {
        const remaining = args.maxBodyBytes - bytes;
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        bytes += kept.length;
        if (chunk.length > remaining) finish(undefined, true);
      });
      response.once("end", () => finish());
    });
    request.end();
  });
}
