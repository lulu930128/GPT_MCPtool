# KGI Broker Bridge

這是 KGI SUPER PY 與 PAOS 之間的唯讀隔離層。它由 PAOS 擁有，但仍是獨立 process，
不是 MCP，也不是 PAOS Ledger 的一部分。

## 安全與資料邊界

- 第一版只允許 health 與 positions；不得加入下單、改單、刪單或任何交易操作。
- `kgisuperpy`、CA、ServiSign、credential 與 session lifecycle 必須留在 bridge runtime。
- 不得將完整身分證、券商帳號、密碼、憑證 secret、原始持倉或 runtime log 寫入 Git。
- 對外 contract 只能使用 opaque account id 與 masked label。
- 無法確認成功的空回應不得表示成零持倉；只能回傳明確錯誤。
- Bridge 不得寫入 PAOS database、Ledger、Financial Event 或 OMI domain storage。

## Contract

- 金額與數量以 `Decimal` 建模，JSON 一律序列化成字串。
- datetime 必須是 timezone-aware UTC。
- position quantity 與 valuation 分開，避免同一個 KGI instrument row 的 ASSET／NETPL
  被重複配置到多個 position type。
- 正式 snapshot 只允許 `complete` 或經上游明確確認的 `explicit_empty`。
- schema parse 失敗時不得發布標準 snapshot。

## Runtime

- HTTP 只能綁定 loopback。
- positions endpoint 必須使用本機 bearer token，且回應 `Cache-Control: no-store`。
- 正式 `kgisuperpy` adapter 必須在獨立 `.venv-kgi` 內執行；不得加入 PAOS 主環境依賴。
- Control Center 若未來接管 lifecycle，只能做 exact-path probe／restart，不得讀取持倉 payload。

## 驗證

```powershell
cd C:\GPT_MCPtool\personal-asset-os\kgi_broker_bridge
.\.venv\Scripts\python.exe -X utf8 -m pytest -q
.\.venv\Scripts\python.exe -X utf8 -m ruff check src tests
.\.venv\Scripts\python.exe -X utf8 -m mypy src
```

未經使用者明確要求，不執行正式 KGI 登入、不讀取真實持倉、不啟動常駐 runtime，也不
commit／push。
