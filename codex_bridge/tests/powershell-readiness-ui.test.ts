import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { deploymentStatus } from "../src/powershell-approval/contract.js";
import { registerPowerShellApprovalTools } from "../src/powershell-approval/tools.js";

// Run from the component root; no live dist, private state, controller or external IO.
const html = readFileSync("web/codex-console.html", "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
const jobId = "11111111-1111-4111-8111-111111111111";
const otherJobId = "22222222-2222-4222-8222-222222222222";
const job = { id: jobId, projectId: "p", dataClassification: "personal", directActionHistoryEligible: true };
const preview = {
  availability: "AVAILABLE", jobId, executes: false, createsRequest: false, createsGrant: false, requiresPassword: false,
  executionPolicy: { NORMAL: "OFF", ADMIN: "OFF" },
  commandFailureDiagnostics: { evidenceStatus: "OBSERVED_NONZERO", scope: "bounded_saved_conversation", cause: "UNKNOWN",
    permissionAttribution: "UNVERIFIED", truncated: true,
    failures: [{ jobId, observedStatus: "completed", evidenceStatus: "OBSERVED_NONZERO", exitCode: 7 }] },
};
const names = ["openOperatorStatus", "loadOperatorStatus", "renderOperatorStatus", "loadPowerShellReceipt", "renderPowerShellReceipt", "operatorPart", "statusCard", "statusRows",
  "statusDetails", "usageRateLimits", "unixTime", "formatTime", "metric", "escapeHtml", "escapeAttr", "formatBytes"];
const source = names.map((name) => {
  const start = script.indexOf("        function " + name + "(");
  assert.ok(start >= 0, name);
  const next = script.slice(start + 1).search(/\n        (?:(?:async )?function |bridgeReady\.then)/);
  assert.ok(next >= 0, name);
  return script.slice(start, start + 1 + next);
}).join("\n");

function fixture(selectedJob: any = job, configured = true, respond?: (name: string, args: any) => any) {
  const nodes = new Map<string, any>();
  const element = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { open: false, innerHTML: "", textContent: "", disabled: false,
      showModal() { this.open = true; }, setAttribute() {}, querySelectorAll: () => [] });
    return nodes.get(id);
  };
  const calls: { name: string; args: any; options: any }[] = [];
  const state: any = { selectedProjectId: "p", selectedJob, displayMode: "fullscreen", operatorRead: null };
  const scope: any = { state, $: element, currentProject: () => ({ name: "測試專案" }), isOperableProjectId: () => configured,
    callTool: async (name: string, args: any, options: any) => {
      calls.push({ name, args, options });
      if (respond) return respond(name, args);
      return name === "codex_powershell_status" ? deploymentStatus() : name === "codex_powershell_job_preview" ? preview : {};
    } };
  new Script(source + "\nglobalThis.api = { openOperatorStatus, loadOperatorStatus, renderOperatorStatus, loadPowerShellReceipt, renderPowerShellReceipt };").runInNewContext(scope);
  const api = scope.api as { openOperatorStatus: () => Promise<void>; loadOperatorStatus: (force: boolean) => Promise<void>; renderOperatorStatus: () => void;
    loadPowerShellReceipt: () => Promise<void>; renderPowerShellReceipt: (receipt: unknown, requestId: string) => string };
  return { ...api, state, element, calls, rendered: () => element("#operator-content").innerHTML as string };
}

test("configured NORMAL shows local confirmation while malformed ON claims stay unavailable", async () => {
  const status = { enabled: true, deployment: "LOCAL_CONFIRMATION_REQUIRED", protectedHost: "UNVERIFIED",
    NORMAL: "LOCAL_HOST_CONFIRMATION_REQUIRED", ADMIN: "BLOCKED_AWAITING_LOCAL_UAC",
    executionPolicy: { NORMAL: "PER_REQUEST_LOCAL_CONFIRMATION", ADMIN: "OFF" },
    normalExecution: { configured: true, currentHostVerified: false, consent: "WINDOWS_LOCAL_HOST_EACH_REQUEST" } };
  const f = fixture(job, true, name => name === "codex_powershell_status" ? status : preview);
  await f.openOperatorStatus(); assert.match(f.rendered(), /NORMAL 每筆本機確認 · ADMIN OFF/);
  assert.match(f.rendered(), /目前 Host 身分仍須每次 Native IPC 驗證/);
  for (const invalid of [{ ...status, ADMIN: "ON" }, { ...status, normalExecution: { ...status.normalExecution, currentHostVerified: true } }]) {
    const bad = fixture(job, true, name => name === "codex_powershell_status" ? invalid : preview);
    await bad.openOperatorStatus(); assert.doesNotMatch(bad.rendered(), /NORMAL 每筆本機確認 · ADMIN OFF/);
  }
});

test("existing MCP status and job preview schemas are strict and read-only, with source-only gates", async (t) => {
  const server = new McpServer({ name: "readiness-test", version: "1" });
  registerPowerShellApprovalTools(server); // No snapshot reader or execution capability injected.
  const client = new Client({ name: "readiness-test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = (await client.listTools()).tools;
  assert.deepEqual(listed.map((tool) => tool.name).sort(), ["codex_powershell_host_preflight", "codex_powershell_job_preview", "codex_powershell_preview", "codex_powershell_status"]);
  assert.deepEqual(listed.find((tool) => tool.name === "codex_powershell_host_preflight")!.annotations,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  for (const name of ["codex_powershell_status", "codex_powershell_job_preview"]) {
    const tool = listed.find((entry) => entry.name === name)!;
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties || {}), name.endsWith("status") ? [] : ["jobId"]);
  }
  const response = await client.callTool({ name: "codex_powershell_status", arguments: {} });
  assert.deepEqual(response.structuredContent, {
    ...deploymentStatus(), deployment: "EXECUTION_DISABLED", sourceDeclaration: deploymentStatus(),
    host: { enabled: false, authority: "BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED",
      humanApproval: "LOCAL_HOST_CONFIRMATION_REQUIRED", reviewOpinionIsAuthorization: false,
      authenticatedReceiver: "SOURCE_IMPLEMENTED_NOT_DEPLOYED", protectedInstallation: "NOT_VERIFIED",
      normalRunner: "LOCAL_CONFIRMATION_AND_DURABLE_CLAIM", admin: "BLOCKED_AWAITING_LOCAL_UAC",
      journal: "EXISTING_APPROVAL_STORE_ONLY", automaticRetry: false, evidence: "SOURCE_DECLARATION" },
    installedRuntime: { evidence: "LOADED_RUNTIME_BINDING", binding: "ABSENT",
      activationAtStartup: "NOT_VERIFIED", currentInstallation: "NOT_PROBED" },
    authenticatedOwner: "UNVERIFIED",
    nativeTransport: { available: false, active: null, closed: null, observation: "CACHED_PREFLIGHT_ONLY",
      code: "HOST_TRANSPORT_UNAVAILABLE", observedAt: null, provesCurrentReadiness: false },
    externalBlockers: ["BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED", "LOCAL_HOST_CONFIRMATION_REQUIRED", "BLOCKED_AWAITING_LOCAL_UAC"],
    normalExecution: { entry: "codex_powershell_normal_execute", consent: "WINDOWS_LOCAL_HOST_EACH_REQUEST",
      configured: false, remoteHumanAttestation: "NOT_REQUIRED_FOR_LOCAL_CONFIRMATION", currentHostVerified: false,
      outputLimitBytes: 16384, outputRetentionMs: 600000, automaticRetry: false },
    bounds: { timeoutMs: 60_000, frameBytes: 131028, concurrency: 1, automaticRetry: false },
    reviewStore: { availability: "UNAVAILABLE" },
  });
  assert.equal(response.structuredContent?.enabled, false);
  assert.equal(response.structuredContent?.protectedHost, "UNVERIFIED");
  assert.deepEqual(response.structuredContent?.executionPolicy, { NORMAL: "OFF", ADMIN: "OFF" });
  const ui = fixture(job, true, (name) => name === "codex_powershell_status" ? response.structuredContent
    : name === "codex_powershell_job_preview" ? preview : {});
  await ui.openOperatorStatus();
  assert.match(ui.rendered(), /EXECUTION_DISABLED · NORMAL\/ADMIN OFF/);
  assert.match(ui.rendered(), /OS／Host 驗證 UNVERIFIED/);
  assert.doesNotMatch(ui.rendered(), /工具不可用或回傳不符預期|NORMAL\/ADMIN ON/);
  assert.deepEqual(deploymentStatus().readiness, { evidence: "SOURCE_DECLARATION", appOnlyReview: "NATIVE_CODEX_ONLY",
    passwordChannel: "UNVERIFIED", windowsHost: "NOT_DEPLOYED", osAttestation: "UNVERIFIED" });
  assert.equal(deploymentStatus().enabled, false);
  assert.deepEqual(deploymentStatus().executionPolicy, { NORMAL: "OFF", ADMIN: "OFF" });
  const unavailable = await client.callTool({ name: "codex_powershell_job_preview", arguments: { jobId } });
  assert.equal((unavailable.structuredContent as Record<string, unknown>).availability, "UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(response.structuredContent), /scriptSnapshot|token|credential|[A-Z]:\\/i);
});

test("drawer source compiles and permits only readonly status, preview and request receipt calls", () => {
  new Script(script);
  const drawer = source.slice(source.indexOf("        function openOperatorStatus"), source.indexOf("        function operatorPart"));
  assert.deepEqual(Array.from(drawer.matchAll(/"(codex_[a-z_]+)"/g), (match) => match[1]),
    ["codex_usage_status", "codex_runtime_status", "codex_inventory", "codex_powershell_status", "codex_powershell_job_preview", "codex_powershell_receipt"]);
  assert.doesNotMatch(source, /setInterval|setTimeout|localStorage|sessionStorage|fetch\(|navigator\.|<input|<button|codex_approval_decide|codex_powershell_(?:request|approve|execute|preview)\b/i);
  assert.equal((script.match(/loadOperatorStatus\(/g) || []).length, 3); // Definition, open, manual refresh only.
  assert.match(script, /\$\("#refresh-operator"\)\.addEventListener\("click", \(\) => loadOperatorStatus\(true\)\)/);
});

test("reads only on open or manual refresh, coalesces requests and keeps bounded evidence non-executable", async () => {
  const ui = fixture();
  await ui.loadOperatorStatus(false);
  assert.equal(ui.calls.length, 0);
  const first = ui.openOperatorStatus();
  assert.equal(ui.loadOperatorStatus(true), first);
  await first;
  assert.equal(ui.calls.length, 5);
  assert.ok(ui.calls.every((call) => call.options.update === false));
  assert.deepEqual(Object.keys(ui.calls[4]!.args), ["jobId"]);
  assert.match(ui.rendered(), /NOT_DEPLOYED · NORMAL\/ADMIN OFF/);
  assert.match(ui.rendered(), /Source 固定宣告；非 Live OS／Host attestation/);
  assert.match(ui.rendered(), /僅既有 Codex 核准介面有 App-only 隔離/);
  assert.match(ui.rendered(), /密碼端到端安全/);
  assert.match(ui.rendered(), /OBSERVED_NONZERO · 1 筆；Exit 7/);
  assert.match(ui.rendered(), /UNKNOWN／UNVERIFIED；非零 Exit 不等於已證實權限拒絕/);
  assert.match(ui.rendered(), /已縮限，非完整清單/);
  ui.renderOperatorStatus();
  await ui.loadOperatorStatus(true);
  assert.equal(ui.calls.length, 5);
  ui.state.operatorRead.startedAt -= 6000;
  await ui.loadOperatorStatus(true);
  assert.equal(ui.calls.length, 10);
});

for (const deployment of ["NOT_DEPLOYED", "EXECUTION_DISABLED"]) {
  test(`disabled readiness accepts exact ${deployment} with fixed informational labels`, async () => {
    for (const executionPolicy of [undefined, { NORMAL: "OFF", ADMIN: "OFF" }]) {
      const ui = fixture(job, true, (name) => name === "codex_powershell_status"
        ? { ...deploymentStatus(), deployment, executionPolicy, shell: "<img src=x onerror=unsafe>", path: "C:\\PRIVATE_PATH" }
        : name === "codex_powershell_job_preview" ? preview : {});
      await ui.openOperatorStatus();
      assert.ok(ui.rendered().includes(`<h3>${deployment} · NORMAL/ADMIN OFF</h3>`));
      assert.match(ui.rendered(), /狀態來源 · codex_powershell_status<\/dt><dd>Source 固定宣告；非 Live OS／Host attestation/);
      assert.match(ui.rendered(), /不可執行；不收集密碼、不建立請求或授權/);
      assert.match(ui.rendered(), /OS／Host 驗證 UNVERIFIED/);
      assert.ok(ui.rendered().includes(deployment === "NOT_DEPLOYED" ? "未部署功能的唯讀準備度預覽" : "停用執行功能的唯讀準備度預覽"));
      assert.doesNotMatch(ui.rendered(), /工具不可用或回傳不符契約|<img|unsafe|PRIVATE_PATH/);
    }
  });

  test(`disabled readiness rejects malformed and ON claims for ${deployment}`, async () => {
    for (const patch of [
      { deployment: deployment.toLowerCase() }, { deployment: deployment + " " },
      { deployment: "<img src=x onerror=unsafe>" }, { deployment: [deployment] },
      { enabled: true }, { enabled: "false" }, { protectedHost: "VERIFIED" },
      { NORMAL: "ON" }, { ADMIN: "ON" },
      { executionPolicy: null }, { executionPolicy: {} },
      { executionPolicy: { NORMAL: "ON", ADMIN: "OFF" } },
      { executionPolicy: { NORMAL: "OFF", ADMIN: "ON" } },
    ]) {
      const ui = fixture(job, true, (name) => name === "codex_powershell_status"
        ? { ...deploymentStatus(), deployment, ...patch }
        : name === "codex_powershell_job_preview" ? preview : {});
      await ui.openOperatorStatus();
      assert.match(ui.rendered(), /狀態來源 · codex_powershell_status<\/dt><dd>工具不可用或回傳不符契約 · UNVERIFIED/);
      assert.match(ui.rendered(), /Windows Host<\/dt><dd>UNVERIFIED/);
      assert.doesNotMatch(ui.rendered(), /Source 固定宣告|<img|unsafe|NORMAL\/ADMIN ON/);
    }
  });
}

test("ineligible selections never call job preview; global status survives unconfigured projects", async () => {
  for (const selected of [null, { ...job, dataClassification: "company_approved" }, { ...job, dataClassification: undefined },
    { ...job, directActionHistoryEligible: false }, { ...job, directActionHistoryEligible: undefined },
    { ...job, source: "local" }, { ...job, readOnly: true }, { ...job, projectId: "other" }, { ...job, id: "invalid" }]) {
    const ui = fixture(selected);
    await ui.openOperatorStatus();
    assert.equal(ui.calls.some((call) => call.name === "codex_powershell_job_preview"), false);
    assert.match(ui.rendered(), /未讀取：需選取 allowlist/);
  }
  const ui = fixture(job, false);
  await ui.openOperatorStatus();
  assert.deepEqual(ui.calls.map((call) => call.name), ["codex_usage_status", "codex_powershell_status"]);
});

test("tool failures and malformed responses stay independently unavailable without raw error disclosure", async () => {
  for (const failedTool of ["codex_powershell_status", "codex_powershell_job_preview"]) {
    for (const mode of ["throw", "missing", "malformed", "conflictingPolicy"]) {
      const ui = fixture(job, true, (name) => {
        if (name === failedTool) {
          if (mode === "throw") throw new Error("DO_NOT_RENDER_BACKEND_DETAILS");
          if (mode === "conflictingPolicy") return { ...(name.endsWith("status") ? deploymentStatus() : preview), executionPolicy: { NORMAL: "ON", ADMIN: "OFF" } };
          return mode === "missing" ? undefined : { enabled: true, deployment: "DEPLOYED" };
        }
        return name === "codex_powershell_status" ? deploymentStatus() : name === "codex_powershell_job_preview" ? preview : {};
      });
      await ui.openOperatorStatus();
      assert.match(ui.rendered(), /工具不可用或回傳不符契約 · UNVERIFIED/);
      assert.match(ui.rendered(), /NOT_DEPLOYED · NORMAL\/ADMIN OFF/);
      assert.doesNotMatch(ui.rendered(), /DO_NOT_RENDER_BACKEND_DETAILS|\bDEPLOYED\b/);
      if (failedTool.endsWith("status")) assert.match(ui.rendered(), /OBSERVED_NONZERO/);
      else assert.match(ui.rendered(), /Source 固定宣告/);
    }
  }
});

test("old status schemas and absent/nonzero-invalid evidence never imply readiness or permission proof", async () => {
  const { readiness: _, executionPolicy: __, ...oldStatus } = deploymentStatus();
  for (const evidence of [undefined, { ...preview.commandFailureDiagnostics, evidenceStatus: "UNVERIFIED", failures: [] },
    ...[0, NaN, 1.5].map((exitCode) => ({ ...preview.commandFailureDiagnostics, failures: [{ ...preview.commandFailureDiagnostics.failures[0], exitCode }] }))]) {
    const ui = fixture(job, true, (name) => name === "codex_powershell_status" ? oldStatus : name === "codex_powershell_job_preview"
      ? { ...preview, commandFailureDiagnostics: evidence, unrecognized: "DO_NOT_RENDER_EXTRA_FIELDS" } : {});
    await ui.openOperatorStatus();
    assert.match(ui.rendered(), /App-only 審核準備<\/dt><dd>UNVERIFIED/);
    assert.match(ui.rendered(), /Windows Host<\/dt><dd>UNVERIFIED/);
    assert.doesNotMatch(ui.rendered(), /OBSERVED_NONZERO|DO_NOT_RENDER_EXTRA_FIELDS/);
  }
});

test("manual selection changes bypass old job cache and stale responses cannot replace the new read", async () => {
  let finishOld!: (value: unknown) => void;
  const ui = fixture(job, true, (name, args) => {
    if (name === "codex_powershell_status") return deploymentStatus();
    if (name === "codex_powershell_job_preview") return args.jobId === jobId
      ? new Promise((resolve) => { finishOld = resolve; }) : { ...preview, jobId: otherJobId, commandFailureDiagnostics: { ...preview.commandFailureDiagnostics,
        failures: [{ ...preview.commandFailureDiagnostics.failures[0], jobId: otherJobId }] } };
    return {};
  });
  const old = ui.openOperatorStatus();
  ui.state.selectedJob = { ...job, id: otherJobId };
  await ui.loadOperatorStatus(true);
  finishOld(preview);
  await old;
  assert.equal(ui.state.operatorRead.jobId, otherJobId);
  assert.match(ui.rendered(), new RegExp(otherJobId));
  assert.doesNotMatch(ui.rendered(), new RegExp(jobId));
});

test("mismatched job preview remains unavailable even when the response claims success", async () => {
  const ui = fixture(job, true, (name) => name === "codex_powershell_status" ? deploymentStatus()
    : name === "codex_powershell_job_preview" ? { ...preview, jobId: otherJobId } : {});
  await ui.openOperatorStatus();
  assert.match(ui.rendered(), /工具不可用或回傳不符契約 · UNVERIFIED/);
  assert.doesNotMatch(ui.rendered(), /OBSERVED_NONZERO/);
});

test("request lookup works without a job, is single-flight and rejects malformed or mismatched results", async () => {
  let finish!: (value: unknown) => void;
  const ui = fixture(null, false, () => new Promise(resolve => { finish = resolve; }));
  ui.element("#powershell-request-id").value = "not-a-uuid";
  await ui.loadPowerShellReceipt(); assert.equal(ui.calls.length, 0);
  ui.element("#powershell-request-id").value = jobId;
  const pending = ui.loadPowerShellReceipt(), duplicate = ui.loadPowerShellReceipt();
  assert.equal(pending, duplicate); assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0]!.name, "codex_powershell_receipt");
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[0]!.args)), { requestId: jobId });
  const receipt = { availability: "AVAILABLE", requestId: jobId, receiptId: otherJobId, origin: "DIRECT",
    evidence: "SAVED_JOURNAL_ONLY", hostAcceptance: "UNVERIFIED", productionEnabled: false, automaticResume: false, retryAllowed: false,
    kind: "REVIEW_ONLY_NONEXECUTABLE", reviewOpinion: { evidence: "REVIEW_ONLY_NONEXECUTABLE", effectiveState: "ACCEPTED" },
    osExecutionReceipt: null, correlation: { request: "MATCHED_CANONICAL_REQUEST", completion: "UNVERIFIED" } };
  finish(receipt); await pending;
  const rendered = ui.element("#powershell-receipt-result").innerHTML;
  assert.match(rendered, /ACCEPTED · NONEXECUTABLE/); assert.match(rendered, /未有 OS 執行收據 · UNVERIFIED/);
  assert.equal(ui.element("#read-powershell-receipt").disabled, false);
  for (const patch of [{ requestId: otherJobId }, { productionEnabled: true }, { retryAllowed: true },
    { hostAcceptance: "VERIFIED" }, { reviewOpinion: { effectiveState: "<script>unsafe</script>" } }]) {
    const text = ui.renderPowerShellReceipt({ ...receipt, ...patch }, jobId);
    assert.match(text, /收據無法確認 · UNVERIFIED/); assert.doesNotMatch(text, /<script>|ACCEPTED/);
  }
  const execution = { ...receipt, kind: "PRODUCTION", state: "UNKNOWN", reviewOpinion: null,
    osExecutionReceipt: { requestId: jobId, receiptId: otherJobId, outcome: "UNKNOWN", exitCode: null, verification: "UNVERIFIED" } };
  assert.match(ui.renderPowerShellReceipt(execution, jobId), /UNKNOWN · Exit null · UNVERIFIED/);
  assert.match(ui.renderPowerShellReceipt({ ...execution, osExecutionReceipt: { ...execution.osExecutionReceipt, requestId: otherJobId } }, jobId), /收據無法確認/);
});

test("receipt lookup does not replace another entered request with a late response or retry a failure", async () => {
  let finish!: (value: unknown) => void;
  const ui = fixture(null, false, () => new Promise(resolve => { finish = resolve; }));
  ui.element("#powershell-request-id").value = jobId;
  const pending = ui.loadPowerShellReceipt();
  ui.element("#powershell-request-id").value = otherJobId;
  finish({ requestId: jobId }); await pending;
  assert.equal(ui.element("#powershell-receipt-result").innerHTML, "");
  const failed = fixture(null, false, () => { throw new Error("private failure"); });
  failed.element("#powershell-request-id").value = jobId;
  await failed.loadPowerShellReceipt();
  assert.equal(failed.calls.length, 1);
  assert.match(failed.element("#powershell-receipt-result").textContent, /UNVERIFIED/);
  assert.doesNotMatch(failed.element("#powershell-receipt-result").textContent, /private failure/);
});
