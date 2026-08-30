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
assert.ok(!html.includes("—"), "Widget visible text must not use em dashes.");
assert.ok(!html.includes('class="status-strip"'), "Widget must not restore the redundant dashboard status strip.");
assert.ok(!html.includes('class="event-list'), "Technical event logs must stay out of the primary widget UI.");
assert.ok(!html.includes("function renderEvent"), "Technical event renderers must stay out of the primary widget UI.");
assert.ok(!html.includes("100vh") && !html.includes("100dvh"), "Widget root must not couple its intrinsic height to the host iframe viewport.");
assert.ok(!html.includes("min-height: 100%"), "Widget body must remain shrinkable inside an auto-sized host iframe.");
assert.ok(!html.includes('setProperty("--workspace-height", "720px")'), "Inline mode must not restore a hard-coded workspace height.");
assert.ok(!html.includes('type="file"'), "The core text shuttle must not depend on host file upload controls.");
assert.ok(!html.includes("data.complete === true && !data.nextCursor"), "A final pagination response must not discard previously loaded conversations.");
assert.ok(!html.includes("localThreads") && !html.includes("localHistoryCursor") && !html.includes("selectLocalThread"), "Legacy dual-inventory widget state must stay removed.");
assert.match(html, /<body data-display-mode="inline" data-ledger="project-ledger" data-theme="night-shift">/, "Widget must expose its display mode and dark visual system.");
assert.match(html, /const replaceRegistry = data\.reset === true;/, "Only an explicit first-page marker may replace the unified registry.");
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
console.log(JSON.stringify({ ok: true, bytes: Buffer.byteLength(html), bridge: "mcp-apps", remoteResources: 0 }, null, 2));
