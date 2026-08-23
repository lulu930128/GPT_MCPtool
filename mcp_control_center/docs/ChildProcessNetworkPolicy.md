# Child Process Network Policy

`MCP Control Center` 不修改 Windows 全域 proxy，也不把目前 PowerShell session 的 ambient
proxy 當成各元件的正式 runtime 設定。七個 production component 的 controller 在建立
server、Hub、backend 或 `tunnel-client` child process 時遵循同一個邊界：

- 只在 child spawn 的短暫環境覆寫 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 與其小寫版本。
- 將 `NO_PROXY`／`no_proxy` 明確設為 `127.0.0.1,localhost`，避免 loopback health、MCP 與
  upstream dependency 被誤送到 proxy。
- spawn 完成後在 `finally` 還原 parent process 原值；不污染 Control Center、tray 或使用者
  shell 的後續命令。
- tunnel credential 只透過 component-owned DPAPI／環境注入進入 child，不由中樞讀取或投影。

若企業網路要求 outbound HTTPS proxy，必須由各元件以明確、可稽核的 profile／CLI 設定，
不能依賴啟動 Control Center 當下碰巧存在的 session environment。導入此例外前應先用單一
元件驗證 control-plane、data-plane、loopback bypass 與 credential 不落盤，再逐元件採用。

## Tunnel binary inventory

[`tunnel-runtime-inventory-v1`](../config/tunnel-runtime-inventory.json) 記錄七個元件目前採用的
binary path、來源類型及唯一允許的 explicit `TunnelClientPath` override。下列命令只執行
bounded `--version` 並計算檔案 metadata／SHA-256；不下載、複製、更新或切換 executable：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts\tunnel-runtime-inventory.ps1 -Action Inventory
```

未來共用 runtime 的候選位置是 `runtime\tunnel-client\tunnel-client.exe`，但只有在
`version.json`、相容性 regression、component-specific override 與 rollback 都驗證完成後才可
逐元件切換。Control Center 不提供 automatic upgrade，也不因發現不同 binary cohort 自動修復。

## 驗證邊界

- `SelfTest` 驗證 inventory schema、component count、timeout／output 上限與 zero-mutation 宣告。
- component lifecycle tests 使用 fake／temporary runtimes，確認 process ownership 與啟停行為。
- production adoption 必須另外驗證 local health、tunnel readiness、MCP protocol 與明確的遠端／
  ChatGPT connector evidence；單一 `--version`、hash 或 HTTP 200 都不足以證明可採用。
