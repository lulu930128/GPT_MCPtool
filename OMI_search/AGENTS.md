# OMI Search MCP Adapter Instructions

本專案是 `C:\GPT_MCPtool\OMI_search` 的 standalone MCP adapter。預設用繁體中文回覆使用者；程式碼、identifier、log 與 protocol 名稱保留原文。

## 邊界

- 只做 MCP request 到 OMI backend 的轉接。
- 不直接讀取 `C:\project\Open Market Intelligence\data\open_market_intelligence.db`。
- 不 import OMI backend Python module。
- 不在本專案複製市場資料、freshness、trading calendar、provider fallback 或 refresh orchestration 邏輯。
- 不修改 OMI 本體，除非使用者明確要求並另外確認範圍。
- 不保存 secrets、API key、trust token 或市場資料快取。
- OMI public ask contract 擴充時，本 adapter 只能同步 schema 與 payload forwarding；不要在 adapter 端重做 target resolution、market data shaping 或 refresh 判斷。

## Backend Contract

v1 的唯一 backend 入口是 OMI 既有：

```text
POST /api/ai/ask
```

adapter 必須固定：

- `contract_version="omi.decision.v4"`
- `caller_profile="omi_search"`
- `allow_llm=false`
- `allow_write=false`

`omi.decision.v4` 必須原樣交付給 MCP consumer。adapter 不得把 `answer`、
`decision`、`evidence`、`limitations`、`status` 重新組成另一套摘要 contract，
也不得接受或產出 v2/v3 public response。

如果需要補資料，只能把 `refresh_if_missing=true` 轉成 bounded `allow_external_fetch=true` 與 `tool_budget`，交給 OMI backend 的 trust policy、freshness guard 與 tool allowlist 決定是否執行。

`target.type`、`mode`、`selection`、`output`、`realtime_policy` 與
`market_data_params` 應和 OMI backend 的 public `/api/ai/ask` schema 保持對齊；
但 `analysis` / `report` 類需要 LLM 或寫入的模式不應在本 adapter 開放。

## Public Tool Surface

`tools/list` 只公開以下精選 read-only tools：

- `omi.ask`
- `omi.read_market_overview`
- `omi.read_stock_context`
- `omi.read_data_freshness`
- `omi.read_source_health`
- `omi.read_capability_status`

所有工具都必須回到 canonical `POST /api/ai/ask`，固定
`allow_llm=false`、`allow_write=false`。read shortcut 固定
`mode=data_only`，不得改打 specialized route 或重組另一套 response contract。

舊 `omi.search` 只保留為不列在 `tools/list` 的 callable alias，供舊
connector/schema cache 遷移；新 schema 使用 `omi.ask` + `question`。

不得在預設外部 surface 公開 LLM report、memory write/update/archive、
persist/save 或其他未具 approval/idempotency/audit 邊界的工具。完整准入條件與
使用說明見 `docs/OMI_search-Public-Tool-Boundary.txt`。

## ChatGPT Web

ChatGPT 網頁不能直接啟動 stdio MCP，也不能直接連 `127.0.0.1`。給 ChatGPT 使用時必須走：

```text
http_server.py -> http://127.0.0.1:8797/mcp -> Secure MCP Tunnel -> ChatGPT
```

預設只 listen `127.0.0.1`。不要把 `/mcp` endpoint 無驗證公開到 internet。

## 驗證

修改後至少執行：

```powershell
cd C:\GPT_MCPtool\OMI_search
python -B -m unittest discover -s tests
```

若只改 README 或 AGENTS，讀回檔案即可。live OMI backend smoke 不是預設驗證；只有在使用者要求或改到 HTTP request behavior 時才執行，且必須確認 OMI backend 正在正確 port 上。
