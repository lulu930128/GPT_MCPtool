import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerPowerShellApprovalTools } from "../src/powershell-approval/tools.js";
import { createNativeHostTransport } from "../src/powershell-approval/host-transport.js";
import type { HostDiagnostics } from "../src/powershell-approval/host-diagnostics.js";
import type { PowerShellHostPort } from "../src/powershell-approval/host-admission.js";
import type { ReviewStoreDiagnostics } from "../src/powershell-approval/review-runtime.js";
import { createCodexBridgeMcpServer } from "../src/server.js";
import type { BridgeRuntime } from "../src/runtime.js";

const name = "codex_powershell_host_preflight";
const intent = { userIntent: "EXPLICIT_USER_DIAGNOSTIC" };
async function connect(t: TestContext, context?: HostDiagnostics, store?: () => Promise<ReviewStoreDiagnostics>) {
  const server = new McpServer({ name: "diagnostic-fixture", version: "1" });
  registerPowerShellApprovalTools(server, undefined, store, context);
  const client = new Client({ name: "diagnostic-fixture-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, call: (tool = name, args: Record<string, unknown> = intent) =>
    client.callTool({ name: tool, arguments: args }) as Promise<CallToolResult> };
}
const forbiddenPort = new Proxy({} as PowerShellHostPort, { get() { assert.fail("Host authority accessed"); } });

test("one explicit effectful diagnostic rejects all candidate/authority inputs before invocation", async t => {
  let calls = 0;
  const transport = { preflight: async (...args: unknown[]) => { assert.deepEqual(args, []); calls++; return { code: "BLOCKED_PLATFORM_CAPABILITY" }; },
    status: () => ({ code: "NOT_DEPLOYED", active: false, closed: false, authorization: "BLOCKED_PLATFORM_CAPABILITY",
      preflight: { code: "NOT_CHECKED", observedAt: null } }) };
  const f = await connect(t, { transport });
  const listed = (await f.client.listTools()).tools, tool = listed.find(tool => tool.name === name)!;
  assert.equal(listed.filter(tool => tool.name === name).length, 1);
  assert.equal(tool._meta, undefined);
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.equal(tool.inputSchema.additionalProperties, false);
  for (const input of [{}, { userIntent: "AUTO" }, ...["script", "args", "review", "requestId", "Grant", "Run", "command", "accepted", "transport"].map(key => ({ ...intent, [key]: "forbidden" }))])
    assert.equal((await f.call(name, input)).isError, true);
  assert.equal(calls, 0);
  const result = await f.call();
  assert.equal(calls, 1); assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.productionEnabled, false);
  assert.equal(result.structuredContent?.executionDispatched, false);
  assert.equal(result.structuredContent?.createsGrant, false);
  assert.equal(result.structuredContent?.authenticatedOwner, "UNVERIFIED");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
});

test("unavailable, missing installed binding and closed transport never reach HostPort", async t => {
  const missing = await connect(t);
  assert.equal((await missing.call()).structuredContent?.code, "HOST_TRANSPORT_UNAVAILABLE");
  const transport = createNativeHostTransport(forbiddenPort), f = await connect(t, { transport });
  const status = (await f.call("codex_powershell_status", {})).structuredContent as any;
  assert.equal(status.nativeTransport.code, "NOT_CHECKED");
  assert.equal(status.nativeTransport.checkState, "NOT_CHECKED");
  assert.deepEqual(status.externalBlockers, ["HOST_READINESS_NOT_CHECKED"]);
  assert.equal(status.separateModes.CODEX_DERIVED, "FAILURE_ATTRIBUTION_UNVERIFIED");
  assert.equal(status.separateModes.ADMIN, "BLOCKED_AWAITING_LOCAL_UAC");
  assert.equal(status.installedRuntime.binding, "ABSENT");
  assert.equal((await f.call()).structuredContent?.code, "NOT_DEPLOYED");
  await transport.close();
  assert.equal((await f.call()).structuredContent?.code, "HOST_TRANSPORT_CLOSED");
  assert.equal(transport.status().active, false);
});

test("cached preflight success never projects a verified current owner or empty blockers", async t => {
  const f = await connect(t, { transport: {
    preflight: async () => { assert.fail("passive status must not probe"); },
    status: () => ({ code: "HOST_READY", active: false, closed: false, authorization: "AUTHENTICATED_DIRECT_REQUEST",
      preflight: { code: "HOST_READY", observedAt: "2026-10-23T00:00:00.000Z" } }),
  } });
  const status = (await f.call("codex_powershell_status", {})).structuredContent as any;
  assert.equal(status.nativeTransport.checkState, "SUCCEEDED");
  assert.equal(status.nativeTransport.provesCurrentReadiness, false);
  assert.equal(status.authenticatedOwner, "UNVERIFIED");
  assert.equal(status.normalExecution.currentHostVerified, false);
  assert.deepEqual(status.externalBlockers, ["CURRENT_HOST_UNVERIFIED"]);
});

test("status is passive and separates source, cached observation, binding, owner and durable Store", async t => {
  let preflights = 0;
  const observation = { code: "BLOCKED_PLATFORM_CAPABILITY", observedAt: "2026-10-16T00:00:00.000Z" };
  const context: HostDiagnostics = { installedBinding: { activationReady: true, secretPath: "PRIVATE-PATH" } as HostDiagnostics["installedBinding"],
    transport: { preflight: async () => { preflights++; throw new Error("must not invoke"); },
      status: () => ({ code: "RECEIPT_RECORDED", active: false, closed: false, authorization: "BLOCKED_PLATFORM_CAPABILITY", preflight: observation }) } };
  const store: ReviewStoreDiagnostics = { startup: { status: "OPEN", errorCode: null, source: "CACHE_ON_STARTUP" },
    current: { observation: "LIVE_METADATA_ONLY", observedAt: observation.observedAt, lifecycle: "OPEN", presence: "PRESENT",
      owner: "THIS_INSTANCE", recovery: "CLOSE_OWNER_NORMALLY" }, automaticRecovery: false, recoveryAuthorization: "VERIFY_STALE_THEN_SEPARATE_AUTHORIZATION" };
  const f = await connect(t, context, async () => store);
  for (let i = 0; i < 2; i++) {
    const result = await f.call("codex_powershell_status", {}), data = result.structuredContent as any;
    assert.equal(data.deployment, "AUTHENTICATED_DIRECT_REQUEST_REQUIRED");
    assert.equal(data.sourceDeclaration.readiness.evidence, "SOURCE_DECLARATION");
    assert.equal(data.host.evidence, "SOURCE_DECLARATION");
    assert.equal(data.installedRuntime.binding, "PRESENT");
    assert.equal(data.installedRuntime.currentInstallation, "NOT_PROBED");
    assert.equal(data.authenticatedOwner, "UNVERIFIED");
    assert.equal(data.nativeTransport.code, observation.code);
    assert.equal(data.nativeTransport.checkState, "FAILED");
    assert.deepEqual(data.externalBlockers, [observation.code]);
    assert.equal(data.nativeTransport.observedAt, observation.observedAt);
    assert.equal(data.nativeTransport.provesCurrentReadiness, false);
    assert.deepEqual(data.reviewStore, store);
    assert.deepEqual(data.executionPolicy, { NORMAL: "AUTHENTICATED_DIRECT_REQUEST", ADMIN: "OFF" });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-PATH|RECEIPT_RECORDED/);
  }
  assert.equal(preflights, 0);
});

test("transient/unknown native results and storage errors are bounded without raw text", async t => {
  for (const code of ["HOST_TRANSPORT_BUSY", "HOST_PREFLIGHT_TIMEOUT", "secret-output".repeat(10000)]) {
    const f = await connect(t, { transport: { preflight: async () => ({ code }), status: () => { throw new Error("PRIVATE-PATH"); } } },
      async () => { throw new Error("PRIVATE-STORE"); });
    const result = await f.call();
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.code, code.startsWith("secret") ? "HOST_TRANSPORT_UNKNOWN" : code);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
    assert.doesNotMatch(JSON.stringify(result), /secret-output|PRIVATE/);
    assert.deepEqual((await f.call("codex_powershell_status", {})).structuredContent?.reviewStore, { availability: "UNAVAILABLE" });
  }
  const f = await connect(t, { transport: { preflight: async () => { throw new Error("PRIVATE-EXCEPTION"); },
    status: () => { throw new Error("PRIVATE-EXCEPTION"); } } });
  assert.equal((await f.call()).structuredContent?.code, "HOST_TRANSPORT_UNAVAILABLE");
});

test("runtime construction has no implicit preflight and tool adapter has no execution capability", async () => {
  const runtime = await readFile("src/runtime.ts", "utf8");
  assert.doesNotMatch(runtime, /\.preflight\(/);
  const tools = await readFile("src/powershell-approval/tools.ts", "utf8");
  assert.doesNotMatch(tools, /\.inspect\(|\.admit\(|\.claim\(|\.dispatch\(|\.spawn\(/);
});

test("real server registers one diagnostic and one receipt, wiring only the runtime transport", async t => {
  const transport = createNativeHostTransport(forbiddenPort);
  t.after(() => transport.close());
  const forbidden = new Proxy({}, { get() { assert.fail("Unrelated runtime capability accessed"); } });
  const runtime = { powershellHostTransport: transport, config: {}, store: forbidden, controller: forbidden,
    conversations: forbidden, textBundles: forbidden, privilegedBroker: forbidden, widgetHtml: "" } as unknown as BridgeRuntime;
  const server = createCodexBridgeMcpServer(runtime);
  const client = new Client({ name: "real-server-diagnostics", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  for (const tool of [name, "codex_powershell_status", "codex_powershell_receipt"])
    assert.equal(tools.filter(value => value.name === tool).length, 1);
  const diagnostic = await client.callTool({ name, arguments: intent }) as CallToolResult;
  assert.equal(diagnostic.structuredContent?.code, "NOT_DEPLOYED");
  const status = (await client.callTool({ name: "codex_powershell_status", arguments: {} })).structuredContent as any;
  assert.equal(status.nativeTransport.code, "NOT_DEPLOYED");
  assert.ok(status.nativeTransport.observedAt);
});
