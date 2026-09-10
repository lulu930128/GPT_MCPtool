# Listening Audio 的 Control Center 整合

元件 ID `listening_audio`，採用 `unified-lifecycle-v3`，固定 UI action 使用 `component-menu-v1`。
Controller 依序啟動 Trainer、MCP、tunnel；關閉時依反向順序，只處理經 executable path、start time、owner metadata、listener lineage 驗證的程序。
生命週期 mutex 防止同元件並行操作；PID 僅為定位資訊。未知身分或外來 listener 必須停止操作，不接管。

## 設定與邊界

複製 `config/runtime.example.psd1` 至忽略的 `.local/runtime.psd1` 後填寫本機路徑。
Trainer 使用其原有 `.venv`、`src`、資料目錄與 GPT-SoVITS；MCP 不讀取 domain 資料。
此主機沿用 `project_reading` 的 tunnel client 與 DPAPI current-user 金鑰位置，沒有複製金鑰；更新共享 binary 需另外協調。
元件自有 `.tunnel-client/` profile、`.tmp/` PID/owner/log，不與其他元件共享。
Control Center 只能讀取安全 health/probe 與 lifecycle metadata，不讀 secret 或 domain payload。

固定埠：Trainer `18811`、MCP `18810`、tunnel admin `18812`。Trainer 的 male TTS 在子程序環境使用 `9984`，避開主機 VPN 使用的 `9983`；不修改 Trainer 原設定檔。TTS 按需求啟動。
MCP 僅監聽 `127.0.0.1`，拒絕 browser Origin。受控 tunnel 是遠端認證邊界，local upstream 使用 `sample_mcp_remote_no_auth`。
Controller 明確清除子程序的 `LISTENING_MCP_HTTP_TOKEN`，避免未同步的 bearer 設定造成 tunnel/health 不一致；手動 HTTP 啟動仍支援 bearer。

## 驗證與操作

在元件目錄執行 `npm test`、`npm run smoke:http`、`powershell -NoProfile -File tests/test-runtime-control.ps1`。
再執行中樞的 `Test-McpComponent.ps1 -ComponentRoot <component-root>`、`Register-McpComponent.ps1 -Plan`，使用計畫 hash 套用。
通過 isolated ownership/lifecycle 後才啟用 registry。日常操作使用 Control Center 的 Start、RestartCore、RepairConnectivity、ShutdownRuntime。
本機 Ready 表示三個 owned runtime 與 tunnel readyz 成功；ChatGPT connector 與聽感必須另外驗證。

`tunnel Doctor` 是啟動前設定檢查，不適合當成運行中 readiness：服務運行時它會嘗試重綁 admin port 而失敗；本元件的 no-auth upstream 也沒有 OAuth metadata endpoint，該檢查會回報 404。運行中使用 `tunnel.ps1 -Action Health`、Control Center 與 `node scripts/smoke-managed.mjs`；不要為了讓 Doctor 全綠而偽造 OAuth metadata。
