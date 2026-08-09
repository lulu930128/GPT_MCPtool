# OMI Search MCP Adapter

`OMI_search` 是 OMI 的 standalone MCP 映射層。它只處理 MCP protocol、公開 tool surface、相容欄位映射與 HTTP transport；所有市場資料與回答判斷都由 OMI backend 擁有。

```text
MCP client
  -> C:\GPT_MCPtool\OMI_search\server.py
  -> OMI launcher-selected loopback backend
  -> GET  /api/ai/tools
  -> POST /api/ai/ask
  -> GET  /api/ai/refresh-status/{job_id}
  -> unchanged omi.decision.v4 envelope
```

## 文件導覽

- [公開 MCP 契約](docs/PublicContract.md)：責任邊界、七個公開 tools、schema owner、
  refresh 與錯誤語意。
- [故障排除](docs/Troubleshooting.md)：adapter／backend／tunnel／ChatGPT action cache 的
  分層診斷。
- [ChatGPT 掛載](docs/ChatGPT-Setup.md)：本機 HTTP MCP 與 Secure MCP Tunnel 設定。

## 嚴格責任邊界

Adapter 只負責：

- MCP `initialize`、`tools/list`、`tools/call` 與 JSON serialization。
- 將 canonical tool arguments 映射到 `POST /api/ai/ask`。
- 固定 `contract_version=omi.decision.v4`、`caller_profile=omi_search`、`allow_llm=false`、`allow_write=false`。
- 將 caller 明確指定的 `refresh_if_missing` 映射成 `allow_external_fetch`。
- 將 compatibility alias `include_intraday` / `intraday_limit` 合併到 `market_data_params`。
- 將 backend `omi.decision.v4` envelope 原樣放入 MCP `content` 與 `structuredContent`。

Adapter 不負責：

- 解析 question 關鍵字、判斷 query intent 或改寫 question。
- 推斷 target、market、analysis horizon、freshness 或 refresh 時機。
- 自行補 strategy、ranking、limit、refresh policy 或 tool budget 預設值。
- clamp 或重解釋 backend contract 欄位。
- 裁切、摘要、重組或重新判定 backend response。
- 讀寫 OMI SQLite、import OMI backend code、呼叫市場 provider、執行 LLM 或寫入 report。

因此，像 `TSM intraday live quote` 這類問題會完整不變地送到 backend。是否屬於 intraday、資料是否 stale、是否需要 refresh、能否執行 external fetch，以及如何產出 evidence/answer，都由 OMI backend 決定。

## 公開 tools

- `omi.ask`：canonical `omi.decision.v4` read-only 入口。
- `omi.read_refresh_status`：依正整數 `job_id` 讀取 redacted refresh operation/evidence 狀態與 cache-only resume template。
- `omi.read_market_overview`：將明確 market 映射成 market target。
- `omi.read_stock_context`：將明確 market + symbol 映射成 stock target。
- `omi.read_data_freshness`：映射成 data-freshness target。
- `omi.read_source_health`：映射成 source-health target 與 filters。
- `omi.read_capability_status`：映射成 capability-status target 與 filters。

`omi.search` 不出現在 `tools/list`，但仍保留為 legacy callable alias。只有這個 legacy alias 會把 `query` 映射成 `question`，並支援舊的 `stock_id` / `symbol` target alias。新 caller 必須使用 `omi.ask`、`question` 與明確 `target`。

Shortcuts 只依 tool 名稱與明確 arguments 做機械映射，固定使用 `mode=data_only`；不從自然語言推斷 target。

## Schema owner 與離線 fallback

正常執行時，`tools/list` 會從 OMI backend `GET /api/ai/tools` 取得 `omi.ask` 與 `omi.read_refresh_status` input schema。Target registry、capability registry、typed parameters、selection version 與 public contract digest 都由 backend 擁有。

Adapter 只投影自己的安全 surface：

- 隱藏 caller 不可控制的 `allow_llm`、`allow_write`、`allow_external_fetch`、`caller_profile`。
- `mode` 只開放 `data_only`、`brief`、`full`。
- 新增 adapter alias `refresh_if_missing`、`include_intraday`、`intraday_limit`、`include_raw`。

Backend 暫時無法連線時，`tools/list` 使用 `public_contract_snapshot.json`。Snapshot 必須由 OMI repo 的 generator 產生，不可在 adapter 手工維護市場契約：

```powershell
cd "C:\project\Open Market Intelligence"
.\.venv\Scripts\python.exe .\scripts\generate-ai-public-contract-snapshot.py `
  --output .\agents\omi_mcp_server\public_contract_snapshot.json `
  --output C:\GPT_MCPtool\OMI_search\public_contract_snapshot.json
```

Live schema 與 snapshot 的 `x-omi-public-contract-digest` 必須一致。

## Canonical request

```json
{
  "question": "2330 最新量價與籌碼 evidence",
  "target": {"type": "tw_stock", "id": "2330"},
  "mode": "data_only",
  "output": "evidence_only",
  "selection": {
    "include": ["quote.snapshot", "chips.institutional"]
  }
}
```

沒有明確要求 refresh 時，adapter 固定傳送 `allow_external_fetch=false`。只有 caller 明確設定下列欄位時才會開啟：

```json
{
  "question": "MU 最新資料",
  "target": {"type": "us_stock", "id": "MU"},
  "refresh_if_missing": true,
  "tool_budget": {
    "max_calls": 3,
    "max_external_fetches": 2,
    "max_total_seconds": 20
  }
}
```

Adapter 不替 `tool_budget` 補值或 clamp；backend schema、trust policy 與 runtime policy 負責驗證及執行。

Compatibility aliases 只做欄位搬移，nested canonical value 優先：

```json
{
  "question": "BTC compact context",
  "target": {"type": "crypto_asset", "id": "BTC"},
  "market_data_params": {
    "provider": "binance",
    "include_intraday": false
  },
  "include_intraday": true,
  "intraday_limit": 80
}
```

上例送到 backend 後，`market_data_params.include_intraday` 仍是 `false`，`intraday_limit` 被加入 nested object。數值範圍由 backend 驗證。

Legacy caller 可暫時使用：

```json
{"query": "讀取 2330", "stock_id": "2330"}
```

## Response 與錯誤語意

- Backend `omi.decision.v4` 一律原樣回傳，不由 adapter 產生第二份摘要或 compact contract。
- `TARGET_NOT_FOUND`、missing evidence 等 structured business result 仍是成功的 MCP transport，`isError=false`。
- Protocol、HTTP、serialization、non-v4 backend contract 或 adapter internal failure 才是 `isError=true`。
- `include_raw` 只為舊 caller 保留；無論其值為何，response 都不會被投影或裁切。
- Refresh job 的 operation 完成只表示刷新工作結束；consumer 必須依 `evidence.status` 與 cache-only `resume` 重建 evidence，不能直接宣稱資料已 fresh。

## 環境變數

```powershell
$env:OMI_SEARCH_API_BASE_URL = "http://127.0.0.1:8400"
$env:OMI_SEARCH_API_TIMEOUT_SECONDS = "90"
$env:OMI_SEARCH_SCHEMA_TIMEOUT_SECONDS = "2"
$env:OMI_SEARCH_AI_TRUST_TOKEN = ""
$env:OMI_SEARCH_TUNNEL_ID = ""
```

`OMI_SEARCH_AI_TRUST_TOKEN` 只設定 `X-OMI-AI-Trust-Token` header。Adapter 不讀、不保存、不轉送 OpenAI API key。

## 驗證

```powershell
cd C:\GPT_MCPtool\OMI_search
python -B -m unittest discover -s tests
python -B -c "import ast, pathlib; [ast.parse(p.read_text(encoding='utf-8'), filename=str(p)) for p in pathlib.Path('.').rglob('*.py')]; print('syntax ok')"
```

## Codex MCP 設定

```toml
[mcp_servers.omi_search]
command = "python"
args = ["C:/GPT_MCPtool/OMI_search/server.py"]
env = { OMI_SEARCH_API_BASE_URL = "http://127.0.0.1:8400" }
default_tools_approval_mode = "prompt"
tool_timeout_sec = 90
startup_timeout_sec = 10
```

## ChatGPT Web

ChatGPT Web 無法直接存取本機 stdio 或 `127.0.0.1`。本專案提供 HTTP MCP transport：

```powershell
cd C:\GPT_MCPtool\OMI_search
python .\http_server.py
```

本機 endpoint 為 `http://127.0.0.1:8797/mcp`，公開連線與 Secure MCP Tunnel 設定見 [docs/ChatGPT-Setup.md](docs/ChatGPT-Setup.md)。

`GET http://127.0.0.1:8797/health` 只表示 adapter core 正常；
`GET http://127.0.0.1:8797/upstream-health` 由 adapter 以啟動時已解析的 OMI backend URL
執行 bounded probe，只回傳 `ready`／`unavailable` 與安全 error code。它不公開實際 backend
URL、原始 response、exception、credential 或市場資料，供 Control Center 區分 owned runtime
故障與 OMI upstream 暫時不可用。

## Windows 托盤

一般啟動使用 `scripts\Start-Tray.cmd`；它不會破壞性取代已存在的 tray。修改 adapter
source 或 public contract snapshot 後，使用 `scripts\Restart-Tray.cmd`。Restart 會先
確認舊的 8797 listener 已釋放，再要求 `/health` 的 `buildId` 與目前
`http_server.py`、`server.py`、`public_contract_snapshot.json` 完全一致。

托盤使用 `unified-always-on-v2` 契約。正式啟動會一起準備 MCP server 與 Secure MCP
Tunnel；選單不提供 Start／Stop 或 tunnel restart。OMI backend 仍由正式 OMI launcher
管理，adapter 的 `Restart MCP server` 不會越界重啟 backend。外部市場 refresh 仍只在
caller 明確傳入 `refresh_if_missing=true` 時啟用，不因 tray 啟動而自動抓取資料。
Tray 會從正式 OMI launcher 的 bounded runtime evidence 解析實際 backend loopback URL，
因此 Control Center 不硬編碼或猜測 launcher 動態選用的 port。

### Control Center v3

`control-center/component.json` 是 OMI Search 的正式 runtime descriptor。
`scripts/runtime-control.ps1` 只管理 adapter HTTP server 與 Secure MCP Tunnel；
OMI backend 仍是 `external-dependency`，不會被 Control Center 啟動、停止或讀取 domain payload。

`scripts/show-diagnostic-tray.vbs` 是 optional diagnostic UI。關閉它只會關閉 UI，
不會停止 adapter、tunnel 或 OMI backend。完整 ownership、能力矩陣與隔離驗證方式見
[`docs/ControlCenterIntegration.md`](docs/ControlCenterIntegration.md)。

原托盤的 Copy／Open 操作與 `CONTROL_PLANE_API_KEY` prompt／status 已透過
`component-menu-v1` 直接接回中樞子選單。中樞只委派固定 action ID；DPAPI、tunnel ID、
resolved backend URL 與市場資料都不會離開 OMI Search 的 `control-center-ui.ps1`。

本機 build 驗證成功不會自動刷新 ChatGPT 已快取的 action/schema。若 ChatGPT 仍顯示
舊欄位，請另外執行 Refresh Actions／重新連線或開新對話。

## 未來擴充規則

若需要新的 query DSL、日期範圍、欄位選擇、排序、分頁、refresh policy 或 answer contract，先在 OMI backend 建立正式公開契約，再由 adapter 同步 schema 與做機械映射。不要把功能先偷寫在 `OMI_search`。
