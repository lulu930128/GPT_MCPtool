import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import test from "node:test";
import { MODEL_PRESETS, modelPresetCatalog } from "../src/model-presets.js";

const html = readFileSync(new URL("../../web/codex-console.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
const terminal = new Set(["completed", "failed", "interrupted", "cancelled", "declined"]);
function fixture(names: string[], context: Record<string, any> = {}) {
  if (names.includes("sendMessage")) names = [...names,"sendReceiptId","finishSend"];
  const functions = names.map((name) => {
    const start = script.search(new RegExp(`        (?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    const rest = script.slice(start + 1);
    const next = rest.search(/\n        (?:(?:async )?function |document\.addEventListener|bridgeReady\.then|\$\()/);
    assert.ok(next >= 0, name);
    return script.slice(start, start + 1 + next);
  }).join("\n");
  const scope: Record<string, any> = { terminal, URL, pendingSends:new Map(), sha256Text:async (text:string) => text, ...context };
  new Script(functions + "\nglobalThis.api = { " + names.join(",") + " };").runInNewContext(scope);
  return { api: scope.api, scope };
}
const failureHelpers = ["isTechnicalItem", "needsApprovalAttention", "isFailedActivity", "isSuccessfulActivity", "reliableOperationValue", "sameTechnicalOperation", "turnFailurePresentation", "turnWorkCounts", "publicFailureText", "renderCompactFailure"];
const markdownHelpers = ["renderSafeMarkdown", "markdownInline", "markdownCells", "markdownTableStart", "safeMarkdownUrl"];
const renderHelpers = [...markdownHelpers, ...failureHelpers, "escapeHtml", "escapeAttr", "formatTime", "formatBytes", "formatDuration", "projectionStatusLabel", "activityTitle", "activitySubtitle", "activityStatusClass", "activityIcon", "activityBody", "isNarrative", "requestedSelectionLabel", "effortLabel", "renderProjectedMessage", "renderConversationItem", "renderApproval", "renderDockWork", "metric"];
const narrative = (id: string, type: string, text = id) => ({ id, type, text, status: "completed" });

// Match native select semantics: replacing options resets selection; duplicate
// empty values distinguish the default option from the explicit custom mode.
function modelSelectFixture() {
  let markup = "";
  const select = {
    options: [] as any[], selectedIndex: -1, disabled: false,
    get innerHTML() { return markup; },
    set innerHTML(value: string) {
      markup = value;
      this.options = Array.from(value.matchAll(/<option value="([^"]*)"([^>]*)>([\s\S]*?)<\/option>/g), (m) => ({
        value: m[1]!, textContent: m[3]!, dataset: /data-custom="true"/.test(m[2]!) ? { custom: "true" } : {},
      }));
      this.selectedIndex = this.options.length ? 0 : -1;
    },
    get selectedOptions() { return this.options.slice(this.selectedIndex, this.selectedIndex + 1); },
    get value() { return this.options[this.selectedIndex]?.value ?? ""; },
    set value(value: string) { this.selectedIndex = this.options.findIndex((option) => option.value === value); },
  };
  return select;
}

function modelWidgetFixture() {
  const nodes: Record<string, any> = { "#model": modelSelectFixture(), "#effort": modelSelectFixture() };
  const $ = (id: string): any => nodes[id] ??= { value: "", hidden: false, disabled: false, classList: { toggle() {} }, setAttribute() {} };
  $("#mode").value = "plan"; $("#reviewer").value = "auto_review"; $("#speed").value = "standard";
  $("#classification").value = "personal";
  const state: any = { selectedProjectId: "omi", selectedJob: null, draftArtifacts: [], expandedProjects: new Set(), status: { modelPresets: modelPresetCatalog([]), models: [
    { id: "gpt-test", displayName: "GPT Test", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
  ] } };
  const calls: any[] = [];
  const names = ["isCustomModelSelection", "selectedModelId", "selectedModelPreset", "renderModelOptions", "renderEffortOptions", "renderSettingsSummary", "effortLabel", "escapeHtml", "escapeAttr",
    "sendMessage", "syncSettingsFromJob", "renderComposerState", "applyStatus", "updateFromResponse"];
  const { api, scope } = fixture(names, {
    state, $, isOperableProjectId: () => true, stageDraftArtifacts: async () => [], deriveTitle: (s: string) => s,
    makeId: () => "model-widget-fixture", renderCompanyConfirmation() {}, renderDraftArtifacts() {}, requestAnimationFrame() {}, resizeComposerInput() {},
    callTool: async (name: string, args: any) => { calls.push({ name, args }); return { workPackage: args, previewDigest: "fixture" }; },
    render: () => api.renderModelOptions(),
  });
  api.renderModelOptions();
  return { api, scope, state, $, calls };
}

test("custom model input survives dynamic options, status refresh, selection reload and effort changes", () => {
  const { api, state, $ } = modelWidgetFixture();
  assert.deepEqual($("#model").options.slice(1, 4).map((o: any) => o.value), ["gpt-6.2-astra/high", "gpt-6.2-sol/high", "gpt-6.2-sol/medium"]);
  assert.equal(api.selectedModelId(), "", "New drafts do not inherit the native default model");
  assert.ok($("#model").options.slice(1, 4).every((o: any) => o.textContent.includes("NOT VERIFIED")));
  assert.deepEqual($("#effort").options.map((o: any) => o.value), [""]);
  $("#model").selectedIndex = $("#model").options.length - 1;
  api.renderModelOptions();
  assert.equal($("#custom-model-field").hidden, false);
  $("#custom-model").value = "  gpt-6.1-sol  ";
  api.renderEffortOptions("max", false);
  const status = { service: "codex-handoff-bridge", models: [], modelPresets: modelPresetCatalog([]) };
  api.updateFromResponse({ structuredContent: status });
  assert.equal($("#custom-model").value, "  gpt-6.1-sol  ", "Refresh must not rewrite the draft input");
  assert.equal(api.selectedModelId(), "gpt-6.1-sol");
  assert.equal($("#effort").value, "max");
  assert.match($("#run-settings-summary").title, /gpt-6\.1-sol/);
  api.syncSettingsFromJob({ model: "gpt-6.1-sol", effort: "ultra" });
  assert.equal(api.selectedModelId(), "gpt-6.1-sol");
  assert.equal($("#effort").value, "ultra");
  state.status.models = [{ id: "gpt-6.1-sol", displayName: "Newly listed", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }];
  api.renderModelOptions();
  assert.equal(api.isCustomModelSelection(), true);
  assert.equal($("#effort").value, "ultra", "Updated capabilities must not silently replace an explicit effort");
  assert.match($("#effort").innerHTML, /未列於此模型/);
  $("#model").value = "gpt-6.2-sol/medium"; api.renderModelOptions();
  assert.equal($("#custom-model-field").hidden, true);
  assert.equal(api.selectedModelId(), "gpt-6.2-sol");
  state.status.models = []; api.renderModelOptions();
  assert.equal(api.isCustomModelSelection(), false, "Native inventory does not replace the selected fixed pair");
  assert.equal(api.selectedModelId(), "gpt-6.2-sol");
  api.renderModelOptions("", "");
  assert.equal(api.isCustomModelSelection(), false);
  assert.equal(api.selectedModelId(), "");
});

test("retired preset jobs retain their exact model and effort in the widget", () => {
  const { api, state, $ } = modelWidgetFixture();
  for (const [model, effort] of [["gpt-6-astra", "xhigh"], ["gpt-6.1-sol", "xhigh"], ["gpt-6.1-sol", "medium"]]) {
    for (const status of ["completed", "running"]) {
      const job = { model, effort, status };
      state.selectedJob = job;
      api.syncSettingsFromJob(job);
      api.renderModelOptions();
      assert.equal(api.isCustomModelSelection(), true);
      assert.equal(api.selectedModelId(), model);
      assert.equal($("#effort").value, effort);
      assert.deepEqual(job, { model, effort, status }, "Reading history never rewrites selection");
    }
  }
});

test("memory maintenance banner disables new/send, retains drafts and exposes failure until verified reopening", async () => {
  const { api, state, $, calls } = modelWidgetFixture();
  $("#message").value = "unsent draft"; $("#context").value = "draft context";
  state.maintenance = { admission: "closed", phase: "draining", heapUsed: 1600 * 1048576, thresholdBytes: 1500 * 1048576,
    pendingWork: { jobs: 2, approvals: 1 } };
  api.renderComposerState();
  assert.equal($("#new-chat").disabled, true); assert.equal($("#send").disabled, true);
  assert.equal($("#message").disabled, false); assert.match($("#memory-maintenance").textContent, /不可接續任務.*等待現有工作完成/);
  await assert.rejects(api.sendMessage(), /不可接續任務/); assert.equal(calls.length, 0);
  assert.equal($("#message").value, "unsent draft"); assert.equal($("#context").value, "draft context");
  state.maintenance.phase = "failed"; api.renderComposerState(); assert.match($("#memory-maintenance").textContent, /自動重啟失敗／需處理/);
  state.maintenance = { admission: "open", phase: "cooldown" }; api.renderComposerState();
  assert.equal($("#send").disabled, false); assert.equal($("#memory-maintenance").hidden, true);
  assert.equal($("#message").value, "unsent draft");
});

test("fixed widget choices require selection, retain exact pairs and expose native uncertainty", async () => {
  const { api, state, $, calls } = modelWidgetFixture();
  assert.deepEqual($("#model").options.filter((o: any) => o.value).map((o: any) => o.value), MODEL_PRESETS.map((p) => p.id));
  $("#message").value = "No implicit default";
  await assert.rejects(api.sendMessage(), /請明確選擇/);
  assert.equal(calls.length, 0);
  for (const preset of MODEL_PRESETS) {
    state.selectedJob = null;
    $("#model").value = preset.id; api.renderModelOptions();
    assert.equal($("#effort").value, preset.effort);
    assert.equal($("#effort").disabled, true);
    assert.match($("#model-preset-note").textContent, /NOT VERIFIED/);
    api.renderModelOptions(); api.renderComposerState();
    assert.equal($("#model").value, preset.id);
    assert.equal($("#effort").disabled, true);
    $("#message").value = "New task";
    await api.sendMessage();
    for (const call of calls.slice(-2)) {
      assert.equal(call.args.modelPreset, preset.id);
      assert.equal(call.args.model, preset.model); assert.equal(call.args.effort, preset.effort);
      assert.equal(call.args.speed, "standard");
    }
    state.selectedJob = { id: "bridge", status: "completed" };
    $("#message").value = "Follow-up"; await api.sendMessage();
    assert.equal(calls.at(-1).args.modelPreset, preset.id);
    state.selectedJob.status = "running";
    $("#message").value = "Steer"; await api.sendMessage();
    for (const field of ["modelPreset", "modelSelection", "model", "effort", "speed"]) assert.equal(calls.at(-1).args[field], undefined);
  }
  state.selectedJob = { status: "completed" };
  api.syncSettingsFromJob({ model: "gpt-5.6-sol", effort: "medium" });
  assert.equal(api.isCustomModelSelection(), true, "Historic custom pairs remain readable outside the fixed presets");
  assert.equal(api.selectedModelId(), "gpt-5.6-sol"); assert.equal($("#effort").value, "medium");
});

test("custom widget dispatch and app/local follow-ups send exact IDs and efforts; empty or rejected input never resends", async () => {
  const { api, scope, state, $, calls } = modelWidgetFixture();
  api.renderModelOptions("gpt-6.1-sol", "max");
  $("#message").value = "Initial";
  await api.sendMessage();
  assert.deepEqual(calls.map((c) => c.name), ["codex_job_preview", "codex_job_dispatch"]);
  for (const call of calls) { assert.equal(call.args.modelSelection, "custom"); assert.equal(call.args.model, "gpt-6.1-sol"); assert.equal(call.args.effort, "max"); assert.equal(call.args.speed, "standard"); }
  for (const job of [{ id: "bridge", status: "completed" }, { id: "local", source: "local", localThreadId: "native", status: "completed" }]) {
    state.selectedJob = job; $("#message").value = "Continue";
    await api.sendMessage();
    assert.equal(calls.at(-1).name, "codex_conversation_send");
    assert.equal(calls.at(-1).args.model, "gpt-6.1-sol");
    assert.equal(calls.at(-1).args.effort, "max");
  }
  const count = calls.length;
  $("#custom-model").value = "  "; $("#message").value = "Do not default";
  api.renderModelOptions();
  assert.equal(api.isCustomModelSelection(), true);
  await assert.rejects(api.sendMessage(), /請輸入自訂 Model ID/);
  assert.equal(calls.length, count);
  $("#custom-model").value = "gpt-6.1-sol";
  let rejectedCalls = 0;
  scope.callTool = async () => { rejectedCalls++; throw new Error("Model not supported by App Server"); };
  await assert.rejects(api.sendMessage(), /Model not supported by App Server/);
  assert.equal(rejectedCalls, 1);
  assert.equal($("#message").value, "Do not default");
  assert.equal(api.selectedModelId(), "gpt-6.1-sol");
  for (const change of [{ busy: true }, { busy: false, selectedJob: { status: "running" } }, { selectedJob: { status: "completed", readOnly: true } }]) {
    Object.assign(state, change); api.renderComposerState();
    assert.equal($("#custom-model").disabled, true);
  }
});

test("composer grows to its cap, preserves editor scroll and skips unchanged measurements", () => {
  const input: any = { value: "draft", clientWidth: 400, scrollHeight: 52, scrollTop: 0, style: {} };
  const state: any = {};
  const { api } = fixture(["resizeComposerInput"], { state, $: () => input, getComputedStyle: () => ({ maxHeight: "192px" }) });
  api.resizeComposerInput();
  assert.equal(input.style.height, "52px");
  input.value = "long\n".repeat(20); input.scrollHeight = 504; input.scrollTop = 100;
  api.resizeComposerInput();
  assert.equal(input.style.height, "192px");
  assert.equal(input.scrollTop, 100);
  input.style.height = "unchanged";
  api.resizeComposerInput();
  assert.equal(input.style.height, "unchanged", "Polling does not disturb an unchanged editor");
  input.value = ""; input.scrollHeight = 48;
  api.resizeComposerInput();
  assert.equal(input.style.height, "52px");
});

test("composer settings keep Agent/Plan and reviewer visible without duplicating controls", () => {
  const nodes: any = { "#mode": { value: "workspace_write" }, "#reviewer": { value: "user" }, "#model": { selectedOptions: [{ textContent: "model" }] }, "#effort": { selectedOptions: [{ textContent: "high" }] }, "#compact-settings-summary": {}, "#run-settings-summary": {} };
  nodes["#speed"] = { value: "standard", disabled: false };
  const { api } = fixture(["renderSettingsSummary", "isCustomModelSelection", "selectedModelId"], { $: (id: string) => nodes[id] });
  api.renderSettingsSummary();
  assert.equal(nodes["#run-settings-summary"].textContent, "Agent 可修改 · 每次詢問 · 下回合 Standard");
  assert.equal(nodes["#run-settings-summary"].title, "model · high");
  nodes["#mode"].value = "plan"; nodes["#reviewer"].value = "auto_review";
  api.renderSettingsSummary();
  assert.equal(nodes["#run-settings-summary"].textContent, "Plan 唯讀 · 自動審核 · 下回合 Standard");
  nodes["#speed"].value = "fast"; api.renderSettingsSummary();
  assert.match(nodes["#run-settings-summary"].textContent, /下回合 Fast/);
  nodes["#speed"].disabled = true; api.renderSettingsSummary();
  assert.match(nodes["#run-settings-summary"].textContent, /速度暫不可變更/);
  assert.equal((html.match(/id="context-panel"/g) || []).length, 1);
  assert.equal((html.match(/id="add-text-artifact"/g) || []).length, 1);
});

test("widget sends manual speed for new turns, resets after success, and omits it for steer", async () => {
  const nodes: any = {};
  const $ = (id: string) => nodes[id] ??= { value: "", selectedOptions: [], checked: false, open: false, classList: { toggle() {} }, setAttribute() {} };
  $("#message").value = "Inspect"; $("#mode").value = "plan"; $("#reviewer").value = "auto_review";
  $("#classification").value = "personal"; $("#speed").value = "fast";
  const state: any = { selectedProjectId: "omi", selectedJob: null, draftArtifacts: [], status: { modelPresets: modelPresetCatalog([]) } };
  $("#model").value = "gpt-6.2-sol/medium";
  const calls: any[] = [];
  const { api } = fixture(["sendMessage", "syncSettingsFromJob", "renderComposerState", "startNewConversation", "isCustomModelSelection", "selectedModelId", "selectedModelPreset"], {
    state, $, isOperableProjectId: () => true, stageDraftArtifacts: async () => [], deriveTitle: (s: string) => s,
    makeId: () => "fixture-message", renderDraftArtifacts() {}, renderSettingsSummary() {}, renderModelOptions() {}, renderCompanyConfirmation() {},
    requestAnimationFrame() {}, resizeComposerInput() {},
    firstProjectId: () => "omi", syncWorkspacePanels() {}, render() {}, focusWithoutScroll() {},
    callTool: async (name: string, args: any) => { calls.push({ name, args }); return { workPackage: args, previewDigest: "fixture" }; },
  });
  await api.sendMessage();
  assert.equal(calls[0].name, "codex_job_preview"); assert.equal(calls[0].args.speed, "fast");
  assert.equal(calls[1].name, "codex_job_dispatch"); assert.equal(calls[1].args.speed, "fast");
  assert.equal($("#speed").value, "standard");
  state.selectedJob = { id: "job", status: "completed", speed: "fast" }; $("#message").value = "Next";
  await api.sendMessage();
  assert.equal(calls.at(-1).args.speed, "standard", "Previous job Fast must not become next-turn default");
  state.selectedJob = { id: "local", source: "local", localThreadId: "native", status: "completed" };
  $("#message").value = "Local follow-up"; $("#speed").value = "fast";
  await api.sendMessage(); assert.equal(calls.at(-1).args.localThreadId, "native"); assert.equal(calls.at(-1).args.speed, "fast");
  state.selectedJob = { id: "job", status: "running", speed: "fast" };
  $("#message").value = "Steer"; $("#speed").value = "fast";
  api.renderComposerState(); assert.equal($("#speed").disabled, true);
  await api.sendMessage(); assert.equal(calls.at(-1).args.speed, undefined);
  state.selectedJob.status = "completed"; api.renderComposerState(); assert.equal($("#speed").disabled, false);
  $("#speed").value = "fast"; api.syncSettingsFromJob(state.selectedJob);
  assert.equal($("#speed").value, "standard", "Switching conversation never restores its previous requested Fast");
  state.timelineSignatures = new Map(); state.draft = { speed: "fast" };
  api.startNewConversation("omi"); assert.equal($("#speed").value, "fast", "Explicit MCP draft selection is used once");
  api.startNewConversation("omi"); assert.equal($("#speed").value, "standard", "Next blank draft does not retain Fast");
  assert.match(html, /id="speed"[\s\S]*?<option value="standard">Standard/);
});

test("widget shows requested speed on projected messages without claiming actual tier", () => {
  const { api } = fixture([...renderHelpers, "legacyConversation"]);
  const history = api.legacyConversation([{ id: "u", role: "user", speed: "fast", content: "Inspect" }]);
  assert.equal(history.turns[0].items[0].speed, "fast");
  assert.match(api.renderProjectedMessage(history.turns[0].items[0], "u"), /請求速度 Fast/);
  assert.doesNotMatch(api.renderProjectedMessage({ type: "userMessage", text: "Old history" }, "old"), /請求速度/);
});

test("widget preserves each turn's submitted model and effort provenance, including defaults, legacy unknowns and steer", () => {
  const { api } = fixture([...renderHelpers, "legacyConversation"]);
  const rows = [
    { id: "explicit", role: "user", content: "Initial", model: "gpt-test", effort: "xhigh", selectionRecorded: true, selectionKind: "turn", modelSource: "explicit", effortSource: "explicit" },
    { id: "inherited", role: "user", content: "Continue", model: "gpt-test", effort: "xhigh", selectionRecorded: true, selectionKind: "turn", modelSource: "inherited", effortSource: "inherited" },
    { id: "default", role: "user", content: "Omitted", selectionRecorded: true, selectionKind: "turn", modelSource: "default", effortSource: "default" },
    { id: "old-known", role: "user", content: "Old known", model: "old-model", effort: "high" },
    { id: "old-unknown", role: "user", content: "Old unknown" },
    { id: "steer", role: "user", content: "Same turn", model: "gpt-test", effort: "xhigh", selectionRecorded: true, selectionKind: "steer", modelSource: "inherited", effortSource: "inherited" },
  ];
  const items = api.legacyConversation(rows).turns.flatMap((turn: any) => turn.items);
  assert.equal(items.length, rows.length);
  const rendered = new Map(items.map((item: any) => [item.id, api.renderProjectedMessage(item, item.id)]));
  assert.match(String(rendered.get("legacy:explicit")), /提交模型 gpt-test（明確提交） · 推理 極高（明確提交）/);
  assert.match(String(rendered.get("legacy:inherited")), /提交模型 gpt-test（沿用） · 推理 極高（沿用）/);
  assert.match(String(rendered.get("legacy:default")), /提交模型 預設（省略，交由預設） · 推理 預設（省略，交由預設）/);
  assert.match(String(rendered.get("legacy:old-known")), /提交模型 old-model（舊紀錄，來源未知）/);
  assert.match(String(rendered.get("legacy:old-unknown")), /提交模型 未知（舊紀錄，來源未知） · 推理 未知（舊紀錄，來源未知）/);
  assert.doesNotMatch(String(rendered.get("legacy:old-unknown")), /預設/);
  assert.match(String(rendered.get("legacy:steer")), /同回合補充 · 未變更模型或推理/);
  assert.doesNotMatch(String(rendered.get("legacy:steer")), /提交模型/);
});

test("Markdown renders headings, lists, tables, code and safe links without interpreting HTML", () => {
  const { api } = fixture(renderHelpers);
  const output = api.renderSafeMarkdown('# Title\n\n## Section\n- **bold** and `code`\n- *emphasis*\n\n3. third\n4. fourth\n\n| Name | Value |\n| --- | ---: |\n| A | `a|b` |\n| B | escaped\\|pipe |\n\n```js\nconst x = "<tag>";\n```\n\n[Docs](https://example.com/a?q=1&b=2)\n[Mail](mailto:dev@example.com)');
  for (const pattern of [/<h2>Title<\/h2>/, /<h3>Section<\/h3>/, /<ul>/, /<ol start="3">/, /<strong>bold<\/strong>/, /<em>emphasis<\/em>/, /<th scope="col">Name/, /<td><code>a\|b<\/code><\/td>/, /escaped\|pipe/, /&lt;tag&gt;/, /href="https:\/\/example.com\/a\?q=1&amp;b=2"/, /rel="noopener noreferrer"/, /href="mailto:/]) assert.match(output, pattern);
  assert.doesNotMatch(output, /<tag>/);
  assert.equal(api.renderSafeMarkdown(null), "");
  assert.equal(api.renderSafeMarkdown(""), "");
});

test("Markdown rejects script schemes, encoded schemes, raw HTML, SVG and attribute injection", () => {
  const { api } = fixture(renderHelpers);
  for (const href of ["javascript:alert%281%29", "JaVaScRiPt:foo", "data:text/html;base64,xxx", "vbscript:foo", "file:///C:/secret", "//evil.test", "javascript&#58;alert", "&#106;avascript:foo", "https://example.com/\"onclick=evil", "https://example.com/\\evil", "https://u:p@example.com", "https://example.com/\u0000", "https:\n//evil.test"]) {
    assert.equal(api.safeMarkdownUrl(href), "", href);
    assert.doesNotMatch(api.renderSafeMarkdown('[attack](' + href + ')'), /<a\s/, href);
  }
  for (const payload of ['<script>alert(1)</script>', '<img src=x onerror="alert(1)">', '<svg onload=alert(1)>', '<a href="javascript:evil" onclick="evil">x</a>', '<iframe srcdoc="evil">']) {
    for (const wrapper of [(s: string) => s, (s: string) => '`' + s + '`', (s: string) => '```html\n' + s + '\n```', (s: string) => '| x |\n| --- |\n| ' + s + ' |']) {
      const output = api.renderSafeMarkdown(wrapper(payload));
      assert.doesNotMatch(output, /<(?:script|img|svg|iframe|a)\b/);
      assert.match(output, /&lt;/);
    }
  }
  assert.match(api.renderSafeMarkdown('&lt;img src=x onerror=evil&gt;'), /&amp;lt;img/);
});

test("streaming partial Markdown and malformed tables preserve text; fences never parse markup", () => {
  const { api } = fixture(renderHelpers);
  assert.match(api.renderSafeMarkdown('```js\n<script>\n**raw**'), /&lt;script&gt;\n\*\*raw\*\*/);
  assert.match(api.renderSafeMarkdown('**unfinished [link](https://'), /\*\*unfinished/);
  assert.match(api.renderSafeMarkdown('| A | B |\n| --- | --- |\n| do | not | lose |'), /do.*not.*lose/);
  const partial = api.renderProjectedMessage({ type: "agentMessage", text: '```\nunsafe <b>', isStreaming: true }, 'x');
  assert.match(partial, /正在輸出/);
  assert.match(partial, /unsafe &lt;b&gt;/);
  assert.match(api.renderSafeMarkdown('~~~txt\r\nline\r\n~~~'), /<code>line<\/code>/);
});

test("panel visibility defaults, focus mode and responsive boundaries are UI only", () => {
  const state: any = { displayMode: "fullscreen", railCollapsed: false, inspectorOpen: false, focusMode: false };
  const window = { innerWidth: 1440 };
  const { api } = fixture(["workspacePanelState"], { state, window });
  assert.equal(api.workspacePanelState().rail, true);
  assert.equal(api.workspacePanelState().inspector, false);
  state.inspectorOpen = true;
  assert.equal(api.workspacePanelState().overlay, "");
  window.innerWidth = 900;
  assert.equal(api.workspacePanelState().overlay, "inspector");
  state.focusMode = true;
  assert.equal(api.workspacePanelState().rail, false);
  assert.equal(api.workspacePanelState().inspector, false);
  state.focusMode = false; state.inspectorOpen = false; window.innerWidth = 390;
  assert.equal(api.workspacePanelState().rail, false);
  state.railOverlayOpen = true;
  assert.equal(api.workspacePanelState().overlay, "rail");
  state.displayMode = "inline"; window.innerWidth = 1440;
  assert.equal(api.workspacePanelState().overlay, "rail");
});

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
  const { api } = fixture(["renderThreadControls", "requestedSelectionLabel", "tokenSummary", "metric", "escapeHtml", "controllerLabel", "effortLabel"], { state: { status: { controller: "ready" } } });
  const usage = { total: { totalTokens: 990000 }, last: { totalTokens: 100 }, modelContextWindow: 1000 };
  const rendered = api.renderThreadControls({ model: "requested", executionMode: "plan", approvalReviewer: "user", conversation: { tokenUsage: usage, modelRouting: { executedModel: "executed", fromModel: "requested" } } });
  assert.match(rendered, /提交模型 requested（舊紀錄，來源未知）/);
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
  assert.equal(calls.length, 4);
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
  assert.equal(calls.length, 4, "Render/poll and repeated clicks do not refetch heavy RPCs.");
  state.operatorRead.startedAt -= 31000;
  await api.loadOperatorStatus(false);
  assert.equal(calls.length, 8);
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

test("poll timeout, reconnect, instance reset, suspended page and obsolete selection keep the committed cursor", async () => {
  const id = crypto.randomUUID(), first = crypto.randomUUID(), second = crypto.randomUUID();
  const state:any = {selectionGeneration:1,bridgeInstance:first,selectedJob:{id,status:"running",stateVersion:2,
    conversation:{revision:9},nextConversationRevision:9,nextEventSeq:10}};
  const calls:any[] = [], saves:any[] = [];
  let reply:any = async () => { throw new Error("Host timeout"); };
  const document = {hidden:false};
  const {api} = fixture(["pollSelectedJob"],{state,crypto,performance,document,
    schedulePoll(){},readPollEvidence(){return null;},savePollEvidence(s:any){saves.push(s);state.lastPollEvidence=s;},
    callTool:async (_:string,args:any) => {calls.push(args);return reply();},showError(){},
    updateFromResponse:(r:any,reset:boolean) => {assert.ok(reset);state.selectedJob={...state.selectedJob,...r.structuredContent};}});
  await api.pollSelectedJob();
  assert.equal(saves.at(-1).outcome,"timeout");
  assert.equal(state.selectedJob.nextConversationRevision,9);
  reply = async () => ({_meta:{bridgeInstance:second},structuredContent:{id,nextConversationRevision:4}});
  await api.pollSelectedJob();
  assert.equal(calls.at(-1).recovery,"snapshot");
  assert.equal(calls.at(-1).poll.previous.outcome,"timeout");
  assert.equal(saves.at(-1).outcome,"gap");
  reply = async () => ({_meta:{bridgeInstance:second},structuredContent:{id,status:"running",messages:[],conversation:{revision:4},nextConversationRevision:4,stateVersion:1}});
  await api.pollSelectedJob();
  assert.equal(state.selectedJob.nextConversationRevision,4);
  assert.equal(saves.at(-1).outcome,"applied");
  document.hidden=true;
  await api.pollSelectedJob();
  assert.equal(calls.length,3);
  document.hidden=false;
  reply=async()=>{state.selectionGeneration++;return {};};
  await api.pollSelectedJob();
  assert.equal(saves.at(-1).outcome,"obsolete");
});
