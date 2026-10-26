# InstalledRelease 桌面離線交接

`scripts/validate-installed-desktop.ps1` 是單一離線驗證入口。由原帳號從 Explorer
開啟**非管理員 Windows PowerShell 5.1**，執行：

```powershell
& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -File 'C:\GPT_MCPtool\codex_bridge\scripts\validate-installed-desktop.ps1'
```

入口拒絕 Admin／其他 PowerShell，建立唯一隨機 `%TEMP%\installed-handoff-native-<guid>`
及 `fixture-only` marker，再原封呼叫 `test-installed-auto-resume.ps1 -Mode NativeOperator
-FixtureRoot <該目錄>`。既有 fixture 的原始 `Assert-IndependentOperator` 負責 Job Object
與 Explorer 血緣檢查；入口沒有替代判斷、breakaway、排程或 Explorer proxy。

只有子程序 exit=0，且 `native-result.json` 的 `ok=true`、`outsideJobs=true`、
`independentOperatorVerified=true`、`productionTouched=false` 均為 JSON boolean，
`scope=NativeOperator` 才顯示 PASS。缺檔、malformed／過大結果、非零 exit、錯誤型別與
原始 `INDEPENDENT_OPERATOR_REQUIRED` 均拒絕並回非零 exit。fixture 保留供檢視，沒有正式
receipt 或新 Approval Gate。PASS 僅代表離線 NativeOperator fixture，installed ACL 仍是
`NOT_TESTED`，不能宣稱已部署、IPC 已連線或 Live 已接受。

Codex Job 只跑以下 parser／static／合成 IO 測試，不執行上述入口或 NativeOperator：

```powershell
powershell -NoProfile -NonInteractive -File codex_bridge\tests\test-validate-installed-desktop.ps1
```

## Candidate 與桌面部署順序

Candidate 必須在 LegacyWorkspaceRoot 外，保持 `STAGED_ONLY`。固定集合為 CC
`src/config`、Bridge `src/dist/web/control-center/node_modules`、Prepare 原始
`$scriptLists` 的 19 個腳本，以及 Bridge `package.json/package-lock.json`。
`dist/src` 必須由同一 source WIP 建置；不帶舊 compiled tests、歷史 package、私有設定、
`.git/.local/.env`、token、DB、log 或 installed manifest。合法依賴內的 `runtime/cache`
是套件程式碼，不能因目錄名稱而刪除。Native DLL 仍由既有 Prepare 編譯，不能預放。

本次實際 CandidateRoot、Build ID、source HEAD、逐檔 SHA-256 及 metadata 盤點保存在
repo 外交接目錄。這是 source provenance，並非 Package hash、簽章或正式 lifecycle receipt。
修改 Candidate 後不得沿用舊 hash 證據。Prepare 本身仍負責正式 package closure。

以下僅是桌面命令模板；不要在 Codex Job 執行。每步取得成功輸出、核對其 phase／hash
才進下一步；任何權限／independence／UNKNOWN 拒絕立即停下，不改 ACL 或換入口重試。
完整 v6 恢復契約見 [RuntimeStateMigration.md](RuntimeStateMigration.md)。

1. 原帳號、非 Admin、獨立桌面 PowerShell：完成上述離線驗證。核對本次交接中的
   Candidate 與 selected release，設定 `$candidate`、`$previous`、新的 `$releaseId`、
   尚不存在的 `$package`，及 `$op=Join-Path $candidate 'codex_bridge\scripts\installed-release-operator.ps1'`。
2. 若 selected v6 是 `STATE_BOUND` 且原 Cutover `UNKNOWN / lastPhase=SELECTED`，先由
   操作者核對原 receipt 與 selected manifest 的 SHA-256，再合法執行一次：

   ```powershell
   & $op -Action AttestSelectedV6 -ReleaseRoot $previous -OriginalCutoverSha256 '<reviewed-original-cutover-sha256>' -RecoveryManifestSha256 '<reviewed-selected-manifest-sha256>'
   ```

   只有成功回傳 `ATTESTED_SELECTED_V6` 才將真實 `attestationSha256` 設為 `$recovery`。
   本動作保留歷史 UNKNOWN，不重放 Cutover、不寫成 ACCEPTED。有效期四小時；Prepare／
   PlanState／BindState 及首次 Cutover 須保持原 selected evidence。失敗不續行、不自造 pin。
3. 同一非 Admin 桌面環境：

   ```powershell
   & $op -Action Prepare -CandidateRoot $candidate -PackageRoot $package -ReleaseId $releaseId -LegacyWorkspaceRoot 'C:\GPT_MCPtool' -UpgradeFromReleaseRoot $previous -InstalledRecoverySha256 $recovery
   ```

   只接受真實 `PACKAGED` 的 `packageFile` 與 `sha256`；這時才有 Package hash。
   不使用 `-InitializeBridgeBearer`、不提供或輸出 token。
4. **僅 Install 使用 Administrator**；原帳號從桌面另開獨立 Windows PowerShell 5.1，
   設定相同 `$op`，並代入上一階段核對過的實際值：

   ```powershell
   & $op -Action Install -PackageFile '<actual-packageFile>' -PackageSha256 '<actual-sha256>'
   ```

   必須得到 `INSTALLED_INACTIVE`。將其真實 `releaseRoot` 設為 `$next`，結束 Admin shell。
5. 回原帳號獨立**非 Admin** Windows PowerShell；沿用同一 Candidate 的 `$op`、`$previous`
   與 `$recovery`，逐步執行（不要一次整段貼上）：

   ```powershell
   & $op -Action PlanState -ReleaseRoot $next -UpgradeFromReleaseRoot $previous -InstalledRecoverySha256 $recovery
   # 核對 STATE_PLAN_READY；$planPin 使用真實 statePlanSha256。
   & $op -Action BindState -ReleaseRoot $next -UpgradeFromReleaseRoot $previous -InstalledRecoverySha256 $recovery -StatePlanSha256 $planPin
   # 核對 STATE_BOUND。
   & $op -Action Preflight -ReleaseRoot $next -InstalledRecoverySha256 $recovery
   # 核對 PREFLIGHT_READY，確認已授權停機時段；首次 bootstrap 不帶 AutoResume。
   & $op -Action Cutover -ReleaseRoot $next -InstalledRecoverySha256 $recovery
   # 必須先得到 UPGRADE_STOPPED，再手動在舊 CC 選 Exit control center only。
   # 舊 Tray 結束後，執行同一個 Cutover，沿原 UPGRADE_STOPPED 收據續接。
   & $op -Action Cutover -ReleaseRoot $next -InstalledRecoverySha256 $recovery
   ```

   本次唯讀確認 selected `normal-direct-bearer-20261023` 的 installed `tray.ps1` 不含
   `McpCc.InstalledTrayExit.v1`、`New-TrayExitSignal` 或 `Initialize-TrayExitSignal`。
   因此首次 bootstrap 必須用上述兩階段路徑；直接 `-AutoResume` 會因舊 Tray 沒有 Event
   而在停機前拒絕 `UPGRADE_TRAY_EXIT_UNAVAILABLE`。只有第一步成功留下 `UPGRADE_STOPPED`
   才允許第二次 Cutover 續接；若是 UNKNOWN 或其他錯誤，不重試、不手改收據。

新版本成功啟動且後續升級的 selected Tray 已支援 Event 時，才可改用以下單次命令：

```powershell
# 僅限未來已採用 Event 的 installed v6 -> v6 升級。
& $op -Action Cutover -ReleaseRoot $next -AutoResume
```

正常 `LOCAL_ACCEPTED` 基線不需要本次 UNKNOWN 恢復 pin。`-AutoResume` 由原 operator
自動通知舊 Tray Exit、等待它結束並續接，不要求手動 Exit。不使用 Stop All、不另起
manager。任何 timeout／拒絕都保留原 phase 與 evidence，停止人工判讀；不能將 UNKNOWN
假設成可續接的 UPGRADE_STOPPED。

正常已 `LOCAL_ACCEPTED` 的 release 不適用上述 UNKNOWN attestation；不能盲用本次恢復參數。
部署完成後仍須另行確認實際 installed Build、Workspace→CC IPC 與產品行為；離線 PASS
與 STAGED_ONLY 均不取代那些驗收。
