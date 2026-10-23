import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { previewJobFailure, type JobPreviewReader } from "../src/powershell-approval/job-preview.js";
import { createCodexBridgeMcpServer } from "../src/server.js";
import type { BridgeRuntime } from "../src/runtime.js";

const jobId = "6bbd034a-fbb7-4714-ad7a-acb9c3b36942";
const otherId = "2833303d-c720-4c22-9875-4aad6e85c843";
const sensitive = "private-path sensitive-command secret-value raw-stderr";
function fixture() {
  return { id: jobId, turnId: "turn-1", dataClassification: "personal" as const, directActionHistoryEligible: true,
    command: sensitive, env: sensitive, stderr: sensitive, title: sensitive,
    commandFailureDiagnostics: { evidenceStatus: "OBSERVED_NONZERO" as const,
      cause: "UNKNOWN" as const, permissionAttribution: "UNVERIFIED" as const,
      scope: "bounded_saved_conversation" as const, scannedItems: 1, truncated: false,
      failures: [{ jobId, turnId: "turn-1", itemId: "item-1", exitCode: 5,
        observedStatus: "completed" as const, evidenceStatus: "OBSERVED_NONZERO" as const,
        cause: "UNKNOWN" as const, permissionAttribution: "UNVERIFIED" as const,
        command: sensitive, cwd: sensitive, env: sensitive, stderr: sensitive }] } };
}
const reader = (snapshot: unknown): JobPreviewReader => async () => snapshot as Awaited<ReturnType<JobPreviewReader>>;
function available(result: Awaited<ReturnType<typeof previewJobFailure>>) {
  assert.ok("commandFailureDiagnostics" in result);
  return result;
}

test("nonzero evidence is projected without mutation or sensitive fields; both entrances stay OFF", async () => {
  for (const dataClassification of ["personal", "public"]) {
    const snapshot = { ...fixture(), dataClassification };
    const before = structuredClone(snapshot);
    const result = available(await previewJobFailure({ jobId }, reader(snapshot)));
    assert.deepEqual(snapshot, before);
    assert.deepEqual(result.commandFailureDiagnostics.failures, [{ jobId, turnId: "turn-1", itemId: "item-1",
      exitCode: 5, observedStatus: "completed", evidenceStatus: "OBSERVED_NONZERO",
      cause: "UNKNOWN", permissionAttribution: "UNVERIFIED" }]);
    assert.equal(result.currentTurnId, "turn-1");
    assert.deepEqual(result.executionPolicy, { NORMAL: "OFF", ADMIN: "OFF" });
    assert.doesNotMatch(JSON.stringify(result), /operationPreview|fixture\.marker|scriptSnapshot|scriptSha256|protectedHost|runner/i);
    assert.equal(result.createsRequest, false);
    assert.equal(result.createsGrant, false);
    assert.equal(result.requiresPassword, false);
    assert.equal(result.executes, false);
    assert.equal(result.requiresSeparateHumanReview, true);
    assert.doesNotMatch(JSON.stringify(result), /private-path|sensitive-command|secret-value|raw-stderr|"cwd"|"env"|"command"|"stderr"/);
  }
});

test("current turn metadata does not relabel or discard historical completion evidence", async () => {
  for (const turnId of ["turn-2", undefined, "", "C:\\private-path", "sk-abcdefghijklmnop"]) {
    const snapshot = { ...fixture(), turnId };
    const before = structuredClone(snapshot);
    const result = available(await previewJobFailure({ jobId }, reader(snapshot)));
    assert.equal(result.currentTurnId, turnId === "turn-2" ? "turn-2" : null);
    assert.equal(result.commandFailureDiagnostics.failures[0]?.turnId, "turn-1");
    assert.equal(result.commandFailureDiagnostics.evidenceStatus, "OBSERVED_NONZERO");
    assert.deepEqual(snapshot, before);
    assert.doesNotMatch(JSON.stringify(result), /private-path|sk-abcdefghijklmnop/);
  }
});

test("missing or invalid completion evidence stays UNVERIFIED, never infers a permission cause", async () => {
  const original = fixture().commandFailureDiagnostics;
  for (const diagnostics of [undefined, { ...original, evidenceStatus: "UNVERIFIED", failures: [] },
    ...[0, undefined, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1].map((exitCode) => ({
      ...original, failures: [{ ...original.failures[0], exitCode }] })),
    { ...original, failures: [{ ...original.failures[0], observedStatus: "failed" }] },
    { ...original, failures: [{ ...original.failures[0], observedStatus: "inProgress" }] },
    { ...original, failures: [{ ...original.failures[0], evidenceStatus: "UNVERIFIED" }] },
    { ...original, failures: [{ ...original.failures[0], itemId: "" }] },
    { ...original, failures: [{ ...original.failures[0], turnId: "" }] },
    { ...original, failures: [{ ...original.failures[0], itemId: "sk-abcdefghijklmnop" }] },
    { ...original, failures: [{ ...original.failures[0], turnId: "C:\\private-path" }] }]) {
    const result = available(await previewJobFailure({ jobId }, reader({ ...fixture(), commandFailureDiagnostics: diagnostics })));
    assert.equal(result.commandFailureDiagnostics.evidenceStatus, "UNVERIFIED");
    assert.equal(result.commandFailureDiagnostics.cause, "UNKNOWN");
    assert.equal(result.commandFailureDiagnostics.permissionAttribution, "UNVERIFIED");
    assert.deepEqual(result.commandFailureDiagnostics.failures, []);
  }
});

test("company, unknown classification and ineligible history disclose no individual preview", async () => {
  for (const patch of [{ dataClassification: "company_approved" }, { dataClassification: undefined },
    { directActionHistoryEligible: false }, { directActionHistoryEligible: undefined }]) {
    const result = await previewJobFailure({ jobId }, reader({ ...fixture(), ...patch }));
    assert.equal(result.availability, "UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(result), /item-1|turn-1|6bbd034a|fixture.marker|private-path|company/);
  }
});

test("snapshot and failure identities cannot cross job boundaries", async () => {
  assert.equal((await previewJobFailure({ jobId }, reader({ ...fixture(), id: otherId }))).availability, "UNAVAILABLE");
  const snapshot = fixture();
  snapshot.commandFailureDiagnostics.failures[0]!.jobId = otherId;
  const result = available(await previewJobFailure({ jobId }, reader(snapshot)));
  assert.equal(result.commandFailureDiagnostics.evidenceStatus, "UNVERIFIED");
  assert.deepEqual(result.commandFailureDiagnostics.failures, []);
  assert.ok(!JSON.stringify(result).includes(otherId));
});

test("invalid UUID and additional inputs are rejected before any read", async () => {
  let calls = 0;
  for (const input of [{ jobId: "../private" }, { jobId: "" }, {}, { jobId, command: sensitive }]) {
    const result = await previewJobFailure(input, async () => { calls++; return fixture(); });
    assert.equal(result.availability, "UNAVAILABLE");
  }
  assert.equal(calls, 0);
});

test("missing jobs and failed reads use the same non-disclosing response", async () => {
  const missing = await previewJobFailure({ jobId });
  assert.deepEqual(await previewJobFailure({ jobId }, reader(null)), missing);
  assert.deepEqual(await previewJobFailure({ jobId }, reader(undefined)), missing);
  assert.deepEqual(await previewJobFailure({ jobId }, async () => { throw new Error(sensitive); }), missing);
  assert.deepEqual(await previewJobFailure({ jobId }, reader({ ...fixture(), directActionHistoryEligible: false })), missing);
});

test("real Bridge MCP registration uses only fake snapshot reader and preserves static tools", async (t) => {
  const calls: string[] = [];
  const forbidden = new Proxy({}, { get() { throw new Error("Forbidden capability access"); } });
  const store = new Proxy({ snapshot: async (id: string) => { calls.push(id); return fixture(); } }, {
    get(target, key) { if (key === "snapshot") return target.snapshot; throw new Error("Forbidden store access"); },
  });
  const runtime = { store, controller: forbidden, conversations: forbidden, textBundles: forbidden,
    privilegedBroker: forbidden, widgetHtml: "" } as unknown as BridgeRuntime;
  const server = createCodexBridgeMcpServer(runtime);
  const client = new Client({ name: "readonly-job-preview-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools.filter((tool) => tool.name.startsWith("codex_powershell_"));
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["codex_powershell_host_preflight", "codex_powershell_job_preview", "codex_powershell_normal_execute", "codex_powershell_preview", "codex_powershell_receipt", "codex_powershell_status"]);
  const tool = tools.find((tool) => tool.name === "codex_powershell_job_preview")!;
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.equal(tool.annotations?.destructiveHint, false);
  assert.equal(tool.inputSchema.additionalProperties, false);
  for (const args of [{ jobId: "invalid" }, { jobId, command: sensitive }]) {
    assert.equal((await client.callTool({ name: tool.name, arguments: args })).isError, true);
  }
  await client.callTool({ name: "codex_powershell_status", arguments: {} });
  const receipt = await client.callTool({ name: "codex_powershell_receipt", arguments: { requestId: jobId } });
  assert.equal(receipt.isError, true);
  assert.match(JSON.stringify(receipt.structuredContent), /RECEIPT_SOURCE_UNAVAILABLE/);
  await client.callTool({ name: "codex_powershell_preview", arguments: { artifactId: "fixture.marker.v1", executionMode: "NORMAL" } });
  assert.deepEqual(calls, []);
  const response = await client.callTool({ name: tool.name, arguments: { jobId } });
  assert.notEqual(response.isError, true);
  const content = response.structuredContent as Record<string, unknown>;
  assert.equal(content.availability, "AVAILABLE");
  assert.equal(content.executes, false);
  assert.equal(content.createsRequest, false);
  assert.equal(content.createsGrant, false);
  assert.equal(content.requiresPassword, false);
  assert.equal(content.currentTurnId, "turn-1");
  assert.deepEqual(content.executionPolicy, { NORMAL: "OFF", ADMIN: "OFF" });
  assert.deepEqual(content.commandFailureDiagnostics, available(await previewJobFailure({ jobId }, reader(fixture()))).commandFailureDiagnostics);
  assert.doesNotMatch(JSON.stringify(response), /operationPreview|fixture\.marker|scriptSnapshot|scriptSha256|protectedHost|runner/i);
  assert.deepEqual(calls, [jobId]);
  assert.doesNotMatch(JSON.stringify(response), /private-path|sensitive-command|secret-value|raw-stderr/);
});
