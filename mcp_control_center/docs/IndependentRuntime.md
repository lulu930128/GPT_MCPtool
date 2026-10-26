# CC 獨立 Runtime

CC 自己部署程式，Bridge 繼續擁有 Bridge 的 lifecycle 與資料。此流程不使用 Program Files 的 ACL、manifest、cutover 或歷史 attestation。

**2026-10-25 目前狀態：`cc-20261025-d` 已啟動，實際 tray PID 44892、唯一 mutex 與版本路徑核對通過，八元件均 Ready。** 使用者後續要求啟用新版開機自動啟動，唯一 Startup 捷徑現為 `wscript.exe "C:\GPT_MCPtool\mcp_control_center\scripts\start-runtime-tray.vbs" --boot`；登入後由既有 Reconcile 安全啟動元件。17 個 Program Files 舊 release 已刪除、舊程序為 0，原根目錄只保留 maintenance 修補備份；現行資料、ACL 與程序未變。下方首次交接敘述保留作流程背景，不代表仍需恢復舊 owner。

`cc-20261025-c` 的隱藏啟動因繼承 PowerShell 7 的 PSModulePath，讓 Windows PowerShell 找不到 Get-FileHash。`d` 的穩定 launcher 與 tray child 明確使用該 PowerShell 的內建 Modules；沒有更動全域環境變數、ACL 或 NODE／OPENSSL 的獨立操作檢查。launcher 測試以無效的外來模組路徑啟動 inert child，實際確認 CIM 與檔案 hash cmdlet 可載入。

| 用途 | 固定位置 | 行為 |
| --- | --- | --- |
| Source | `C:\GPT_MCPtool\mcp_control_center` | 開發與部署工具；保留未提交 WIP |
| Runtime versions | `mcp_control_center\Runtime\versions\<version>` | 明列程式副本，不覆寫既有版本 |
| 選版 | `mcp_control_center\Runtime\current.json` | 停止後原子選版；不代表程序已啟動 |
| Existing State | `mcp_control_center\.local\runtime` | 沿用既有 state、PID、events、receipts；不搬、不打包 |
| Program Files Legacy | `C:\Program Files\McpCcReleases` | 原樣保留；不讀取其部署內容、不修改、不作 fallback |

`Runtime/` 由本元件 `.gitignore` 排除；不需要修改正在被其他工作編輯的根 `.gitignore`。本流程不授予 ACL、不更動 Startup，也不繞過 Windows／sandbox 拒絕。

## Stage 與唯讀 Status

在 repository 根目錄執行：

```powershell
powershell.exe -NoProfile -File mcp_control_center\scripts\runtime-update.ps1 -Action Stage -Version cc-20261025-b
powershell.exe -NoProfile -File mcp_control_center\scripts\runtime-update.ps1 -Action Status
```

Stage 不要求 Bridge 已停止或已建立 selector；它完全不呼叫任何 controller、probe、tray、IPC 或 Startup 工具。Status 只讀部署 metadata／code integrity 與 Bridge 的公開選版入口，不使用會 publish state 的 `control-center.ps1 -Action Status`。

`McpControlCenter.Deployment.psm1` 明列所有可複製檔案；只讀那些 code 與 registry，不遞迴複製 checkout。`.local`、`.env`、資料庫、未列入的 config／private 檔案及 installed-release manifest 不進入 candidate。必要 code 的任一祖先／檔案為 reparse point 即拒絕。Stage 比對複製前、複製後 source 與 candidate 的 SHA-256，避免併行 WIP 產生混合版本。失敗不選版；未完成 staging 留供檢查，不自動重試或清除。

Stage 與 SelectStopped 共用唯一 `Runtime/update.lock` exclusive handle；不依 PID 判斷或打破 lock。版本由暫存目錄 rename 發布。每版保存 code inventory；Status／啟動前檢查完整 inventory、檔案 hash 與額外檔案。

## 程式與元件路徑

`cc-runtime.json` 識別 `mcp_control_center/Runtime/versions/<version>` 位置。Core 從這個結構取得真正 workspace 與既有 state，不把 versions 的上層誤當 workspace，也不接受其他 state override。

registry 保持 v3、八個元件。七個未遷移元件解析至 workspace 原有根。Bridge 僅從 `codex_bridge/Runtime/current.json` 的 `mcpcc-daily-current-v1` 解析至 `versions/<version>/codex_bridge`，使用該版本的 `scripts/runtime-control.ps1`。缺 selector、非法版本、缺 controller、選版中途改變均停止解析，不退回 dev 或 Program Files。

Bridge 的 PID／remote evidence 路徑沿用其 paths-only `settings.json` 中的 `bridgeRuntimeDir`，tunnel ownership 使用其 `tunnelClientPath`；不開啟任何被參照的 credential 或私人 state 檔案。這是目前 Bridge daily 契約的 adapter；若隔壁工作改變契約，須先核對，不能猜測新路徑。長駐 Workspace IPC 的 Bridge action 在派送前重讀 selector，避免持有上次換版的 root。

## 協調後的選版與啟動

**目前 Live／Startup 尚未驗收。** 首次交接由 Bridge 的 `cutover-daily-code.ps1 -ControlCenterVersion <version>` 協調。新 Bridge package 已移除內附 CC，Bridge 的日常 Start／Update／rollback 不再啟停托盤。唯一 Startup 由本元件 `start-runtime-tray.vbs --boot` 持有；切換前仍保留原入口，驗證成功後才原子替換同一個 shortcut。

現役舊 owner 的 tunnel verifier 缺陷須先由原帳號 Administrator 使用有界修補腳本處理，才能透過原 controller 正常停機。完整命令、原始備份、正常／Admin 邊界與失敗處理見 [Bridge 首次交接](../../codex_bridge/docs/DailyCodeUpdate.md)。此步不是舊版相容層，也不允許來源 controller 接管舊 listener。

協調完成後，透過現役 tray 的 **Exit control center only** 正常退出。既有 busy／unknown／Workspace maintenance refusal 仍有效；拒絕時停止，不 kill PID、不重試。新版 `cc-runtime` 支援同一 PID/start-time cooperative Exit event，仍進入同一普通 Exit／drain 流程；不新增管理程序或另一套 IPC。

```powershell
# 只選版；若既有 singleton 尚在，拒絕，不停止任何程序。
powershell.exe -NoProfile -File mcp_control_center\scripts\runtime-update.ps1 -Action SelectStopped -Version cc-20261025-b
# 明確啟動；本輪尚未執行，也未更改 Startup。
wscript.exe C:\GPT_MCPtool\mcp_control_center\scripts\start-runtime-tray.vbs
```

穩定入口啟動獨立 PowerShell child，OS 命令列的 `-File` 指向真正版本 `scripts/tray.ps1`。launcher 僅等候 child；唯一 tray 沿用 `Local\McpControlCenterTray`。日常啟動不加 `AutoReconcile`，所有模式均不加 `ReplaceExisting`。tray 拿到 singleton 後再核對 selector 與完整 inventory，避免 launcher／選版競爭造成舊版啟動。

| 同一入口的用途 | VBS 參數 | PowerShell 參數 | 真正 tray 的行為 |
| --- | --- | --- | --- |
| 日常換版後啟動 | 無 | 無 | 一般 Status，不 Reconcile |
| 協調後唯一冷開機入口 | `--boot` | `-Boot` | 明確傳 `-AutoReconcile`，保留八元件 autoStart |

`--boot` 是唯一 Startup 使用的明確能力，不是另一個 Tray／Startup。沒有 boot 參數就不推斷開機情境；本輪沒有執行真正的 boot／Reconcile。

SelectStopped 只在 singleton 不存在時原子替換 `current.json`，並保存原 selector 的 exact-byte `previous-<uuid>.json`。選版失敗保留舊 selector；啟動失敗不自動 kill／rollback／重試。確認程序已正常退出後，可用同一 SelectStopped 選回仍保留的舊版。沒有自動刪版或資料回復步驟。

此流程尚未搬移 legacy protected NORMAL／R1 Host 信任契約；不能把一般 CC 啟動或離線測試當作那些通道的 live acceptance。既有 Windows Startup 完全不動，後續必須獨立驗收。

## 驗收狀態

獨立部署／launcher fixture 通過不等於 Live 採用。首次切換需同時核對 selected version、實際 tray 命令列與 singleton、Bridge owned listener／認證／readiness，以及同一個 Startup shortcut。冷開機另驗收；未驗證的 protected NORMAL／ADMIN Host 保持 UNVERIFIED。

唯讀候選版檢查：

```powershell
powershell.exe -NoProfile -File C:\GPT_MCPtool\mcp_control_center\scripts\runtime-update.ps1 -Action Status
```

後續 CC 更新仍使用 Stage → 普通 Exit → SelectStopped → 同一 launcher。Bridge 與其他 MCP 不因此停止。失敗不自動 kill、重試或改資料。
