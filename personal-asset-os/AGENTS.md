# Personal Asset OS

這是 local-first、single-user 的個人資產與帳務系統。修改前先讀 `README.md`、
`docs/product/` 與相關 `docs/agent-runs/`。

## 資料與帳務邊界

- `transactions` 與 `postings` 是正式帳本的唯一真相來源。
- 正式交易只能新增、沖銷或以調整交易修正，不提供 update/delete。
- 每筆 posted transaction 的 `base_amount` 總和必須為零。
- `trades`、`prices`、`balance_observations`、`snapshots` 都是交易細節、外部證據或衍生資料，不能取代正式帳本。
- 第一版基準幣別固定為 TWD。不得假裝已支援完整多幣別帳務。
- 市價與匯率必須保留 `as_of`、來源與品質；缺價、舊價、部分估值必須顯示。
- 正式資料預設位於 `%LOCALAPPDATA%\PersonalAssetOS`，永遠不得進 Git。

## 安全與 runtime

- HTTP server 只允許綁定 loopback address；dashboard 與 REST API 不得成為 public endpoint。
- 唯一允許的遠端路徑是 OpenAI Secure MCP Tunnel 對 `/mcp` 的 outbound-only 轉送，且 MCP 只能暴露明確列出的唯讀 read model 工具。
- MCP 與 AI 不得新增、修改、沖銷或核准帳務；任何未來 proposal 都必須由本機 UI 明確核准後才可進 ledger。
- 托盤只能管理 command line、entry path 與本專案完全相符的 process，不得按 process name 廣泛終止。
- `.env.example` 只能放無法使用的 placeholder，不得放 credential 或私人機器值。
- `.env`、`.tunnel-client/`、`.tmp/`、runtime executable 與 tunnel log 都是本機狀態，不得進 Git；health、自測與 log 不得回傳 credential value。
- 備份與還原必須先做 SQLite integrity check；還原預設寫入新資料目錄，不覆蓋目前資料庫。

## 架構

- `src/personal_asset_os/domain/`：帳務不變量與 domain type。
- `src/personal_asset_os/services/`：ledger、portfolio、reporting、backup 等 use case。
- `src/personal_asset_os/api/`：HTTP schema 與 route adapter，不承擔帳務計算。
- `frontend/`：Fluent UI React dashboard，只消費 API contract。
- `src/personal_asset_os/mcp_server.py`：唯讀 MCP adapter，只呼叫既有 read model。
- `scripts/`：Windows bootstrap、驗證與 exact-path tray lifecycle。

## 驗證

- Python：`uv run pytest`、`uv run ruff check .`、`uv run mypy src`
- Frontend：`npm run lint`、`npm run build`
- 完整安全驗證：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate.ps1`
- Tray 靜態檢查：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tray.ps1 -SelfTest`

不要 commit 或 push，除非使用者明確要求。
