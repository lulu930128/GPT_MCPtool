# Bridge 日常換版與首次退役交接

CC 與 Bridge 各自在自己的 `Runtime/versions` 執行，分別以 `current.json` 選版。CC 持有唯一托盤與 Windows Startup；Bridge package 不包含 CC，Start／Update／rollback 都只操作 Bridge。既有 `McpControlCenter.DailyCode.psm1` 是部署協調器，Bridge controller 仍是 Bridge 停機、程序與資料的唯一 owner。

**目前已採用 Bridge `pathfix-20261025-06` 與 CC `cc-20261025-d`。** 兩者實際程序位置已核對，Bridge/Tunnel 均為 OwnedReady，CC probe Ready、匿名 MCP 401／認證 initialize PASS、ApprovalStore OPEN／THIS_INSTANCE。舊 release 程序為 0。使用者後續要求啟用新版 Startup：唯一捷徑現指向 `wscript.exe "C:\GPT_MCPtool\mcp_control_center\scripts\start-runtime-tray.vbs" --boot`，八元件 Reconcile 已驗證 Ready，實際下次登入仍未驗收。17 個 Program Files 舊 release 已由原帳號管理員刪除，RETIRED 收據與目錄消失已獨立核對；只保留 maintenance 修補備份，現行資料與 ACL 未變。protected NORMAL／ADMIN Host 未部署，不能把一般 Bridge Ready 視為該能力通過。

新版 JobStore 會建立空的 `.tmp/codex-inbox`。版本完整性檢查只允許該精確空目錄，仍核對全部 code hash；Stage 輸入、任何 inbox 內容、額外暫存檔或 reparse point 仍拒絕，且不刪資料。此限制不能當作已完成 inbox 持久化位置遷移。

## 舊版已退役、重開機後直接啟動

2026-10-25 的 `cutover-0ad4c43f9cb44829a718e35f6da1c4fd` 已由原 controller 成功 ShutdownRuntime，之後因 10 月 23 日殘留的 ApprovalStore lock 回覆 `DAILY_STATE_LOCK_PRESENT`。`oldStopped=false` 是協調器尚未通過 lock 檢查的旗標，不能取代實際程序／controller 證據。原 UNKNOWN 收據不修改。

此情境不再執行下方歷史 cutover、不要求舊版 Ready，也不呼叫舊 controller。由 `daily-code-update.ps1 -Action RecoverAfterReboot -Version pathfix-20261025-06 -OperationName cutover-0ad4c43f9cb44829a718e35f6da1c4fd` 驗證 OS boot、原停機收據、程序已退出、Startup 與 tray 已不存在，再保留 stale lock 原始位元組於原資料目錄的 `approval.lock.retired-<uuid>`。只讀 lock 的 operational identity，不讀／修改 approval journal，不重新執行任何審批。

恢復只嘗試一次；權限拒絕、active lock、原程序仍在、同次開機、收據變更或部分完成均停止。原 PID 可能已由其他程序重用，因此以 CIM CreationDate 比較身分；不依賴 Get-Process 對其他服務可能回傳 null 的 StartTime。本次首次嘗試因該 null 值失敗且鎖檔未移動；確認原 lock 仍在、backup 不存在後，以明確 `-ResumeUnchangedLock` 接續一次並另留收據。此參數仍執行全部 stale-lock 檢查，不能接續已移動或結果不明的鎖。成功後既有 `Adopt -LegacyRetired` 與 CC `SelectStopped` 選版，再用既有 `Start` 與 CC launcher 啟動。此路徑不建立 Startup，也不刪 Program Files。

## 目錄責任

| 路徑 | 責任 |
| --- | --- |
| `codex_bridge`，排除 Runtime | 可編輯 Source 與部署入口 |
| `codex_bridge/Runtime/staging` | 未完成的候選版，失敗保留 |
| `codex_bridge/Runtime/versions/<version>/codex_bridge` | immutable Bridge 程式及必要依賴 |
| `codex_bridge/Runtime/current.json` | 原子選版，不代表程序已啟動 |
| `codex_bridge/Runtime/settings.json` | 既有 paths-only 設定，不存 secret |
| `codex_bridge/Runtime/operations` | intent／terminal receipt，UNKNOWN 不重放 |
| `mcp_control_center/Runtime` | CC 自己的版本與 selector |
| settings 的 dataDir／ownerRoot／bridgeRuntimeDir | existing state，不搬移、不打包、不直接修復 |
| Program Files 舊 release | 只用於一次性正常退役，新 runtime 不依賴它 |

`Runtime` 全部 Git-ignored。既有版本不覆寫。早期 `pathfix-20261025-01..03` 包含 CC，不適用此獨立部署流程；`04` 缺 cooperative native 依賴，已在 PREFLIGHT 拒絕且未停機。新 Stage 以 `daily-mode.json` 的 `trayOwner=independent-cc` 明確識別，並要求完整 cooperative 依賴，不自動相容。

Bridge 的 `scripts/shared-native` 僅打包 CC canonical source 的 `NormalOperator.Native.cs`、`RemoteSelfReload.Native.cs`，逐檔 hash 核對；不含 CC launcher、registry 或 owner。安全停止的 IPC 仍由原 Bridge controller 負責；每日版驗證 CC caller 時讀取 CC 自己的 selector，核對所選版本 wrapper 的 inventory hash 與完整命令列。Preflight 在停機前實際載入 native helper。

## 歷史：舊版仍在執行時的首次交接

目前舊版 `normal-direct-bearer-20261023` 的 tunnel verifier 漏掉 launcher 已有的兩個認證環境變數參照參數，導致正常 ShutdownRuntime 的 owner gate 拒絕。這是退役前的單行修補，不是舊版功能相容層。

先執行唯讀檢查：

```powershell
powershell.exe -NoProfile -File C:\GPT_MCPtool\codex_bridge\scripts\repair-legacy-tunnel-verifier.ps1
```

只有 `VERIFIED_NOT_APPLIED` 才可由原帳號在 **Administrator Windows PowerShell 5.1** 執行：

```powershell
& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -File 'C:\GPT_MCPtool\codex_bridge\scripts\repair-legacy-tunnel-verifier.ps1' -Apply
```

腳本 pin 住本次實際 module／manifest hash，只把 verifier 改為共用原 `Get-CbTunnelArguments`，保留原檔於 protected maintenance 目錄，同步 Bridge code-tree hash，驗證 closure 及原 ACL。沒有停機、重啟、secret 讀取、資料／Startup／ACL 修改。已知驗證失敗可 byte-exact 回復；部分寫入或外來變更為 UNKNOWN，不覆蓋也不重試。任何 Windows 拒絕交回操作者，不提權或換入口。

修補成功 `REPAIRED` 後結束 Admin shell。使用原帳號的普通、獨立 Windows PowerShell 執行：

```powershell
& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -File 'C:\GPT_MCPtool\codex_bridge\scripts\cutover-daily-code.ps1' -Version pathfix-20261025-05 -ControlCenterVersion cc-20261025-c
```

這條命令要求兩個指定版本已 Stage。它依序核對新程式與既有 owner／工作狀態，透過**原 installed controller** 正常 ShutdownRuntime，確認程序退出及 ApprovalStore lock 釋放，退出舊 tray，使用既有 API 選定 Bridge 與獨立 CC，啟動／驗證兩者，最後原子改既有 Startup 為：

`wscript.exe "C:\GPT_MCPtool\mcp_control_center\scripts\start-runtime-tray.vbs" --boot`

舊 Tray 沒有 Exit event，因此仍有一個 UI 步驟：腳本在停機前要求輸入 `EXIT` 確認已準備操作；顯示 Bridge／Tunnel 已安全停止後，才在舊托盤選 **Exit control center only**。不能提前關閉，原 controller 的 shutdown 需要原 Tray 在場。等待上限 120 秒，逾時保留 UNKNOWN。

普通換版啟動 CC 不帶 AutoReconcile；只有唯一 Startup 的 `--boot` 才啟動八個 registry 元件。Bridge 更新不重啟其他 MCP。切換完成的 `ACCEPTED` 與後續冷開機、ChatGPT connector、protected NORMAL／ADMIN Host 驗收仍分開。

**不要刪舊 release 來代替停機。** 新版實際 owner、程序路徑、認證、readiness、Startup 驗收通過後，再檢查沒有程序／入口引用，才清除舊程式。私人資料、歷史 receipt、backup 及既有 operational state 不屬於程式清除範圍。

## 後續一般更新

```powershell
# repository 根目錄；先建置 Bridge，再 Stage 新名稱。
npm.cmd --prefix C:\GPT_MCPtool\codex_bridge run build
powershell.exe -NoProfile -File C:\GPT_MCPtool\codex_bridge\scripts\daily-code-update.ps1 -Action Stage -CandidateRoot C:\GPT_MCPtool -Version fix-20261026-01
powershell.exe -NoProfile -File C:\GPT_MCPtool\codex_bridge\scripts\daily-code-update.ps1 -Action Update -Version fix-20261026-01 -CodeOnly
```

`-CodeOnly` 聲明持久資料、設定、credential storage、owner protocol、tunnel profile 相容，不授予權限。`daily-code-contract.json`、dependency／package、schema migration 的變更走另外審閱的遷移，不以 CodeOnly 隱藏。

Stage 只複製 Bridge 明列 code trees，不讀 workspace 的 `.env`、`.local`、Runtime、DB 或 credential。拒絕 reparse／缺檔／重複版本。Update 正常 drain 原 Bridge、確認停止、原子選版、啟動並驗證；已知啟動失敗才經原 owner 正常停止新版並回到上一個 **Bridge** 版本，CC 不動。不能安全停止或結果不明時保留 UNKNOWN，不刪 lock、不 force kill、不重放操作。

## 歷史：第一次停機中斷後的恢復

操作 `cutover-c452a9b2c0714c47a9c6c565c48d056d` 在 `STOPPING_LEGACY` 得到 `CUTOVER_CONTROLLER_FAILED`，terminal 保留 `UNKNOWN`。底層 stderr 當時未保存，不能斷言根因。使用者重新由 Startup 捷徑開啟舊 CC 後，原 controller Status 確認 server PID 8292 與 tunnel PID 42712 均為 OwnedReady，沒有選版或 Startup 變更。

不能在同一次開機直接重跑。儲存工作、由使用者重新啟動 Windows 後，確認原 CC 已正常出現，再在普通 Windows PowerShell 執行：

```powershell
& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -File 'C:\GPT_MCPtool\codex_bridge\scripts\cutover-daily-code.ps1' -Version pathfix-20261025-05 -ControlCenterVersion cc-20261025-c -RecoverAfterReboot cutover-c452a9b2c0714c47a9c6c565c48d056d
```

只接受本次尚未選版／改 Startup 的特定失敗階段與錯誤碼。恢復驗證 OS boot time 晚於原 intent 與 terminal、原兩個 PID 身分均已退役，再追加綁定原收據 hashes 的 `recovered-after-reboot.json`；歷史 terminal 不修改。新的切換仍須通過原 controller／owner／idle／drain／選版／readiness gates。不執行重開機、不停止程序、不刪 lock，不以後續健康回應解除同次開機的 UNKNOWN。

新版協調腳本記錄自己的 code hash，controller 呼叫保存有限 code／engine category／exit code，永不保存 raw stdout／stderr 或 secret。`[KEEP_CC_OPEN]` 時保持舊 CC 開啟；只有 `[CLOSE_CC_NOW]` 才在 120 秒內選 **Exit control center only**。此恢復修改位於 source 部署入口，05 的 immutable runtime 包不覆寫。

## 離線驗證命令

```powershell
powershell.exe -NoProfile -File codex_bridge\tests\test-daily-code-update.ps1
powershell.exe -NoProfile -File codex_bridge\tests\test-daily-cutover.ps1
powershell.exe -NoProfile -File codex_bridge\tests\test-daily-cooperative-package.ps1
powershell.exe -NoProfile -File codex_bridge\tests\test-cutover-reboot-recovery.ps1
powershell.exe -NoProfile -File codex_bridge\tests\test-legacy-tunnel-repair.ps1
```

測試使用隔離檔案與合成 process／SID／lifecycle，並執行實際 hash、selector、receipt、rollback 與 byte-preserving repair 邏輯；不操作正式程序、資料、Startup、credentials 或 ACL。
