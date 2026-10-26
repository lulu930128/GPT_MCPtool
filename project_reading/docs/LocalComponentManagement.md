# Workspace → 現有 Control Center 本機維護

目前 source contract 為 `2026-10-14.2`，新增唯讀工具見 [runtime 診斷](RuntimeDiagnostics.md)。
2026-10-25 live Workspace 已是此 contract、build `68edcbe8df019eeeb148`，人工維護已啟用。
本次確認 selected installed CC 的 v4 Tray 仍只初始化 v3 receiver，且缺少 native DLL，
因此固定 pipe 不存在、status 只有 TCP fallback。Source v4 修補通過隔離驗證，尚未採用。
Canonical operator Preflight 實際拒絕 `INDEPENDENT_OPERATOR_REQUIRED`；Bridge 仍有 active job。
完整證據與最小操作員步驟見 [2026-10-25 接續紀錄](agent-runs/seven-component-restart/Progress.md#2026-10-25-installed-v4-接續)。
以下保留先前 `2026-10-14.1` 維護工作當時的驗證紀錄，並非本次 runtime 實測：
當時 live MCP 唯讀查詢為 `2026-10-13.3`、build `4a4248981e4a44e2e7ea`；
CC ownerChannel 為 `IPC_TIMEOUT`，不能以 source build 或七個 TCP_CONNECTED 宣稱可重啟。

## 已修訂的需求與單一 owner

使用者明確取消額外真人 identity attestation、WebAuthn、password、跨 SID 與
`C:\Program Files\McpControlCenterG2` 部署前提。現有 authenticated Workspace
互動就是入口；確認「允許中斷目前請求」是操作語意，不是另一套身分驗證。

現有 `scripts/tray.ps1` 取得原 `Local\McpControlCenterTray` mutex 後，才在同一程序
開啟 `mcpcc-workspace-local-v1`。沒有第二個 manager、常駐 launcher 或新自動 restart。
Source 支援 registry schema 3／4；v4 在既有 installed activation 後載入同一 release 的
`WorkspaceLocal.Native.dll`，不動態編譯、不增加 activation gate。既有 installed R1／NORMAL／ADMIN 路徑未改變。
pipe 限本機、目前使用者，first-instance 且跨 request 保持 handle；不調整現有檔案／OS ACL。
這不是獨立的 source attestation：`ownerVerified=false`、`SAME_USER_LOCAL_IPC`
刻意保留，不能用來防禦同一 Windows 使用者已被攻陷的情境。

## 工具與結果

| 工具 | 行為 |
| --- | --- |
| `mcp_component_status` | 七個固定 ID；讀 tray 既有、最多 90 秒的快照，帶逐列 observedAt。無 query-triggered probe／CLI Status／state 或 event 寫入。不可用時回 G1 固定 TCP 觀察，明確 UNVERIFIED。 |
| `mcp_component_preview` | 五個既有固定 action；只說明 capability、觀測狀態、人工確認或未啟用的 component policy；不建立 request。 |
| `mcp_component_receipt` | 固定 UUID 唯讀 lookup；找不到為 found=false，不代表先前一定沒執行。儲存失效為 RECEIPT_UNAVAILABLE；UNKNOWN 不是完成。 |
| `mcp_component_restart` | 只有七白名單 componentId / reload_runtime / interrupt_current_requests / UUID。destructiveHint=true；其他目標或額外 command/path/URL/env 一律 schema 拒絕。 |

七個 status／preview／restart 目標：`codex_bridge`、`omi_search`、`japanese_study`、`memory_core`、
`personal_asset_os`、`english_study`、`listening_audio`。排除 `project_reading`、`mcp_control_center`。
每次只處理一個元件；包含 Codex Bridge active jobs／pending approvals 的既有拒絕政策仍有效。
正式 `registry.json` 的八個 descriptor 均為 component-controller，七目標固定映射到各自的
`scripts/runtime-control.ps1 -Action ReloadRuntime`。舊 `components.json` 只有六筆，
其中五筆 legacy-tray 仍以既有 `reload_runtime -> restart` 映射保留作 rollback，
不是目前正式 registry；本輪不啟動 legacy tray，也不修改映射或 descriptor。

目前 source 共 37 tools，啟用檔案 operate mode 時 43（新增兩個唯讀 runtime 診斷）。檔案 read-only mode 與單一維護工具分開；
STDIO／未驗證 HTTP 的 restart 回 `AUTHENTICATED_TRANSPORT_REQUIRED`，不接觸 pipe。
維護重用現有 `WORKSPACE_MCP_HTTP_TOKEN`（至少 32 字元）及 loopback HTTP transport；
不讀出 token、不建立新 credentials。既有 bearer 檢查逐 request 執行，browser Origin 拒絕。
`/health.manualMaintenanceEnabled` 可確認此 server 的 transport 是否已具備維護入口。
若目前只依賴 tunnel 外層 auth 而沒有既有 HTTP token，這個入口仍未啟用；不可假稱已可 restart。

`NOT_DEPLOYED`／channel unavailable／不支援的維護條件是結構化結果，不當成
`INVALID_ARGUMENT`。`ok=true` 表示成功取得或表達結果，不表示服務健康、允許 mutation 或重啟成功。

## 明確人工維護與收據

PAOS 沒有可採用的 active-work／drain contract：原 controller 的
`Assert-PaosMutationPreflight` 檢查角色 ownership，隨後 stop/start。本次依使用者修訂，
允許人工確認中斷；不假裝 active requests=0，也不新增全域 drain attestation。
CC 只呼叫既有 `Invoke-McpCcComponentAction`，保持 component-specific manager mutex，
最後由各元件 controller 再查 PID／start／exact ownership；unknown 或 mismatch 仍拒絕。
確認中斷不會覆蓋 Codex Bridge 的 `ACTIVE_WORK_PRESENT`／`ACTIVE_STATE_UNKNOWN`。
原 CC action delegation 中 `$pid` 撞到 PowerShell 唯讀 `$PID` 的既有錯誤，已用原函式
本體 fixture 重現並將四個引用改名；沒有替换 lifecycle owner 或取消 safety check。

收據位於既有 private RuntimeRoot 的 `workspace-local-receipts/<uuid>.json`。
只有 explicit restart 會建立目錄／收據；status／preview／receipt 查詢不寫入。
`UNKNOWN` 使用 CreateNew + Flush(true) 持久化後才 enqueue；完成採 atomic replace。
同一 requestId 永不重新 enqueue，包含 response timeout、tray crash／重開、已完成與未完成。
Reserve 保存實際 componentId；Read 只接受七白名單。相同 UUID 換 componentId／action／
confirmation 回 `REQUEST_CONFLICT`，receipt／completed／found 均為 null，原收據不變。
TS 對所有 restart receipt（包含 REQUEST_REPLAY）再精確比對這三欄；不符即
`IPC_INVALID_RESPONSE`／`DELIVERY_UNKNOWN`，不能拿舊目標的 COMPLETED 充當新目標成功。
唯讀 receipt lookup 仍以 UUID 返回原始 target；未知或衝突不得換新 UUID 重送。
最多一件 active request；其他新 ID 回 ACTION_BUSY。排隊超過 30 秒不再 dispatch，
原收據維持 UNKNOWN。沒有背景補跑或自動 retry。

最多保留 256 個目錄項目（含未完成 atomic update），不自動刪除去重鍵；滿額為
RECEIPT_CAPACITY，需人工查核／設計保留政策，不能直接刪除 UNKNOWN 後重試。
COMPLETED 只代表原 controller 回傳成功且 exitCode=0，不代表 ChatGPT E2E 或 domain 驗收。
controller error／timeout／crash／結果儲存失敗都維持 UNKNOWN；不得以新 ID 重送。
pipe 每次 1800ms、16 KiB response、2 個 Workspace concurrent calls、無 client retries。

## Runtime 採用界線

以下保留 2026-10-14 的授權範圍與操作紀錄；2026-10-25 的部署授權、實測與阻擋以上方接續紀錄為準。

本輪已授權 Workspace 單次正式重啟，但沒有授權重啟七個 MCP 或替換 CC tray。
先核對既有 host-owned CC、controller owner／IPC／權限，以及 launch ancestry 可存活；
僅在可證明的既有 owner 路徑下，才可執行一次 `project_reading` 的正式 Restart。
目前 live IPC_TIMEOUT，且此 session 不允許存取 CC private runtime，因此停在 BLOCKED，
沒有派送 Restart，也沒有另起 Codex child／detached tray／server 或繞過 Job Object。
CC Native assembly 的新契約也必須由既有 CC 採用；只重啟 Workspace 不等於 CC 已更新。

恢復既有 owner 通道後，由 host operator 核對既有 CC 確實執行新 Native assembly，
再於已授權窗口經 CC tray 的 Workspace Restart MCP 執行一次。若走正式 CLI，必須
從已證明不屬於短命 Codex Job Object 的 host context 執行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\GPT_MCPtool\mcp_control_center\scripts\control-center.ps1 -Action Restart -Component project_reading
```

失敗即停止，不改 ACL、不另起 server、不自動重送；不可把 Workspace 加入遠端 allowlist。
完成後以 `/health`、`workspace_info` 與 fresh authenticated MCP discovery 核對
contract `2026-10-14.2`、新 buildId／runtimeStartedAt、restart 七目標 schema，並確認
`manualMaintenanceEnabled`。七元件 status／preview 仍為唯讀，ownerVerified=false。
要真正重啟其中任一 MCP，仍須當次明確使用者指示與中斷確認，本輪沒有執行。

## 本輪 source 驗證與回退

本輪命令、結果與完整變更清單見 [Progress](agent-runs/seven-component-restart/Progress.md)。
本輪已執行正式 `npm run build` 更新 dist；source/build 與 runtime adoption 分開驗收。
以下為先前 local-component-management 的歷史回退資料，不適用於本轮改動：
舊 G1 E2E 與 G2 30 tests／70 checks／interop 證據保留為歷史，不算本次 live acceptance。
舊 `ReadOnlyG2.Native.cs`／`McpControlCenter.ReadOnlyG2.psm1` 未刪除，只有 deprecated 註記；
現有 tray 不 import 它們，Workspace 不再連舊 G2 pipe。

本輪起始 bytes、277 檔 SHA-256、原 dirty diff 位於 ignored
`project_reading/.tmp/local-management-review/`；`task-changes.json`、`task.patch`、
`rollback.ps1` 只針對這一輪實際變動。回退先執行 `rollback.ps1` 預覽，核對後才
`rollback.ps1 -Apply`；script 會先檢查所有目標仍是本輪結束 hash，任一檔後續被改就停止。
它還原起始 WIP bytes，不使用 HEAD／reset／stash／checkout，不改 live runtime。
