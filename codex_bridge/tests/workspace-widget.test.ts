import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import test from "node:test";

const html = readFileSync(new URL("../../web/codex-console.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
const terminal = new Set(["completed", "failed", "interrupted", "cancelled", "declined"]);
function fixture(names: string[], context: Record<string, any> = {}) {
  const functions = names.map((name) => {
    const start = script.search(new RegExp(`        (?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    const rest = script.slice(start + 1);
    const next = rest.search(/\n        (?:(?:async )?function |bridgeReady\.then)/);
    assert.ok(next >= 0, name);
    return script.slice(start, start + 1 + next);
  }).join("\n");
  const scope: Record<string, any> = { terminal, ...context };
  new Script(functions + "\nglobalThis.api = { " + names.join(",") + " };").runInNewContext(scope);
  return { api: scope.api, scope };
}
const failureHelpers = ["isTechnicalItem", "needsApprovalAttention", "isFailedActivity", "isSuccessfulActivity", "reliableOperationValue", "sameTechnicalOperation", "turnFailurePresentation", "turnWorkCounts", "publicFailureText", "renderCompactFailure"];
const renderHelpers = [...failureHelpers, "escapeHtml", "escapeAttr", "formatTime", "formatBytes", "formatDuration", "projectionStatusLabel", "activityTitle", "activitySubtitle", "activityStatusClass", "activityIcon", "activityBody", "isNarrative", "renderProjectedMessage", "renderConversationItem", "renderApproval", "renderDockWork", "metric"];
const narrative = (id: string, type: string, text = id) => ({ id, type, text, status: "completed" });

test("message rendering uses createdAt, hides invalid/unknown time and identifies other dates", () => {
  const { api } = fixture(renderHelpers);
  const item = { ...narrative("a", "agentMessage"), createdAt: "2026-10-08T01:00:00.000Z", updatedAt: "2030-10-09T01:00:00.000Z" };
  const rendered = api.renderProjectedMessage(item, "a");
  assert.match(rendered, /10\/8/);
  assert.equal(api.renderProjectedMessage({ ...item, updatedAt: "2040-01-01T00:00:00Z" }, "a"), rendered);
  for (const createdAt of [undefined, "invalid"]) {
    const unknown = api.renderProjectedMessage({ ...item, createdAt }, "a");
    assert.match(unknown, /class="message-meta">Codex<\/div>/);
    assert.doesNotMatch(unknown, /Invalid Date|2040|2030/);
  }
});

test("inline keeps the whole last narrative turn, never pairs messages across turns", () => {
  const { api } = fixture([...renderHelpers, "compactConversationEntries", "legacyConversation"]);
  const turns = [
    { turnId: "old", items: [narrative("old-u", "userMessage"), narrative("old-a", "agentMessage")] },
    { turnId: "last", items: [narrative("new-a", "agentMessage")] },
    { turnId: "active", items: [{ id: "cmd", type: "commandExecution", status: "inProgress" }] },
  ];
  let result = api.compactConversationEntries({ status: "running", turnId: "active" }, turns, []);
  assert.deepEqual(Array.from(result, (entry: any) => entry.key), ["dock:last:new-a", "dock-work:active:cmd"]);
  turns[1]!.items = [narrative("u", "userMessage"), narrative("a1", "agentMessage"), narrative("a2", "agentMessage")];
  result = api.compactConversationEntries({ status: "completed" }, turns, [{ id: "approve", kind: "command", state: "pending" }]);
  assert.deepEqual(Array.from(result, (entry: any) => entry.key), ["dock:last:u", "dock:last:a1", "dock:last:a2", "dock-approval:approve"]);
  const legacy = api.legacyConversation([{ id: "1", turnId: "t", role: "user" }, { id: "2", turnId: "t", role: "assistant" }]);
  assert.equal(legacy.turns.length, 1);
  assert.equal(legacy.turns[0].items.length, 2);
});

test("turn summary preserves real counts and keeps current unresolved errors visible", () => {
  const { api } = fixture([...renderHelpers, "turnWorkSummary", "renderTurnWorkstream", "compactConversationEntries"]);
  const turn = { turnId: "t", durationMs: 4200, items: [
    { id: "c", type: "commandExecution", status: "completed" },
    { id: "f", type: "fileChange", changes: [{ path: "a.ts" }, { path: "a.ts" }, { path: "b.ts" }] },
    { id: "m", type: "mcpToolCall", status: "failed", error: "visible failure" },
  ] };
  const rendered = api.renderTurnWorkstream(turn, 0);
  assert.match(rendered, /技術活動 3 · 成功 0 · 失敗 1 · 已恢復 0 · 待處理 1 · 4.2 s/);
  assert.ok(rendered.indexOf("visible failure") < rendered.indexOf('class="turn-technical"'));
  assert.doesNotMatch(rendered, /class="turn-technical"[^>]* open/);
  const inline = api.compactConversationEntries({ status: "failed" }, [turn], []);
  assert.match(inline[0].html, /visible failure/);
});

test("header distinguishes requested/executed models and never derives pressure from cumulative usage", () => {
  const { api } = fixture(["renderThreadControls", "tokenSummary", "metric", "escapeHtml", "controllerLabel", "effortLabel"], { state: { status: { controller: "ready" } } });
  const usage = { total: { totalTokens: 990000 }, last: { totalTokens: 100 }, modelContextWindow: 1000 };
  const rendered = api.renderThreadControls({ model: "requested", executionMode: "plan", approvalReviewer: "user", conversation: { tokenUsage: usage, modelRouting: { executedModel: "executed", fromModel: "requested" } } });
  assert.match(rendered, /指定 requested/);
  assert.match(rendered, /實際 executed/);
  assert.match(rendered, /max="1000" value="100"/);
  assert.doesNotMatch(api.tokenSummary({ ...usage, modelContextWindow: null }), /<progress/);
  assert.doesNotMatch(api.tokenSummary({ ...usage, last: { totalTokens: null } }), /<progress/);
});

test("client patches apply telemetry and clear obsolete item times without losing revision rules", () => {
  const { api } = fixture(["applyConversationChanges"], { cloneValue: structuredClone });
  const conversation: any = { revision: 1, updatedAt: "fake-now", turns: [{ turnId: "t", items: [{ id: "a", createdAt: "fake-now" }] }] };
  const usage = { total: { totalTokens: 12 } };
  const routing = { requestedModel: "r", executedModel: "e" };
  assert.equal(api.applyConversationChanges(conversation, [{ revision: 2, at: "observation", updatedAt: null, tokenUsage: usage, modelRouting: routing,
    turns: [{ turnId: "t", tokenUsage: usage, modelRouting: routing, items: [{ id: "a", text: "native" }] }] }]), true);
  assert.equal(conversation.updatedAt, undefined);
  assert.equal(conversation.turns[0].items[0].createdAt, undefined);
  assert.equal(conversation.tokenUsage.total.totalTokens, 12);
  assert.equal(conversation.turns[0].modelRouting.executedModel, "e");
  assert.equal(api.applyConversationChanges(conversation, [{ revision: 4, turns: [] }]), false);
  assert.equal(conversation.revision, 2);
});

function element() {
  return { open: true, innerHTML: "", textContent: "", disabled: false, querySelectorAll: () => [] };
}

function failureFixture() {
  return fixture([...renderHelpers, "turnWorkSummary", "renderTurnWorkstream", "conversationEntries", "compactConversationEntries", "legacyConversation", "statusLabel"],
    { state: { displayMode: "fullscreen" } });
}
const mcp = (id: string, status = "failed", tool = "read_file", server = "project_workspace") => ({ id, type: "mcpToolCall", status, server, tool });
const command = (id: string, status = "failed", exitCode: number | undefined = 1, value = "npm test") => ({ id, type: "commandExecution", status, exitCode, command: value });
const files = (id: string, status = "failed", paths = ["a.ts"]) => ({ id, type: "fileChange", status, changes: paths.map((path) => ({ path, kind: "update" })) });
function jobFixture(items: any[], status = "running", turnStatus = status === "running" ? "inProgress" : status) {
  const turn = { turnId: "t", status: turnStatus, items };
  return { turn, job: { status, turnId: "t", approvals: [], conversation: { turns: [turn] } } };
}
const entryKeys = (entries: any[]) => Array.from(entries, (entry: any) => entry.key);

test("MCP recovery requires same server/tool, later confirmed success, same turn and reliable identity", () => {
  const { api } = failureFixture();
  const { turn, job } = jobFixture([mcp("failed"), mcp("ok", "completed")]);
  const before = JSON.stringify(job);
  assert.equal(api.turnFailurePresentation(turn, job).get("failed"), "recovered");
  assert.ok(!entryKeys(api.conversationEntries(job)).includes("item:t:failed"));
  assert.equal(JSON.stringify(job), before, "Classification/rendering must never rewrite underlying truth.");
  for (const later of [mcp("ok", "completed", "patch_text_file"), mcp("ok", "completed", "read_file", "another"),
    { ...mcp("ok", "completed"), error: "still failed" }, mcp("ok", "inProgress"),
    { ...mcp("ok", "completed"), isStreaming: true }, { ...mcp("ok", "completed"), turnId: "other" }]) {
    assert.notEqual(api.turnFailurePresentation({ ...turn, items: [mcp("failed"), later] }, job).get("failed"), "recovered");
  }
  for (const value of ["", "[redacted]", "read[truncated]"]) {
    assert.notEqual(api.turnFailurePresentation({ ...turn, items: [mcp("failed", "failed", value), mcp("ok", "completed", value)] }, job).get("failed"), "recovered");
  }
  assert.notEqual(api.turnFailurePresentation({ ...turn, items: [mcp("ok", "completed"), mcp("failed")] }, job).get("failed"), "recovered");
  const old = { ...turn, turnId: "old", status: "completed", items: [mcp("failed")] };
  assert.equal(api.turnFailurePresentation(old, job, [old, turn]).get("failed"), "historical");
});

test("command recovery requires exact command, matching cwd and completed exit zero", () => {
  const { api } = failureFixture();
  for (const later of [command("ok", "completed", 0), { ...command("ok", "completed", 0), cwd: undefined }]) {
    const { turn, job } = jobFixture([command("failed"), later]);
    assert.equal(api.turnFailurePresentation(turn, job).get("failed"), "recovered");
  }
  for (const later of [command("ok", "completed", 1), { ...command("ok", "completed", 0), exitCode: undefined },
    command("ok", "completed", 0, "npm run build"), command("ok", "completed", 0, "npm  test"),
    { ...command("ok", "completed", 0), cwd: "other" }, { ...command("ok", "completed", 0), error: "failed" }]) {
    const { turn, job } = jobFixture([command("failed"), later]);
    assert.notEqual(api.turnFailurePresentation(turn, job).get("failed"), "recovered");
  }
});

test("file recovery requires a nonempty fully covered path set in a later successful item", () => {
  const { api } = failureFixture();
  for (const paths of [["a.ts"], ["a.ts", "b.ts"]]) {
    const { turn, job } = jobFixture([files("failed"), files("ok", "completed", paths)]);
    assert.equal(api.turnFailurePresentation(turn, job).get("failed"), "recovered");
  }
  for (const pair of [[files("failed"), files("ok", "completed", ["b.ts"])],
    [files("failed", "failed", []), files("ok", "completed")],
    [files("failed", "failed", ["a.ts", "b.ts"]), files("ok", "completed")],
    [files("failed"), { ...files("ok", "completed"), error: "failed" }],
    [files("failed", "failed", ["[redacted]"]), files("ok", "completed", ["[redacted]"])]]) {
    const { turn, job } = jobFixture(pair);
    assert.notEqual(api.turnFailurePresentation(turn, job).get("failed"), "recovered");
  }
});

test("completed turns keep historical failures in neutral collapsed Workstream details, not main conversation", () => {
  const { api } = failureFixture();
  const { turn, job } = jobFixture([narrative("answer", "agentMessage"), mcp("m"), command("c"), files("f"),
    { id: "error", type: "error", status: "failed", text: "public error" }], "completed");
  assert.deepEqual(entryKeys(api.conversationEntries(job)), ["item:t:answer"]);
  const work = api.renderTurnWorkstream(turn, 0, job);
  assert.match(work, /技術活動 4 · 成功 0 · 失敗 4 · 已恢復 0/);
  assert.doesNotMatch(work, /待處理|activity-card error| open/);
  for (const id of ["m", "c", "f", "error"]) assert.ok(work.indexOf("work:t:" + id) > work.indexOf('class="turn-technical"'));
  assert.match(work, /public error/);
});

test("terminal unsuccessful jobs retain the latest unresolved cause even if their turn says completed", () => {
  const { api } = failureFixture();
  for (const status of ["failed", "interrupted", "declined", "cancelled"]) {
    const { turn, job } = jobFixture([mcp("old"), command("latest")], status, "completed");
    assert.deepEqual(entryKeys(api.conversationEntries(job)), ["item:t:latest"]);
    assert.match(api.renderTurnWorkstream(turn, 0, job), /待處理 1/);
    turn.items.push({ id: "error", type: "error", status: "failed", text: "termination cause" });
    assert.match(api.conversationEntries(job).map((entry: any) => entry.html).join(""), /termination cause/);
  }
});

test("active latest failures remain visible until recovery; unrelated progress only makes them historical", () => {
  const { api } = failureFixture();
  const { turn, job } = jobFixture([mcp("failed")]);
  assert.ok(entryKeys(api.conversationEntries(job)).includes("item:t:failed"));
  turn.items.push(mcp("ok", "completed"));
  assert.ok(!entryKeys(api.conversationEntries(job)).includes("item:t:failed"));
  turn.items[1] = mcp("unrelated", "completed", "patch_text_file");
  assert.equal(api.turnFailurePresentation(turn, job).get("failed"), "historical");
  turn.items.push({ id: "error", type: "error", status: "failed", text: "still unresolved" });
  turn.items.push(mcp("another", "completed"));
  assert.equal(api.turnFailurePresentation(turn, job).get("error"), "unresolved", "Unidentified errors cannot be recovered by unrelated success.");
  const old = { turnId: "old", status: "completed", items: [mcp("previous")] };
  job.conversation.turns.unshift(old);
  assert.ok(!entryKeys(api.conversationEntries(job)).includes("item:old:previous"));
});

test("pending/declined/expired approval visibility cannot be consumed by technical recovery", () => {
  const { api, scope } = failureFixture();
  for (const approvalState of ["pending", "declined", "expired"]) {
    const { turn, job } = jobFixture([{ ...mcp("failed"), approvalState }, mcp("ok", "completed"),
      { id: "approval", type: "approval", status: approvalState }], "completed");
    assert.equal(api.turnFailurePresentation(turn, job).get("failed"), "unresolved");
    assert.equal(api.turnFailurePresentation(turn, job).get("approval"), "unresolved");
    assert.ok(entryKeys(api.conversationEntries(job)).includes("item:t:approval"));
  }
  const { job } = jobFixture([mcp("failed"), mcp("ok", "completed")]);
  const pending = { id: "request", kind: "command", state: "pending" };
  for (const mode of ["fullscreen", "inline"]) {
    scope.state.displayMode = mode;
    const rendered = api.conversationEntries({ ...job, approvals: [pending] }).map((entry: any) => entry.html).join("");
    assert.match(rendered, /data-approval="request"/);
    assert.match(rendered, /data-decision="accept"/);
  }
});

test("inline preserves complete narrative, excludes recovered failures and bounds unresolved warnings to one card", () => {
  const { api, scope } = failureFixture();
  scope.state.displayMode = "inline";
  const { turn, job } = jobFixture([narrative("u", "userMessage"), narrative("a1", "agentMessage"), narrative("a2", "agentMessage"), mcp("failed"), mcp("ok", "completed")]);
  let entries = api.conversationEntries(job);
  assert.deepEqual(entryKeys(entries).filter((key) => key.startsWith("dock:")), ["dock:t:u", "dock:t:a1", "dock:t:a2"]);
  assert.equal(entries.filter((entry: any) => entry.key.startsWith("dock-error")).length, 0);
  turn.items.push(mcp("latest", "failed", "patch_text_file"));
  turn.items.push({ id: "error", type: "error", status: "failed", text: "visible cause" });
  entries = api.conversationEntries(job);
  const warnings = entries.filter((entry: any) => entry.key.startsWith("dock-error"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].html, /class="compact-warning"/);
  assert.match(warnings[0].html, /visible cause/);
  assert.doesNotMatch(warnings[0].html, /<pre|<details/);
});

test("safe failure fallback names operations without serializing raw error data", () => {
  const { api } = failureFixture();
  const item = { ...mcp("m"), error: { data: "PRIVATE", message: "RAW_PRIVATE" } };
  const rendered = api.renderConversationItem(item, null, "m", "unresolved");
  assert.match(rendered, /project_workspace \/ read_file/);
  assert.match(rendered, /此工具呼叫失敗；詳細原因未公開/);
  assert.doesNotMatch(rendered, /PRIVATE|\[object Object\]|沒有額外公開內容/);
  assert.match(api.renderConversationItem(files("f"), null, "f", "unresolved"), /a.ts/);
  assert.match(api.renderCompactFailure(command("c"), "c", 1), /npm test/);
  const escaped = api.renderCompactFailure({ ...mcp("m"), tool: "<script>" }, "m", 1);
  assert.doesNotMatch(escaped, /<script>/);
});

test("summary fixture counts successes, true failures and recovered subset without mutating status", () => {
  const { api } = failureFixture();
  const { turn, job } = jobFixture([mcp("mf"), mcp("ms", "completed"), command("cf"), command("cs", "completed", 0),
    files("ff"), files("fs", "completed"), mcp("other-f", "failed", "patch_text_file"),
    command("unknown", "completed", 0), { id: "pending", type: "activity", status: "inProgress" }], "completed");
  delete turn.items[7].exitCode;
  const original = JSON.stringify(turn);
  const presentation = api.turnFailurePresentation(turn, job);
  const counts = api.turnWorkCounts(turn, presentation);
  assert.deepEqual(JSON.parse(JSON.stringify(counts)), { total: 9, success: 3, failed: 4, recovered: 3, unresolved: 0 });
  assert.ok(counts.recovered <= counts.failed);
  const work = api.renderTurnWorkstream(turn, 0, job);
  assert.match(work, /技術活動 9 · 成功 3 · 失敗 4 · 已恢復 3/);
  assert.equal((work.match(/class="recovery-badge"/g) || []).length, 3);
  assert.match(work, /activity-card recovered/);
  assert.match(work, /activity-status failed">失敗/);
  assert.equal(JSON.stringify(turn), original);
});
const drawerHelpers = ["loadOperatorStatus", "renderOperatorStatus", "operatorPart", "statusCard", "statusRows", "statusDetails", "usageRateLimits", "unixTime", "formatTime", "metric", "escapeHtml", "escapeAttr", "formatBytes"];

test("drawer reads lazily, coalesces requests, uses bounded refresh and isolates partial failures", async () => {
  const nodes: Record<string, any> = { "#operator-drawer": element(), "#operator-context": element(), "#refresh-operator": element(), "#operator-content": element() };
  nodes["#operator-drawer"].open = false;
  const calls: any[] = [];
  let resolveUsage!: (value: unknown) => void;
  const usage = new Promise((resolve) => { resolveUsage = resolve; });
  const state: any = { selectedProjectId: "p", operatorRead: null };
  const { api } = fixture(drawerHelpers, { state, $: (id: string) => nodes[id], currentProject: () => ({ name: "Fixture" }), isOperableProjectId: () => true,
    callTool: (name: string, args: any, options: any) => {
      calls.push({ name, args, options });
      if (name === "codex_usage_status") return usage;
      if (name === "codex_runtime_status") return Promise.reject(new Error("secret-path must not render"));
      return Promise.resolve({ skills: { status: "available", data: { items: [], errorCount: 0, warningCount: 0 }, truncated: true }, hooks: { status: "error", code: "INVALID_RESPONSE" }, mcpServers: { status: "unavailable", code: "UNSUPPORTED" } });
    } });
  await api.loadOperatorStatus(false);
  assert.equal(calls.length, 0);
  nodes["#operator-drawer"].open = true;
  const first = api.loadOperatorStatus(false);
  assert.equal(api.loadOperatorStatus(false), first);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.options.update === false));
  resolveUsage({ rateLimits: { status: "unavailable", code: "AUTH_UNAVAILABLE" }, accountUsage: { status: "available", data: { summary: { lifetimeTokens: null, peakDailyTokens: 0, currentStreakDays: null } }, truncated: false } });
  await first;
  const rendered = nodes["#operator-content"].innerHTML;
  assert.match(rendered, /AUTH_UNAVAILABLE/);
  assert.match(rendered, /BACKEND_UNAVAILABLE/);
  assert.match(rendered, /INVALID_RESPONSE/);
  assert.match(rendered, /已縮限/);
  assert.match(rendered, /累計 tokens<\/dt><dd>未知/);
  assert.doesNotMatch(rendered, /secret-path/);
  api.renderOperatorStatus();
  await api.loadOperatorStatus(true);
  assert.equal(calls.length, 3, "Render/poll and repeated clicks do not refetch heavy RPCs.");
  state.operatorRead.startedAt -= 31000;
  await api.loadOperatorStatus(false);
  assert.equal(calls.length, 6);
});

test("drawer selects safe fields, keeps null credits unknown and avoids schema/commands", () => {
  const { api } = fixture(["statusCard", "usageRateLimits", "statusRows", "statusDetails", "unixTime", "formatTime", "metric", "escapeHtml", "escapeAttr"]);
  const rendered = api.statusCard("額度", { status: "available", data: { ordinaryUsageAllowed: null, rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1791417600 }, secondary: null, credentials: "PRIVATE" }, rateLimitResetCredits: null, commands: "PRIVATE" } }, api.usageRateLimits);
  assert.match(rendered, /12%/);
  assert.match(rendered, /Reset credits<\/dt><dd>未知/);
  assert.doesNotMatch(rendered, /PRIVATE/);
  assert.match(api.statusCard("壞資料", { status: "available", data: null }, api.usageRateLimits), /INVALID_RESPONSE/);
});

test("review/compact require a user invocation, exact identities and a fresh receipt; accepted still polls", async () => {
  const job = { id: "job", threadId: "thread", turnId: "turn", projectId: "p", status: "completed", directActionHistoryEligible: true, conversation: { status: "idle" }, approvals: [] };
  const state: any = { selectedJob: job, selectionGeneration: 1, actionRequests: new Map(), busy: false };
  const calls: any[] = [];
  let polls = 0;
  const { api } = fixture(["actionIdentity", "directActionEligible", "runThreadAction"], { state, isOperableProjectId: () => true, makeId: () => "fresh-request", withBusy: (fn: any) => fn(), renderHeader: () => undefined, showNotice: () => undefined, schedulePoll: () => undefined,
    pollSelectedJob: async () => { polls++; }, callTool: async (name: string, args: any, options: any) => { calls.push({ name, args, options }); return { accepted: true }; } });
  assert.equal(calls.length, 0);
  assert.equal(api.directActionEligible({ ...job, directActionHistoryEligible: false }), false);
  assert.equal(api.directActionEligible({ ...job, approvals: [{ state: "pending" }] }), false);
  assert.equal(api.directActionEligible({ ...job, conversation: { status: "active" } }), false);
  await api.runThreadAction("review");
  assert.equal(calls[0].name, "codex_direct_thread_review");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args)), { jobId: "job", expectedThreadId: "thread", expectedTurnId: "turn", requestId: "fresh-request" });
  assert.equal(polls, 1);
  assert.equal(job.status, "completed", "An accepted action cannot invent a new completed lifecycle.");
  await api.runThreadAction("compact");
  assert.equal(calls.length, 1, "Unknown or accepted receipt cannot be bypassed with another action.");
  state.selectedJob = { ...job, turnId: "new-turn" };
  await api.runThreadAction("compact");
  assert.equal(calls[1].name, "codex_direct_thread_compact");
  assert.doesNotMatch(html, /data-thread-action="fork"|codex_direct_thread_fork/);
});

test("scroll/reveal is bounded and one-time; reduced motion, keyboard rails and sticky controls exist", () => {
  const state: any = { selectedJob: { id: "job" }, revealedKeys: new Set(), displayMode: "fullscreen" };
  const compact: any[] = [];
  const { api } = fixture(["claimReveal", "reducedMotion", "updateScrollState", "matchesConversation"], { state,
    window: { matchMedia: () => ({ matches: true }) }, document: { body: { classList: { toggle: (...args: any[]) => compact.push(args) } } } });
  assert.equal(api.claimReveal("a"), true);
  assert.equal(api.claimReveal("a"), false);
  assert.equal(api.reducedMotion(), true);
  api.updateScrollState({ scrollTop: 100 });
  api.updateScrollState({ scrollTop: 0 });
  assert.deepEqual(compact, [["header-compact", true], ["header-compact", false]]);
  assert.equal(api.matchesConversation({ title: "Yesterday review" }, { name: "Project" }, "review"), true);
  assert.match(html, /prefers-reduced-motion: reduce\)[\s\S]*animation: none !important; transition: none !important; scroll-behavior: auto !important/);
  assert.match(html, /\.chat-head\s*\{\s*position: sticky; top: 0/);
  assert.match(html, /\.rail-controls,[\s\S]*?position: sticky/);
  assert.match(html, /aria-label="額度視窗，可橫向捲動"/);
  assert.match(html, /scroll-snap-type: x proximity/);
  assert.match(html, /button:focus-visible/);
  assert.doesNotMatch(html, /parallax|scroll-snap-type:\s*[^;]*mandatory/);
});
