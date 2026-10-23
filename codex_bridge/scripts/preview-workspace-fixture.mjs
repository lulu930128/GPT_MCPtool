// Offline visual fixture. No Bridge, App Server, account, project or tool IO.
// Run: node scripts/preview-workspace-fixture.mjs (prints an ephemeral loopback URL).
// Add --keep-alive for a manual preview; stop the printed PID when finished.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../web/codex-console.html", import.meta.url), "utf8");
const keepAlive = process.argv.includes("--keep-alive");
const markdown = [
  "## 第一輪 UX 檢查", "", "回覆支援 **重點**、標題、清單與 `inline code`。這是純離線資料。", "",
  "### 閱讀與操作", "- 對話清單可以收合，長標題保留兩行。", "- 工作紀錄按需展開，專注模式隱藏兩側欄。", "- 草稿與捲動位置應在切換側欄後保留。", "",
  "| 項目 | 狀態 | 說明 |", "| --- | --- | --- |", "| Markdown | 可閱讀 | 標題、清單與程式碼 |", "| 核准 | 保留 | 只核准這一次 |", "| Runtime | 未連線 | fixture 不呼叫正式 Bridge |", "",
  "```typescript", 'const message = "<script>不執行 HTML</script>";', 'console.log(message); // ' + "long-line-".repeat(20), "```", "",
  "1. 點選上方「專注」。", "2. 按 Esc 返回原本佈局。", "",
  "[安全連結範例](https://example.com) · 惡意連結保持文字：[blocked](javascript:alert%281%29)",
  '<img src=x onerror="alert(1)">', "", "原始 HTML 以文字顯示，沒有載入外部圖片。",
].join("\n");
const available = (data, truncated = false) => ({ status: "available", data, truncated });
const usage = { total: { totalTokens: 38420 }, last: { totalTokens: 2410 }, modelContextWindow: 128000 };
const job = {
  id: "00000000-0000-4000-8000-000000000001", projectId: "fixture", projectName: "Workspace UX fixture", title: "整理 Workspace 時間與工作紀錄", objective: "離線 UI fixture",
  status: "completed", stateVersion: 1, threadId: "fixture-thread", turnId: "turn-2", directActionHistoryEligible: true,
  executionMode: "workspace_write", approvalReviewer: "auto_review", dataClassification: "personal", model: "requested-model", effort: "high",
  createdAt: "2026-10-08T01:00:00.000Z", updatedAt: "2026-10-08T01:05:00.000Z", messages: [], approvals: [], events: [], artifacts: [],
  conversation: { schemaVersion: 1, threadId: "fixture-thread", status: "idle", revision: 1, tokenUsage: usage,
    modelRouting: { requestedModel: "requested-model", fromModel: "requested-model", executedModel: "executed-model", toModel: "executed-model", reason: "highRiskCyberActivity" },
    turns: [1, 2].map((n) => ({ turnId: "turn-" + n, status: "completed", startedAt: "2026-10-08T01:00:00.000Z", completedAt: "2026-10-08T01:05:00.000Z", durationMs: 300000, tokenUsage: usage, items: [
      { id: "u" + n, type: "userMessage", status: "completed", text: n === 1 ? "請保留真實的歷史時間，重新讀取不能顯示成現在。" : "把工作紀錄依回合整理，並保留必要的錯誤訊息。", createdAt: "2026-10-08T01:00:00.000Z" },
      { id: "cmd" + n, type: "commandExecution", status: "completed", command: "npm test", output: "Fixture tests passed", exitCode: 0, durationMs: 4000 },
      { id: "f" + n, type: "fileChange", status: "completed", changes: [{ path: "src/fixture.ts", kind: "update", diffPreview: "+ fixture only" }] },
      { id: "m" + n, type: "mcpToolCall", status: n === 1 ? "failed" : "completed", server: "fixture", tool: "read", ...(n === 1 ? { error: "Fixture: 資料暫時無法使用，錯誤應持續可見。" } : {}) },
      { id: "a" + n, type: "agentMessage", status: "completed", text: n === 2 ? markdown : "已保留原始訊息時間；技術活動預設收合。\n\n這是隔離 fixture，沒有呼叫 live runtime。\n可展開右側回合、搜尋左側對話，或開啟 Codex 狀態查看分項失敗。", createdAt: "2026-10-08T01:05:00.000Z" },
    ] })) }, nextConversationRevision: 1, serverConversationRevision: 1,
};
const summary = { conversationId: job.threadId, threadId: job.threadId, projectId: job.projectId, projectName: job.projectName, title: job.title, createdAt: job.createdAt, updatedAt: job.updatedAt, threadStatus: "idle", source: "mixed", bridgeJob: job, automations: [] };
job.artifacts = [{ id: "response", name: "response.md", bytes: Buffer.byteLength(markdown), sha256: "0".repeat(64), mimeType: "text/markdown" }];
const fixture = {
  status: { service: "codex-handoff-bridge", ok: true, controller: "ready", projects: [{ id: "fixture", name: job.projectName }], recentJobs: [job], models: [] },
  job, summary,
  usage: { rateLimits: available({ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1791507600 }, secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: null }, planType: "Fixture plan" }, rateLimitResetCredits: { availableCount: 2 }, rateLimitsByLimitId: null }), accountUsage: { status: "unavailable", code: "AUTH_UNAVAILABLE" } },
  runtime: { server: available({ process: { residentMemoryBytes: 104857600 }, gauges: [{ name: "active_threads", value: 0 }] }), windowsSandbox: available({ status: "ready" }), permissionProfiles: available([{ id: "plan", allowed: true }, { id: "workspace", allowed: true }]), modelProvider: available({ namespaceTools: true, imageGeneration: false, webSearch: true }) },
  inventory: { skills: available({ items: [{ name: "fixture-skill", scope: "project", enabled: true }], errorCount: 0, warningCount: 0 }, true), hooks: { status: "error", code: "INVALID_RESPONSE" }, mcpServers: available([{ name: "fixture-server", runtimeStatus: "connected", authStatus: "unknown", toolDiscoveryFailed: false }]) },
};
const wrapper = `<!doctype html><html lang="zh-TW"><meta charset="utf-8"><title>Workspace UX v2 · Offline fixture</title><style>html,body{height:100%;margin:0;background:#1c1d1f;color:#ececf1;font:12px Segoe UI}header{height:30px;display:flex;align-items:center;gap:18px;padding:0 12px}iframe{display:block;width:100%;height:calc(100% - 30px);border:0}button{font:inherit}</style><header>OFFLINE FIXTURE · 不連接 Bridge <button id="narrow">390px</button><button id="wide">Full width</button><span id="calls">RPC 0</span></header><iframe title="Workspace fixture" src="/app"></iframe><script>
const fixture=${JSON.stringify(fixture).replace(/</g, "\\u003c")};
const frame=document.querySelector('iframe'); let calls=0, mode='fullscreen'; window.fixtureCalls=[];
const scenario=document.createElement('button');scenario.id='scenario';scenario.textContent='核准 / 錯誤情境';document.querySelector('header').append(scenario);
scenario.onclick=()=>{fixture.job.status='awaiting_approval';fixture.job.approvalReviewer='user';fixture.job.approvals=[{id:'fixture-approval',kind:'command',state:'pending',summary:{command:'echo fixture-only'}}];fixture.job.conversation.turns[1].items.push({id:'fixture-error',type:'mcpToolCall',status:'failed',server:'fixture',tool:'read',error:'離線錯誤：需要使用者檢查'});fixture.job.conversation.turns[1].status='inProgress';fixture.job.stateVersion++;frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:fixture.job}},'*')};
document.querySelector('#narrow').onclick=()=>{frame.style.width='390px';context()};
document.querySelector('#wide').onclick=()=>{frame.style.width='100%';context()};
function context(){frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{displayMode:mode,containerDimensions:{width:frame.clientWidth,height:frame.clientHeight}}},'*')}
addEventListener('message',async event=>{if(event.source!==frame.contentWindow)return; const m=event.data; if(!m.id)return; let result={};
if(m.method==='ui/initialize')result={hostCapabilities:{},hostContext:{displayMode:mode,containerDimensions:{width:frame.clientWidth,height:frame.clientHeight}}};
if(m.method==='ui/request-display-mode'){mode=m.params.mode;result={mode};context()}
if(m.method==='tools/call'){calls++;document.querySelector('#calls').textContent='RPC '+calls; const n=m.params.name;window.fixtureCalls.push({name:n,args:m.params.arguments});
let data=n==='codex_bridge_status'?{...fixture.status,job:fixture.job}:n==='codex_unified_conversation_list'?{conversations:[fixture.summary,...Array.from({length:22},(_,i)=>({...fixture.summary,conversationId:'history-'+i,title:'歷史對話 '+(i+1)+'：檢查對話清單在窄畫面中的標題換行與閱讀層級',bridgeJob:undefined}))],reset:true}:n==='codex_unified_conversation_get'?{unifiedConversation:{...fixture.summary,conversationId:m.params.arguments.conversationId,view:fixture.job}}:n==='codex_job_get'?fixture.job:n==='codex_usage_status'?fixture.usage:n==='codex_runtime_status'?fixture.runtime:n==='codex_inventory'?fixture.inventory:{jobId:fixture.job.id,accepted:true};
if(n==='codex_approval_decide'){fixture.job.approvals[0].state=m.params.arguments.decision==='accept'?'accepted':'declined';fixture.job.status='completed';fixture.job.stateVersion++;data=fixture.job}
if(n.startsWith('codex_direct_thread_')){fixture.job.status='preparing';fixture.job.stateVersion++;fixture.job.conversation.status='active'}
if(n==='codex_text_bundle_begin')data={bundleId:'fixture-bundle'};
if(n==='codex_conversation_send'){
 await new Promise(resolve=>setTimeout(resolve,250));
 const text=m.params.arguments.message;
 if(text.includes('[fixture-error]')){event.source.postMessage({jsonrpc:'2.0',id:m.id,result:{isError:true,content:[{type:'text',text:'離線測試：送出失敗，草稿已保留'}]}},'*');return}
 fixture.job.conversation.turns.push({turnId:'fixture-send-'+calls,status:'completed',items:[{id:'user-'+calls,type:'userMessage',status:'completed',text},{id:'reply-'+calls,type:'agentMessage',status:'completed',text:'離線 fixture 已收到訊息；沒有呼叫正式 Bridge。'}]});
 fixture.job.conversation.revision++;fixture.job.stateVersion++;fixture.job.nextConversationRevision=fixture.job.conversation.revision;fixture.job.serverConversationRevision=fixture.job.conversation.revision;data=fixture.job;
}
result={structuredContent:data};}
if(m.method==='tools/call'&&m.params.name==='codex_artifact_read_chunk')result={structuredContent:{artifact:{name:'response.md',mimeType:'text/markdown',nextCursor:null}},_meta:{artifactContent:fixture.job.conversation.turns[1].items.find(x=>x.type==='agentMessage').text}};
event.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');});
</script></html>`;
const server = createServer((request, response) => {
  if (request.method !== "GET" || !["/", "/app"].includes(request.url)) {
    response.writeHead(404, { "cache-control": "no-store" }); response.end("Not found"); return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'" });
  response.end(request.url === "/app" ? app : wrapper);
});
server.listen(0, "127.0.0.1", () => console.log(`OFFLINE_FIXTURE http://127.0.0.1:${server.address().port} PID=${process.pid} KEEP_ALIVE=${keepAlive}`));
if (!keepAlive) setTimeout(() => server.close(), 15 * 60 * 1000).unref();
