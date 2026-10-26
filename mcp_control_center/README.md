# MCP Control Center

`NormalOperator.Native.cs` 與 `RemoteSelfReload.Native.cs` 同時提供 Bridge cooperative transport 的 native primitives。Bridge daily Stage 僅複製這兩個 code dependency 到自己的版本包並驗 hash；canonical source 仍在此處，CC owner／launcher／registry 維持獨立。

CC 獨立部署使用本元件的 `Runtime/versions/<version>` 與 `Runtime/current.json`，既有 state 固定沿用 `.local/runtime`。先用 [runtime-update.ps1](scripts/runtime-update.ps1) 的 `Stage`／`Status`；這兩個操作不搬資料、不改 Startup、不重啟元件。2026-10-25 已啟動 `cc-20261025-d`，實際 tray 路徑、唯一 mutex 與八元件 Ready 已核對。使用者後續要求啟用新版開機自動啟動，唯一捷徑現指向 `scripts/start-runtime-tray.vbs --boot`。操作見 [獨立 Runtime](docs/IndependentRuntime.md)。

CC 是唯一 tray／Startup owner。Bridge 的 [daily-code-update.ps1](../codex_bridge/scripts/daily-code-update.ps1) 使用既有 `McpControlCenter.DailyCode.psm1` 協調 Bridge 自身版本與回復，但不打包、不啟動或停止 CC。本次在停機及使用者重開機後，以既有 Adopt／SelectStopped／Start 直接採用新版，沒有恢復舊 release 或建立 Startup，詳見 [日常換版](../codex_bridge/docs/DailyCodeUpdate.md)。

2026-10-23 DIRECT NORMAL source：沿用既有單例 Owner 與 Native Host，接受 Bridge 經驗證的
一次明確遠端請求；不再加本機密碼或確認。完整 closure 在 context setup 沿用既有 OwnerBinding
核對，每次 native 連線仍重新完整驗證；同次連線 handler 只重查受保護 manifest／retained peer，
重用證據一次消耗、120 秒到期，失敗與連線結束即清除。Native peer／DACL／claim 不變。
這輪僅 source 與離線驗證，未更動 installed release 或服務；下方 10/15 文字是歷史紀錄。
實際認證與部署缺口見 [NORMAL 交接](docs/NormalOperatorHandoff.md)。

InstalledRelease v6 的正式 owner state 固定在 `mcp_control_center\.local\runtime`，並由同一受保護
manifest 將 Bridge 資料固定在 `codex_bridge\.local\runtime`。此例外只適用於已驗證的 installed v6；
一般 source workspace override 仍被拒絕。Git ignore 不能取代完整祖先 ACL 驗證。遷移使用原
Bridge installed-release operator，詳見 [Runtime 資料遷移](../codex_bridge/docs/RuntimeStateMigration.md)。

2026-10-15 PowerShell Host source 接續：既有 NormalOperator preflight 改沿用 InstalledRelease 全 closure，native Token/Peer/DACL checks 與 NORMAL execution kernel 僅供後續受保護 owner 接線；`HostLease` 仍拒絕執行，沒有開 listener、增加 Tray 或另一份 Grant Journal。唯一 Journal 仍由 Bridge Runtime 擁有；本輪只編譯／隔離檢查，沒有安裝或啟用。[工程紀錄與尚未完成項目](../codex_bridge/docs/agent-runs/powershell-host-20261015/Progress.md)。

> **2026-10-15 Codex PowerShell 正式工程範圍：** Control Center 的一般 `component-controller` 仍只接受固定 lifecycle actions，不接受任意命令；但這不禁止在既有單例 Tray Owner 下開發獨立、受保護且逐筆核准的 Codex PowerShell Operator（DIRECT／CODEX_DERIVED）。開發期真實 PowerShell 操作唯讀、排除 `.env`／敏感內容；正式寫入／高權限測試僅在使用者明確發起並逐筆核准後、依 OS／平台授權執行。Host 尚未部署，不能以刪除 hard guard 或切換工具繞過平台拒絕。現行規格見 [Bridge PowerShell 主計畫](../codex_bridge/docs/RemotePowerShellApprovalPlan.md)。

R1 目前為 **G1 PARTIAL / G2 NOT_DEPLOYED**：v4 搭配 release contract v3 已接通受驗證的本機 lifecycle，並提供獨立 operator 的版本安裝、cutover 與 rollback 工具。
正式預設 v3 不變；G0 遠端核准保持關閉。操作與證據見 [R1 G2 operator](docs/R1G2Operator.md)。

`MCP Control Center` 是可擴充的本機 MCP runtime Windows 中樞。它不是 MCP server，
不持有任何市場、記憶、學習、workspace、Codex job 或財務資料；即使 MCP server 或
Secure MCP Tunnel 故障，中樞仍可獨立檢查、記錄與協調啟動。

目前 application release 為 `1.1.0`。registry schema v3、component descriptor schema v1
與 `unified-lifecycle-v3` 是獨立契約版本，不因 application release 而重新編號。

目前預設的 registry v3 已登錄八個元件，全部使用 `unified-lifecycle-v3`
component controller，並由各元件自己持有 runtime ownership。八個正式元件都維持 enabled、
auto-start；English Study 常駐 Hub、MCP 與元件自有 tunnel。OMI backend 維持 external
dependency，不屬於 Control Center lifecycle ownership；Memory Core 與 Personal Asset OS
的正式私人資料也不屬於 manager authority：

- `autoStartCore=true`
- 只有宣告 `tunnel` trait 的元件使用 `autoStartTunnel=true`
- production Start 不取代既有 instance
- replacement／restart 使用 component 自己的 exact-path lifecycle
- legacy tray 的 `Exit` 維持完整停止；v3 diagnostic UI 的 `Exit` 只關閉 UI

目前保留全部舊 component tray source、launcher、Startup／restore artifact 與
`config/components.json` rollback manifest。中樞提供單一狀態與操作入口，但不隱藏或取代
component-specific action，也不提供危險的 Stop All／kill-by-name。八個元件皆已完成
controller 遷移與 live adoption；既有六個元件另保留 legacy tray closure artifact，舊 artifact
尚未刪除。

中樞 source 同時支援 registry schema v3、舊 manifest schema v1／v2 與
`unified-lifecycle-v3`。v3 採用
component-owned stateless lifecycle controller：controller 以 mutex、PID file、exact
executable／command、listener ownership 與必要的 process lineage 管理 detached child
runtime，完成 action 後退出。中樞不接管 component process ownership。Loader 仍保留
`legacy-tray` 相容能力，供 rollback 或尚未升級的新註冊元件使用；目前八個 descriptor 皆為 v3。

## 能力

Remote Self-Reload R1 新增可選的 tray-owned runspace 與固定 authenticated named pipe，
僅受理 Codex Bridge 的 `reload_runtime`；不新增 MCP server、不另建 component lifecycle。
worker 持久化 exact human approval 與 receipt，等待完整 idle、重新核對 owner／canonical Build ID，
再委派既有 action mapping。跨元件依賴只含固定 IPC 及公開 native verifier source，不讀 domain data／secret。
**NOT_DEPLOYED**；正式 activation、同帳號信任界線、受保護安裝、WebAuthn host gate 與測試證據見
[RemoteSelfReloadR1.md](docs/RemoteSelfReloadR1.md)。缺 policy 時既有 tray 行為不變。

- 依 registry 的 `startupOrder` 檢查所有 enabled 元件的 core、dependency 與 tunnel readiness。
- 在可取得 Windows listener 資訊時，比對 PID、process name 與 expected command fragments；
  對 Windows venv shim 產生的 listener，可再驗證 component 內 managed PID 檔、managed
  process command line，以及 listener 到 managed PID 的父子程序鏈。
- 區分 `Ready`、`Degraded`、`BlockedUpstream`、`Stopped`、`Unhealthy`、
  `OwnershipUnknown`、`OwnershipMismatch`、`Misconfigured`、`NotInstalled`。
- 狀態優先序為 ownership、owned core、connectivity、dependency；因此
  `BlockedUpstream` 僅表示 owned core 與 tunnel 都已就緒，外部 dependency 仍不可用，
  不會遮蔽 server 或 tunnel failure。
- 將目前狀態寫入 atomic `state.json`，只在狀態變化或 action 發生時追加每日 JSONL event。
- Reconcile 另寫入 atomic `reconcile-progress.json`；tray 只接受自己啟動的 operation ID，並在
  controller 執行期間逐元件顯示 `Pending`、`Checking`、`Ready`、`Needs attention` 或 `Failed`。
  因此新開機的長時間檢查不會再把上一次 boot 的 `Stopped` 當成目前結果。
- 開機 reconciliation 只對真正 `Stopped` 的元件呼叫既有非破壞性 Start；不自動 Restart
  `Unhealthy`、上游阻塞或 ownership 不明的程序。每個 component 的 monitor、action 與
  post-action wait 都有獨立 exception boundary；單一失敗會寫入 bounded
  `reconcile_component_failed` event 與安全 `actions[]` row，但不會阻止後續元件。
- Reconcile 在任何自動 Start／Repair 前會再讀取 component controller 的 bounded `Status`；
  `OwnershipUnknown`、`OwnershipMismatch` 或 controller status failure 一律轉為
  `ManualAttention`，不委派 lifecycle mutation。Ownership 判斷仍由 component controller 擁有。
- 人工 Start／Repair connectivity／Restart core／Reload／Stop 會委派給 manifest 中已驗證、位於 component root 內的固定 entrypoint；Stop 必須逐元件確認，不提供 Stop All。
- Startup adoption 會先驗證各 descriptor 宣告的 legacy shortcut target，再移到 private backup；不直接刪除，並可依 receipt 回復。

### 本機與遠端連線狀態

Control Center 以 additive [`component-connectivity-v1`](docs/RemoteConnectivityContract.md)
呈現分層證據，不再用單一 `Ready` 同時代表所有連線範圍：

- `localStatus` 與 `connectivity.localTunnel` 只證明本機 core、ownership 與 tunnel listener。
- `connectivity.remoteRegistration` 只接受 component-owned diagnostic 產生的安全、具 TTL 證據。
- `connectivity.chatgptConnector` 必須有獨立端到端證據，不由 local HTTP 200 或 remote registration 推論。
- `readinessScope` 明確區分 `none`、`local`、`remote`、`end_to_end`。

一般 `Status` 不解密 credential、不查 tunnel identity，也不同步呼叫外部服務。尚未執行遠端診斷時，
remote／ChatGPT 狀態是 `NotChecked`；證據過期時是 `Stale`。只有新鮮且明確的 remote failure
可以把本機 `Ready` 投影為 `Degraded`，`Unknown`／`NotChecked`／`Stale` 不會觸發自動 repair。

需要讓 Status 採納 component-owned evidence 時，descriptor 可宣告
`connectivityEvidence.remoteEvidencePath`。它必須是 component root 內的相對 `.json` 路徑；
Manager 最多讀取 8192 bytes，只接受固定 contract 與欄位 allowlist。非法、超大或含額外欄位的
文件會 fail closed，且不把原始內容帶入 manager state。外部 lookup 與原子寫入仍由元件明確操作擁有。

Automatic repair 遵循 [`Bounded Repair Policy`](docs/RepairPolicy.md)：只有 core healthy、ownership
可驗證且 local tunnel 為 allowlisted transient failure 時，Reconcile 才委派一次
`repair_connectivity`。Manager 不做外層重試；bounded retry／backoff 仍由 component controller
擁有。Remote、identity／profile／credential、active work、monitor 或 ownership failure 一律
`ManualAttention`，不會自動 restart core 或 full reload。

### Tunnel runtime inventory 與 child network policy

[`Child Process Network Policy`](docs/ChildProcessNetworkPolicy.md) 定義八個 production component
共用的 loopback bypass 與 proxy 邊界。Controller 只在 child spawn 時清除 ambient proxy、設定
`NO_PROXY=127.0.0.1,localhost`，完成後還原 parent environment；不修改 Windows 全域 proxy。

唯讀 inventory 可用下列命令檢查實際 binary path、version、SHA-256、來源與 cohort：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts\tunnel-runtime-inventory.ps1 -Action SelfTest
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts\tunnel-runtime-inventory.ps1 -Action Inventory
```

Inventory 不下載、更新、複製或切換 binary。`runtime\tunnel-client\` 是 gated shared-runtime
候選位置，不是目前已採用的事實；不同 cohort 只產生 warning，不觸發 automatic repair／upgrade。

## Runtime 資料

預設位置：

```text
%LOCALAPPDATA%\McpControlCenter\
├── state.json
├── reconcile-progress.json
├── tray.pid
├── events\YYYY-MM-DD.jsonl
├── diagnostics\latest.json
├── registration-receipts\<timestamp-component-id>\
│   ├── registry.before.json
│   ├── receipt.json
│   └── rollback.json
└── startup-adoptions\<timestamp>\
    ├── receipt.json
    └── <原 Startup shortcuts>
```

`reconcile-progress.json` 是 manager-owned、bounded 的營運進度，只含 boot／operation ID、時間、
元件 ID／顯示名稱與安全狀態；完成後保留最後一次結果供診斷，下一次 Reconcile 會原子取代。
損毀、超過大小限制、舊 operation 或不符 contract 的文件會 fail closed，tray 不會採用。

可用 `MCP_CONTROL_CENTER_DATA_DIR` 指定另一個 private、repo-external 目錄。事件與進度不保存
health response body、MCP payload、token、secret、credential、DPAPI ciphertext 或 domain data；
`token`、`secret`、`credential`、`authorization`、`payload`、`content` 等欄位會被 redaction。

## 使用方式

先執行無副作用驗證：

```powershell
cd C:\GPT_MCPtool\mcp_control_center
powershell -NoProfile -ExecutionPolicy Bypass -File tests\run-tests.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\control-center.ps1 -Action SelfTest
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tray.ps1 -SelfTest
```

讀取目前 live 狀態；這會寫入中樞自己的 state／event，但不啟動、停止或重啟 component：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\control-center.ps1 -Action Status
```

只產生安全啟動計畫，不建立程序：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\control-center.ps1 `
  -Action Reconcile -PlanOnly
```

手動開啟中樞 tray：

```powershell
.\scripts\Start-Tray.cmd
```

一般 Start 不取代既有中樞。更新中樞 source 後使用：

```powershell
.\scripts\Restart-Tray.cmd
```

中樞 tray 的 `Exit control center only` 只關閉中樞，不停止任何 component。

八個元件都使用 `component-menu-v1`；既有元件把舊托盤的 Copy／Open／金鑰狀態／備份等功能直接列在
Control Center 的元件子選單。中樞只渲染 descriptor 內固定的 action ID，再委派給元件自己的
`scripts/control-center-ui.ps1`；它不接收任意 arguments，也不讀 tunnel ID、credential、備份結果
或 domain payload。`Open troubleshooting tools` 仍可按需開啟 component-owned diagnostic UI，
作為 action adapter 無法使用時的完整故障處理 fallback。兩種啟動路徑都與背景
`Status`／`Doctor` 程序彼此獨立；關閉 diagnostic UI 只關閉臨時圖示，不停止或接管 runtime。

## 採用單一 Startup 入口

InstalledRelease 的 Startup 由安裝 operator 管理，固定使用 Windows `wscript.exe` 執行該 release
內的 `scripts/start-tray.vbs`。Launcher 使用 `WScript.Shell.Run(..., 0, True)` 在建立時隱藏
console，並讓 launcher 持續存在以供 tray 核對 Explorer lineage；tray 結束時 launcher 一併結束。
子程序仍是固定的 Windows PowerShell 與 `-NoProfile -WindowStyle Hidden -File "<installed tray.ps1>" -AutoReconcile`。
selection 與後續升版檢查也保留既有直接 PowerShell 捷徑相容性，其他路徑與參數仍拒絕。
Windows Terminal 下單靠 `-WindowStyle Hidden` 仍可能顯示終端視窗；`MainWindowHandle=0`
也不足以證明視窗已隱藏。驗證必須涵蓋實際可見的 Terminal／console 視窗。
舊版不能只修改捷徑，否則會回報 `INSTALLED_STARTUP_NOT_SELECTED`。使用者可選擇同一版本的
局部修補：備份並更新啟動相關程式檔、同步 code tree hash、最後更新捷徑；不需重跑整套升版。
原 manifest 以受保護的 `config/startup-presentation-baseline.json` 保留，state-plan 驗證只在
其 hash 與歷史 pin 一致，且除 code tree hash 外所有設定完全相同時接受此修補。
歷史切換收據仍維持原狀；`UNKNOWN` 不因此變成驗收成功。Program Files 寫入仍需管理員權限。
沒有隨包附帶 `start-tray.vbs` 的舊 release 必須先完成上述局部修補，不能指向 source workspace
的 launcher。重複修補保留最初的 manifest baseline。此修正尚未代表冷開機驗收通過。
隔離驗證：`powershell -NoProfile -File tests\test-installed-hidden-startup.ps1`。

先預覽目前已註冊的 legacy shortcut；任何 target conflict 都會阻止 adoption：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\startup.ps1 -Action Plan
```

確認 plan 後才明確套用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\startup.ps1 -Action Adopt -Apply
```

Adopt 只移動 descriptor 中已識別的 component shortcut，其他 Startup 項目與
`Open Market Intelligence Launcher.lnk` 不在操作範圍。中樞登入後先等待設定的 initial delay，
再按 `startupOrder` 逐一檢查；已 Ready 的元件不會重複啟動。等待與檢查期間 tray 會顯示
本次 Reconcile 的即時進度，不會沿用上一份 `state.json` 的 component label；controller 完成後
才切回最終 authoritative `state.json`。

預覽回復：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\startup.ps1 -Action Restore
```

確認 receipt 與目的位置沒有衝突後：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\startup.ps1 -Action Restore -Apply
```

## Registry 與 component descriptor

預設入口是 [`config/registry.json`](config/registry.json)。registry schema v3 只保存元件的
穩定 ID、workspace 直接子目錄、固定 descriptor path、enabled／autoStart 與
`startupOrder`；每個元件的公開運行契約則由自己的 `control-center/component.json` 持有。
正式結構可參考 [`schemas/registry-v3.schema.json`](schemas/registry-v3.schema.json) 與
[`schemas/component-descriptor-v1.schema.json`](schemas/component-descriptor-v1.schema.json)。

舊 [`config/components.json`](config/components.json) 仍保留作 rollback，並可用
`-ManifestPath` 明確載入。Loader 接受 manifest schema v1／v2 與 registry schema v3，且不會在
registry 已存在但無效時靜默退回舊版。所有設定只包含公開的 source-relative path、loopback
endpoint、port、expected health fields 與 ownership fragment；不得保存 tunnel ID、token、
資料內容、resolved upstream URL 或 credential。Loader 會拒絕：

- 非 loopback 或非 HTTP probe。
- 逃出 component root 的 action path。
- 不是 workspace 直接子目錄的 component root。
- 不符合 `unified-always-on-v2` 的 tray `SelfTest`。
- 不符合 `unified-lifecycle-v3` 的 stateless controller `SelfTest`。
- controller SelfTest capability 與 descriptor 宣告不完全一致。
- controller action 使用錯誤 launcher kind，或由 manifest 自訂 PowerShell arguments。
- `component-menu-v1` 缺少固定 PowerShell entrypoint、宣告未知 action group／confirmation、
  重複 action ID、逃出 component root，或 component SelfTest 與 descriptor action ID 不一致。
- 未知欄位、未知 trait／capability、registry／descriptor ID 不一致、重複 component／root／
  `startupOrder`、不同元件宣告相同 owned port、URL／port 不一致、無 ownership evidence 或
  超過 128 KiB 的設定檔。同一元件的多個 health endpoint 可以共用它自己的 port。
- `publicSummaryFields` 不在安全 allowlist，或 navigation／launcher／PID path 逃出 component root。

### Windows 固定服務埠政策

Production component 的 owned loopback port 是固定服務埠，不得落在 Windows IPv4／IPv6 TCP
dynamic client range，也不得落在 current excluded ranges。Control Center 每次建立 system state
時只讀一次 `netsh interface ipv4|ipv6 show dynamicportrange|excludedportrange protocol=tcp`；它不會
新增、刪除或修改 Windows port policy，也不會停用 HNS、WinNAT、Docker 或 WSL。

- 明確命中 excluded range：probe 回報 `PORT_EXCLUDED`，component 為 `Misconfigured`。
- 未 excluded 但位於 dynamic range：probe 回報 `PORT_IN_DYNAMIC_RANGE`，component 為
  `Misconfigured`。
- policy command／parser unavailable：state 回報 `PORT_POLICY_UNAVAILABLE` 或
  `PORT_POLICY_PARTIAL` evidence，但 health／ownership probe 照常執行，避免監測能力本身造成
  全體 outage。

目前 production cohort 為 Project Reading `18787/18788`、Japanese Study
`18790/18791/18792`、OMI Search `18797/18799`、Memory Core `18765/18818/18800`、Codex
Bridge `18828/18829`、Personal Asset OS `18876/18877`。這些 URL 仍由 component descriptor、
runtime controller、tunnel profile 與 smoke test 共同維持一致；變更時必須重跑 current Windows
policy inventory 與 reboot acceptance。Windows command contract 參考
[netsh interface](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-interface)，
excluded port bind failure 參考 Microsoft 的
[WSAEACCES guidance](https://learn.microsoft.com/en-us/troubleshoot/windows-server/networking/error-10013-wsaeacces-is-returned)。

v3 lifecycle action 的 `-Action EnsureRunning|RepairConnectivity|RestartCore|ReloadRuntime|ShutdownRuntime` 參數由 manager
依 semantic action 固定產生；manifest 只能選擇 component root 內的相對 entrypoint，不能
注入 command string 或 arguments。`show_diagnostic_tray` 只能使用 component 內的 VBS launcher。
PowerShell controller 執行會以 component-specific manager mutex 防止重疊，預設沿用 registry
的 `controllerActionTimeoutSeconds`，descriptor 可用 bounded `timing` 覆寫；action 後的 readiness
等待同理使用 `postStartTimeoutSeconds`。stdout + stderr 合計上限 64 KiB；capture file
在解析後立即刪除。v3 成功結果必須是完整 bounded JSON contract，非 JSON、缺欄、timeout
或超量輸出都會安全失敗，且不會把 stderr 寫入 manager event。

`component-menu-v1` 同樣採固定語意委派：descriptor 只能宣告 `id`、`label`、`group` 與
`confirmation`，不能提供 command、argument、URL 或 secret。manager 固定呼叫 component root
內的 `control-center-ui.ps1 -Action <declared-id>`，並要求 component SelfTest 回報完全一致的 action
集合。選單順序固定為狀態、共同 lifecycle、connection actions、component-specific actions、
troubleshooting 與 component folder；元件可省略不適用的 action，也可在 component group 加入自己的
功能。像 Personal Asset OS verified backup 這類有 side effect 的操作必須宣告
`confirmation: required`，實作與結果內容仍完全由元件擁有。

`ownerManagedPidFile` 是可選的 component-relative runtime PID 檔。設定後，中樞不會只靠
listener module 名稱判定 ownership，而會要求 listener 等於該 managed PID，或位於其
子程序鏈；`ownerManagedCommandContains` 則用來確認 managed process 仍來自預期的
exact-path lifecycle。PID 檔不存在、內容無效、程序無關或 command 不符都會得到
`OwnershipMismatch`，CIM 權限不足則維持 ownership unknown，不冒充已驗證。

Component controller 的 PID reuse、owner sidecar、listener/lineage 與 cleanup race 規格集中於
[`docs/LifecycleOwnershipPolicy.md`](docs/LifecycleOwnershipPolicy.md)；現有 tunnel PID 雙 writer
盤點與保留條件記錄於 [`docs/TunnelPidWriterAudit.md`](docs/TunnelPidWriterAudit.md)。這兩份文件
只定義 component 應遵守的 contract，不把 process ownership 移進 manager。

OMI Search 的 dependency probe 指向 adapter 自己的固定 loopback `/upstream-health`；實際
OMI backend URL 仍由 OMI launcher 與 adapter 擁有。中樞不讀 OMI launcher log、不接管 backend，
也不保存 resolved URL 或 upstream response。Memory Core internal backend 預設使用 `18765`；
Memory Core MCP 與 tunnel admin 使用 reboot-stable 固定埠 `18818` 與 `18800`。

## New Component Kit

[`templates/component-controller`](templates/component-controller) 是新增元件的唯一 base template；
預設產生 `ensure_running`、`reload_runtime`、`shutdown_runtime` 三個 controller capabilities，
可用 `-IncludeDiagnosticUi` 加入 component-owned `diagnostic-ui` trait 與
`show_diagnostic_tray`。模板包含：

```text
<component>\
├── control-center\component.json
├── scripts\runtime-control.ps1
├── scripts\component-runtime.psm1
├── scripts\control-center-ui.ps1
├── tests\test-runtime-control.ps1
└── docs\ControlCenterIntegration.md
```

先預覽 scaffold；`-Plan` 不建立目錄：

```powershell
cd C:\GPT_MCPtool\mcp_control_center
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\New-McpComponent.ps1 `
  -Id example_component -DisplayName "Example Component" -CorePort 18990 `
  -IncludeDiagnosticUi -Plan
```

確認後建立 source。目標只能是 workspace 的直接子目錄，已存在時會 fail closed，不覆寫任何檔案：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\New-McpComponent.ps1 `
  -Id example_component -DisplayName "Example Component" -CorePort 18990 `
  -IncludeDiagnosticUi -Apply
```

新模板的 `component-runtime.psm1` 故意是安全的 `not_implemented` stub；`control-center-ui.ps1`
則提供只含 MCP URL／health／runtime logs 的固定安全起點。它可通過 descriptor、controller／menu
SelfTest 與 source completeness 驗證，因此是 `registrationReady=true`；但在換成元件真正的
exact-path lifecycle、ownership 與 targeted tests 前，會維持 `activationReady=false`，不會啟動程序：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Test-McpComponent.ps1 `
  -ComponentRoot C:\GPT_MCPtool\example_component
```

註冊固定分成 Plan／Apply。Plan 會重跑 validator、檢查 ID、root、startup order 與跨元件 owned
port 衝突，並輸出目前 registry SHA-256；它不修改 registry：

```powershell
$plan = powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts\Register-McpComponent.ps1 `
  -ComponentRoot C:\GPT_MCPtool\example_component -Plan | ConvertFrom-Json

powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Register-McpComponent.ps1 `
  -ComponentRoot C:\GPT_MCPtool\example_component `
  -ExpectedRegistrySha256 $plan.registrySha256 -Apply
```

Apply 會在 mutation mutex 內再次驗證 hash、candidate 與 conflicts，只新增一筆
`enabled=false`、`autoStart=false` entry；不修改 component source、Startup，也不建立 process。
registry 的 exact-byte backup 與 receipt 只寫到 `%LOCALAPPDATA%\McpControlCenter\registration-receipts`，
或明確指定的 repo-external `-ReceiptRoot`。若 receipt root 位於 source workspace 內會被拒絕。

需要撤回該次 registry mutation 時，先預覽並使用 plan 回傳的 current SHA：

```powershell
$rollback = powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts\Register-McpComponent.ps1 -RollbackReceipt <receipt.json> -Plan | ConvertFrom-Json

powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Register-McpComponent.ps1 `
  -RollbackReceipt <receipt.json> `
  -ExpectedRegistrySha256 $rollback.currentRegistrySha256 -Apply
```

Rollback 只還原 receipt 中的 exact registry bytes，保留 component root、receipt、Startup 與 runtime。
註冊不是啟用；完成真實 lifecycle、隔離 smoke、`tests\run-tests.ps1`、Control Center `SelfTest`
與人工 adoption review 前，不應把新元件設為 enabled 或 auto-start。

## 驗證界線

`Status` 與 `Doctor` 不改變 runtime；`Doctor` 另外逐一呼叫 v3 controller 的 `Status`，
所以 health probe 即使為 Ready，只要 controller 回報 ownership mismatch，完整診斷仍會失敗，
不會把「可連線」誤當成「可安全管理」。`Start` 只委派非破壞性 launcher；
`Restart`／`Reload component` 是人工 side effect。完整 MCP protocol smoke、ChatGPT action cache
刷新與 component-specific domain 驗證仍由各元件自己的 README／測試負責，中樞不把 HTTP 200
冒充成完整 protocol 或目前 source 已採用的證明。

v3 descriptor 啟用時，六個舊 tray script 會拒絕任何非 `DiagnosticOnly` 的持久化啟動。
舊 source 與 launcher 仍保留作 rollback；只有把 descriptor 明確回復為 `legacy-tray` 後，
舊托盤才可重新取得 lifecycle ownership。

## 日常托盤與元件 Health 詳情

Control Center 的日常元件選單固定只呈現：

- `Restart MCP`：狀態感知的 manager façade。`Stopped` 導向 `EnsureRunning`；`Ready`、`Degraded`、`BlockedUpstream`、`Unhealthy` 導向 `ReloadRuntime`。
- `Open MCP health`：開啟獨立、無 listener 的 WinForms 詳情頁，顯示 safe state、probe、ownership 與低頻連線工具。
- `Open <Frontend>`：只有 descriptor 宣告正式 `primary-ui` 時出現。第一版支援 VBS `primaryLauncher` 與 `primary_ui` loopback navigation。

`OwnershipUnknown`、`OwnershipMismatch`、`Misconfigured`、`NotInstalled` 與 `MONITOR_EXCEPTION` 一律拒絕 `Restart MCP`。底層 `RepairConnectivity`、`RestartCore`、`ShutdownRuntime` 與 component-owned UI adapter 保留給 CLI、Health > Advanced 與 troubleshooting，不再平鋪到日常托盤。

Health 詳情頁只讀取 registry/descriptor、sanitized `state.json` 與 `%LOCALAPPDATA%\McpControlCenter\last-actions\<component-id>.json`；不讀 MCP domain payload、secret、credential 或 component 私有資料。每個元件的狀態檢查有獨立 exception boundary，意外監測錯誤會合成固定 `MONITOR_EXCEPTION` issue，其餘元件仍會保留並更新。

額外驗證命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\component-health.ps1 `
  -Component personal_asset_os -SelfTest
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\component-health.ps1 `
  -Component personal_asset_os -SmokeTest
```


## Listening Audio 納管

`listening_audio` 是第八個 enabled／autoStart 元件，startupOrder `80`。
元件 controller 擁有 Trainer → MCP → tunnel 的啟動流程；固定埠為 `18811`、`18810`、`18812`。
依賴、私有設定與操作方法見 [Listening Audio 整合文件](../listening_audio/docs/ControlCenterIntegration.md)。
中樞只讀安全 health 與 ownership metadata，不讀取題目、音訊、作答或金鑰。

## Workspace 本機管理通道（2026-10-14 source candidate）

現有 source schema 3 tray 在原 singleton mutex 後接入 `WorkspaceLocal.Native.cs`／
`McpControlCenter.WorkspaceLocal.psm1`，沒有第二個 manager。status／preview 只讀 tray
既有快照；固定七元件 reload 需 explicit interruption confirmation 與 UUID，寫 durable
UNKNOWN 後才委派原 component controller。UUID 綁定精確目標，跨目標 replay 回
`REQUEST_CONFLICT` 且不派送。排除 Workspace 自身與 CC；Codex Bridge active-work refusal 保留。
不需要另一套人員身分驗證、跨 SID 或 Program Files G2；不涉及 R1／NORMAL／ADMIN。
本輪未 restart 或部署。精確範圍、收據、人工採用與回退見
[Workspace 本機維護](../project_reading/docs/LocalComponentManagement.md)。

IPC 在每次 exchange 結束後重用同一個 pipe instance，包含 EOF／broken client；
timeout 會先取消並等待 overlapped IO 結束，再 Disconnect。無法安全清理時關閉 owner，
不留下無人處理的 pipe handle，也不重綁名稱或新增 listener。

唯讀 `diagnostics` operation（`diagnosticsVersion=1`）由同一 publisher 擷取 canonical
state 的安全欄位，在同一 owner 記憶體快照中回應；不於 IPC request 執行 probe 或讀取
私人 runtime。舊四操作回應保持原樣。Bridge descriptor 透過既有 health summary 流程
opt-in jobs.active／jobs.awaitingApproval／jobs.scope／controller；新增四欄各有型別與
值域驗證，不保存 jobs payload，也不新增 probe。來源、ownership 與 Idle 的保守判定見
[Workspace runtime 診斷](../project_reading/docs/RuntimeDiagnostics.md)。
新增隔離測試：Windows PowerShell 5.1 `tests\test-runtime-diagnostics.ps1`。

controller 明確拒絕 `ReloadRuntime` 且結果通過既有驗證時，CC 只接受
`ACTIVE_WORK_PRESENT`、`OWNERSHIP_MISMATCH`、`OWNERSHIP_UNKNOWN`、`ACTIVE_STATE_UNKNOWN`
四個 reason，原子寫入 `%LOCALAPPDATA%\McpControlCenter\workspace-local-diagnostics\<UUID>.json`
（或明確 runtime override）。私有 sidecar 只有 requestId、componentId、action、reason、observedAt；
不保存 exception、stderr、command、token 或 domain data。只有當次已派送的 active UUID
可寫入一次；不回填歷史 receipt。寫入失敗仍保留 UNKNOWN 與防重播 reservation。
Workspace wire schema 不變：失敗 receipt 仍為 `UNKNOWN`，`completed=null`；
此私有診斷不代表 ChatGPT 可見的 terminal rejection，timeout／不完整結果也不推論拒絕。

定向隔離測試（Windows PowerShell 5.1，無正式 controller／production pipe）：
`powershell -NoProfile -File tests\test-workspace-local.ps1`。
Tray runtime 採用另行驗收；`Restart-Tray.cmd` 含 AutoReconcile，不適合只刷新 CC。
只有確定 exact owner 與 maintenance 閒置才可走 source schema 3 replacement；
schema 4 不接受 `-ReplaceExisting`。無法證明閒置時，使用現有 Tray 的
`Exit control center only` 安全閘門，確認退出後以不帶 AutoReconcile／ReplaceExisting 的入口啟動。

## NORMAL 本機確認候選（2026-10-16）

InstalledRelease v5 候選將唯一 owner state 固定為受保護 manifest 的 `C:\McpControlCenter`，沿用原 Tray mutex、Core、Native Host 與 Bridge lifecycle。Core 預設路徑、PID 投影、Tray／控制入口與 binding v3 一致選用該位置，拒絕 caller 改成其他 runtime root。原 AppData state 先保留私有備份，再準備 active copy，原目錄留作回復；不改 AppData ancestors ACL、不搬 `C:\CodexBridge`、不啟動第二個 owner。

私有 runtime／部署快照與共用 Codex home 分開驗證，要求 `STATE_BOUND` receipt；APPLYING／UNKNOWN 不得啟動 installed binding。Control Center 不讀取或解密 credential bytes，只檢查其 metadata／ACL；ciphertext digest 與原 key-store 呼叫由 Bridge 負責。原 operator 的 state binding 保留來源與目的的平台 Deny，不信任 sandbox group，不修改 workspace／共用 `.codex` ACL。這些變更尚須新 release 部署與正式 Host 驗收。

沿用 InstalledRelease v3 的單一 Tray owner，NORMAL 選單一次啟用一個有期限的 native session；既有 worker 使用 STA 執行 Windows 本機確認。對話框顯示 Canonical ApprovalStore 回傳的完整 Script／Args／CWD／Digest／TTL，使用者勾選同意該指令與有界結果回傳後才可執行一次。預設取消；取消或逾時不執行。MCP JSON、review 意見及選單啟用均不等於 Grant。

只有此私有 Host ceremony 可進入原 NORMAL runner；公開 `Execute` 仍在 launch 前拒絕。UI 不保存 domain payload，Store 與 Receipt 仍由 Bridge 擁有；完成後不自動重綁 session、不自動重跑。ADMIN 保留獨立 UAC。封裝新增 Windows Forms／Drawing 參照，依既有 Prepare → Install → Preflight → Cutover 操作，不能把編譯 PASS 當成已採用，見[本次進度](../codex_bridge/docs/agent-runs/powershell-normal-20261016/Progress.md)。

2026-10-20 閒置 listener 修正：同一個 first-instance pipe 持續等候首筆連線，Control Center 退出時取消等待，不再把啟動後的 120 秒視為首筆請求的期限。連線後仍保留 hello／challenge IO deadline、120 秒 session、exact peer 驗證與逐筆本機確認；完成或失敗後不自動重綁。這是 Source 修正，不能當作現役安裝已採用的證據。針對此缺陷的隔離驗證為 `powershell.exe -NoProfile -File tests\test-normal-host-receiver.ps1 -IdleAdmission`：實際等待 125 秒再送固定 preflight，另查取消等待及已連線未送 hello 的逾時；不建立 Grant 或執行指令。


## NORMAL 持續接收遠端請求（2026-10-22 現行需求）

既有單例 Tray Owner 啟動後持續接收經驗證的 DIRECT MCP 請求，取消逐次 arm 選單與 Windows 本機確認對話框。每筆仍使用獨立 native session、原 Request／Digest 與一次性 durable claim；下一筆請求不依賴前一筆人工重開通道。單筆通道失敗不重播該命令，owner 結束時取消等待並釋放同一接收通道。

授權來源改記 `REMOTE_MCP_REQUEST`，沿用原 Host／Runner／ApprovalStore；component-controller 仍只有既有 lifecycle actions。完整輸出沿用原通道分段傳回 Bridge；大型結果由原 receipt 工具分頁續讀。詳見 [Bridge 現行 DIRECT NORMAL 說明](../codex_bridge/README.md#direct-normal-遠端執行2026-10-22-現行需求)。
