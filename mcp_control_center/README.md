# MCP Control Center

`MCP Control Center` 是可擴充的本機 MCP runtime Windows 中樞。它不是第八個 MCP，
不持有任何市場、記憶、學習、workspace、Codex job 或財務資料；即使 MCP server 或
Secure MCP Tunnel 故障，中樞仍可獨立檢查、記錄與協調啟動。

目前 application release 為 `1.1.0`。registry schema v3、component descriptor schema v1
與 `unified-lifecycle-v3` 是獨立契約版本，不因 application release 而重新編號。

目前預設的 registry v3 已登錄七個元件，全部使用 `unified-lifecycle-v3`
component controller，並由各元件自己持有 runtime ownership。七個正式元件都維持 enabled、
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
component-specific action，也不提供危險的 Stop All／kill-by-name。七個元件皆已完成
controller 遷移與 live adoption；既有六個元件另保留 legacy tray closure artifact，舊 artifact
尚未刪除。

中樞 source 同時支援 registry schema v3、舊 manifest schema v1／v2 與
`unified-lifecycle-v3`。v3 採用
component-owned stateless lifecycle controller：controller 以 mutex、PID file、exact
executable／command、listener ownership 與必要的 process lineage 管理 detached child
runtime，完成 action 後退出。中樞不持有 child process handle，也不新增 IPC。Loader 仍保留
`legacy-tray` 相容能力，供 rollback 或尚未升級的新註冊元件使用；目前七個 descriptor 皆為 v3。

## 能力

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

[`Child Process Network Policy`](docs/ChildProcessNetworkPolicy.md) 定義七個 production component
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

可用 `MCP_CONTROL_CENTER_DATA_DIR` 指定另一個 private、repo-external 目錄。事件不保存
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

七個元件都使用 `component-menu-v1`；既有元件把舊托盤的 Copy／Open／金鑰狀態／備份等功能直接列在
Control Center 的元件子選單。中樞只渲染 descriptor 內固定的 action ID，再委派給元件自己的
`scripts/control-center-ui.ps1`；它不接收任意 arguments，也不讀 tunnel ID、credential、備份結果
或 domain payload。`Open troubleshooting tools` 仍可按需開啟 component-owned diagnostic UI，
作為 action adapter 無法使用時的完整故障處理 fallback。兩種啟動路徑都與背景
`Status`／`Doctor` 程序彼此獨立；關閉 diagnostic UI 只關閉臨時圖示，不停止或接管 runtime。

## 採用單一 Startup 入口

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
再按 `startupOrder` 逐一檢查；已 Ready 的元件不會重複啟動。

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
