// Offline visual fixture. No Bridge, App Server, account, project or tool IO.
// Run: node scripts/preview-workspace-fixture.mjs (prints an ephemeral loopback URL).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../web/codex-console.html", import.meta.url), "utf8");
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
      { id: "a" + n, type: "agentMessage", status: "completed", text: "已保留原始訊息時間；技術活動預設收合。\n\n這是隔離 fixture，沒有呼叫 live runtime。\n可展開右側回合、搜尋左側對話，或開啟 Codex 狀態查看分項失敗。", createdAt: "2026-10-08T01:05:00.000Z" },
    ] })) }, nextConversationRevision: 1, serverConversationRevision: 1,
};
const summary = { conversationId: job.threadId, threadId: job.threadId, projectId: job.projectId, projectName: job.projectName, title: job.title, createdAt: job.createdAt, updatedAt: job.updatedAt, threadStatus: "idle", source: "mixed", bridgeJob: job, automations: [] };
const fixture = {
  status: { service: "codex-handoff-bridge", ok: true, controller: "ready", projects: [{ id: "fixture", name: job.projectName }], recentJobs: [job], models: [] },
  job, summary,
  usage: { rateLimits: available({ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1791507600 }, secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: null }, planType: "Fixture plan" }, rateLimitResetCredits: { availableCount: 2 }, rateLimitsByLimitId: null }), accountUsage: { status: "unavailable", code: "AUTH_UNAVAILABLE" } },
  runtime: { server: available({ process: { residentMemoryBytes: 104857600 }, gauges: [{ name: "active_threads", value: 0 }] }), windowsSandbox: available({ status: "ready" }), permissionProfiles: available([{ id: "plan", allowed: true }, { id: "workspace", allowed: true }]), modelProvider: available({ namespaceTools: true, imageGeneration: false, webSearch: true }) },
  inventory: { skills: available({ items: [{ name: "fixture-skill", scope: "project", enabled: true }], errorCount: 0, warningCount: 0 }, true), hooks: { status: "error", code: "INVALID_RESPONSE" }, mcpServers: available([{ name: "fixture-server", runtimeStatus: "connected", authStatus: "unknown", toolDiscoveryFailed: false }]) },
};
const wrapper = `<!doctype html><html lang="zh-TW"><meta charset="utf-8"><title>Workspace UX v2 · Offline fixture</title><style>html,body{height:100%;margin:0;background:#111820;color:#ccd6dc;font:12px Segoe UI}header{height:30px;display:flex;align-items:center;gap:18px;padding:0 12px}iframe{display:block;width:100%;height:calc(100% - 30px);border:0}button{font:inherit}</style><header>OFFLINE FIXTURE · 不連接 Bridge <button id="narrow">390px</button><button id="wide">Full width</button><span id="calls">RPC 0</span></header><iframe title="Workspace fixture" src="/app"></iframe><script>
const fixture=${JSON.stringify(fixture).replace(/</g, "\\u003c")};
const frame=document.querySelector('iframe'); let calls=0, mode='fullscreen';
document.querySelector('#narrow').onclick=()=>{frame.style.width='390px';context()};
document.querySelector('#wide').onclick=()=>{frame.style.width='100%';context()};
function context(){frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{displayMode:mode,containerDimensions:{width:frame.clientWidth,height:frame.clientHeight}}},'*')}
addEventListener('message',event=>{if(event.source!==frame.contentWindow)return; const m=event.data; if(!m.id)return; let result={};
if(m.method==='ui/initialize')result={hostCapabilities:{},hostContext:{displayMode:mode,containerDimensions:{width:frame.clientWidth,height:frame.clientHeight}}};
if(m.method==='ui/request-display-mode'){mode=m.params.mode;result={mode};context()}
if(m.method==='tools/call'){calls++;document.querySelector('#calls').textContent='RPC '+calls; const n=m.params.name;
let data=n==='codex_bridge_status'?{...fixture.status,job:fixture.job}:n==='codex_unified_conversation_list'?{conversations:[fixture.summary,...Array.from({length:22},(_,i)=>({...fixture.summary,conversationId:'history-'+i,title:'歷史對話 '+(i+1),bridgeJob:undefined}))],reset:true}:n==='codex_unified_conversation_get'?{unifiedConversation:{...fixture.summary,view:fixture.job}}:n==='codex_job_get'?fixture.job:n==='codex_usage_status'?fixture.usage:n==='codex_runtime_status'?fixture.runtime:n==='codex_inventory'?fixture.inventory:{jobId:fixture.job.id,accepted:true};
if(n.startsWith('codex_direct_thread_')){fixture.job.status='preparing';fixture.job.stateVersion++;fixture.job.conversation.status='active'}
result={structuredContent:data};}
event.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');});
</script></html>`;
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(request.url === "/app" ? app : wrapper);
});
server.listen(0, "127.0.0.1", () => console.log(`OFFLINE_FIXTURE http://127.0.0.1:${server.address().port}`));
setTimeout(() => server.close(), 15 * 60 * 1000).unref();
