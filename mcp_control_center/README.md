# MCP Control Center

`MCP Control Center` 是六個本機 MCP runtime 的 Windows 中樞。它不是第七個 MCP，
不持有任何市場、記憶、學習、workspace、Codex job 或財務資料；即使 MCP server 或
Secure MCP Tunnel 故障，中樞仍可獨立檢查、記錄與協調啟動。

目前 live manifest 的六個 component tray 皆通過共同的 `unified-always-on-v2` contract：

- `autoStartServer=true`
- `autoStartTunnel=true`
- production Start 不取代既有 instance
- replacement／restart 使用 component 自己的 exact-path lifecycle
- `Exit` 仍由 component tray 負責完整停止該 component

第一版保留六個 component tray 作為各自的 lifecycle owner。中樞提供單一狀態與操作入口，
但不隱藏或取代 component-specific action，也不提供危險的 Stop All／kill-by-name。

中樞 source 同時支援下一階段的 manifest schema v2 與 `unified-lifecycle-v3`。v3 採用
component-owned stateless lifecycle controller：controller 以 mutex、PID file、exact
executable／command、listener ownership 與必要的 process lineage 管理 detached child
runtime，完成 action 後退出。中樞不持有 child process handle，也不新增 IPC。尚未遷移的
元件繼續以 schema v1／`legacy-tray` 運作，因此加入相容層本身不會改變目前 runtime。

## 能力

- 依序檢查六個元件的 core、dependency 與 tunnel readiness。
- 在可取得 Windows listener 資訊時，比對 PID、process name 與 expected command fragments；
  對 Windows venv shim 產生的 listener，可再驗證 component 內 managed PID 檔、managed
  process command line，以及 listener 到 managed PID 的父子程序鏈。
- 區分 `Ready`、`Degraded`、`BlockedUpstream`、`Stopped`、`Unhealthy`、
  `OwnershipMismatch`、`Misconfigured`、`NotInstalled`。
- 將目前狀態寫入 atomic `state.json`，只在狀態變化或 action 發生時追加每日 JSONL event。
- 開機 reconciliation 只對真正 `Stopped` 的元件呼叫既有非破壞性 Start；不自動 Restart
  `Unhealthy`、上游阻塞或 ownership 不明的程序。
- 人工 Start／Reload 會委派給 manifest 中已驗證、位於 component root 內的 entrypoint。
- Startup adoption 會先驗證六個 shortcut target，再移到 private backup；不直接刪除，並可依 receipt 回復。

## Runtime 資料

預設位置：

```text
%LOCALAPPDATA%\McpControlCenter\
├── state.json
├── tray.pid
├── events\YYYY-MM-DD.jsonl
├── diagnostics\latest.json
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

中樞 tray 的 `Exit control center only` 只關閉中樞，不停止六個 component。

## 採用單一 Startup 入口

先預覽目前六個 shortcut；任何 target conflict 都會阻止 adoption：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\startup.ps1 -Action Plan
```

確認 plan 後才明確套用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\startup.ps1 -Action Adopt -Apply
```

Adopt 只移動 manifest 中六個已識別的 component shortcut，其他 Startup 項目與
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

## Manifest

[`config/components.json`](config/components.json) 只保存公開的 source-relative path、loopback
endpoint、port、expected health fields 與 ownership fragment。它不保存 tunnel ID、token、
資料目錄內容或 credential。Loader 接受 schema v1 與 v2；schema v1 會正規化成
`runtimeMode=legacy-tray`，schema v2 則要求每個元件明確宣告 `legacy-tray` 或
`component-controller`。Loader 會拒絕：

- 非 loopback 或非 HTTP probe。
- 逃出 component root 的 action path。
- 不是 workspace 直接子目錄的 component root。
- 不符合 `unified-always-on-v2` 的 tray `SelfTest`。
- 不符合 `unified-lifecycle-v3` 的 stateless controller `SelfTest`。
- controller 缺少 `ensure_running`、`restart_core`、`reload_runtime`、
  `show_diagnostic_tray` 任一固定 capability。
- controller action 使用錯誤 launcher kind，或由 manifest 自訂 PowerShell arguments。
- 重複 component／probe id 或無效 port。

v3 lifecycle action 的 `-Action EnsureRunning|RestartCore|ReloadRuntime` 參數由 manager
依 semantic action 固定產生；manifest 只能選擇 component root 內的相對 entrypoint，不能
注入 command string 或 arguments。`show_diagnostic_tray` 只能使用 component 內的 VBS launcher。
PowerShell controller 執行會以 component-specific manager mutex 防止重疊，沿用
`postStartTimeoutSeconds` 作 action timeout，stdout + stderr 合計上限 64 KiB；capture file
在解析後立即刪除。v3 成功結果必須是完整 bounded JSON contract，非 JSON、缺欄、timeout
或超量輸出都會安全失敗，且不會把 stderr 寫入 manager event。

`ownerManagedPidFile` 是可選的 component-relative runtime PID 檔。設定後，中樞不會只靠
listener module 名稱判定 ownership，而會要求 listener 等於該 managed PID，或位於其
子程序鏈；`ownerManagedCommandContains` 則用來確認 managed process 仍來自預期的
exact-path lifecycle。PID 檔不存在、內容無效、程序無關或 command 不符都會得到
`OwnershipMismatch`，CIM 權限不足則維持 ownership unknown，不冒充已驗證。

## 驗證界線

`Status` 與 `Doctor` 是 read-only runtime probe；`Start` 只委派非破壞性 launcher；
`Restart`／`Reload component` 是人工 side effect。完整 MCP protocol smoke、ChatGPT action cache
刷新與 component-specific domain 驗證仍由各元件自己的 README／測試負責，中樞不把 HTTP 200
冒充成完整 protocol 或目前 source 已採用的證明。
