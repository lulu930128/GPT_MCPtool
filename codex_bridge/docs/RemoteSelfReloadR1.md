2026-10-13：本機 installed runtime 與 operator 工具的目前規格見 [R1 G2 操作頁](../../mcp_control_center/docs/R1G2Operator.md)。正向 source path 已接通，G2 尚未部署；真正 ChatGPT host 與 OS/plugin isolation 未驗收，遠端核准維持關閉。

# Remote Self-Reload R1：Bridge 契約

2026-10-12 後續 source 修復：目前新增 UI **候選** `src/self-reload/ui.html` 固定回
`HOST_NOT_VERIFIED`，拒絕 request／核准／enrollment；原 `web/self-reload.html` 未被覆寫，以保留 live canonical。
只在隔離 candidate 執行 `node scripts/stage-self-reload-ui.mjs --isolated-candidate`。
G1 binding 尚未完成，**不可採用本候選**；見 [安裝阻擋與驗證](../../mcp_control_center/docs/R1InstalledRelease.md)。

**NOT_DEPLOYED**。目前 live 仍是舊版，沒有六個 R1 tools；下列是本次 source/offline contract。

| 工具 | 可見性 | readOnlyHint | 輸入／用途 |
| --- | --- | --- | --- |
| `codex_self_reload_status` | model + app | true | 空輸入；owner deployment 狀態，開啟 R1 操作卡 |
| `codex_self_reload_preview` | model + app | true | 空輸入；核對 PID、live/desired build，回 preview digest |
| `codex_self_reload_request` | model + app | false | idempotencyKey 16–80、previewDigest、ttlSeconds 60–1800；只建立固定請求 |
| `codex_self_reload_receipt` | model + app | true | requestId；重啟後查同一筆收據 |
| `codex_self_reload_challenge` | app only | true | requestId + digest；取得 exact WebAuthn challenge |
| `codex_self_reload_approve` | app only | false | requestId + digest + ES256 assertion；真人確認 |

所有 schema 都拒絕額外欄位。沒有 caller command、path、port、cwd、env、component 或 action。
app-only metadata 由 host 過濾；server 仍要求真的 authenticator assertion，不能靠文字標記核准。
Approval 不共用 `codex_approval_decide`／JobStore job ownership。Remote Privileged Broker V1 的 status/preview
與 fail-closed 行為未改；R1 不部署 general elevated broker。

MCP Apps resource：`ui://codex-bridge/self-reload-r1.html`。既有 conversation widget v15 保留原樣。
操作卡列 exact PID、live/target Build ID、digest、expiry；checkbox + click 後才發起 passkey ceremony。
host 不明確允許 WebAuthn 時顯示 BLOCKED；沒有文字核准 fallback。

localStorage 只保存 retry identity，不是 grant。重新連線先查舊收據。已完成或執行前安全失敗可按
「開始新的一筆」；按鈕會重新查收據，再清舊 key 並要求新 preview。unknown／dispatching／running
不得清 key 或自動重送。遠端收據的 schema 與 host cache 證據分開，local completed 不表示 ChatGPT host 已更新。

JobStore admission fence 與 create/import/append/prepare 共用同一把 lock；`/health.jobs.scope=all`，
active／awaitingApproval 不再只看最近 20 筆，pending approvals 也會阻擋。drain 的 owner receipt 未知時保持 fence。
簽章拒絕或 delivery error 透過 owner 原子 resolve 確認「永不核准」後才清 fence；並行 accepted receipt 不會提前清除。

Bridge 自身不啟動 executor。固定 PowerShell helper 是 authenticated named-pipe client，僅驗證獨立 tray
並傳 JSON；controller 實際執行權仍在 CC runspace。Helper 讀不到 receipt store／policy／token。
Codex 的 read-only/workspace profiles 明確 deny `%LOCALAPPDATA%\McpControlCenter`；不修改原本 permission reviewer。

驗證：`npm test`、`npm run smoke:http`、`npm run widget:check`。新增 tests 含完整 synthetic owner
process、MCP HTTP session reconnect、UI event fixture、expired/replay/forgery/concurrency/crash/store failure。
瀏覽器 fixture 可用 `node scripts/preview-self-reload-fixture.mjs`；它是 deliberately host-denied 合成介面，沒有 lifecycle authority。

正規 operator bootstrap、同帳號信任限制、受保護程式／state ACL、passkey enrollment、回滾及詳細證據見
[Control Center R1 文件](../../mcp_control_center/docs/RemoteSelfReloadR1.md)。本輪未修改 root README，遵守只改兩元件的限制；
此功能新增的跨元件 runtime 依賴是上述固定 pipe 與公開 native IPC verifier source，沒有跨元件 domain data。
