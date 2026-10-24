本頁保留舊 v3 bootstrap 紀錄。新的 versioned installed 安裝、cutover 與 rollback 請使用 [R1G2Operator.md](R1G2Operator.md)；G2 本機部署與 G0 WebAuthn 已分離，尚未實際部署。

# R1 首次採用：本機 operator 操作頁

**後續 G1 gate 尚未完成，暫勿執行本頁 cutover。** 2026-10-12 source 修復保留
`INSTALLED_LIFECYCLE_BINDINGS_REQUIRED`／`R1_DEPENDENCY_BINDINGS_UNVERIFIED`；
完整 G2/G3 前置與剩餘檔案見 [R1 installed-release](R1InstalledRelease.md)。

本頁是人工操作交付，**NOT_DEPLOYED**，不是 reload 成功收據。預設只做 PlanOnly。
不得從 Bridge job、Codex terminal 或其子程序執行正式 Restart。若 Task Scheduler 唯讀
preflight 失敗，該次排程流程即停止，不改用其他背景程序、SYSTEM、Highest 或提權。

既有契約見 [R1 bootstrap／rollback](RemoteSelfReloadR1.md) 與
[canonical Build ID／正式驗收](../../codex_bridge/docs/RuntimeBuildId.md)。

## 1. 在獨立、非管理員 PowerShell 做唯讀 preflight

先保存本次 job ID／turn ID 與已知其他 jobs 的 ID；從已認證 Bridge 查 exact snapshot，
確認本次 turn 已 terminal、pending approvals 為 0。分頁核對其他工作，期間不要送出新工作。
舊版 health 的 `totalVisible=20` **不能證明全部 idle**；只看 `active=0` 不足以放行。
若 inventory 不完整、身分或工作狀態不明，停在 PlanOnly。

```powershell
$ErrorActionPreference = 'Stop'
$PlanOnly = $true
$root = 'C:\GPT_MCPtool\codex_bridge'
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
$desired = & $node (Join-Path $root 'scripts\runtime-build-id.mjs')
if ($LASTEXITCODE -ne 0 -or $desired -cnotmatch '^[0-9a-f]{16}$') {
    throw 'Canonical Build ID unavailable'
}
$module = Import-Module (Join-Path $root 'scripts\codex-bridge-runtime.psm1') -Force -PassThru
# Pure build readers only: no settings, token, lifecycle or owner-state mutation.
$context = [pscustomobject]@{
    projectRoot=$root; nodePath=$node; expectedBuildId=$null
    httpEntry=(Join-Path $root 'dist\src\http-main.js')
}
$windowsId = & $module { param($c) Get-CbExpectedBuildId -Context $c } $context
$current = & $module { param($c) Test-CbBuildCurrent -Context $c } $context
if (-not $current -or $desired -cne $windowsId) { throw 'Build stale or canonical mismatch' }
$h = Invoke-RestMethod 'http://127.0.0.1:18828/health' -TimeoutSec 3
$t = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:18829/readyz' -TimeoutSec 3 -MaximumRedirection 0
if (-not $h.ok -or $h.service -ne 'codex-handoff-bridge' -or
    $null -eq $h.jobs.active -or $h.jobs.active -ne 0 -or
    $null -eq $h.jobs.awaitingApproval -or $h.jobs.awaitingApproval -ne 0 -or
    $h.controller -notin @('idle','ready') -or $t.StatusCode -ne 200 -or
    $t.Content.Trim() -notin @('ready','ok')) { throw 'Runtime not confirmed idle and healthy' }
[pscustomobject]@{
    PlanOnly=$PlanOnly; liveBuildId=$h.buildId; desiredBuildId=$desired
    nodeWindowsEqual=($desired -ceq $windowsId); healthScope=$h.jobs.scope
    exactJobAndAllWorkReviewRequired=$true; ownershipReviewRequired=$true
}
```

此輸出不是 execution grant。另以既有 component `Status` 核對 server／tunnel PID、
exact executable、start time、owner sidecar、listener、tunnel identity 與 canonical Build ID。
controller 必須使用相同 Node executable；任何 `OwnershipUnknown`、`OwnershipMismatch`、
controller inspection failure 或設定不可讀均停止，不能用手動 PID kill 補救。
磁碟 desired 與 live build 不同可以是待採用狀態；Node／Windows desired 算法必須一致，
且兩個值都要保存。只有 build stale 時才先依 RuntimeBuildId 文件建置，然後從頭重做 preflight。

## 2. 只委派既有固定 Restart，一次

在上述獨立 operator 視窗，先保留預設 `$PlanOnly = $true`：

```powershell
$PlanOnly = $true
& powershell.exe -NoProfile -ExecutionPolicy Bypass `
    -File 'C:\GPT_MCPtool\mcp_control_center\scripts\control-center.ps1' `
    -Action Restart -Component codex_bridge -PlanOnly:$PlanOnly
if ($LASTEXITCODE -ne 0) { throw 'Control Center plan/action failed; stop and inspect' }
```

PlanOnly 仍可能寫入既有 Control Center 營運紀錄，但不委派 component mutation。
確認 plan 固定映射為 `reload_runtime -> runtime-control.ps1 -Action ReloadRuntime`，
且全部 gate 通過後，**由 operator 在同一段命令把 `$PlanOnly` 改成 `$false`，只執行一次**。
`ExecutionPolicy Bypass` 是 repo 原有 script 啟動參數，不是 UAC 提權；視窗保持非管理員。
不得加 `ExpectedBuildId`、變更帳號、替換 controller、重試或在本次 Codex job 執行這一步。
若 registry 被其他元件既有 SelfTest 阻擋，保存 error／exit，停止，不停用檢查或修理其他元件。

## 3. 成功條件、失敗處置與遠端覆核

- 保存 action exit code、component delegation 的 before／after PID、canonical Build ID、
  safe errorCode 與時間到 ignored `.tmp` 收據；不要保存 token、profile、原始 MCP payload 或 log。
- exit 0 之外，須有 controller `after.status=Ready`、exact server／tunnel ownership、
  `/health.buildId` 等於剛驗證的 desired、`/readyz=200 ready|ok`。R1 health 須有
  `jobs.scope=all`、active=0、awaitingApproval=0 與 R1 contract。
- 依 RuntimeBuildId 文件依序做既有 `EnsureRunning`、`Status` 驗收，均不帶 Build ID override；
  必須保持剛採用的 server／tunnel PID。EnsureRunning 是既有非破壞性 lifecycle 驗收，
  不屬於上方唯讀 preflight，只有正式 reload 成功後才執行。
- 重新連線／Refresh Actions；新的已認證 MCP session 應查到六個 `codex_self_reload_*`
  tools，其中 `challenge`／`approve` 僅 app 可見。遠端 Reviewer 再查 Bridge build 與同筆
  sanitized receipt；local health 不代表 host schema cache 或真正 passkey 已通過。
- 非零 exit、斷線或 postcheck 不完整即保存證據並停止；若 lifecycle 已開始，結果視為
  `UNKNOWN`，不得自動重送或自動 rollback。先核對兩個 owner／PID／listener／build，
  再由 operator 決定恢復；不能用 git reset、source 回復或健康 HTTP 200 宣稱 runtime 已回滾。
- 本輪若沒有 register／dispatch／reload，沒有需要撤銷的 task 或 runtime action。
  正式 owner 啟用後要停用時，先核對無 dispatching／running／unknown、無 active job，
  保留 receipts，再由 operator 停用 policy 並透過既有 tray lifecycle 更新；不手改 receipt。

## 4. protected owner／passkey 仍須獨立部署

Bridge 採用新版不等於 R1 owner 已啟用。人工 Administrator 必須完成受保護 source promotion，
保留原 WIP checkout，不直接複製 DPAPI 材料、不開放 code write。正式程式／依賴與父目錄
owner/write ACE 只允許 SYSTEM／Administrators；runtime 同一非管理員 SID 只有 read/execute。
既有 lifecycle 的設定、tunnel／credential 路徑與登入身分必須先證明可沿用，否則停止部署。

獨立 tray 必須 out-of-job，ancestor chain、exact entrypoint 與 Bridge 同 SID 都可驗證；
private state ACL、固定 policy fields 與 authenticator 公鑰由真人核對，不由模型產生替代金鑰。
另盤點 Project Workspace 的 mode、roots、policy、runtime identity：`operate/writeEnabled`
不會因 Codex profile 自動變唯讀；protected tree 排除與受控負向權限測試完成前保持未驗證。

真正 ChatGPT iframe 必須證明 Permissions-Policy／iframe allow、HTTPS RP／origin／topOrigin
和 UP／UV ceremony。WebAuthn API 存在或合成 fixture 通過都不足；未實測即
**NOT_DEPLOYED / HOST_NOT_VERIFIED**，不修改父頁授權或使用文字核准 fallback。
詳見 [W3C WebAuthn Permissions Policy](https://www.w3.org/TR/webauthn-3/#sctn-permissions-policy)。
