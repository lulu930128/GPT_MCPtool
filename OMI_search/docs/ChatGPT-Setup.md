# ChatGPT 網頁掛載 OMI Search

`OMI_search` 給 ChatGPT 網頁使用時，必須走 HTTP MCP endpoint 加受控 tunnel。ChatGPT 網頁不能直接啟動 stdio MCP，也不能直接連你的 `127.0.0.1`。

## 1. 啟動 OMI backend

OMI Search 只是轉接口，實際資料仍由 OMI backend 提供。先確認：

```powershell
Invoke-RestMethod http://127.0.0.1:8400/api/system/health
```

應看到 `status: ok`。

## 2. 啟動本機 HTTP MCP endpoint

```powershell
cd C:\GPT_MCPtool\OMI_search
$env:OMI_SEARCH_API_BASE_URL = "http://127.0.0.1:8400"
$env:OMI_SEARCH_MCP_HTTP_HOST = "127.0.0.1"
$env:OMI_SEARCH_MCP_HTTP_PORT = "8797"
python .\http_server.py
```

本機 MCP endpoint：

```text
http://127.0.0.1:8797/mcp
```

健康檢查：

```text
http://127.0.0.1:8797/health
```

## 3. 初始化 Secure MCP Tunnel profile

本機已可重用 `project_reading` 下載好的 tunnel client：

```text
C:\GPT_MCPtool\project_reading\vendor\tunnel-client\tunnel-client.exe
```

先從 ChatGPT/OpenAI 的 tunnel 設定取得自己的 tunnel ID：

```text
tunnel_<your-id>
```

初始化 profile：

```powershell
cd C:\GPT_MCPtool\OMI_search
$env:OMI_SEARCH_TUNNEL_ID = "tunnel_<your-id>"
.\scripts\tunnel.ps1 -Action Init
```

這會建立：

```text
C:\GPT_MCPtool\OMI_search\.tunnel-client\omi-search.yaml
```

內容會指向：

```text
http://127.0.0.1:8797/mcp
```

## 4. 保存 OpenAI control-plane API key

不要把 plaintext key 寫進 YAML 或 README。建議用 Windows DPAPI：

```powershell
cd C:\GPT_MCPtool\OMI_search
.\scripts\tunnel.ps1 -Action SaveKey
```

如果目前 shell 已經有 `CONTROL_PLANE_API_KEY`：

```powershell
.\scripts\tunnel.ps1 -Action SaveKeyFromEnv
```

檢查：

```powershell
.\scripts\tunnel.ps1 -Action KeyStatus
.\scripts\tunnel.ps1 -Action Doctor -Explain
```

## 5. 啟動 tunnel

可以直接雙擊隱藏啟動托盤常駐：

```text
C:\GPT_MCPtool\OMI_search\scripts\start-tray.vbs
```

托盤會自動啟動本機 MCP server，並嘗試啟動 tunnel。若還沒保存 `CONTROL_PLANE_API_KEY`，托盤會開啟密碼輸入框讓你貼上 key；也可以右鍵托盤圖示選 `Save CONTROL_PLANE_API_KEY...` 手動保存，或選 `Show key status` 查看目前是否已保存且可解密。

也可以手動保持 `python .\http_server.py` 正在跑，另開一個 PowerShell：

```powershell
cd C:\GPT_MCPtool\OMI_search
.\scripts\tunnel.ps1 -Action Run
```

## 6. ChatGPT 網頁設定

在 ChatGPT 的 connector / MCP connector 設定中：

1. 選 tunnel / 通道連線方式。
2. 選剛建立的 OMI Search tunnel，或貼自己的 tunnel ID。
3. 本機 target 是 `http://127.0.0.1:8797/mcp`。
4. 連上後請 ChatGPT 列出 tools，應看到：
   - `omi.ask`
   - `omi.read_market_overview`
   - `omi.read_stock_context`
   - `omi.read_data_freshness`
   - `omi.read_source_health`
   - `omi.read_capability_status`

若仍只看到舊 `omi.search`，在 connector/plugin 管理介面 Refresh Actions、
重新連線或重新載入 schema。`omi.search` 仍保留為隱藏 callable alias，因此
舊 schema 在遷移期間不會立刻失效。完整界線見
[OMI_search-Public-Tool-Boundary.txt](OMI_search-Public-Tool-Boundary.txt)。

不要把 `http://127.0.0.1:8797/mcp` 填成公開 server URL；ChatGPT 遠端看不到你的 localhost。

## 7. 測試提示

連上後可以先問：

```text
Use the OMI Search MCP connector. List available tools, then call omi.ask for stock_id 2330 with question "2330 最近資料" and mode data_only. Do not refresh data.
```

若要允許 OMI backend 在資料缺漏時補資料：

```text
Call omi.ask for stock_id 2330 with question "2330 最近量價與籌碼資料", mode data_only, refresh_if_missing true, and tool_budget max_calls 3 max_external_fetches 2 max_total_seconds 20.
```
