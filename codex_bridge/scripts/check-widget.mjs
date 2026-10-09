import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";

const html = await readFile(new URL("../web/codex-console.html", import.meta.url), "utf8");
for (const marker of [
  'rpcRequest("ui/initialize"',
  'availableDisplayModes: ["inline", "fullscreen"]',
  'rpcRequest("ui/request-display-mode"',
  'message.method === "ui/notifications/host-context-changed"',
  'rpcNotify("ui/notifications/initialized"',
  'rpcRequest("tools/call"',
  'message.method === "ui/notifications/tool-result"',
  'state.pollInFlight',
  'state.registryRefreshInFlight',
  'state.registryRefreshGeneration',
  'generation !== state.registryRefreshGeneration',
  'allowAuthoritativeReset: false',
  'automationActive ? 4000 : 20000',
  'afterConversationRevision:',
  'function applyConversationChanges',
  'if (change.replaceAll)',
  'data-timeline-key=',
  'class="new-content"',
  'activity-card',
  'class="project-tree"',
  'data-project-toggle=',
  'class="thread"',
  'function renderMessages()',
  'function reconcileTimeline(thread, entries)',
  'codex_conversation_send',
  'localThreadId: state.selectedJob.localThreadId',
  '本機歷史 · 可續作',
  '這個專案位置受到保護',
  'value="workspace_write" selected',
  'codex_unified_conversation_list',
  'codex_unified_conversation_get',
  'class="composer"',
  '背景與文字文件',
  '貼上文字文件',
  'codex_text_bundle_begin',
  'codex_text_bundle_append',
  'codex_text_bundle_finalize',
  'codex_artifact_read_chunk',
  'rpcRequest("ui/download-file"',
  'rpcRequest("ui/message"',
  'id="model"',
  'id="effort"',
  'id="reviewer"',
  'data-approval=',
  'company-confirm-checkbox',
  '@media (max-width: 760px)',
  '@media (prefers-reduced-motion: reduce)',
  'data-ledger="project-ledger"',
  'data-theme="night-shift"',
  '--ledger-canvas: #111820',
  'data-shell="conversation-dock"',
  'class="compact-settings-summary"',
  'class="inspector"',
  'id="workstream"',
  'function renderWorkstream()',
  'inlineWorkspaceHeight(availableWidth)',
  'element.focus({ preventScroll: true })',
]) {
  assert.ok(html.includes(marker), `Missing widget contract marker: ${marker}`);
}
assert.ok(!html.includes("http://") && !html.includes("https://"), "Widget must not depend on remote resources.");
assert.ok(!html.includes("eval("), "Widget must not use eval.");
assert.ok(!html.includes("isBlockingItem("), "Raw failure truth must not directly decide conversation visibility.");
for (const helper of ["turnFailurePresentation", "sameTechnicalOperation", "turnWorkCounts", "renderCompactFailure"]) {
  assert.ok(html.includes("function " + helper + "("), `Missing shared failure presentation helper: ${helper}`);
}
assert.match(html, /activity-card\.recovered \.activity-status/, "Recovered failures must use neutral status styling.");
assert.match(html, /warnings\[warnings\.length - 1\]/, "Inline unresolved warnings must remain compact.");
assert.ok(!html.includes("—"), "Widget visible text must not use em dashes.");
assert.ok(!html.includes('class="status-strip"'), "Widget must not restore the redundant dashboard status strip.");
assert.ok(!html.includes('class="event-list'), "Technical event logs must stay out of the primary widget UI.");
assert.ok(!html.includes("function renderEvent"), "Technical event renderers must stay out of the primary widget UI.");
assert.ok(!html.includes("100vh") && !html.includes("100dvh"), "Widget root must not couple its intrinsic height to the host iframe viewport.");
assert.ok(!html.includes("min-height: 100%"), "Widget body must remain shrinkable inside an auto-sized host iframe.");
assert.ok(!html.includes('setProperty("--workspace-height", "720px")'), "Inline mode must not restore a hard-coded workspace height.");
assert.ok(!html.includes('type="file"'), "The core text shuttle must not depend on host file upload controls.");
assert.ok(!html.includes("data.complete === true && !data.nextCursor"), "A final pagination response must not discard previously loaded conversations.");
assert.ok(!html.includes('thread.innerHTML = entries.map'), "Normal timeline changes must not rebuild the entire transcript DOM.");
assert.ok(!html.includes("localThreads") && !html.includes("localHistoryCursor") && !html.includes("selectLocalThread"), "Legacy dual-inventory widget state must stay removed.");
assert.match(html, /<body data-display-mode="inline" data-ledger="project-ledger" data-theme="night-shift">/, "Widget must expose its display mode and dark visual system.");
assert.match(html, /const replaceRegistry = options\.allowAuthoritativeReset === true && data\.reset === true;/, "Only the latest coordinated authoritative response may replace the unified registry.");
assert.match(html, /function refreshConversationRegistry\(\)\s*\{[\s\S]*?if \(state\.registryRefreshInFlight\) return state\.registryRefreshInFlight;[\s\S]*?const generation = \+\+state\.registryRefreshGeneration;[\s\S]*?if \(generation !== state\.registryRefreshGeneration\) return;/, "Full registry refresh must be single-flight and reject stale generations.");
assert.match(html, /function loadMoreConversationRegistry\(cursor\)[\s\S]*?applyConversationRegistryResponse\(data, \{ allowAuthoritativeReset: false \}\)/, "Cursor pagination must remain merge-only.");
assert.doesNotMatch(html, /visibilitychange[\s\S]{0,180}loadConversationRegistry\(/, "Visibility recovery must use the shared registry refresh coordinator.");
assert.doesNotMatch(html, /addEventListener\("focus"[\s\S]{0,180}loadConversationRegistry\(/, "Focus recovery must use the shared registry refresh coordinator.");
assert.match(html, /if \(node\.tagName === "DETAILS" && replacement\.tagName === "DETAILS"\) replacement\.open = node\.open;/, "Incremental reconciliation must preserve DETAILS open state when replacing one keyed node.");
assert.match(html, /const keyedNodes = new Map\(\);[\s\S]*?node\.dataset\.timelineKey/, "Timeline reconciliation must use data-timeline-key as its identity owner.");
assert.match(html, /\$\("#thread"\)\.addEventListener\("click"/, "Reused timeline nodes must use one delegated action listener.");
assert.match(html, /maxConversations:\s*10000/, "Unified inventory must continue beyond the former 2,000-conversation ceiling.");
assert.match(html, /body\[data-display-mode="inline"\]\s*\{[^}]*padding:\s*0;/s, "Inline mode total height must not add body padding outside the bounded workspace.");
assert.match(html, /body\[data-ledger="project-ledger"\]\[data-display-mode="inline"\] \.workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*width:\s*100%;[^}]*max-width:\s*none;/s, "Inline mode must use the full host conversation width.");
assert.match(html, /function inlineWorkspaceHeight\(availableWidth\)\s*\{[^}]*availableWidth \* 1\.12[^}]*Math\.max\(640, Math\.min\(960, proportionalHeight\)\)/s, "Inline height must scale from host width within bounded limits.");
assert.match(html, /\.thread::before\s*\{[^}]*content:\s*none;[^}]*display:\s*none;/s, "The transcript must not render a persistent execution spine.");
assert.match(html, /body\[data-ledger="project-ledger"\]\[data-display-mode="inline"\] \.sidebar,[\s\S]*?\.inspector\s*\{\s*display:\s*none;/s, "Inline mode must not persistently render project or work rails.");
assert.match(html, /body\[data-ledger="project-ledger"\]\[data-display-mode="fullscreen"\] \.workspace\s*\{[^}]*grid-template-columns:\s*260px minmax\(0, 1fr\) 320px;[^}]*width:\s*100%;/s, "Fullscreen mode must expose project, conversation, and workstream zones.");
assert.match(html, /state\.displayMode === "fullscreen" \? "縮回對話" : "放大工作區"/, "Display toggle must name the compact-to-fullscreen action clearly.");
assert.match(html, /\.chat-heading\s*\{[^}]*flex:\s*1 1 auto;[^}]*overflow:\s*hidden;/s, "Chat heading must shrink before it reaches the widget boundary.");
assert.match(html, /\.thread\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s, "Transcript thread must remain shrinkable.");
assert.match(html, /\.approval-card\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/s, "Approval cards must not overflow the transcript.");
assert.match(html, /\.approval-card pre\s*\{[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere;/s, "Long approval payloads must wrap inside the card.");
assert.match(html, /@media \(max-width: 760px\)[\s\S]*?\.workspace\.rail-open \.sidebar\s*\{[^}]*position:\s*absolute;/, "Narrow fullscreen navigation must use an overlay instead of compressing the conversation.");
const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(inlineScript, "Widget must include an inline bridge script.");
new Script(inlineScript, { filename: "codex-console.inline.js" });

const registryApplyStart = inlineScript.indexOf("        function applyConversationRegistryResponse");
const registryApplyEnd = inlineScript.indexOf("        function mergeJob", registryApplyStart);
assert.ok(registryApplyStart >= 0 && registryApplyEnd > registryApplyStart, "Registry response applier must be extractable for behavior checks.");
const registryApplyContext = {
  state: {
    conversations: [{ conversationId: "verified", updatedAt: "2026-08-31T10:00:00Z" }],
    conversationCursor: null,
    treeSignature: "stable",
  },
  applyConversationDiagnostics: () => undefined,
  render: () => undefined,
};
new Script(`${inlineScript.slice(registryApplyStart, registryApplyEnd)}\nglobalThis.applyRegistryResponse = applyConversationRegistryResponse;`)
  .runInNewContext(registryApplyContext);
registryApplyContext.applyRegistryResponse({
  conversations: [{ conversationId: "durable", updatedAt: "2026-08-31T09:00:00Z" }],
  reset: false,
}, { allowAuthoritativeReset: true });
assert.deepEqual(
  Array.from(registryApplyContext.state.conversations, (conversation) => conversation.conversationId).sort(),
  ["durable", "verified"],
  "A degraded first page must merge without clearing the verified client registry.",
);
registryApplyContext.applyRegistryResponse({
  conversations: [{ conversationId: "older", updatedAt: "2026-08-31T08:00:00Z" }],
  reset: true,
}, { allowAuthoritativeReset: false });
assert.deepEqual(
  Array.from(registryApplyContext.state.conversations, (conversation) => conversation.conversationId).sort(),
  ["durable", "older", "verified"],
  "A cursor page must remain merge-only even if the server unexpectedly marks it for reset.",
);
registryApplyContext.applyRegistryResponse({
  conversations: [{ conversationId: "current", updatedAt: "2026-08-31T11:00:00Z" }],
  reset: true,
}, { allowAuthoritativeReset: true });
assert.deepEqual(
  Array.from(registryApplyContext.state.conversations, (conversation) => conversation.conversationId),
  ["current"],
  "Only an explicitly authoritative healthy first page may replace the client registry.",
);

class FakeNode {
  constructor(key, tagName) {
    this.dataset = { timelineKey: key };
    this.tagName = tagName;
    this.open = false;
    this.parent = null;
  }

  get nextElementSibling() {
    if (!this.parent) return null;
    const index = this.parent.children.indexOf(this);
    return index >= 0 ? this.parent.children[index + 1] ?? null : null;
  }

  replaceWith(replacement) {
    const parent = this.parent;
    const index = parent.children.indexOf(this);
    parent.children[index] = replacement;
    replacement.parent = parent;
    this.parent = null;
  }

  remove() {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }
}

class FakeThread {
  constructor() {
    this.children = [];
  }

  get firstElementChild() {
    return this.children[0] ?? null;
  }

  insertBefore(node, reference) {
    if (node.parent) {
      const currentIndex = node.parent.children.indexOf(node);
      if (currentIndex >= 0) node.parent.children.splice(currentIndex, 1);
    }
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
    node.parent = this;
  }

  replaceChildren(...nodes) {
    this.children.forEach((node) => { node.parent = null; });
    this.children = nodes;
    nodes.forEach((node) => { node.parent = this; });
  }
}

const refreshStart = inlineScript.indexOf("        async function loadConversationRegistry");
const refreshEnd = inlineScript.indexOf("        function schedulePoll", refreshStart);
assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, "Registry coordinator source must be extractable for behavior checks.");
const refreshCalls = [];
const appliedRegistryResponses = [];
const refreshContext = {
  state: {
    conversationCursor: null,
    registryRefreshGeneration: 0,
    registryRefreshInFlight: null,
    registryLoadMoreInFlight: null,
  },
  document: { hidden: false },
  callTool: (...args) => {
    const request = deferred();
    refreshCalls.push({ args, request });
    return request.promise;
  },
  applyConversationRegistryResponse: (data, options) => appliedRegistryResponses.push({ data, options }),
};
new Script(`${inlineScript.slice(refreshStart, refreshEnd)}\nglobalThis.registryCoordinator = { refreshConversationRegistry, loadMoreConversationRegistry };`)
  .runInNewContext(refreshContext);
const firstRefresh = refreshContext.registryCoordinator.refreshConversationRegistry();
const coalescedRefresh = refreshContext.registryCoordinator.refreshConversationRegistry();
assert.equal(firstRefresh, coalescedRefresh, "Concurrent full refresh triggers must share one in-flight request.");
assert.equal(refreshCalls.length, 1, "Single-flight refresh must issue only one registry request.");
refreshContext.state.registryRefreshGeneration += 1;
refreshCalls[0].request.resolve({ conversations: [{ conversationId: "stale" }], reset: true });
await firstRefresh;
assert.equal(appliedRegistryResponses.length, 0, "A stale registry generation must not mutate authoritative state.");
const latestRefresh = refreshContext.registryCoordinator.refreshConversationRegistry();
refreshCalls[1].request.resolve({ conversations: [{ conversationId: "latest" }], reset: true });
await latestRefresh;
assert.equal(appliedRegistryResponses.length, 1);
assert.equal(appliedRegistryResponses[0].options.allowAuthoritativeReset, true);
refreshContext.state.conversationCursor = "cursor-1";
const loadMore = refreshContext.registryCoordinator.loadMoreConversationRegistry("cursor-1");
refreshCalls[2].request.resolve({ conversations: [{ conversationId: "older" }], reset: true, nextCursor: null });
await loadMore;
assert.equal(appliedRegistryResponses[1].options.allowAuthoritativeReset, false, "Load-more must ignore an unexpected reset marker.");

const timelineStart = inlineScript.indexOf("        function reconcileTimeline");
const pollStart = inlineScript.indexOf("        function schedulePoll()");
const pollEnd = inlineScript.indexOf('        document.addEventListener("visibilitychange"', pollStart);
const pollCalls = [];
const pollApplied = [];
const pollContext = {
  state: {
    selectedJob: { id: "job-a", status: "running", conversation: { revision: 1, turns: [] }, nextConversationRevision: 1, conversationHasMore: true },
    selectedConversation: { conversationId: "thread-a" },
    selectionGeneration: 1, pollInFlight: false, catchUpStartedAt: Date.now() - 2000, catchUpPages: 4,
  },
  terminal: new Set(["completed", "failed", "cancelled", "interrupted"]),
  document: { hidden: false },
  setTimeout: () => 1,
  clearTimeout: () => undefined,
  showError: () => undefined,
  callTool: (...args) => { const request = deferred(); pollCalls.push({ args, request }); return request.promise; },
  updateFromResponse: (response) => { pollApplied.push(response); pollContext.state.selectedJob = response.structuredContent; },
};
new Script(`${inlineScript.slice(pollStart, pollEnd)}\nglobalThis.poll = pollSelectedJob;`).runInNewContext(pollContext);
const recovering = pollContext.poll();
assert.equal(pollCalls[0].args[0], "codex_job_get");
assert.equal(pollCalls[0].args[1].recovery, "snapshot", "Expired catch-up requests a snapshot, never sends a prompt.");
assert.equal(pollCalls[0].args[2].update, false, "Polling must guard the response before applying it.");
await pollContext.poll();
assert.equal(pollCalls.length, 1, "Polling is single-flight.");
pollCalls[0].request.resolve({ structuredContent: { id: "job-a", status: "running", conversation: { revision: 5000, turns: [] }, nextConversationRevision: 5000, conversationHasMore: false } });
await recovering;
assert.equal(pollContext.state.catchUpPages, 0);
assert.equal(pollContext.state.selectedJob.nextConversationRevision, 5000);
const stalePoll = pollContext.poll();
pollContext.state.selectionGeneration += 2; // A -> B -> A while the request is in flight.
pollCalls[1].request.resolve({ structuredContent: { id: "job-a", nextConversationRevision: 2 } });
await stalePoll;
assert.equal(pollApplied.length, 1, "An obsolete selection generation must not overwrite the current conversation.");
const failedPoll = pollContext.poll();
pollCalls[2].request.reject(new Error("temporary MCP timeout"));
await failedPoll;
assert.equal(pollContext.state.recoverSnapshot, true);
const retryPoll = pollContext.poll();
assert.equal(pollCalls[3].args[1].recovery, "snapshot");
pollCalls[3].request.resolve({ structuredContent: { id: "job-a", status: "running", conversation: { revision: 5001, turns: [] }, nextConversationRevision: 5001, conversationHasMore: false } });
await retryPoll;
pollContext.document.hidden = true;
await pollContext.poll();
assert.equal(pollCalls.length, 4, "Hidden widgets do not poll.");

const patchStart = inlineScript.indexOf("        function applyConversationChanges");
const patchEnd = inlineScript.indexOf("        function cloneValue", patchStart);
const patchContext = { cloneValue: structuredClone };
new Script(`${inlineScript.slice(patchStart, patchEnd)}\nglobalThis.apply = applyConversationChanges;`).runInNewContext(patchContext);
const patched = { revision: 10, turns: [] };
assert.equal(patchContext.apply(patched, [{ revision: 12, turns: [] }]), false);
assert.equal(patched.revision, 10, "A gap must not advance the client cursor.");
assert.equal(patchContext.apply(patched, [{ revision: 11, turns: [] }, { revision: 12, turns: [] }]), true);
assert.equal(patched.revision, 12);

const timelineEnd = inlineScript.indexOf("        function conversationEntries", timelineStart);
assert.ok(timelineStart >= 0 && timelineEnd > timelineStart, "Timeline reconciler source must be extractable for behavior checks.");
const timelineContext = {
  state: { timelineSignatures: new Map() },
  claimReveal: () => false,
  htmlElement: (source) => new FakeNode(
    source.match(/data-timeline-key="([^"]+)"/)?.[1],
    source.trimStart().startsWith("<details") ? "DETAILS" : "ARTICLE",
  ),
};
new Script(`${inlineScript.slice(timelineStart, timelineEnd)}\nglobalThis.timelineReconciler = reconcileTimeline;`)
  .runInNewContext(timelineContext);
const thread = new FakeThread();
let entries = timelineEntries(["A", "B", "C"], { B: "DETAILS" });
timelineContext.timelineReconciler(thread, entries);
timelineContext.state.timelineSignatures = signatureMap(entries);
const [nodeA, nodeB, nodeC] = thread.children;
entries = timelineEntries(["A", "B", "C", "D"], { B: "DETAILS" });
timelineContext.timelineReconciler(thread, entries);
timelineContext.state.timelineSignatures = signatureMap(entries);
assert.equal(thread.children[0], nodeA);
assert.equal(thread.children[1], nodeB);
assert.equal(thread.children[2], nodeC);
const nodeD = thread.children[3];
nodeB.open = true;
entries = timelineEntries(["A", "B", "C", "D"], { B: "DETAILS" }, { B: "B2" });
timelineContext.timelineReconciler(thread, entries);
timelineContext.state.timelineSignatures = signatureMap(entries);
const replacementB = thread.children[1];
assert.notEqual(replacementB, nodeB);
assert.equal(replacementB.open, true);
assert.equal(thread.children[0], nodeA);
assert.equal(thread.children[2], nodeC);
assert.equal(thread.children[3], nodeD);
entries = timelineEntries(["A", "C", "D"]);
timelineContext.timelineReconciler(thread, entries);
timelineContext.state.timelineSignatures = signatureMap(entries);
assert.deepEqual(thread.children, [nodeA, nodeC, nodeD]);
entries = timelineEntries(["A", "D", "C"]);
timelineContext.timelineReconciler(thread, entries);
assert.deepEqual(thread.children, [nodeA, nodeD, nodeC]);
console.log(JSON.stringify({ ok: true, bytes: Buffer.byteLength(html), bridge: "mcp-apps", remoteResources: 0 }, null, 2));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function timelineEntries(keys, tags = {}, signatures = {}) {
  return keys.map((key) => ({
    key,
    signature: signatures[key] ?? key,
    html: tags[key] === "DETAILS"
      ? `<details data-timeline-key="${key}"></details>`
      : `<article data-timeline-key="${key}"></article>`,
  }));
}

function signatureMap(entries) {
  return new Map(entries.map((entry) => [entry.key, entry.signature]));
}
