# OMI Search MCP Adapter Instructions

本專案是 `C:\GPT_MCPtool\OMI_search` 的 standalone MCP adapter。預設用繁體中文回覆使用者；程式碼、identifier、log 與 protocol 名稱保留原文。

## 唯一責任

- 將 MCP request 機械映射到 OMI backend 公開 API。
- 不直接讀寫 `C:\project\Open Market Intelligence\data\open_market_intelligence.db`。
- 不 import OMI backend Python module。
- 不呼叫市場 provider、LLM、report 或 memory write。
- 不複製 target resolution、question intent、analysis horizon、freshness、trading calendar、provider fallback、refresh orchestration、budget policy、evidence shaping 或 answer logic。
- OMI public contract 擴充時，只同步 backend-owned schema 與 payload forwarding。

## Backend contract

Canonical endpoint：

```text
POST /api/ai/ask
```

Adapter 固定：

- `contract_version="omi.decision.v4"`
- `caller_profile="omi_search"`
- `allow_llm=false`
- `allow_write=false`

`refresh_if_missing` 缺省必須是 `false`。只有 caller 明確傳入 boolean `true` 時，才映射成 `allow_external_fetch=true`；不得從 question、target、market、horizon 或 freshness 推斷。

Adapter 不得替 backend contract 欄位補預設、clamp 數值或做語意驗證。結構性的 MCP compatibility alias 可以機械映射，但範圍、policy 與執行決策交給 backend。

`omi.decision.v4` 必須原樣交付給 MCP consumer。不得重新投影 `answer`、`decision`、`evidence`、`freshness`、`limitations`、`status` 或 response budget。

## Schema contract

`tools/list` 正常時從 OMI backend `GET /api/ai/tools` 取得 `omi.ask` schema；`public_contract_snapshot.json` 只作離線 fallback，且必須由 OMI repo 的 generator 產生。

Adapter 只能投影自己的安全 surface：隱藏固定 trust flags、限制不可執行的 LLM/write modes，以及加入明確的 compatibility aliases。Target、capability、selection、parameter schema、registry metadata 與 digest 都由 backend 擁有。

## Public tool surface

`tools/list` 只暴露：

- `omi.ask`
- `omi.read_market_overview`
- `omi.read_stock_context`
- `omi.read_data_freshness`
- `omi.read_source_health`
- `omi.read_capability_status`

Shortcuts 只能把 tool 名稱與明確 arguments 映射成 canonical target/parameters，固定 `mode=data_only`。不得分析自然語言後改變 target 或 refresh。

`omi.search` 只保留為不公開的 legacy callable alias。只有 legacy alias 可把 `query`、`stock_id`、`symbol` 轉成 canonical fields；`omi.ask` 不得使用這些欄位推斷 target。

不得加入 LLM report、memory write/update/archive、persist/save 或任何 direct database tool。

## 驗證

```powershell
cd C:\GPT_MCPtool\OMI_search
python -B -m unittest discover -s tests
```

修改 mapping 或 schema 時，還要驗證：

- 原始 question 未被改寫。
- 未明確指定時不會開啟 external fetch。
- backend-owned fields 未被補值或 clamp。
- live schema 與 generated snapshot digest 一致。
- initialize -> tools/list -> representative tools/call protocol smoke。
- structured business rejection 維持 `isError=false`。

Live backend smoke 不是每次預設驗證；只有確認正式 OMI runtime endpoint 與 process owner 後才執行。
