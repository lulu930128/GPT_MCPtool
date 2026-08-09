# Personal Asset OS

Personal Asset OS 是本機優先的個人資產與帳務系統。目前提供可實際使用的桌面 dashboard、日常快速捕捉、複式帳本、信用卡負債、投資部位、手動估值、對帳、月結與可驗證備份。

## 目前能力

- 建立現金、銀行、信用卡、券商現金與投資帳戶。
- 記錄期初餘額、收入、支出、帳戶互轉與信用卡付款。
- 記錄股票買進與賣出，使用移動平均成本推導持倉與已實現損益。
- 保存手動市場價格及其時間、來源與品質，不把舊價冒充即時價格。
- 顯示總資產、負債、可用現金、投資成本／市值、當月收支與資料警告。
- 以 Quick Capture 保存不影響正式帳本的 Financial Event，並在 Pending Inbox 修改、拒絕或正式入帳。
- 一般支出／收入在帳戶明確時可一次「直接入帳」；finalize 會原子化建立平衡交易、lineage 與 audit。
- 保存帳戶餘額觀察值與帳面差額，支援月結快照。
- 建立 SQLite online backup、SHA-256 manifest 與 integrity check。
- 透過七個唯讀 MCP 工具查詢總覽、帳戶、部位、近期交易、待處理日常記錄、對帳與系統狀態。
- 由 Windows 托盤固定準備 server、外部 API 能力與 Secure MCP Tunnel，並可重啟 server、開啟 dashboard、執行備份與檢查 health。
- 使用固定 synthetic prompt 驗證 OpenAI Responses API；該檢查不傳送個人財務資料。

目前不包含手機同步、一般雲端 relay、銀行／券商自動匯入、完整多幣別、稅務引擎或 AI 寫入。dashboard 與 REST API 永遠只綁定 loopback；唯一遠端路徑是 OpenAI Secure MCP Tunnel 對 `/mcp` 的私有 outbound-only 轉送。

## 文件導覽

- [帳本模型](docs/LedgerModel.md)：`transactions + postings`、debit-positive、immutability、
  idempotency、投資與對帳語意。
- [安全與隱私](docs/SecurityAndPrivacy.md)：本機資料、loopback、read-only MCP、手機與備份邊界。
- [MCP 工具參考](docs/McpToolReference.md)：七個唯讀工具及 freshness／quality／warning 語意。
- [備份與還原](docs/BackupRecovery.md)：online backup、integrity、new-path restore 與 recovery acceptance。
- [產品方向](docs/product/ProductVision.md)、[Operating Model](docs/product/OperatingModel.md)、
  [Quality Bar](docs/product/QualityBar.md)、[Roadmap](docs/product/Roadmap.md)。

## 資料位置

預設資料目錄：

```text
%LOCALAPPDATA%\PersonalAssetOS
├── data\personal_asset_os.db
├── backups\
├── logs\
└── runtime\
```

可用 `PAOS_DATA_DIR` 指定其他目錄。正式資料、備份、log、PID 與 `.env` 都已排除於 Git。

## 初次安裝

在 PowerShell 執行：

```powershell
cd C:\GPT_MCPtool\personal-asset-os
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bootstrap.ps1
```

bootstrap 會建立 `.venv`、安裝鎖定的 Python／frontend 依賴、執行 migration、建置 dashboard，然後跑最小 smoke check。

## 托盤啟動

隱藏啟動：

```powershell
C:\GPT_MCPtool\personal-asset-os\scripts\start-tray.vbs
```

一般 `Start-Tray.cmd` 不會取代已存在的 instance。程式更新後使用：

```powershell
C:\GPT_MCPtool\personal-asset-os\scripts\Restart-Tray.cmd
```

Restart 只會終止 command line、Python entry 與本專案 exact path 相符的 server／tray process。它不會按 `python.exe` 或 `powershell.exe` 名稱廣泛終止其他工作。

托盤 menu contract：

- 狀態列：`Personal Asset OS MCP | Server: Running | Tunnel: Ready`。
- `Restart MCP server`。
- Copy MCP URL／health URL／tunnel ID。
- Open MCP health／tunnel UI／runtime logs。
- 元件特有區：dashboard、verified backup、app URL、data folder、backup folder。
- `Quick capture`：直接開啟本機第一屏快速記錄入口。
- `Exit`：確認後完整停止 server、tunnel 與 tray。

選單不提供 Start／Stop 或 tunnel restart。正式 tray 啟動會一起準備 loopback server、
`.env` 中已配置的 Responses API 能力與 Secure MCP Tunnel；Responses API 只有在使用者
明確操作時才會發出 request，不會因 tray 啟動而背景傳送財務資料或消耗 quota。

預設 dashboard：`http://127.0.0.1:8876/`

本機 MCP：`http://127.0.0.1:8876/mcp/`

## 日常記錄與正式入帳

- `先記著`：只新增 pending Financial Event；不改變淨資產、本月收支、transaction 或 posting。
- `直接入帳`：限資料完整的 expense／income，必須選擇付款／收款帳戶；桌面端 finalize service 建立正式雙式交易。
- Pending Inbox：可修改 event 版本、正式入帳或保留 rejected tombstone，不會直接覆寫 posted transaction。
- 相同 idempotency key 搭配相同內容會回傳既有 event；搭配不同內容會回傳 conflict。
- 手機 App 尚未實作。未來手機是主要日常入口，可一次核准低風險事件，但不會直接寫資料庫；desktop 仍負責裝置、版本、帳戶與 ledger invariant 驗證。

## 私有 MCP 連線

連線採用 [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)，不開 inbound firewall port，也不建立 public URL。`tunnel-client` executable、profile、log、PID、`.env` 與 credential 都是 Git-ignored local runtime state。

初始化與檢查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tunnel.ps1 -Action SelfTest
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tunnel.ps1 -Action Init
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tunnel.ps1 -Action Doctor -Explain
```

初始化成功並配置本機 profile／credential 後，托盤固定同時啟動 server 與 tunnel，
不提供 `.env` 或托盤前端停用開關。ChatGPT developer-mode app 建立連線時選擇 Tunnel，
再選擇已建立的 tunnel。MCP 工具全部宣告 read-only，且沒有新增、修改、沖銷、備份或
還原工具。

## OpenAI 連線驗證

`.env.example` 只含不可用 placeholder；實際 credential 留在 ignored `.env`。下列命令會做一次小型 Responses API 呼叫，只傳送固定 readiness marker，不會傳送帳戶、交易、部位或任何個人財務資料：

```powershell
uv run --frozen personal-asset-os openai-check
```

API 呼叫仍可能計入 OpenAI 帳戶用量。實際資產分析目前只透過 ChatGPT 主動呼叫唯讀 MCP 工具；本機 backend 不會背景自動呼叫模型。

## 開發

Backend：

```powershell
uv sync --dev
uv run alembic upgrade head
uv run personal-asset-os serve --host 127.0.0.1 --port 8876
```

Frontend：

```powershell
cd frontend
npm ci
npm run dev
```

完整驗證：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate.ps1
```

包含 production runtime 與 MCP protocol smoke：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate.ps1 -RuntimeSmoke
```

## 帳務符號慣例

postings 採 debit-positive：

- 資產與費用增加為正數。
- 負債、權益與收入增加為負數。
- 每筆交易的基準幣別總額必須為零。

例如信用卡消費 500 元：費用 `+500`、信用卡負債 `-500`。繳款時銀行 `-500`、信用卡負債 `+500`，不會再新增支出。

## 備份與還原

Dashboard 與托盤都能建立 verified backup。備份會包含 SQLite 檔案、SHA-256、建立時間與 integrity check 結果。

為避免覆蓋正式資料，第一版的還原命令只允許寫入不存在的新目標：

```powershell
uv run personal-asset-os restore-backup `
  --source "<backup.db>" `
  --destination "<new-data-dir>\personal_asset_os.db"
```

確認新資料庫的 dashboard、筆數與月結快照後，再由使用者明確切換 `PAOS_DATA_DIR`。
