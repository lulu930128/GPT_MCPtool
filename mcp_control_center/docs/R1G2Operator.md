# R1 本機 installed release 與 operator cutover

2026-10-13。本頁是目前 G2 操作規格；取代舊 bootstrap 的 installed 部分。

| Gate | 本輪證據 |
|---|---|
| G0 | `HOST_NOT_VERIFIED`。沒有 ChatGPT host ceremony，request/enroll/approve 維持禁用。 |
| G1 | **PARTIAL**。本機正向 binding/spawn source path 已接通；完整 protected child、實際 operator/NTFS、OS/plugin 負向權限尚未驗收，不能宣稱 SOURCE_COMPLETE。 |
| G2 | operator 工具已實作；**NOT_DEPLOYED**。本 job 沒有安裝、ACL、Startup 或 lifecycle mutation。 |
| G3 | 未驗收；沒有遠端核准或 reload 成功收據。 |

這次不再用 G0 阻擋所有本機部署。registry v4 搭配新的 release contract v3 可以在完整本機檢查成功後啟動；
舊 release contract v1/v2 仍是 inert candidate。`activationReady` 是 verifier 的輸出，manifest 不接受這個欄位。
本機可用不等於 R1 遠端授權可用；installed R1 owner/pipe 仍在 G0 拒絕，不開核准 fallback。

## 已接通的來源

- 固定八元件，只有 Bridge 使用版本化 code root；另外七個 root、descriptor 與 controller 留在原 checkout。
- Node 完整 distribution、Codex 0.154.0 JS/native、tunnel-client、key-store、native DLL、CC/Bridge 完整樹受 ACL/hash 綁定。
  Codex platform package 必須實際解析至該 release 的固定 package.json；沒有 ancestor fallback。
- 既有 operator SID、profile、LocalAppData、JobStore、allowlist、Codex home 與 handoff 路徑保持分離。
  profile 檔案 bytes 與 HTTP bearer 模式在封裝時綁定；DPAPI 原檔留在原處，只有同帳號啟動 tunnel 時由固定 key-store 解密。
  key-store 不可使用 ambient `CONTROL_PLANE_API_KEY` shortcut。
- runtime/owner/PID/log 位於原 operator 的 `McpControlCenter/installed-bridge/<releaseId>`；不採用 legacy PID sidecar。
  child 的 executable、argv、closed environment 和 protected working directory 由實際 context 重建並比較。
  parent PATH、NODE/OPENSSL loader、tray settings、caller executable overrides 均不能選取程式。
- 每次 mutation 重查 closure/state/Startup/owner；native tree reader無跨呼叫 cache。native DLL 先核對自己的 protected path/hash，
  再載入，並核對 loaded assembly location。tree digest 與既有 ordinal SHA256 契約一致。
- tray bootstrap 核對 SID、exact command、out-of-job 與 ancestor chain；後續以仍存活的 exact protected tray、Startup、SID、
  out-of-job 和既有單一 mutex 查核。launcher 退出不會使 owner 永久失效，也不以重用的 parent PID 作授權。
- Core/CLI/UI/autoReconcile 都經相同 gate；Status/Doctor/PlanOnly 不委派 lifecycle。
  tray 的明確 `PublishObservation` 才寫營運狀態。Bridge 舊 diagnostic tray 拒絕 installed 模式，使用單一 CC 的 health detail。
- Bridge stop 保留同一 native process handle 的驗證與終止，installed 另核對 exact argv/SID，拒絕 legacy adoption。

## 唯一操作入口

`codex_bridge/scripts/installed-release-operator.ps1` 只接受 `Prepare / Install / Preflight / Cutover / Rollback`。
不自我提權、不建 task/service、不接受 command string。每個 action 都要求獨立 Windows PowerShell、非 Codex/Node ancestry、
out-of-job。Install 必須 Administrator；其他 action 必須原 non-admin operator。

請等本次 job 與其他工作全部 terminal，暫停新工作提交，再由 Windows 桌面開啟 `powershell.exe -NoProfile`。
下面三個階段都只使用此入口。若原 private ACL/identity 不合格，preflight 會拒絕；工具不偷偷修改原 credential、policy 或資料 ACL。
這是實際現場 gate，不是要求改 manifest boolean。需要調整原私人 ACL 時，應由 operator 另行核對範圍，不能從此 job 代做。

### 1. 原帳號 non-admin：封裝已建置的隔離 candidate

```powershell
$tool = 'C:\GPT_MCPtool\codex_bridge\scripts\installed-release-operator.ps1'
$candidate = 'C:\project\r1-isolated-bca30996e4034276946f75fe991d5638'
$package = 'C:\project\r1-package-20261013-g2'
& $tool -Action Prepare -CandidateRoot $candidate -PackageRoot $package -ReleaseId r1-20261013-g2
```

若使用非預設 JobStore/allowlist/Codex home，必須傳入與既有 runtime 設定相符的 `-DataDir / -ProjectsFile / -CodexHome`。
現有 bearer token 只從原 operator 已有的 process 環境使用，不貼到命令或對話。
Prepare 不解密、不複製秘密；只讀設定 identity/hash，驗證 live ownership、HTTP auth 與六個 R1 tools 的 schema。
它只複製固定 code/script allowlist，包含完整 Node distribution，並在 non-admin 階段用固定 Windows compiler 建置四個 native DLL。installed bundle 不包含 legacy standalone tunnel/Startup/restart scripts 或 VBS；bundled Bridge descriptor 與 SelfTest 移除 legacy diagnostic tray capability，使用單一 CC health detail。原 v3 descriptor 未改。
保留輸出的 `packageFile` 與 `sha256`，交給下一個本機 Administrator 視窗。

2026-10-16 封裝修補（source-only）：Bridge allowlist 加入 `powershell-host-transport.ps1`，來源固定為
`CandidateRoot/codex_bridge/scripts`，沿用缺檔及 reparse ancestor 拒絕。Prepare 在 package 的
`mcp_control_center/src/NormalOperator.Host.dll` 合併編譯下列五檔，沒有 wildcard 或額外來源搜尋：
`NormalOperator.Native.cs`、`NormalOperator.Pipe.cs`、`NormalOperator.Security.cs`、
`NormalOperator.Execution.cs`、`NormalOperator.Host.cs`。
使用固定 Framework64 v4.0.30319 `csc.exe`、`/noconfig /nostdlib+ /target:library`，明確參照
`mscorlib.dll`、`System.dll`、`System.Core.dll`、`System.Security.dll`，Host 另參照
`System.Web.Extensions.dll`（`JavaScriptSerializer`）。拒絕預建輸出、缺少或 reparse native source、編譯失敗；
產物及 transport 均在原有 tree hashes 計算前進入 package，沿用 archive/closure/ACL 驗證。
installed loader 仍只載入 protected DLL，並要求五個 `McpCcNormal*` types 的 assembly path 完全相符；
未增加 installed runtime 動態編譯或 writable TEMP loader。

局部驗證使用 `codex_bridge/tests/test-installed-operator.ps1` 抽取實際 Prepare 的 allowlist/copy/compiler 語句，
在可刪除 fixture 編譯四個 DLL；Host DLL 只做 reflection-only metadata 檢查，不執行 candidate。
測試涵蓋 transport 缺檔與 reparse ancestor、五檔 source 各自缺檔、native reparse、四個預建 DLL 拒絕、
編譯失敗，以及 DLL/transport/source 篡改或刪除造成 closure 拒絕。reparse metadata 與 protected ACL 邊界為隔離模擬，
不代表真實 OS protected-install positive 驗收。`requireProductionHost()`、`FreshNativeCeremony.Require()`、
`HostLease.Require()` 與 ADMIN UAC 阻擋維持；此修補不啟用 PowerShell E2E，也不改變部署狀態。

### 2. 獨立 Administrator：只安裝新版本

```powershell
& 'C:\GPT_MCPtool\codex_bridge\scripts\installed-release-operator.ps1' `
  -Action Install -PackageFile 'C:\project\r1-package-20261013-g2.zip' `
  -PackageSha256 '<Prepare 輸出的完整 sha256>'
```

Install 不執行 package 中的 JS/PS lifecycle；它鎖住單一 archive stream、核對 digest，
在新的 `C:\Program Files\McpCcReleases\r1-20261013-g2` 建立 protected ACL 後才解壓。
拒絕既有版本覆寫、ZIP traversal、ADS/device names、duplicate/link entries、超量 entries/bytes；核對實際解壓長度。
完成後回 `INSTALLED_INACTIVE`，Startup/Bridge 尚未切換。失敗留下 inactive 目錄，不自動刪除或放寬 ACL。

### 3. 原帳號 non-admin：preflight 與單次切換

```powershell
$release = 'C:\Program Files\McpCcReleases\r1-20261013-g2'
$tool = Join-Path $release 'codex_bridge\scripts\installed-release-operator.ps1'
& $tool -Action Preflight -ReleaseRoot $release
# 通過後，在舊 CC tray 選 Exit control center only；不要停止其他 MCP。
& $tool -Action Cutover -ReleaseRoot $release
```

Preflight 可以建立新的 private release runtime 目錄；不改原 owner/credential ACL，不啟停程序。
Cutover 重新要求 `jobs.scope=all, active=0, awaitingApproval=0`、owner/native identities、rollback Build ID、原 Startup bytes、
HTTP auth/schema 與 release closure。舊 tray 必須已退出；既有 R1 receipts 必須完整、digest 相符且全部 completed/failed，未完成寫入或 unknown 一律拒絕。工具不讀取或改寫 policy，也不執行 receipt recovery。
切換只委派既有 controller：legacy `ShutdownRuntime` → 保存/更換唯一 Startup → 啟動 installed CC → installed `EnsureRunning`。
沒有第二套 Bridge/tunnel stop/start，也不啟動另外七個 MCP。

僅在 exact ownership、canonical/health Build ID、HTTP auth、原 tunnel profile/readyz、六個 R1 tools 都成功時寫 `LOCAL_ACCEPTED`。
收據在該 private runtime 的 `operator-cutover.json`，不含 token、profile body、DPAPI bytes 或 domain payload。
本機 MCP discovery 不代表 ChatGPT cache/iframe/WebAuthn 已驗收。

任何 `UNKNOWN` / 非零 exit 都停止；不能重送 Cutover、手改 receipt 或用健康 HTTP 200 認定完成。
初次 cutover 仍依賴 operator 暫停所有新提交；它不替既有 loaded v3 新增 admission API，不能把 idle snapshot 當遠端 drain fence。

## 回滾

### 已檢視恢復後沿用 state

v5 的 `PlanState` / `BindState` 可指定 `PreviousReleaseRoot`，沿用已完成
`STATE_BOUND` 的單一 owner，僅建立新 release 的部署快照，不重做遷移或既有 ACL。
原本從未選用的路徑仍要求 `UNKNOWN / STOPPING_LEGACY` 與原複製內容一致。

若前版停在 `UNKNOWN / SELECTED`，只能在獨立人工恢復已完成後，明確傳入
`-StateRecoveryReceipt <已檢視的恢復紀錄>` 與 `-StateRecoverySha256 <完整 hash>`。
目前接受 `r7-selected-source-recovery-v1 / SOURCE_RUNTIME_RESTORED`：重新核對前版
protected closure、STATE_BOUND／計畫、原 UNKNOWN hash、保存的 Startup bytes、
還原後唯一 Startup、無 Tray／installed role marker，以及原 Controller 的 live ownership、
全量工作閒置、恢復時 core／tunnel PID 與 build。恢復 JSON 本身不是授權。

只容許 Control Center 的 `state.json` 觀察快照不同；長度與 SHA-256 一併綁入新計畫，
其餘原遷移項目仍須相符。BindState 完成前再核對一次，任何差異保留 UNKNOWN、禁止重跑。
原 UNKNOWN／STATE_BOUND／恢復紀錄和狀態快照均不改寫。這個分支不重送 Cutover，
也不授予 PowerShell NORMAL 或 ADMIN 執行權限。

### 成功部署的回滾

成功的本機部署可透過同一入口做兩階段回滾，仍要求全部工作 terminal。

```powershell
& $tool -Action Rollback -ReleaseRoot $release
# 收到 ROLLBACK_STOPPED 後，在 installed CC 選 Exit control center only。
& $tool -Action Rollback -ReleaseRoot $release
```

第一階段在 installed owner 仍存在時透過其 controller 停止自身 runtime；第二階段要求無 tray、無 listener，
核對原 v3 canonical 與保存的 Startup bytes，才恢復原 Startup 並委派 v3 `EnsureRunning`。
不是 source rollback，不修改 live dist/web/package，不刪資料。遇到 `UNKNOWN` 或 owner/build 改變，不做自動 recovery。

## 本輪驗證與限制

- 一次 isolated integration：`C:\project\r1-isolated-bca30996e4034276946f75fe991d5638/result.json`，10 steps 全部 exit 0。
  npm 180/180、HTTP/widget、native handle 23、v3 controller 73、canonical 58、CC owner 17、mapping 67、binding 82。
- 後續安全修復只重跑受影響的 targeted suites，證據：
  `C:\GPT_MCPtool\codex_bridge\.tmp\history\r1-g2-evidence-91484a30533743ebb83b2a2934a6e822`。
  最後 targeted：operator 21、mapping/fail-closed 68、binding 82、v3 controller 73 全通過。
  封裝後 descriptor 另由實際 Core parser 驗證五個 lifecycle capabilities；原 v3 descriptor 不變。
  包含 archive path/native ACL/hash parity、operator 在 Codex job 被拒絕、原生 DLL 編譯、source diff 與 live before/after。
- 原 provider 掃描：4,297 + 2,286 entries 約 60.9 秒。native reader 的 **performance-only fixture** 約 1.38 秒；
  該量測另以命名不同的測試 class 略過 owner/write 拒絕，以便讀取 writable candidate；它不是正式 ACL 通過證據。
  原生 production ACL predicate 另有合成正/負 SDDL 驗證，沒有修改 NTFS ACL，也沒有 timeout 放寬。
- 尚未執行 Administrator Install、真正 protected child、Startup/peer live cutover、rollback 或 OS/plugin 負向操作。
  Codex read-only/workspace-write profile 的 deny 不等於 Project Workspace plugin 的 effective denial；此項仍須獨立驗收，
  在完成前 R1 遠端 owner/核准保持關閉。本機 G2 與 G0/G3 的證據不可混用。
