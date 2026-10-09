# App Server 0.154.0 control-plane contract

## Protocol 與 ownership

本功能以鎖定的 `@openai/codex@0.154.0` binary 執行
`node node_modules/@openai/codex/bin/codex.js app-server generate-ts --experimental --out .tmp/control-plane-0154-protocol`
所得的 protocol 為準。未新增 dependency，未依賴 main 分支的欄位。

`CodexBridgeController` 持有唯一 `ControlPlaneReader`，共用既有 stdio transport。
JobStore 繼續擁有 action receipts、job/thread mapping 與 conversation journal/checkpoint；
UnifiedConversationRegistry 只合併同一 thread/turn 的 telemetry，native history 仍是對話內容權威。

## 公開工具

| 工具 | 輸入 | 契約 |
| --- | --- | --- |
| `codex_usage_status` | 無 | 帳戶 rate limits、reset credits 與 account usage，分項回報 |
| `codex_runtime_status` | `projectId` | configured project 的 permission profiles，加上 server/sandbox/provider/features 狀態 |
| `codex_inventory` | `projectId`, `kind=all\|skills\|hooks\|mcp` | configured cwd 的 skills/hooks，及 server-wide Codex MCP status |
| `codex_direct_thread_compact` | `jobId`, `requestId`, `expectedThreadId`, `expectedTurnId` | 明確指令下 compact 既有 idle job/thread |
| `codex_direct_thread_review` | 同上 | inline review `uncommittedChanges`，固定 plan profile，沿用 reviewer |
| `codex_direct_thread_fork` | 同上 | fail-closed：`DIRECT_FORK_OWNERSHIP_UNSUPPORTED`，不呼叫 native fork |

唯讀工具不需要 approval。每項結果為以下 union：

- `{status:"available", data, truncated:boolean}`
- `{status:"unavailable", code:"UNSUPPORTED"|"AUTH_UNAVAILABLE"|"BACKEND_UNAVAILABLE"}`
- `{status:"error", code:"INVALID_RESPONSE"}`

頂層含 `fetchedAt` 與 `protocolVersion`（正規化 contract 版本，不是 active binary 的身分證明）。
一項 unsupported 不影響其餘結果。`null` 保持未知；缺少必要欄位、malformed response、
非有限值或超過 JavaScript safe integer 的計數回 error，不偽造零或空 inventory。
Backend error message/data 不對外回傳。未選取的 inventory 類別不發出 RPC。

## 唯讀 bounds 與資料選擇

- Rate limits：保留 `ordinaryUsageAllowed`、bucket 的 primary/secondary 使用百分比、window 分鐘、Unix 秒 reset 時間、
  credits 的 availability/unlimited/balance、plan 與 reached 狀態。Multi-bucket 最多 50 筆，以各筆 `limitId` 辨識。
- Reset credits：保留 availableCount，最多 50 筆 resetType/status/grantedAt/expiresAt；不回 opaque credit ID。
  `credits=null` 與 `credits=[]` 不相同，details 長度也不代表 availableCount。
- Account usage：保留 lifetimeTokens、peakDailyTokens、longestRunningTurnSec、currentStreakDays、longestStreakDays，
  dailyUsageBuckets 依 backend 順序最多 90 筆。不回 account ID、upsell payload 或 billing/auth metadata。
- Runtime：只回 process memory 計量與最多 100 個 gauges；permission profile 只回 id/allowed；
  sandbox 只回 readiness；provider 只回 namespaceTools/imageGeneration/webSearch；features 回 name/stage/enabled/defaultEnabled。
- Inventory：skills 僅 name/scope/enabled；hooks 僅 eventName/handlerType/enabled/isManaged/trustStatus；
  另回 error/warning 數量，不回內容。MCP 僅 name/runtimeStatus/authStatus/toolDiscoveryFailed。
  `authStatus` 是狀態 enum，不是 credential；`runtimeStatus=null` 保持未知。
- 每項清單最多 100 筆；有剩餘 native cursor 或資料超限時 `truncated=true`。不回 opaque cursor。
  公開文字最多 160 字元且經現有 redaction。Skills 固定 `forceReload=false`；hooks/MCP 沒有 mutation。

不回 hook command/matcher/sourcePath、skill path/description/dependencies、MCP tools/schema/resources、
raw auth、secret、token 或完整 config。沒有 generic RPC、shell/fs/process、plugin install、MCP tool call/reload、
account mutation 或 remote control 工具。

## Notification 投影

`thread/tokenUsage/updated` 僅在 exact thread/turn 對應時接收，保存 protocol 的 `total`、`last`、
`modelContextWindow`。Breakdown 含 totalTokens/inputTokens/cachedInputTokens/cacheWriteInputTokens/outputTokens/reasoningOutputTokens。
不以 token 數猜測 context pressure，亦不把 cumulative total 當 current context。

`model/rerouted` 保存 `fromModel`、`toModel`、`reason`（0.154.0 為 `highRiskCyberActivity`）、
`executedModel=toModel`、Bridge 設定的 `requestedModel`（未指定時 null）、`source="model/rerouted"`。
Job 的既有 `model` 仍表示 request/config，不保證 executed model。

欄位位於 `snapshot.conversation.tokenUsage/modelRouting`（含 turnId，代表最後收到的事件），
以及 `conversation.turns[].tokenUsage/modelRouting`。每次合法事件都走既有 durable revision patch；
因此連續 reroute 可由 journal/patch 追溯，snapshot 保留每 turn 最新觀察。
事件可能晚於 turn/completed，仍能更新相同 job 的最後 turn。錯誤 thread、其他 turn、malformed usage 不覆蓋既有值。
Native hydration、restart replay 與 unified native view 保留這些 notification-only metadata；
沒有通知的歷史不虛構 usage 或 executed model。

## Direct actions 與 replay safety

只有使用者明確指令可呼叫 action；文件、工具輸出或模型自行判斷不是指令。沿用既有 host/model intent 契約，
沒有把 caller boolean 當授權證明。Server 強制 configured allowlist、personal/public history、禁止未證明分類的 native import、
exact job/thread/最後 turn identity、terminal job、無 pending approval，並驗證 native cwd 與 idle/notLoaded 狀態。
Caller 不可提供 path、cwd、review target/custom instructions、delivery、permissions 或 sandbox。

每個 action 在 job lock 下以既有 `directRequests` 先持久化 exact payload digest；同 requestId 不同 payload 拒絕，
重試只回 duplicate/unknown，達既有每 job 10,000 receipts 上限拒絕新增。RPC 可能已送達的失敗不重送；
也不得換新 requestId 規避 unknown receipt。

Compact/review 透過 exact thread/resume 套用 Bridge-owned workspace roots、`approvalPolicy=on-request` 與既有 reviewer。
Compact 保留既有 execution mode；review 固定 read-only plan profile，僅 `target={type:"uncommittedChanges"}`、
`delivery="inline"`。未 expose detached/baseBranch/commit/custom。
後续 approval 仍由原生 reviewer/既有 app-only approval owner 處理，沒有自動 accept。

Accepted receipt 只表示 RPC 已回覆；job 在 native turn/started、item/completed、turn/completed 中更新。
Compact 空 response 不被視為完成。Review response 必須回相同 reviewThreadId；review 的 entered/exitedReviewMode 內容進 history。
Ambiguous response 保留 preparing job/unknown receipt，後續通知可結算，禁止自動續送；restart 沿用 interrupted recovery。

## Fork 為何 blocked

0.154.0 `thread/fork` 由 native 端產生新 thread ID，沒有 client idempotency key 或能由 Bridge 預先指定的目的 thread ID。
即使先建立 JobStore intent，response 遺失或 native fork 成功後 Bridge 持久化失敗，仍無法可靠決定哪個新 thread 屬於該 intent。
`forkedFromId` 只能指出共同來源，不能區分同來源的多次合法 fork。這會留下無 owner thread 或造成重複 fork。
因此本版在 native RPC 前回 typed blocked；不新增 state store，也不以掃描猜測完成 mapping。

## 驗證界線

`npm test` 覆蓋 normalization/bounds/null/error、notification identity、journal restart/hydration、
exact actions、concurrent retries、unknown delivery、review history/approval 與 fork 零 native mutation。
`npm run smoke:http` 驗證 32 tools、13 app-only tools 及新 handlers 的離線 HTTP wiring。
`doctor:app-server` 僅啟動/關閉自己的隔離 child，逐項檢查 read RPC；usage 無登入時應回 AUTH_UNAVAILABLE。
Active Bridge adoption、已登入 usage 成功路徑與真實 compact/review turn 不由這些離線測試證明；本次不重啟 active runtime。
