# KGI Broker Bridge

KGI Broker Bridge 是 KGI SUPER PY 與 Personal Asset OS（PAOS）之間的專用唯讀隔離程序。
它位於 PAOS source tree，但保留獨立 dependency、runtime 與 credential boundary；它不是 MCP，
不保存正式帳本，也不提供交易操作。

目前已完成 bridge runtime 架構：除了 `broker.health.v1`、`broker.position.v1`、帳號去識別、
KGI `InventorySum` row normalization 與 loopback HTTP contract，也包含正式 `kgisuperpy`
subprocess gateway。PAOS dashboard、REST 與 MCP 已接入純讀取的 read-time valuation overlay；
broker snapshot 仍不持久化，也不會變成 Ledger／trade／price row。

## 邊界

```text
KGI SUPER PY / CA / session       (independent Python 3.12 runtime)
              |
              v
       bounded read-only session worker
       - credential only via child env
       - captures vendor stdout/stderr
       - InventorySum("B") only
              |
              v
       InventoryGateway port
              |
              v
       KGIInventoryAdapter
       - normalize raw rows
       - mask account identity
       - reject ambiguous empty
       - publish broker.position.v1
              |
              v
       loopback read-only API
              |
              v
             PAOS
```

- PAOS 不 import `kgisuperpy`。
- Bridge 不 import PAOS domain package，也不寫入 PAOS database。
- `positions` 與 `valuations` 分開；KGI 的 `ASSET`／`NETPL` 不會重複分攤至
  `cash`、`margin`、`short`、`odd_lot` buckets。
- `InventorySum("B")` 若同時回傳 `NETQTY0` 與 `NETQTY9`，只有在 `ASSET` 與
  `RLPRICE` 能明確證明零股已包含於現股總量時，才會從 `cash` 扣除重疊數量；證據不足時
  保留原始 buckets 並避免猜測。
- 完整券商帳號只可短暫存在 vendor adapter 記憶體；標準 contract 使用 HMAC opaque id 與
  masked label。
- 失敗、未登入、CA 異常或無法證明的空結果都不是零持倉。
- live gateway 使用隔離的唯讀 session，連續讀取共用登入；閒置 90 秒或使用滿 30 分鐘
  便登出，下次讀取重新建立。bridge 結束或讀取逾時也會關閉 worker。
- 股票批次快取 15 秒；現金與交割快取 60 秒並保留各自原始觀察時間。
  前端總覽可見時約每 25 秒讀取；輪詢頻率不代表券商報價保證即時。

## HTTP contract

- `GET /api/health`：不含帳戶或持倉的 bridge health。
- `GET /api/v1/positions`：需要 `Authorization: Bearer <local token>`，回傳
  `broker.position.v1` 或 predictable error envelope。
- `GET /api/v2/positions`：同樣需要 bearer token；一次回傳 TW/US scopes。任一市場失敗時
  aggregate 為 `partial`，成功市場仍保留，失敗市場不會被解讀成空持倉。

預設 runtime adapter 仍為 `disabled`；只有明確設定 `KGI_BRIDGE_ADAPTER_MODE=kgisuperpy`
並提供完整 live 設定才會啟用 KGI worker。

## 本機設定

### 帳務讀取

`GET /api/v1/account-state` 使用相同 bearer 認證與 `Cache-Control: no-store`，回傳
`broker.account_state.v1`。worker 在既有 v2 session 內額外呼叫 `Account.SettleAmt(FType="SS")`
與 `SubAccount.PositionDetailReport("USD")`。gateway 以 15 秒程序記憶體快取共用一次
acquisition，避免 positions／account-state 連續讀取重複登入；原始資料不落地。
分項失敗不抹除另一分項，worker 只傳允許的數值欄位及供 HMAC 投影的帳戶識別。

已檢查安裝 SDK：PositionDetailReport 實作只接受 USD，無參數也預設 USD；TWD／None
會直接拒絕，不能依 docstring 宣稱可查所有幣別。`pp3` 為原幣可交易餘額，`pp5` 為
原幣可出金；使用者已確認 `balance_twd` 為 USD 現金，
故 settled_cash_currency=USD，保留 source_field；Bridge 不自行換匯或決定估值納入。
SettleMark 並不自動轉成 pending；pending summaries 仍為 null。

依本機使用者決定，第一版允許將帳密直接放在 Git-ignored `.env`。這仍是 plaintext secret：
只應存在這台電腦、限制為目前 Windows 使用者可讀，且不得同步到雲端、貼進 issue、log、
測試 fixture 或 commit。未來可改用 Windows Credential Manager／DPAPI-backed secret
reference；bridge contract 不需要因此變更。

```powershell
cd C:\GPT_MCPtool\personal-asset-os\kgi_broker_bridge
Copy-Item .env.example .env
```

在 `.env` 設定：

- `KGI_BRIDGE_ADAPTER_MODE=kgisuperpy`
- `KGI_BRIDGE_PERSON_ID`、`KGI_BRIDGE_PERSON_PASSWORD`
- `KGI_BRIDGE_SDK_PYTHON`：指向已能成功執行 `kgisuperpy` 的 `python.exe` 絕對路徑
- `KGI_BRIDGE_ACCOUNT_HASH_KEY`：至少 32 字元，且不可與 API token 相同
- `KGI_BRIDGE_STOCK_ACCOUNT`：可留空，自動選擇 `account_flag=證券` 的帳戶
- `KGI_BRIDGE_SUB_ACCOUNT`：可留空，自動選擇複委託／海外證券帳戶
- `KGI_BRIDGE_SIMULATION=false`：正式帳務查詢；不會開放下單 route

帳密由 bridge 讀取後只透過白名單化的 child-process environment 傳給 worker，不會出現在
worker command line；worker 讀取後立即移除 credential environment variables，查詢完成也會
主動 logout。bridge 不記錄 request access log，worker 會攔截 vendor stdout/stderr；但作業系統
管理員仍可讀取本機 process memory，因此 `.env` 與 Windows 帳號本身仍需妥善保護。

KGI SDK 會在目前工作目錄產生 `errMsg.ini` 等 vendor runtime artifact。Bridge 會把 worker cwd
固定到 `%LOCALAPPDATA%\PersonalAssetOS\runtime\kgi-broker-bridge`（可用
`KGI_BRIDGE_RUNTIME_DIR` 覆寫），不讓這些檔案落進 public source tree。

預設 port `18878` 只是設定偏好；正式採用前仍須確認實際 listener owner 與 Windows excluded
port ranges。

```powershell
cd C:\GPT_MCPtool\personal-asset-os\kgi_broker_bridge
uv sync --dev
uv run kgi-broker-bridge
```

若保持 `disabled`，positions endpoint 會回傳 `adapter_not_configured`。若 live 設定缺欄、SDK
interpreter 不存在或不是絕對路徑，服務會在啟動前 fail closed。

## 驗證

synthetic regression 不會安裝、登入或呼叫正式 `kgisuperpy`：

```powershell
cd C:\GPT_MCPtool\personal-asset-os\kgi_broker_bridge
.\.venv\Scripts\python.exe -X utf8 -m pytest -q
.\.venv\Scripts\python.exe -X utf8 -m ruff check src tests
.\.venv\Scripts\python.exe -X utf8 -m mypy src
```

`tests/fixtures/inventory_sum_synthetic.json` 完全是 synthetic contract fixture，不得換成真實帳號
或真實持倉後提交。

## Live qualification 邊界

自動測試只涵蓋 fake SDK、worker protocol、秘密不進 argv／repr、空持倉語義與 API contract。
真正的 KGI qualification 必須由使用者填妥 `.env` 後明確執行；正式 smoke 只允許 health 與
`GET /api/v1/positions`／`GET /api/v2/positions`，不得加入交易呼叫。測試腳本與真實持倉輸出
不得保存到 repository；smoke 只輸出 status、scope count 與零寫入證據。

## 後續階段

1. 若未來需要歷史追蹤，再另外設計 immutable broker evidence 與 sync-run persistence；
   目前純讀取模式不保存真實持倉 payload。
2. 建立可信本機 UI 的 account mapping／opening-position proposal，且仍需使用者明確核准。
3. 價格與持倉分頻率接入，不改變 Bridge 的唯讀與 process isolation 邊界。
