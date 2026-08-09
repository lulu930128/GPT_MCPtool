import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";

const html = await readFile(new URL("../web/codex-console.html", import.meta.url), "utf8");
for (const marker of [
  'rpcRequest("ui/initialize"',
  'rpcNotify("ui/notifications/initialized"',
  'rpcRequest("tools/call"',
  'message.method === "ui/notifications/tool-result"',
  'state.pollInFlight',
  'setTimeout(pollSelectedJob, 2500)',
  'class="project-tree"',
  'data-project-toggle=',
  'class="thread"',
  'function renderMessages()',
  'codex_conversation_send',
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
  'data-approval=',
  'company-confirm-checkbox',
  '@media (max-width: 760px)',
  '@media (prefers-reduced-motion: reduce)',
  '--workspace-height: 720px',
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
assert.ok(!html.includes('type="file"'), "The core text shuttle must not depend on host file upload controls.");
const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(inlineScript, "Widget must include an inline bridge script.");
new Script(inlineScript, { filename: "codex-console.inline.js" });
console.log(JSON.stringify({ ok: true, bytes: Buffer.byteLength(html), bridge: "mcp-apps", remoteResources: 0 }, null, 2));
