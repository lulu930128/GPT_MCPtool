import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import http from "node:http";
import { Resolver } from "node:dns/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { diagnosticSchemas, DIAGNOSTIC_LIMITS } from "../src/diagnostic-inputs.js";
import { registerDiagnosticTools } from "../src/diagnostic-server.js";
import { checkTcpPort, listListeningPorts, inspectPortOwner, resolveDns, pingHost, httpHealthCheck, parseListeners } from "../src/diagnostics.js";
import { runBoundedProcess, type BoundedProcessResult } from "../src/process-runner.js";

const output = (stdout: string, extra: Partial<BoundedProcessResult> = {}): BoundedProcessResult => ({ code: 0, stdout, stderr: "", ...extra });
const listener = (port = 1234, pid = 42) => `  TCP    127.0.0.1:${port}    0.0.0.0:0    LISTENING    ${pid}\r\n`;

test("diagnostic schemas reject injection, invalid targets, extra fields and cap violations", () => {
  for (const host of ["", "-n", "a;b", "a&whoami", "$(whoami)", "a|b", "a>b", "a b", "a\nb", "http://a", "999.1.1.1", "a".repeat(254)]) {
    assert.equal(diagnosticSchemas.check_tcp_port.safeParse({ host, port: 80 }).success, false, host);
    assert.equal(diagnosticSchemas.ping_host.safeParse({ host }).success, false, host);
    assert.equal(diagnosticSchemas.resolve_dns.safeParse({ hostname: host }).success, false, host);
  }
  for (const port of [-1, 0, 65_536, 1.1, "80", NaN]) {
    assert.equal(diagnosticSchemas.check_tcp_port.safeParse({ host: "localhost", port }).success, false);
    assert.equal(diagnosticSchemas.inspect_port_owner.safeParse({ port }).success, false);
  }
  for (const url of ["file:///etc/passwd", "ftp://example.com", "http://user:pass@localhost", "http://localhost/#x",
    "http://localhost:0", "http://localhost:99999", "http://local host", "http://localhost\\x", "not-a-url"]) {
    assert.equal(diagnosticSchemas.http_health_check.safeParse({ url }).success, false, url);
  }
  for (const host of ["localhost", "example.com.", "127.0.0.1", "10.0.0.1", "::1", "2001:db8::1"]) {
    assert.equal(diagnosticSchemas.ping_host.safeParse({ host }).success, true);
  }
  assert.equal(diagnosticSchemas.http_health_check.safeParse({ url: "http://[::1]:80/health" }).success, true);
  for (const extra of [{ timeoutMs: 10_001 }, { timeoutMs: 0 }, { command: "whoami" }, { args: ["-t"] }, { cwd: "C:\\" }, { env: {} }]) {
    assert.equal(diagnosticSchemas.ping_host.safeParse({ host: "localhost", ...extra }).success, false);
  }
  assert.equal(diagnosticSchemas.list_listening_ports.safeParse({ maxResults: 101 }).success, false);
  assert.equal(diagnosticSchemas.list_listening_ports.safeParse({ address: "-a" }).success, false);
  assert.equal(diagnosticSchemas.http_health_check.safeParse({ url: "http://localhost", method: "POST" }).success, false);
  assert.equal(diagnosticSchemas.http_health_check.safeParse({ url: "http://localhost", maxBodyBytes: 16_385 }).success, false);
});

test("native TCP observes connected and refused sockets", async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  try { assert.equal((await checkTcpPort({ host: "127.0.0.1", port })).connected, true); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  const refused = await checkTcpPort({ host: "127.0.0.1", port });
  assert.equal(refused.connected, false);
  assert.equal(refused.code, "ECONNREFUSED");
});

test("TCP deadline closes a socket even while connect is pending", async (t) => {
  let destroyed = false;
  t.mock.method(net.Socket.prototype, "connect", function (this: net.Socket) { return this; });
  t.mock.method(net.Socket.prototype, "destroy", function (this: net.Socket) { destroyed = true; return this; });
  const result = await checkTcpPort({ host: "localhost", port: 80, timeoutMs: 100 });
  assert.equal(result.code, "TIMEOUT");
  assert.equal(destroyed, true);
});

test("DNS returns bounded records, explicit partial errors, literals and cancelled timeout", async (t) => {
  assert.deepEqual((await resolveDns({ hostname: "::1" })).addresses, [{ address: "::1", family: 6 }]);
  t.mock.method(Resolver.prototype, "resolve4", async () => ["127.0.0.1", "127.0.0.2"]);
  t.mock.method(Resolver.prototype, "resolve6", async () => { throw Object.assign(new Error(), { code: "ENODATA" }); });
  const result = await resolveDns({ hostname: "example.com", maxResults: 1 });
  assert.equal(result.truncated, true);
  assert.equal(result.partial, true);
  assert.deepEqual(result.addresses, [{ address: "127.0.0.1", family: 4 }]);
  let rejectLookup: (reason: Error) => void = () => {};
  t.mock.method(Resolver.prototype, "resolve4", () => new Promise((_, reject) => { rejectLookup = reject; }));
  t.mock.method(Resolver.prototype, "cancel", () => rejectLookup(Object.assign(new Error(), { code: "ECANCELLED" })));
  assert.equal((await resolveDns({ hostname: "example.com", family: "ipv4", timeoutMs: 100 })).code, "TIMEOUT");
});

test("listener parser excludes connections/UDP and supports IPv6", () => {
  assert.deepEqual(parseListeners(listener() + " TCP [::]:80 [::]:0 LISTENING 3\n TCP 127.0.0.1:4 127.0.0.1:5 ESTABLISHED 8\n UDP 0.0.0.0:5 *:* 9\n"), [
    { address: "127.0.0.1", port: 1234, pid: 42, family: "ipv4" }, { address: "::", port: 80, pid: 3, family: "ipv6" },
  ]);
});

test("Windows reads use fixed executable/args, bounded runner, filters and non-atomic PID identities", { skip: process.platform !== "win32" }, async () => {
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = [];
  const runner: typeof runBoundedProcess = async (command, args, options) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs });
    assert.match(command, /^[a-z]:\\.*\\System32\\(?:netstat|tasklist)\.exe$/i);
    assert.equal(options.maxStdoutBytes, DIAGNOSTIC_LIMITS.maxStdoutBytes);
    assert.equal(options.maxStderrBytes, DIAGNOSTIC_LIMITS.maxStderrBytes);
    assert.deepEqual(Object.keys(options.env!).sort(), ["SystemRoot", "WINDIR"]);
    assert.ok(options.timeoutMs <= 3_000);
    return output(command.endsWith("netstat.exe") ? listener() + listener(1234, 43) + listener(5555) : '"node.exe","42","Console","1","1,000 K"\r\n');
  };
  const list = await listListeningPorts({ port: 1234, address: "127.0.0.1", family: "ipv4", maxResults: 1 }, runner);
  assert.equal((list.listeners as unknown[]).length, 1);
  assert.equal(list.truncated, true);
  const owners = await inspectPortOwner({ port: 1234 }, runner);
  assert.equal(owners.identityIsAtomic, false);
  assert.deepEqual((owners.listeners as Array<{ processName: string | null }>).map((item) => item.processName), ["node.exe", null]);
  assert.deepEqual(calls.map((call) => call.args), [["-ano"], ["-ano"], ["/FO", "CSV", "/NH"]]);
  assert.ok(calls[2].timeoutMs <= calls[1].timeoutMs);
});

test("no listener differs from incomplete or failed collection; owner lookup shares the timeout budget", { skip: process.platform !== "win32" }, async () => {
  let calls = 0;
  const empty = await inspectPortOwner({ port: 1234 }, async () => { calls++; return output(""); });
  assert.equal(empty.state, "no_listener");
  assert.equal(calls, 1);
  for (const reason of ["timeout", "output_limit"] as const) {
    const result = await inspectPortOwner({ port: 1234 }, async () => output("", { terminationReason: reason }));
    assert.equal(result.state, "unknown");
    assert.equal(result.ok, false);
  }
  const capped = await listListeningPorts({}, async () => output(listener(), { terminationReason: "output_limit" }));
  assert.equal(capped.truncated, true);
  assert.equal(capped.complete, false);
  const cutPid = await listListeningPorts({}, async () => output(listener().trimEnd(), { terminationReason: "output_limit" }));
  assert.deepEqual(cutPid.listeners, []);
  const failed = await listListeningPorts({}, async () => { throw Object.assign(new Error("private"), { code: "ENOENT" }); });
  assert.deepEqual(failed, { ok: false, code: "ENOENT" });
  calls = 0;
  const budget = await inspectPortOwner({ port: 1234, timeoutMs: 100 }, async () => {
    calls++; await new Promise((resolve) => setTimeout(resolve, 110)); return output(listener());
  });
  assert.equal(budget.ok, true);
  assert.equal(budget.identityCode, "TIMEOUT");
  assert.equal(budget.partial, true);
  assert.equal(calls, 1);
});

test("identity failures preserve a complete listener/PID observation with explicit partial semantics", { skip: process.platform !== "win32" }, async () => {
  for (const failure of ["COMMAND_FAILED", "EACCES", "TIMEOUT", "OUTPUT_LIMIT"]) {
    const result = await inspectPortOwner({ port: 1234 }, async (command) => {
      if (command.endsWith("netstat.exe")) return output(listener());
      if (failure === "EACCES") throw Object.assign(new Error("private"), { code: "EACCES" });
      return output("", failure === "COMMAND_FAILED" ? { code: 1 } : {
        terminationReason: failure === "TIMEOUT" ? "timeout" : "output_limit",
      });
    });
    assert.equal(result.ok, true);
    assert.equal(result.complete, true);
    assert.equal(result.partial, true);
    assert.equal(result.identityCode, failure);
    assert.equal(result.identityComplete, false);
    const row = (result.listeners as Array<Record<string, unknown>>)[0];
    assert.equal(row.pid, 42);
    assert.equal(row.processName, null);
    assert.equal(row.identityStatus, "unavailable");
    assert.equal(row.identityCode, failure);
  }
});

test("ping uses one fixed probe, rejects injection before runner, and bounds output", { skip: process.platform !== "win32" }, async () => {
  let calls = 0;
  const runner: typeof runBoundedProcess = async (command, args) => {
    calls++; assert.match(command, /\\System32\\ping\.exe$/i);
    assert.deepEqual(args, ["-n", "1", "-w", "100", "localhost"]);
    return output("Reply TTL=128 " + "x".repeat(3_000));
  };
  const result = await pingHost({ host: "localhost", timeoutMs: 100 }, runner);
  assert.equal(result.echoReplyObserved, true);
  assert.equal((result.output as string).length, 2_048);
  assert.equal(result.truncated, true);
  await assert.rejects(() => pingHost({ host: "localhost & whoami" }, runner));
  assert.equal(calls, 1);
  assert.equal((await pingHost({ host: "localhost" }, async () => output("Destination host unreachable."))).echoReplyObserved, false);
  assert.equal((await pingHost({ host: "localhost" }, async () => output("", { terminationReason: "timeout" }))).code, "TIMEOUT");
});

test("HTTP GET handles success, non-2xx, no redirect, body caps, partial body and absolute timeout", async () => {
  let redirectHits = 0;
  const server = http.createServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, undefined);
    if (request.url === "/hang") return;
    if (request.url === "/partial") { response.write("partial"); return; }
    if (request.url === "/redirect") { response.writeHead(302, { location: "/target" }); response.end(); return; }
    if (request.url === "/target") redirectHits++;
    response.statusCode = request.url === "/bad" ? 503 : 200;
    response.end(request.url === "/large" ? "x".repeat(32_768) : "healthy");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  try {
    assert.equal((await httpHealthCheck({ url: base })).healthy, true);
    const bad = await httpHealthCheck({ url: base + "/bad" });
    assert.equal(bad.statusCode, 503); assert.equal(bad.healthy, false); assert.equal(bad.ok, true);
    assert.equal((await httpHealthCheck({ url: base + "/redirect" })).statusCode, 302);
    assert.equal(redirectHits, 0);
    const capped = await httpHealthCheck({ url: base + "/large", maxBodyBytes: 33 });
    assert.equal(capped.bodyBytes, 33); assert.equal(capped.truncated, true);
    assert.equal((capped.bodyPreview as string).length, 33);
    assert.equal((await httpHealthCheck({ url: base, maxBodyBytes: 0 })).bodyPreview, "");
    assert.equal((await httpHealthCheck({ url: base + "/hang", timeoutMs: 100 })).code, "TIMEOUT");
    const partial = await httpHealthCheck({ url: base + "/partial", timeoutMs: 100 });
    assert.equal(partial.code, "TIMEOUT"); assert.equal(partial.bodyPreview, "partial"); assert.equal(partial.truncated, true);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("MCP advertises six read-only tools and rejects unknown keys at protocol boundary", async () => {
  const server = new McpServer({ name: "diagnostics-test", version: "1" });
  registerDiagnosticTools(server);
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 6);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(Number(tool.inputSchema.properties?.timeoutMs && (tool.inputSchema.properties.timeoutMs as { maximum: number }).maximum) <= 10_000);
    }
    const invalid = await client.callTool({ name: "ping_host", arguments: { host: "localhost", command: "whoami" } });
    assert.equal(invalid.isError, true);
    const valid = await client.callTool({ name: "resolve_dns", arguments: { hostname: "127.0.0.1" } });
    assert.equal(valid.isError, false);
  } finally { await client.close(); await server.close(); }
});

test("shared process runner enforces timeout/output cap and treats shell characters as literal args", async () => {
  const literal = "a & whoami | echo injected > file; $(whoami)";
  const result = await runBoundedProcess(process.execPath, ["-e", "process.stdout.write(process.argv[1])", literal], { timeoutMs: 2_000, maxStdoutBytes: 1_024 });
  assert.equal(result.stdout, literal);
  const timeout = await runBoundedProcess(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], { timeoutMs: 100 });
  assert.equal(timeout.terminationReason, "timeout");
  const capped = await runBoundedProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000))"], { timeoutMs: 2_000, maxStdoutBytes: 32 });
  assert.equal(capped.terminationReason, "output_limit");
  assert.ok(Buffer.byteLength(capped.stdout) <= 32);
});

test("native Windows listener probe includes IPv6 and preserves listeners when process identity is denied", { skip: process.platform !== "win32" }, async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "::1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const listed = await listListeningPorts({ port, family: "ipv6", timeoutMs: 5_000 });
    assert.equal(listed.ok, true);
    assert.ok((listed.listeners as Array<{ pid: number }>).some((item) => item.pid === process.pid));
    const owner = await inspectPortOwner({ port, timeoutMs: 5_000 });
    const own = (owner.listeners as Array<{ pid: number; processName: string | null; identityStatus: string }>).find((item) => item.pid === process.pid);
    assert.ok(own, "Listener evidence must survive identity lookup failure");
    assert.equal(owner.ok, true);
    assert.equal(owner.complete, true);
    if (owner.identityComplete) {
      assert.equal(own.processName, "node.exe");
      assert.equal(own.identityStatus, "observed");
    } else {
      // Sandboxed Windows can allow netstat but deny tasklist/WMI. Fail visibly, retain no guessed name.
      assert.equal(owner.identityCode, "COMMAND_FAILED");
      assert.equal(owner.partial, true);
      assert.equal(own.processName, null);
      assert.equal(own.identityStatus, "unavailable");
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("diagnostics concurrency cap is shared across MCP sessions and releases after completion", async (t) => {
  let started = 0;
  let allStarted!: () => void;
  const ready = new Promise<void>((resolve) => { allStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(Resolver.prototype, "resolve4", async () => {
    if (++started === DIAGNOSTIC_LIMITS.maxConcurrent) allStarted();
    await gate; return ["127.0.0.1"];
  });
  const pairs = await Promise.all([1, 2].map(async () => {
    const server = new McpServer({ name: "bounded-test", version: "1" });
    registerDiagnosticTools(server);
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    return { server, client };
  }));
  try {
    const pending = Array.from({ length: DIAGNOSTIC_LIMITS.maxConcurrent }, () => pairs[0].client.callTool({
      name: "resolve_dns", arguments: { hostname: "example.com", family: "ipv4" },
    }));
    await ready;
    const blocked = await pairs[1].client.callTool({ name: "resolve_dns", arguments: { hostname: "127.0.0.1" } });
    assert.equal((blocked.structuredContent as Record<string, unknown>).code, "DIAGNOSTICS_BUSY");
    release(); await Promise.all(pending);
    const resumed = await pairs[1].client.callTool({ name: "resolve_dns", arguments: { hostname: "127.0.0.1" } });
    assert.equal(resumed.isError, false);
  } finally {
    release();
    for (const pair of pairs) { await pair.client.close(); await pair.server.close(); }
  }
});
