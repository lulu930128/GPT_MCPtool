# Lifecycle readiness 修復 checkpoint

## 2026-10-15 Source 續修結果（尚未刷新正式 Runtime）

本次檢查時 checkout 已有未提交的 cleanup／cooperative transport 候選碼；以下是保留該 WIP 後的補修，
不是把下方歷史狀態或舊 Fixture PASS 當成新成果。正式 Bridge／Tunnel、dist、PID、設定、ACL、
Lock／Journal 均未操作；已知 `codex_bridge/AGENTS.md` 的 PATH_DENIED 未重試或換工具繞過。

- `http-main.ts` 保留 bind 失敗的 Runtime cleanup，另接上 receiver readiness 等待及失敗清理。
  HTTP 先綁定但回 503，receiver 就緒後才開放 health／MCP，避免 Controller 先看到 Ready。
  `http-server.ts` 連 bind 後 logging 例外也會關 listener／Runtime；逐項 cleanup 保留原始錯誤。
- `cooperative-shutdown.ts` 沿用原 JobStore admission lock 與全部 jobs 檢查，關閉 admission 後才
  close HTTP／Runtime／ApprovalStore。receiver 啟動 8 秒、drain/close 20 秒、receiver close 5 秒；
  transport close／HTTP close 各有 3 秒觀察上限，Runtime close 10 秒。timeout 不取消底層清理、
  不回 CLOSED、不重試、不強殺；保留 drain，Controller 仍以 UNKNOWN 停止。
  原 JobStore queue 在實際釋放 drain 時再次檢查 deadline observation，延遲的拒絕不會在 timeout 後解封。
- 原 component controller 的 `RestartCore`／`ReloadRuntime`／`ShutdownRuntime` 已有 probe → shutdown
  路徑。本次加上與原 query-only native handle 的 PID／creation time／image 再綁定，且只有
  exact response requestId／nonce／CLOSED 加上原 handle 的 5 秒 exit wait 成功才進下一步。
  新版啟動前檢查兩個固定 PS receiver/identity scripts、兩個 compiled TS modules 與既有 native sources。
  缺檔或 PS syntax 錯誤先拒絕，保留舊 Core／Tunnel。
- 接收端只收 probe／shutdown，沒有 command payload、PowerShell Runner 或獨立 lifecycle manager。
  重用 `McpCcReloadNative` 的 first-instance／remote-client rejection 與 SID ACL，以及
  `McpCcNormalNative` 的雙向 peer PID／SID／session／creation／image 驗證；另外讀回 pipe DACL，
  要求 protected DACL、只有 owner allow 與 network deny。這些是 Source 安全檢查，並非實機 PASS。
- `ReloadRuntime` 保留健康 Tunnel：Core 的 CLOSED＋exact exit 後啟動新版，再走既有 connectivity repair。
  不取消既有 installed mutation guard，也不把 source checkout 當成受保護的 Grant Authority。

### 本輪受影響驗證與限制

工作目錄 `C:\GPT_MCPtool\codex_bridge`；編譯只輸出到 `.tmp/lifecycle-20261015-revision-build`。

| 命令 | 結果 |
| --- | --- |
| `node node_modules/typescript/bin/tsc -p tsconfig.json --outDir .tmp/lifecycle-20261015-revision-build` | exit 0 |
| `node --test --test-isolation=none .tmp/lifecycle-20261015-revision-build/tests/lifecycle-cleanup.test.js` | 23/23 PASS，exit 0；包含 production Runtime／Store／HTTP／MCP in-memory transport |
| `powershell.exe -NoProfile -NonInteractive -File tests/test-cooperative-source.ps1` | 30 checks PASS，exit 0；parser／native compile／mocked ACL 與 controller flow，不開 pipe、不呼叫實際 lifecycle |
| `git diff --check -- <本輪檔案 allowlist>` | exit 0；另對既有 untracked WIP 執行 baseline no-index diff／UTF-8 讀回 |

PowerShell executable 為 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`。
舊 `test-runtime-control.ps1`／`test-lifecycle-preflight.ps1` 只更新隔離 staging 的相依檔布局並做 parser；
其真實程序測試本輪未跑。G0/G1、既有 Bridge Request/Receipt 67/67 不重跑。

**尚未完成的驗收接口**：正式 Windows pipe connect／token impersonation／DACL 讀回／peer validation，
到 receiver close-complete＋原 Core exit，再到新版 restart_core／reload_runtime 的完整 E2E。
原因是本輪真實 PowerShell 僅允許唯讀，沒有執行 pipe listener／shutdown／start／restart；
不是聲稱觀察到新的 OS 拒絕。舊 Core 不會因 Source 修改自動取得新通道，仍須受支援維護流程。
若該 instance 沒有可驗證的既有關閉路徑，仍維持 BLOCKED，不能用本候選碼反向授權強殺。
Protected installed-release/v4 的 dependency packaging／ACL／activation 未在本輪交付。

本輪增量與修改前 WIP 的 Git no-index diff：
`.tmp/lifecycle-20261015-revision.patch`；baseline：`.tmp/lifecycle-20261015-revision-baseline`。

## 2026-10-15 現行根因與正式修復範圍（優先於下方 10/14 歷史 Gate）

**已取得完整 Source 工程修改授權；此文件的 10/14 `BLOCKED` 是當時已部署能力的現況，不是禁止後續實作的永久施工規則。** 開發期 Windows PowerShell 操作限唯讀，不讀 `.env`、其他敏感檔；正式中斷／刷新由使用者本人在維護窗口明確發起並確認，拒絕不得換通道繞過。

- **Confirmed implementation gap**：`scripts/codex-bridge-runtime.psm1::Assert-CbCooperativeShutdownAvailable` 對所有仍運行的 Core，在 `Assert-CbIdleForMutation` 後固定拋出 `BLOCKED_GRACEFUL_SHUTDOWN_UNAVAILABLE`；即使 Idle／Owner 可辨識也無成功路徑。原因是 Controller 缺少可信、Owner-bound 的 cooperative shutdown transport，而非使用者沒有授權或 Windows UAC 未同意。
- **現有被動關閉能力**：`src/http-main.ts` 內有 `SIGINT`／`SIGTERM` 事件處理，`src/http-server.ts` 的 `handle.close()` 會關閉 transport、HTTP listener 與 `runtime.close()`；但 Controller 沒有可獨立證明的 Windows 安全投遞通道，不能把 `Stop-Process` 或一般 Windows signal 等同已完成清理。這部分是未接線的 Production 功能，不是需要重跑 G0/G1。
- **下輪 Source 修改**：沿用唯一原有 component Controller／Bridge Runtime，實作固定用途、Owner-bound、可核對 Windows identity／PID＋creation／instance nonce／ACL 的 shutdown-only 通道；完成先拒新工作、驗證所有工作 Idle、關閉 HTTP／Controller／ApprovalStore，Controller 有界等待相同 Core 的 close-complete＋exact exit，再以新版 Build 啟動。不得引入任意遠端 Shell 或第二套 lifecycle manager；timeout／UNKNOWN 停止，不自動重送或強殺。
- **必須補的清理缺口**：`src/http-main.ts` 在 `startBridgeHttpServer()` 啟動失敗時目前僅於最外層 `catch` 設定 exit code，沒有保證呼叫已建立的 `runtime.close()`；`src/http-server.ts` 若早期 close 步驟失敗也需確保適當的 Runtime cleanup。特別要驗證 ApprovalStore 的 close／lock cleanup 與 failure path，不把故障留給下一輪重啟。
- **驗收條件**：在可用的受支援 Windows Host 上，確認 Owner、Build、全部工作 Idle，完成一筆 `reload_runtime` 的 Controller request／durable receipt，原 Core 真正 cooperative close 且 ApprovalStore 正常釋放，然後觀察新 PID、Build ID、MCP response。`Ready`、Preflight PASS、舊重啟收據與舊 G0/G1 PASS 均不能替代本輪 E2E。

日期：2026-10-14。範圍：僅 `codex_bridge`，SOURCE + 隔離回歸；未重啟、未部署。

## 已完成

- `ReloadRuntime` / `RestartCore` 在任何停止前檢查 owner 與 startup readiness。
  缺 entry、allowlist、build inputs、stale build、helper error/timeout、無效 manifest/config/
  entry syntax、缺必要 module/assets 都拒絕；timestamp 掃描錯誤不再被忽略。
  Preflight 重算 build，不把 before-status cache 或 fixture `ExpectedBuildId` 當成可啟動證據。
- 使用 canonical `loadBridgeConfig` 驗證設定；helper 不呼叫 `createBridgeRuntime`，不開
  JobStore/ApprovalStore、不啟動 listener/App Server。Helper 最長 10 秒；只有本次建立的
  helper 可在超時後被清理。輸出不轉送設定、secret、loader error 或私有路徑。
- active/awaitingApproval 必須是已知非負整數；`null` 不再可轉成 idle。原有 all-jobs gate 保留。
- 運行中的 core 缺可信 cooperative 通道時，三種 core mutation 均在碰 tunnel 前拒絕：
  `BLOCKED_GRACEFUL_SHUTDOWN_UNAVAILABLE`。底層 `Stop-CbOwnedRole server` 即使通過
  native handle、executable、creation time、owner metadata、listener 重驗，也不能強殺。
  Tunnel 保留既有精確 handle 與有界終止路徑；它不被宣稱為 graceful。
- 已停止 core 的 `RestartCore` 可啟動；`ReloadRuntime` 先啟動 core，再經原
  `RepairConnectivity` 保留或修復 tunnel。運行中 happy reload **尚不可用**。
- `Status` 不取得 mutation mutex、不清理 stale PID/owner metadata、不寫成功或失敗 audit；
  `Status -AdoptLegacyExactListeners` 明確拒絕。唯讀觀察不保證跨 probe 的原子 snapshot。

## BLOCKED 與恢復邊界

目前 launcher 沒有經驗證的私有 console/process group，也沒有綁定 canonical controller
身分的 cooperative IPC。不能把 `TerminateProcess`、`process.kill(SIGTERM)` 或向未知
console 發送事件當成 graceful。Windows 限制見
[Node signal 文件](https://nodejs.org/api/process.html#signal-events) 與
[GenerateConsoleCtrlEvent 文件](https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent)。

這輪沒有新增 HTTP/MCP shutdown endpoint，沒有假裝交付有界 graceful wait。
新進工作與 shutdown 的原子 drain、Windows 安全投遞、投遞後 timeout/unknown reconciliation、
運行中 happy reload、protected installed-host 環境均未驗收。
Preflight 是不開資料庫的必要靜態檢查，不能證明 runtime data 可寫、Journal 可取得鎖、
tunnel credential 可解密或遠端 registration 成功；不會為了驗證而讀寫受保護資料。

狹義後續方案：在同一 component controller 增加固定 shutdown-only native IPC verifier，
綁定受保護的 controller 身分與 Node 的 PID、creation time、image、instance nonce；
named pipe 必須驗證 ACL、雙向 peer PID/token 及 remote-client rejection，不能僅靠 loopback
或現有 HTTP bearer token。Node 在同一事件迴圈先封鎖新工作、核對全部 active work，再
沿用既有 HTTP close → runtime close → ApprovalStore close；request id/nonce 必須單次使用。
Controller 持有原 native handle 有界等待，只有 close-complete 與同一 process exit
都確認後才可開始下一步。Timeout/unknown 不重送、不強殺、不清 owner/Journal lock。
此方案需要獨立 Windows 安全與競態驗證，並不在本 checkpoint 宣稱已實作。

現役程序無法靠這次 source 修改補上 IPC。先保持服務，交由 Reviewer 決定後續維護窗口；
只有 operator 獨立證明該 instance 的專屬 console/可信控制通道後，才有條件走既有 signal close。
沒有該證據就繼續 BLOCKED。已回報的 live `STORE_LOCKED` 僅是使用者提供的觀察；鎖 owner、
是否遺留及原因本輪均未驗證，不提供刪鎖、改 ACL 或另開 Journal 的恢復捷徑。

## 驗證

工作目錄：`C:\GPT_MCPtool`。PowerShell：Windows PowerShell `5.1.26100.9444`。
候選目錄：`codex_bridge/.tmp/lifecycle-validation`，只包含 source/fixture/隔離編譯產物。

| 實際命令 | 結果 / exit code |
| --- | --- |
| `node codex_bridge/node_modules/typescript/bin/tsc -p codex_bridge/tsconfig.json --outDir codex_bridge/.tmp/lifecycle-validation/dist` | PASS / 0 |
| `powershell.exe -NoProfile -ExecutionPolicy Bypass -File codex_bridge/.tmp/lifecycle-validation/tests/test-lifecycle-preflight.ps1` | 16 情境、256 assertions / 0 |
| `powershell.exe -NoProfile -ExecutionPolicy Bypass -File codex_bridge/.tmp/lifecycle-validation/tests/test-runtime-control.ps1 -CanonicalBuildId` | 89 assertions / 0 |
| `powershell.exe -NoProfile -ExecutionPolicy Bypass -File codex_bridge/.tmp/lifecycle-validation/tests/test-owned-process.ps1` | 38 assertions / 0 |
| `powershell.exe -NoProfile -ExecutionPolicy Bypass -File codex_bridge/.tmp/lifecycle-validation/tests/test-runtime-build-id.ps1` | 58 assertions / 0 |
| `node --test codex_bridge/.tmp/lifecycle-validation/tests/runtime-close.test.mjs` | 2 tests / 0 |

另已完成 9 檔 UTF-8/whitespace、Windows PowerShell parser、兩個 `.mjs` 的 `node --check`，
及 repository 原設定的 `git diff --check`，exit code 均為 0。

上述 `powershell.exe` 實際均指定 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`。
候選的 scripts/tests 來自本次 source；production `dist` 沒有寫入。
Controller 整合測試使用新建、隔離的 server/tunnel 真實 PID，證明 stale refusal 後原 PID 仍存活。
Preflight matrix 呼叫 production lifecycle/ownership/build/config functions，OS process/listener/health
觀察由 fixture 提供；兩個 action 所有拒絕情境均保持 PID/owner bytes、零 stop/start、零 data-dir 建立。
Owner tests 涵蓋 PID reuse、foreign executable/listener、listener race、open/termination failure。
Close tests 直接呼叫 production close chain，證明 listener 已關閉、等待 ApprovalStore 完成前鎖仍有效、
close 後 fixture 鎖解除且可重新開啟，以及 controller close 失敗仍會 finally 關 Journal。
這不是 OS signal delivery 或 live lock recovery 的證據。

驗證過程修正兩項測試問題：Status 的初始 audit assertion 移到 mutation 前；build-id test
以第一個 executable 避免 PATH 多個 `node.exe` 被組成無效路徑。失敗後對應測試已重新通過。

## 變更與交接

- Production：`scripts/codex-bridge-runtime.psm1`、`scripts/runtime-control.ps1`、`scripts/runtime-build-id.mjs`。
- Tests：`tests/test-runtime-control.ps1`、`tests/test-owned-process.ps1`、`tests/test-runtime-build-id.ps1`、
  `tests/test-lifecycle-preflight.ps1`、`tests/runtime-close.test.mjs`。
- 本文件。既有 WIP 保留；`review-tools.ts` / `powershell-review.test.ts` 前後 hash 相同。
  本輪修改前的指定 source baseline 保留於 ignored `.tmp/lifecycle-source-baseline/`，可對照本輪增量。
- 沒有 live restart/reload、Control Center mutation、live Journal 存取、正式 dist build、commit/push，
  沒有修改其他元件，也沒有新增 ADMIN/NORMAL/runner 權限。
- 注意：PowerShell scripts 是直譯檔，下一次正式 controller 呼叫會讀到 source 修改。
  「未部署」指本輪未發布或重載 Node/dist；Reviewer 應先確認 BLOCKED 行為與後續上線安排。
