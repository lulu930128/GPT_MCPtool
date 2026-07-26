# OMI Search MCP Adapter

`OMI_search` 是一個獨立的 stdio MCP adapter。它不讀 OMI SQLite、不 import OMI backend code，也不自己打市場資料來源；它只把 MCP tool request 轉成 OMI 既有 `POST /api/ai/ask` payload，並原樣交付 `omi.decision.v4`，讓 OMI backend 繼續負責 target resolution、freshness、bounded refresh、evidence、decision 與 warnings。

## 架構

```text
MCP client
  -> C:\GPT_MCPtool\OMI_search\server.py
  -> POST http://127.0.0.1:8400/api/ai/ask
  -> OMI backend
  -> unchanged omi.decision.v4 envelope
```

## 公開 tools

- `omi.ask`：canonical `omi.decision.v4` read-only 入口。
- `omi.read_market_overview`：bounded 市場概況。
- `omi.read_stock_context`：台股、美股、日股、韓股個股 evidence。
- `omi.read_data_freshness`：freshness 與資料缺口。
- `omi.read_source_health`：provider/source health。
- `omi.read_capability_status`：capability availability/status。

舊 `omi.search` 不再列在 `tools/list`，但仍保留 callable alias，讓尚未刷新
schema 的既有 connector 繼續工作。新 caller 應使用 `omi.ask` 與
`question`。完整公開/隱藏界線見
[docs/OMI_search-Public-Tool-Boundary.txt](docs/OMI_search-Public-Tool-Boundary.txt)。

安全預設：

- `allow_llm=false`
- `allow_write=false`
- `mode=data_only`
- `refresh_if_missing=false`

如果呼叫時設定 `refresh_if_missing=true`，adapter 只會把
`allow_external_fetch=true` 與 bounded `tool_budget` 傳給 OMI backend。
這表示允許主規劃器在同一請求內嘗試 refresh，不保證所有後續 fill action 都會
自動執行。Consumer 應讀 `execution.refresh_reconciliation` 判斷實際 attempt、
tool outcome、payload 是否進入 evidence，以及仍保留哪些 fill action。

目前 `target.type` 對齊 OMI public ask contract，支援台股 market、freshness、stock、watchlist、index、futures；美股、日股與韓股 stock/index/watchlist；crypto market/asset；resource asset、portfolio、US macro、source health 與 capability status 等 read-only evidence target。`mode` 支援 `data_only`、`brief` 與 `full`；`analysis` / `report` 仍不開放，因為這個 adapter 固定不呼叫 LLM、不寫入 report。

目前 request 固定使用 `contract_version=omi.decision.v4`。不論
`include_raw` 為何，adapter 都原樣交付 backend canonical envelope，避免產生第二套
answer/readiness 語意；資料量應以 `selection.fields`、`selection.limits` 與
`selection.max_response_bytes` 控制。
MCP tool call 會同時輸出文字 `content` 與同內容的 `structuredContent`。
Backend 回傳的 structured business rejection（例如 `TARGET_NOT_FOUND`）仍是
成功的 MCP transport，因此 `isError=false`；只有 protocol、HTTP transport、
serialization 或 adapter internal failure 才使用 `isError=true`。

## 常用輸入

```json
{
  "question": "2330 最近量價、法人、券商分點資料",
  "target": { "type": "tw_stock", "id": "2330" },
  "mode": "data_only",
  "refresh_if_missing": true,
  "tool_budget": {
    "max_calls": 3,
    "max_external_fetches": 2,
    "max_total_seconds": 20
  }
}
```

舊 `omi.search` 可繼續使用 `query`；新 `omi.ask` 使用 `question`。也可以使用
`omi.ask` 的便利欄位：

```json
{ "question": "台積電最近資料", "stock_id": "2330" }
```

```json
{ "question": "MU 最新資料", "symbol": "MU", "refresh_if_missing": true }
```

需要指定 OMI 市場資料形狀時，可傳 `market_data_params`，或用 top-level `include_intraday`、`payload_level`、`intraday_limit` 讓 adapter 合併進 `market_data_params`：

```json
{
  "question": "BTC 最近 1m compact context",
  "target": { "type": "crypto_asset", "id": "BTC" },
  "mode": "data_only",
  "refresh_if_missing": true,
  "market_data_params": {
    "provider": "binance",
    "symbol": "BTCUSDT",
    "interval": "1m"
  },
  "include_intraday": true,
  "payload_level": "summary",
  "intraday_limit": 80
}
```

模型可直接選 capability、欄位、筆數與 response byte budget：

```json
{
  "question": "只要 2330 即時價與資料時間",
  "target": { "type": "tw_stock", "id": "2330" },
  "output": "evidence_only",
  "realtime_policy": "require_live",
  "selection": {
    "include": ["quote.snapshot"],
    "fields": {
      "quote.snapshot": ["price", "quote_time", "provider", "freshness"]
    },
    "max_response_bytes": 12000
  }
}
```

```json
{
  "question": "KOSPI weekly evidence",
  "target": { "type": "kr_index", "id": "KOSPI" },
  "mode": "full",
  "market_data_params": {
    "timeframe": "weekly",
    "bars": 26,
    "payload_level": "standard"
  }
}
```

## 環境變數

```powershell
$env:OMI_SEARCH_API_BASE_URL = "http://127.0.0.1:8400"
$env:OMI_SEARCH_API_TIMEOUT_SECONDS = "90"
$env:OMI_SEARCH_AI_TRUST_TOKEN = ""
$env:OMI_SEARCH_DEFAULT_REFRESH_IF_MISSING = "false"
$env:OMI_SEARCH_TUNNEL_ID = ""
```

`OMI_SEARCH_AI_TRUST_TOKEN` 只用來設定 `X-OMI-AI-Trust-Token` header。adapter 不讀、不保存、不轉送 OpenAI API key。

## 本機測試

```powershell
cd C:\GPT_MCPtool\OMI_search
python -B -m unittest discover -s tests
python -B -c "import ast, pathlib; [ast.parse(p.read_text(encoding='utf-8'), filename=str(p)) for p in pathlib.Path('.').rglob('*.py')]; print('syntax ok')"
```

## Codex MCP 設定範例

參考 [examples/codex-config.toml](examples/codex-config.toml)：

```toml
[mcp_servers.omi_search]
command = "python"
args = ["C:/GPT_MCPtool/OMI_search/server.py"]
env = { OMI_SEARCH_API_BASE_URL = "http://127.0.0.1:8400" }
default_tools_approval_mode = "prompt"
tool_timeout_sec = 90
startup_timeout_sec = 10
```

## ChatGPT 網頁用法

ChatGPT 網頁不能直接啟動上面的 stdio MCP，也不能直接連你的 `127.0.0.1`。給 ChatGPT 使用時，啟動 HTTP MCP endpoint：

```powershell
cd C:\GPT_MCPtool\OMI_search
$env:OMI_SEARCH_API_BASE_URL = "http://127.0.0.1:8400"
python .\http_server.py
```

本機 endpoint：

```text
http://127.0.0.1:8797/mcp
```

再用 OpenAI Secure MCP Tunnel 把 ChatGPT 連回這個本機 endpoint。完整步驟見 [docs/ChatGPT-Setup.md](docs/ChatGPT-Setup.md)。

也可以直接雙擊隱藏啟動托盤常駐：

```text
C:\GPT_MCPtool\OMI_search\scripts\start-tray.vbs
```

若托盤提示缺少 `CONTROL_PLANE_API_KEY`，右鍵托盤圖示選 `Save CONTROL_PLANE_API_KEY...`，貼上 key 後會以 Windows DPAPI 保存到目前 Windows 使用者。

建立新 tunnel profile 時，請使用自己的 tunnel ID：

```text
tunnel_<your-id>
```

ID 可透過 `OMI_SEARCH_TUNNEL_ID` 或 `scripts\tunnel.ps1 -TunnelId` 傳入。
已建立的 profile 會保存在 ignored 的 `.tunnel-client` 目錄。

## 邊界

這個 adapter 的目的只是隔離外部 MCP tool surface，不污染 OMI 本體。v1 只能使用 OMI 既有 `/api/ai/ask` 支援的查詢能力。若未來需要 dataset-level query DSL、日期區間、欄位選擇、排序或分頁，應在 OMI backend 正式新增 `/api/ai/search`，再讓這個 adapter 改打新 endpoint。
