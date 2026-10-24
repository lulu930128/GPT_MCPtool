# NORMAL Operator 正式接線交接

> **2026-10-23 Source 已實作，Runtime 未採用：** 以 [Bridge NORMAL 最小閉環](../../codex_bridge/docs/RemotePowerShellApprovalPlan.md) 首節為準。一次明確 DIRECT NORMAL 請求沿用唯一 Store／Native Host；**不再要求本機視窗、每筆密碼、Passkey 或額外 review_get／review_decide**。本輪只交付 source／離線驗證，正式入站認證、受保護 successor release 與 Windows 執行驗收仍待完成。以下 10/13～10/22 是歷史紀錄，不得拿舊腳本重跑或繞過拒絕。

## 2026-10-23 本輪停止點與獨立 operator 回傳

**SOURCE／OFFLINE 可獨立交付；LIVE BLOCKED／UNVERIFIED。** 沒有安裝、關閉／重啟服務、修改
ACL、讀取 `.local`／既有 `.tmp`、操作正式 Store 或呼叫 live NORMAL。現役 r12 Build
`b4dd244ad1c765a8` 是使用者提供的背景，不能當作這次 source 已載入。

先補的是入站認證證據，不是再次核准每筆指令：source 的 HTTP verifier 在 bearer 成功後才設定
SDK `req.auth`，SDK 將其交給工具 `extra.authInfo`。隔離真實 HTTP 已驗證這個行為。沒有 Bridge
bearer、只因「使用 Secure Tunnel」而宣稱可信，仍會得到 `AUTHENTICATED_MCP_REQUIRED`；
Tunnel 初始化原有 `sample_mcp_remote_no_auth` 不構成 Bridge 已收到認證的證據。不可藉由設定
`approved=true`、信任 `_meta` 或停用 verifier 讓測試通過。

以下是**原 Windows 使用者另行執行的唯讀 metadata 命令**，本輪 agent 沒有執行；不讀 token
內容、不呼叫服務、不啟動 Host、不變更 ACL。它只判斷現役 manifest 是否釘住 bearer 配置，
不能單獨證明目前程序或 Tunnel 轉交成功。請在一般獨立 Windows PowerShell 5.1 貼上：

```powershell
$ErrorActionPreference = 'Stop'
$releaseRoot = 'C:\Program Files\McpCcReleases\r12-stable-pathfix-20261023'
$manifestPath = Join-Path $releaseRoot 'mcp_control_center\config\installed-release.json'
try {
    $manifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($manifest.releaseId -cne 'r12-stable-pathfix-20261023') { throw 'RELEASE_ID_MISMATCH' }
    $pin = [string]$manifest.cutover.httpTokenSha256
    if ($pin -cnotmatch '^([a-f0-9]{64})?$') { throw 'AUTH_PIN_INVALID' }
    [pscustomobject]@{
        result = $(if ($pin.Length -eq 64) { 'BEARER_PIN_PRESENT' } else { 'BLOCKED_NO_BRIDGE_BEARER_PIN' })
        releaseId = $manifest.releaseId
        runtimeBearerVerified = $false
        tunnelForwardingVerified = $false
        nextAction = 'RETURN_METADATA_ONLY_NO_INSTALL_OR_RESTART'
    } | ConvertTo-Json -Compress
} catch {
    [pscustomobject]@{result='BLOCKED';errorType=$_.Exception.GetBaseException().GetType().FullName;
        hresult=$_.Exception.GetBaseException().HResult;nextAction='STOP_NO_RETRY_OR_ACL_CHANGE'} | ConvertTo-Json -Compress
}
```

只回傳上述 JSON；不要貼 token、pin 值、完整 manifest、`.env` 或 Tunnel profile。若無 pin，
缺口是「既有可信 MCP 到 Bridge 的可驗證認證轉交」，不是 Host 連線故障；此 source 不會替正式
環境建立 bearer、修改 immutable manifest 或猜測信任 header。即使有 pin，仍需在已授權維護階段
核對 caller／Tunnel 的 bearer 轉交及 installed binding，而不是新增本機逐筆確認。

本輪未建立可部署 candidate/package。後續安裝須從此 source 建立新的隔離、已編譯候選，
由原 `codex_bridge/scripts/installed-release-operator.ps1` 的既有獨立 operator 流程處理，
不得覆寫 r12 或直接複製 source 至 release。缺少候選路徑／hash、可信入站證據與維護窗口前，
沒有可安全執行的 Install／Cutover 命令；不套用歷史 r15/r16、migration 或 R1 腳本。

安裝及工具 metadata 更新另行完成後，使用者明確發起的一筆無副作用 E2E 應直接呼叫
`codex_powershell_normal_execute`，保留 exact scriptSnapshot／args／cwd 與 UUID idempotencyKey。
回傳原 requestId／digest、Host 關聯、stdout／stderr／exitCode／時間；若輸出有 nextOffset，
以同一 Request Receipt 讀完。逾時／UNKNOWN／遺失回覆只用原 ID 或 idempotencyKey 查收據，
不可再次呼叫 execute。不要求 review_get／review_decide、本機點選或密碼。

### 可重現的 source 隔離驗證

從 `C:\GPT_MCPtool\codex_bridge` 執行下列命令；產物與 fixture 全部在新建 `%TEMP%` 目錄，
不寫 canonical `.tmp`／dist／runtime。既有 node 與 node_modules 足夠，不需要安裝 dependency。

```powershell
$ErrorActionPreference = 'Stop'
Set-Location C:\GPT_MCPtool\codex_bridge
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
if ($LASTEXITCODE) { throw 'NOEMIT_FAILED' }
$checkRoot = Join-Path $env:TEMP ('direct-normal-check-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $checkRoot
$config = @{extends='C:/GPT_MCPtool/codex_bridge/tsconfig.json';compilerOptions=@{
    rootDir='C:/GPT_MCPtool/codex_bridge';outDir=($checkRoot.Replace('\','/')+'/build')};include=@(
    'C:/GPT_MCPtool/codex_bridge/src/http-server.ts',
    'C:/GPT_MCPtool/codex_bridge/tests/powershell-host-diagnostics.test.ts',
    'C:/GPT_MCPtool/codex_bridge/tests/powershell-host-admission.test.ts',
    'C:/GPT_MCPtool/codex_bridge/tests/powershell-host-receiver.test.ts',
    'C:/GPT_MCPtool/codex_bridge/tests/powershell-review.test.ts')}
[IO.File]::WriteAllText((Join-Path $checkRoot 'tsconfig.json'), ($config | ConvertTo-Json -Depth 5))
[IO.File]::WriteAllText((Join-Path $checkRoot 'package.json'), '{"type":"module"}')
foreach ($name in @('node_modules','src','web')) {
    $null = New-Item -ItemType Junction -Path (Join-Path $checkRoot $name) -Target (Join-Path $PWD $name)
}
node node_modules/typescript/bin/tsc -p (Join-Path $checkRoot 'tsconfig.json')
if ($LASTEXITCODE) { throw 'ISOLATED_COMPILE_FAILED' }
$env:NORMAL_TEST_BUILD = Join-Path $checkRoot 'build\src'
$env:NORMAL_TEST_ROOT = Join-Path $checkRoot 'normal-cases'
Push-Location $checkRoot
try {
    node --experimental-test-module-mocks --test C:\GPT_MCPtool\codex_bridge\tests\powershell-normal-flow.test.mjs
    if ($LASTEXITCODE) { throw 'NORMAL_FLOW_FAILED' }
    node --test build/tests/powershell-host-diagnostics.test.js build/tests/powershell-host-admission.test.js build/tests/powershell-host-receiver.test.js build/tests/powershell-review.test.js
    if ($LASTEXITCODE) { throw 'AFFECTED_REGRESSION_FAILED' }
} finally { Pop-Location }
powershell.exe -NoLogo -NoProfile -NonInteractive -File C:\GPT_MCPtool\mcp_control_center\tests\test-normal-production-source.ps1
if ($LASTEXITCODE) { throw 'NATIVE_SOURCE_CHECK_FAILED' }
```

預期 Node 15 + 40 項 PASS；PowerShell 14 checks、nativeCompile PASS、productionEntry
REFUSED_BEFORE_LAUNCH、nativePipeExchange／runnerExecution NOT_RUN、liveMutation false。
這些是 source／離線證據，不是 Windows NORMAL 正式 E2E。

---

> **2026-10-15 工程決策：** 允許繼續編寫正式 CC Operator、受保護 Host IPC、Grant consume、NORMAL／ADMIN Runner 與真正的結果回傳；歷史 checkpoint 內「Source-only」「本輪不能部署」只代表當輪狀態，不阻擋之後的 Source。一般 PowerShell 測試唯讀，禁止讀取 `.env`／機密；正式寫入／提權驗收必須由使用者針對每一筆完整操作明確發起與批准，符合 Windows UAC 和平台政策。詳見 [Bridge 現行 2026-10-15 規格](../../codex_bridge/docs/RemotePowerShellApprovalPlan.md)。

> **2026-10-14 雙入口共用授權執行管線定案（優先）：** [Bridge 最新架構與驗收](../../codex_bridge/docs/RemotePowerShellApprovalPlan.md) 第 0、3、4、6、9、10 節。**主要入口 `CODEX_DERIVED`**：Codex 工程遇真實權限不足，Bridge 通知使用者審核是否放行，Request 必須綁真實 Job／Turn，Receipt 回查原工作。**直接入口 `DIRECT`**：使用者明示 PowerShell 指令，不需 Codex Job。兩者共用同一 App-only 逐筆核准、ApprovalStore 和 Control Center 可信 Operator；特殊操作的**實際派送不經 Codex App Server**。ChatGPT App-only 是唯一真人審核 UI，CC 單例 Tray 只負責 Lifecycle；真實 Windows Host／Grant 仍需驗證。未部署的 v4 Host 與舊 G1 Marker 不能冒充正式能力；以下舊測試只作歷史證據。
>
> **2026-10-13 新決策：正式 Runtime 直接接線／真人 E2E，停止重複 G0／G1 Source Gate。** 唯一執行計畫：[Bridge 正式 Runtime 第 6、9、10 節](../../codex_bridge/docs/RemotePowerShellApprovalPlan.md)。本文件下方原腳本僅作歷史追溯，**不要再跑**。
>
> 目前實際單例 Control Center Tray 為 Source Schema v3；v4 InstalledRelease 未部署，不能把後者當目前活躍的 Owner。維持原 Tray 生命週期，不新增第二套 Tray、平行授權 Store 或 Test Host。
>
> **正式 NORMAL 尚未交付：** CC Source 預檢仍強制 `BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED`，尚無 production Grant authority／可信本機審核／Host IPC／實際 Runner。ADMIN 未完成；不因新計畫或通過舊 Native Pipe 而自行解鎖。任何涉及可信程式安裝、ACL、密碼或 UAC 的本機操作須另外精確告知使用者。

## 已完成的歷史基線（2026-10-13）

- **已通過，不需重跑：** 使用者普通 Windows PowerShell 的 Native Pipe 隔離 Handler 真人驗收 `PASS_ISOLATED_HANDLER_ONLY`，非管理員且 `inAnyJob=false`，三項檢查完整通過。
- **本輪新增：** [固定 11 檔 Source Manifest 唯讀預覽與驗收](NormalSourcePreview.md)；Windows PowerShell 5.1 實際定點回報 `PASS_SOURCE_ONLY`，不寫正式 config、不安裝或啟動任何程序。
- **仍未通過：** protected immutable Host／Canonical Grant／Password Reviewer／跨程序獨立 Runner／結果回傳；正式 NORMAL、ADMIN 均 OFF，無自動執行能力。
- 下方人工 Native Pipe 指令僅為**歷史操作紀錄**，已完成，**不要再執行**。本輪尚無新的真人測試要求。

## 歷史 Reviewer checkpoint：人工 native handler 測試

**以下僅是 2026-10-13 已完成之真人測試的歷史命令，不是現行待辦，也不應再次執行：**

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -File C:\GPT_MCPtool\mcp_control_center\tests\test-normal-pipe-handler.ps1
```

只建立短效本機 pipe、固定合成資料；不讀 secret、不設定密碼、不啟動正式服務、不修改既有 ACL。
receipt 存 `.tmp/normal-pipe-handler/<UTC時間-GUID>/receipt.json`。失敗即停，不提權或重試。
output parent 不必預先存在；腳本只建立固定 `.tmp/normal-pipe-handler` 及唯一 case，
檢查 root containment／reparse point，不覆寫 case。修正後只做 Parser（exit 0）。
exit 0／`PASS_ISOLATED_HANDLER_ONLY` 不代表正式 Host／跨程序／out-of-job 驗收。
請回報 `status`、`operation`、`nativeOperation`、`nativeErrorCode`；FAIL 再附 errorType、
errorCode、hresult，不必提供 identity/SID 或密碼。PASS 後續 canonical Host/Grant source；
FAIL 先分析確切步驟，停止重試／提權。兩者都不授權正式部署。

CodexSandboxOffline 先前執行同類 exchange 已遇 WinError 5、PID52120、HResult -2147467259；
本次 `.ps1` 尚未由 agent 執行。agent 只完成 parser／C# compile（exit 0）。
正式 NORMAL 保持 OFF/UNVERIFIED；ADMIN `BLOCKED_AWAITING_LOCAL_UAC`。

完整 source blockers、固定 handler ordering、deny 收據、SHA／Diff 與回滾：
[Bridge NORMAL Host checkpoint](../../codex_bridge/docs/RemotePowerShellApprovalNormalHost.md)。
原有 Tray preflight 仍未接正式 listener；不可只部署這次檔案便宣稱 production enabled。

## 前輪 source gate 基線

2026-10-13：**正式 host BLOCKED；沒有部署或啟用。**

權威交接與現場步驟：[Bridge G1 Operator](../../codex_bridge/docs/RemotePowerShellApprovalG1Operator.md)。

- 唯一 lifecycle owner 仍是原 CC Tray。新選單 `NORMAL Operator preflight (disabled)` 只建立同程序 runspace；不開 executor listener、不啟動第二個 manager。沒有新增 Startup flag；保持 InstalledRelease exact command。
- 手動 `scripts/normal-marker-operator.ps1 -Action Preflight -TrayProcessId <actual>` 只讀 host gate，BLOCKED exit 2。不要把測試用 `normal-marker-preflight.ps1` 的 current-process probe 當成 host acceptance。
- `McpControlCenter.NormalOperator.psm1` 沿用 InstalledRelease 受保護 path/ACL helper，私有 helper 透過原 module scope。`NormalOperator.Native.cs` 只查 token/job/process/named-pipe peer 身分，沒有 launcher 或 elevation。
- canonical Grant 仍歸 Bridge G0 Broker/Journal/LocalReview；本版 OFFLINE_ONLY Grant 禁止 host 使用。CC 不保存另一份 approval event、不處理 domain payload、不讀密碼。正式 host authority、verifier provisioning、authenticated grant read/consume/result IPC 尚未實作。
- `NormalMarkerOperator.mjs` 僅是 isolated integration composition，依賴 Bridge compiled fixture protocol。沒有新增正式跨元件 runtime dependency 或解除 OS/ACL gate。

定點驗證（不啟動 Tray／component）：

```powershell
powershell -NoLogo -NoProfile -NonInteractive -File tests/test-normal-operator-gate.ps1
```

預期 source proof PASS/exit 0；host BLOCKED 保持不變。不要跑 R1、ADMIN、整套 component tests 取代這個 gate。
