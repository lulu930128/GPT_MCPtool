# G1 NORMAL Operator：進度、驗收與交接（歷史）

> **2026-10-15 現行決策：** 這份 G1 文件不是新工程的施工範圍限制；可以繼續修改正式 Host、Operator、Grant、Runner、Receipt。實際 PowerShell 開發測試唯讀、排除 `.env` 等秘密，正式測試由使用者逐筆核准並受 OS／平台限制。舊 G1 已通過驗證不需重跑，詳見 [主計畫現行決策](RemotePowerShellApprovalPlan.md)。

2026-10-13 後續 Reviewer checkpoint：[NORMAL Host source／native IPC 人工單一測試](RemotePowerShellApprovalNormalHost.md)。
新增 native pipe verified handler；CodexSandboxOffline 的實際 exchange 遭 WinError 5，已停止且沒有重試。
正式管線 source 仍有明列 Pending；不可把此次 source compile 視為可部署或 IPC PASS。
2026-10-13 當輪舊 Gate 曾等待真人 NORMAL PowerShell 單一 handler 測試；後續已由使用者完成（參見 NORMAL Host checkpoint）。不得把此舊待辦當成現行阻擋或要求重跑；後續可以直接進行合法的 canonical Host／Grant Source 開發。當時 WinError 5 的那筆被拒操作不重試，原次並未安裝 protected Host、ACL、密碼或重啟服務。

2026-10-13。**SOURCE / ISOLATED PASS；正式獨立 NORMAL Operator BLOCKED；Production OFF。**

本輪交付的是可檢查的 source gate 與隔離 integration。尚未交付可部署啟用的跨程序授權執行器；下列缺口需要後續 source 工作及獨立部署授權，不能只把設定改成 true。權威需求仍是 [計畫](RemotePowerShellApprovalPlan.md)，[G0/G1 原成果](RemotePowerShellApprovalG0G1.md) 保留。

## 正式路徑與唯一 owner

本機人員點選 CC Tray 的 `NORMAL Operator preflight (disabled)` → 同一 Tray 的 PowerShell runspace → `Invoke-McpCcNormalOperatorOwner` → host gate。新選單只執行預檢，結果顯示 BLOCKED/code；不開 listener、不 spawn executor、不寫 approval 或啟動第二個 manager。原有 singleton mutex、component lifecycle、R1 worker 與退出清理保留。

新 `-NormalOperator` 啟動旗標在定點 review 發現與 InstalledRelease exact command 不相容，已移除。兩邊現在都只接受既有 `-NoProfile -File "…\scripts\tray.ps1"` 及可選 `-AutoReconcile`。沒有修改 Startup 或放寬原檢查。正式已安裝 Tray 還必須通過原本 InstalledRelease selection／closure／lineage 驗證；新版 preflight 不能替代它們。

Host gate 檢查：

- 使用既有 InstalledRelease 保護路徑／ACL primitive，檢查 root、祖先、reparse、owner、DACL、可寫 principal；沒有調整權限。
- 固定 11 個 source 檔的 SHA-256 pins；pin manifest 固定為 manager root 下 `config\normal-operator-source.json`，必須受保護、<=8192 bytes、strict contract/files/path/sha256。實際固定 allowlist 見 module；不接受 manifest 指定額外程式或路徑。
- 保留 exact process handle，讀取 token SID、elevation、image、session、start time、`IsProcessInJob`；NORMAL 必須非管理員且 outside all jobs。再檢查 OS command line exact Tray 入口。
- `NormalOperator.Native.cs` 提供 named-pipe client/server PID、client impersonation SID 及 retained-process identity 比對 primitive；**本輪只編譯與 current-process probe，未聲稱真實雙向 named-pipe exchange 已驗收**。
- 明示 canonical Grant、local verifier、OS IPC、negative ACL 尚未驗收；即使前述檢查都通過，仍回 `BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED`。沒有從本機可寫 JSON、環境變數或 caller boolean 開啟 Production 的出口。

G0 `PowerShellApprovalBroker`／`ApprovalStore`／`LocalReview` 完全保留。它們目前明定 `OFFLINE_ONLY`、`PASSWORD_VERIFIED_OFFLINE`，不能作為正式 host Grant。CC 不複製 approval event、不讀 domain payload、不新增另一套授權資料庫。正式端必須由原 canonical owner 提供經 OS peer 驗證的唯讀 Grant lookup 及唯一持久化 consume／result 回寫邊界；**這段跨程序 authority 尚未實作，不能拿 fixture 的 Map 代替**。

## 隔離成果的精確範圍

`operator-ipc.ts` 使用 ephemeral loopback TCP、合成 Ed25519 keys、雙向 pinned peer、每連線 server/client nonce、session、strict envelope 及 dispatch digest。handoff 只含 canonical request/receipt/approval/boot/job/turn/digest/SID/expiry/mode/executor/artifact identity；不接受 script、path、flags、environment 或 ADMIN。每 stream 16 KiB、最多 4 connections、5.5 秒絕對期限；runner 5.2 秒等待期限，固定 PowerShell runner 自有 timeout/output 限制。

`createIsolatedHandoffAuthority` 只在 Broker 已 fsync RUNNING 後由 runner arm，同步 claim 一次，timeout 亦不還原。它是**同一程序的 dispatch capability Map**，不是獨立 host Grant service；keys 不是 OS identity。重啟依 G0 的 RUNNING → UNKNOWN 規則，無自動重送。CC `NormalMarkerOperator.mjs` 只是隔離 owner composition；不部署 daemon、不接 R1、不提升權限。

結果經 signature、session、雙 nonce、完整 schema、scope、SID／mode／executor／bytes／exit／marker 檢查後，交由原 Broker 保存唯一 receipt。失聯、不合法結果或 timeout 為 UNKNOWN；晚到 success 不更新 journal。簽章用於隔離 transport 驗證，並未新增永久的 host-signed receipt archive。

`job-projection.ts` 使用既有 JobStore.get + Broker.get，精確核對 project/job/current turn，提供唯讀結果，拒絕不存在或已換 turn；不寫 JobStore、不續接、不重送。測試使用真實 JobStore class 的隔離資料，不讀正式 JobStore。

## 實際驗證與退出碼

Bridge 工作目錄 `C:\GPT_MCPtool\codex_bridge`：

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.json --outDir .tmp/g1-operator-20261013/dist
node --test --test-isolation=none .tmp/g1-operator-20261013/dist/tests/powershell-operator.test.js
```

- isolated TypeScript：exit **0**。
- 新增 integration：**10/10 PASS，exit 0**。涵蓋 review／executor capability 分離、雙向 peer pins、scope／expiry／replay／額外欄位、結果錯配／錯誤不洩漏、bounded UNKNOWN／late success、FAILED、真實 isolated JobStore 及 NORMAL PowerShell marker。
- nonce case 後續補成合法 handoff 配錯誤 nonce；只重跑 `--test-name-pattern='nonce tamper'`：**1/1 PASS，exit 0**，未重跑其餘 9 項。
- marker：exit **0**、`LOCAL_INHERITED_PROCESS`、`INHERITED_NOT_HOST_ACCEPTED`；current-process probe 為 `inAnyJob=true`、`elevated=false`。**沒有 out-of-job 證據**。

Workspace root `C:\GPT_MCPtool`：

```powershell
powershell -NoLogo -NoProfile -NonInteractive -File mcp_control_center/tests/test-normal-operator-gate.ps1
```

最終 exit **0**：實際 module private-helper scope、正／負 path schema、原 InstalledRelease 與新 gate 的 source regex、拒絕額外 `-NormalOperator`、四個 touched PS parser、native C# compile/current-process proof。沒有執行 InstalledActivation、讀 Startup/private state、修改 ACL 或啟動 Tray。

首次 source proof exit **1 / code 層**：Windows PowerShell 5.1 對無 BOM 的新中文選單字串解析失敗。已改回 Tray 既有英文 UI 慣例；未更動全檔 encoding，最終 parser/proof PASS。首次 helper 可見性問題在 live source gate 執行前已改為 installed module scope；沒有把 CommandNotFound 記成 host blocker。

沒有跑舊 G0 16 tests、legacy full suite、npm build/test、Tray SelfTest 或 HTTP full smoke；原 G0 程式完全未改。沒有覆蓋 live dist/web/version。

## 已停止的路徑與失敗層

| 操作 | 實際結果 | 層／後續要求 |
| --- | --- | --- |
| Git 候選基線對 `codex_bridge\.env.example` 執行 Get-FileHash | Access denied；PowerShell 非 terminating error，command 最終 exit 0，該項 hash 為 null | permission；命中 `.env.*` deny，已排除、不重試、不讀內容；不可用其他工具繞過，無此檔保留證據 |
| `normal-marker-operator.ps1 -Action Preflight -TrayProcessId <當次呼叫程序 PID>` | exit **2**；`PROTECTED_OWNER_REQUIRED`，operation=`validate protected manager root and ancestors`，HResult=-2146233087、nativeErrorCode=null | policy；source checkout 不是 protected installation。尚未走到目標 PID 驗證，不可聲稱該 PID 為 Tray。已停止該 host 路徑 |
| current-process OS probe | exit 0，inAnyJob=true | runtime evidence；不是 permission error，不嘗試 breakaway／detached／替代 launcher |
| 正式 verifier／canonical Grant／OS IPC／負向 ACL | 未部署、未驗收 | BLOCKED；需要後續 source authority wiring 與獨立人工部署／密碼 provisioning 授權 |

## 現場人工步驟與啟用必要條件

1. **先讀 blocker，不執行部署。** 本版本沒有可用的正式執行開關。必須先完成 canonical host authority / protected verifier / OS IPC 的 source 實作與 review；保留 G0 SoT，不能另建 Approval Event store。OS secret provisioning、protected install／ACL 與 Tray 切換均須逐項另行授權。
2. 由本機 Operator 在合法受保護安裝流程中固定來源、依賴及 pins。pin schema：`{"contract":"normal-operator-source-v1","files":[{"path":"<module 固定 allowlist 相對路徑>","sha256":"<64 lowercase hex>"}]}`；必須有全部 11 項，placeholder 不可用。不提供自動 installer、ACL 命令或 Startup 變更。只有 source pins 不足以證明可執行依賴或 verifier 的完整 closure。
3. 使用原有已驗收的 CC Tray owner，由 Windows 本機人員確認其精確 PID、非管理員身分與 out-of-job 證據。不得在 Codex 執行 `Start-Process` 模擬外部 owner，不啟動平行 Tray。原 InstalledRelease startup selection 必須保持原 exact command；不要加 `-NormalOperator`。
4. **只讀預檢命令**，在本機普通 PowerShell 中，把 `<受保護安裝>` 和 `<已驗證TrayPID>` 替換成現場實值：

   ```powershell
   & '<受保護安裝>\mcp_control_center\scripts\normal-marker-operator.ps1' -Action Preflight -TrayProcessId <已驗證TrayPID>
   $LASTEXITCODE
   ```

   或在已人工採用此 source 的既有 Tray 點 `NORMAL Operator preflight (disabled)`。本版本預期 BLOCKED／exit 2；即使來源／owner 通過也應停止在 `BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED`。任何 Access Denied 記 exact operation/HResult/nativeErrorCode，不重試或提權。
5. **以下是尚不可執行的正式 E2E 驗收要求，不是本版本已支援命令。** 先驗證 OS named-pipe 雙向 peer：retained process handle、PID/start-time/session/SID/exact image、operator non-admin/out-of-job、first-instance/local-only pipe 與最小 ACL；PID、SID 字串或同使用者合成 key 都不夠。再驗證 remote model、Codex 與其他 MCP 無法修改 code／policy／verifier／receipt 或讀秘密。相同 Windows SID 的程序不能僅憑 SID ACL 當作隔離證明。
6. 從真實失敗事件取得 job/turn／error 證據，Bridge 固定 marker proposal；本機獨立 UI 顯示 NORMAL、完整固定 script／target／digest／expiry，本人逐筆輸入密碼。密碼不放命令列、MCP 或 ChatGPT。受保護 verifier 核准 canonical event；executor 只讀該 Grant，由唯一 owner 持久化單次 consume 後才執行。
7. 真正 Operator 回傳 bounded 完整 envelope，核對 OS 身分、child PID、exit 0、marker、request/digest/nonce/SID/executor；canonical Broker 保存 receipt，再由 read-only adapter 查原 JobStore job/turn。人工另開續接，不自動 resume。
8. 真人拒絕／過期／跨 mode／錯誤 peer／重播均不得 spawn；dispatch 後失聯必須 UNKNOWN，重啟也不得重送。記錄實際 OS／ACL／IPC 證據；全部通過前 Production OFF，ADMIN 始終 `BLOCKED_AWAITING_LOCAL_UAC`。

## 保留證據與回滾

本機 ignored `.tmp/g1-operator-20261013/` 保存 `baseline.json`、`plan.before.md`、`tray.before.ps1`、test logs、host-preflight、source-gate-proof、preservation 與本輪 source-only patch。`cases/case-aoZr9a/acceptance.json` 是本輪實際 marker receipt + current-process proof，含本機 SID，**不要 commit/public**。

回滾：未部署，無 runtime 回滾操作。source 只移除本輪新增選單／runspace／gate／fixture／projection，對照本輪 patch 逐段撤回；不要 reset 整個 Tray 或計畫，因為都有前輪 WIP。保留 G0 Journal、JobStore、R1、所有 receipts。正式未來採用後有異常，停新請求、保留 UNKNOWN／收據，再走既有 exact-path lifecycle 的另行人工授權流程；不 Self-Reload、不 kill-by-name、不刪資料。
