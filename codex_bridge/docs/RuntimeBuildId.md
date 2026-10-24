# Runtime Build ID

## 根因與修正

2026-10-10 在同一 checkout 重現 Node `c00f4c4d61f5085c`、Windows PowerShell
`d14aad793042d8ab`。Node 以 `readdir(withFileTypes)` 與 `localeCompare` 排序；舊
PowerShell 以 `Get-ChildItem | Sort-Object Name` 排序。兩者對相同檔案的排序不同，
導致 relative path UTF-8 與檔案 bytes 進入 SHA-256 的順序不同。
`Test-CbServerHealth` 因而始終拒絕目前 build，延長 timeout 無法修復。

唯一算法仍是 `src/config.ts::computeRuntimeBuildId`，其語意未修改：依序處理
`package.json`、`dist/src`、`web`，遞迴排序、加入相對路徑與 bytes，取 SHA-256 前
16 個小寫 hex 字元。`scripts/runtime-build-id.mjs` 僅從自己的目錄定位 component root，
import `dist/src/config.js` 並呼叫該函式，不讀 settings、credentials 或 runtime state。
PowerShell 已移除自己的排序與 hashing。原本的 `-ExpectedBuildId` 測試覆寫保留，
正式啟動不需要也不應使用它。

## 呼叫邊界與 cache

- Helper 固定為 module 旁的檔案，component root 必須與 module 所屬 root 相同。
  Helper 與 canonical module 的路徑鏈不得有 reparse point／junction。
- 執行 controller 已選定的絕對 `node.exe`，使用 `UseShellExecute=false`、隱藏視窗與
  單一固定檔案參數；不拼接 shell code，也不接受 caller 提供的 script 或 hash root。
- Child environment 僅保留 Windows 啟動、temp 及 locale 所需欄位，不繼承 credentials、
  `NODE_OPTIONS` 或 Node preload/loader 設定；不改 parent environment。
- 上限 10 秒；stdout 僅接受單一 16 字元小寫 hex ID，可帶一個換行。
  多餘 stdout、任何 stderr、非零 exit 或逾時均 fail closed；不轉送 child 原始內容。
  失敗只會終止本次建立的 helper child，無權依名稱終止 Bridge／tunnel。
- 成功與失敗都保存在單次 context。before/after status、ownership readiness、health polling
  共用一次 Node 計算；下一次 `runtime-control.ps1` 呼叫重新計算，不跨 lifecycle 保存 cache。
  直接使用 module 的 caller 每次操作也必須建立新的 context。
- 磁碟更新後，新的 Status 會拒絕舊 server 的 buildId，直到受 guard 保護的 reload 採用新 build。
  請先完成 build 再開始 lifecycle 操作，勿在單次操作進行中改寫 build 檔案。

這些檢查保護固定呼叫路徑與輸出邊界，不是程式碼簽章。具備 component source/build 寫入權限的
操作者仍屬信任邊界；不能藉此偵測惡意修改後仍回傳合法 ID 的 canonical 程式。
Node 算法原有的檔案缺漏語意未改變；controller 額外要求 helper 與編譯後 config module 存在。

| Error code | 診斷方向 |
| --- | --- |
| `BUILD_ID_HELPER_MISSING` | 還原 `scripts/runtime-build-id.mjs` |
| `BUILD_ID_CONFIG_MISSING` | 執行 `npm run build` |
| `BUILD_ID_PATH_UNSAFE` | 確認 component root 與固定程式路徑沒有重新導向 |
| `BUILD_ID_NODE_INVALID` | 確認 controller 選定的絕對 `node.exe` 存在 |
| `BUILD_ID_START_FAILED` / `BUILD_ID_COMPUTE_FAILED` | 檢查 Node 安裝、執行權限與 build |
| `BUILD_ID_TIMEOUT` | Helper 超過 10 秒，檢查檔案存取或執行環境 |
| `BUILD_ID_STDERR` | Helper 寫入 stderr；原始內容已抑制 |
| `BUILD_ID_OUTPUT_INVALID` | 空白、大小寫錯誤、多行或過量輸出 |

錯誤在 lifecycle mutation 前產生；exact ownership、active job／approval guard、tunnel identity
比對與嚴格 health buildId 比對均保留。SelfTest 繼續檢查原有宣告，不代替 build 一致性測試。

## 可重現的 Windows 驗證

在 component 內執行。測試使用合成資料、隨機 loopback ports、fake server／tunnel，
不呼叫正式 lifecycle，不讀 `C:\CodexBridge`、本機 settings 或 credentials。
Controller suites 共用 mutex，必須依序執行。

```powershell
Set-Location C:\GPT_MCPtool\codex_bridge
npm.cmd run build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\test-runtime-build-id.ps1
npm.cmd test
npm.cmd run smoke:http
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\test-runtime-control.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\test-runtime-control.ps1 -CanonicalBuildId
```

跨語言測試先唯讀比較實際 checkout，再用含空格、shell metacharacters 的 fixture root，
涵蓋大小寫、標點、Unicode、巢狀路徑、不同建立順序、bytes 修改、重新命名、刪除、cache、
缺檔、junction、非法 Node path、無效／過量輸出、stderr、非零 exit、timeout 與環境注入。
Canonical controller suite 讓 fake server 直接使用同一 `computeRuntimeBuildId`，驗證不帶
覆寫參數的 EnsureRunning、Status、RestartCore、ReloadRuntime，以及檔案更新後拒絕舊 build
再 reload 成功。預設 suite 繼續驗證測試覆寫相容性。HTTP smoke 的 handoff 寫入也在
臨時 fixture 內；實際 checkout 僅供 launch policy 與 build 讀取。

### 2026-10-10 本機執行紀錄

環境：Windows、Windows PowerShell `5.1.26100.9444`、Node `v24.14.1`。
測試程序的 `TEMP`／`TMP` 指向 component 內專用的
`.tmp/build-id-validation`；所有 server／tunnel PID 檔都屬隨機 fixture 子目錄。

| 項目 | 最終結果 | 證據 |
| --- | --- | --- |
| `npm.cmd run build` | PASS | exit 0；實際 Node Build ID 仍為 `c00f4c4d61f5085c` |
| PowerShell parser | PASS | module、controller entry、兩支 Windows regression scripts 均無語法錯誤 |
| `node --check` | PASS | `runtime-build-id.mjs`、`smoke-http.mjs` |
| `test-runtime-build-id.ps1` | PASS | 58 assertions；實際 checkout PS = Node = `c00f4c4d61f5085c` |
| `npm.cmd test` | PASS | 129 tests，0 fail、0 skipped |
| `npm.cmd run smoke:http` | PASS | 32 tools、13 app-only actions、preview created jobs = 0 |
| `test-runtime-control.ps1` | PASS | 73 assertions；原有 explicit test override 相容 |
| `test-runtime-control.ps1 -CanonicalBuildId` | PASS | 82 assertions；無 ExpectedBuildId 的完整隔離 lifecycle |
| UTF-8 讀回與 `git diff --check -- codex_bridge` | PASS | source／tests／docs 最終檢查 |
| 正式 runtime reload／公開 connector E2E | 未執行 | 本次工作由正式 Bridge 承載，禁止重啟 |

曾出現的失敗與處置：

1. 跨語言測試初次 FAIL：helper 環境初始化回報 `BUILD_ID_COMPUTE_FAILED`。
   此 Windows host 環境同時含 `PATH`／`Path`，.NET Framework 首次建立大小寫不敏感的
   environment dictionary 時拋出 `ArgumentException`。修正為捕捉此特定情況，取得已初始化的
   dictionary 後清空，再填入 allowlist；未修改 parent environment。重跑 58 項全部 PASS。
2. Canonical controller suite 首次 FAIL：前一套 suite 尚未結束，共用 mutex 回報 `ACTION_BUSY`。
   這是測試排程重疊，沒有放寬 mutex；待前一套完成後依序重跑，82 項全部 PASS。

本次未執行正式 controller action，未讀寫正式 jobs/data、PID、settings 或 credentials；
未修改其他元件，未 commit／push。Source 與隔離測試完成不表示正式 runtime 已重新載入。

## 本次工作結束後，由使用者執行的正式驗收

以下指令會重新載入正式 runtime，須等本次 Bridge 工作與其他工作全部結束後，
在獨立 PowerShell 視窗執行。Controller 仍會自行重驗 active work 與 ownership；任何失敗都停止，
不要改用手動 PID 終止或 Build ID 覆寫。build 與 reload 之間不要再變更檔案。

```powershell
Set-Location C:\GPT_MCPtool\codex_bridge
$ErrorActionPreference = 'Stop'
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }

$health = Invoke-RestMethod http://127.0.0.1:18828/health
if (-not $health.ok -or $health.service -ne 'codex-handoff-bridge' -or
    $null -eq $health.jobs.active -or $health.jobs.active -ne 0 -or
    $null -eq $health.jobs.awaitingApproval -or $health.jobs.awaitingApproval -ne 0 -or
    $health.controller -notin @('idle', 'ready')) {
    throw 'Bridge is not confirmed idle; do not reload'
}

$reloadText = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
    -File scripts\runtime-control.ps1 -Action ReloadRuntime
if ($LASTEXITCODE -ne 0) { $reloadText; throw 'Reload failed; inspect the safe errorCode' }
$reload = $reloadText | ConvertFrom-Json
if (-not $reload.ok -or $reload.after.status -ne 'Ready') { throw 'Reload is not Ready' }

# Both calls omit ExpectedBuildId and must preserve the newly adopted PIDs.
foreach ($action in @('EnsureRunning', 'Status')) {
    $resultText = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
        -File scripts\runtime-control.ps1 -Action $action
    if ($LASTEXITCODE -ne 0) { $resultText; throw "$action failed" }
    $result = $resultText | ConvertFrom-Json
    if (-not $result.ok -or $result.after.status -ne 'Ready' -or
        $result.after.server.pid -ne $reload.after.server.pid -or
        $result.after.tunnel.pid -ne $reload.after.tunnel.pid) {
        throw "$action did not preserve the ready runtime"
    }
}
$expected = & node.exe scripts\runtime-build-id.mjs
if ($LASTEXITCODE -ne 0) { throw 'Canonical Build ID failed' }
$health = Invoke-RestMethod http://127.0.0.1:18828/health
if (-not $health.ok -or $health.service -ne 'codex-handoff-bridge' -or
    $health.buildId -cne $expected) { throw 'Health Build ID mismatch' }
$tunnel = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:18829/readyz
if ($tunnel.StatusCode -ne 200 -or $tunnel.Content.Trim() -notin @('ready', 'ok')) {
    throw 'Local tunnel is not ready'
}
[pscustomobject]@{ result='PASS'; buildId=$expected; serverPid=$result.after.server.pid;
    tunnelPid=$result.after.tunnel.pid; localTunnelReady=$true }
```

此結果證明本機 controller／health／tunnel readiness；公開 connector E2E 必須另外在
ChatGPT 重新連線後呼叫 `codex_bridge_status` 確認。不要把本機 `/readyz` 當成公開入口驗收。
