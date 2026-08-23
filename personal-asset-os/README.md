# Personal Asset OS

Personal Asset OS 是本機優先的個人資產與帳務系統。目前提供可實際使用的桌面 dashboard、日常快速捕捉、複式帳本、信用卡負債、投資部位、手動估值、對帳、月結與可驗證備份。

目前 application release 為 `1.1.0`。Ledger、API、mobile ingest 與資料 schema 版本仍依各自契約獨立演進。

## 目前能力

- 建立現金、銀行、信用卡、券商現金與投資帳戶。
- 記錄期初餘額、收入、支出、帳戶互轉與信用卡付款。
- 記錄股票買進與賣出，使用移動平均成本推導持倉與已實現損益。
- 保存手動市場價格及其時間、來源與品質，不把舊價冒充即時價格。
- 顯示總資產、負債、可用現金、投資成本／市值、當月收支與資料警告。
- 手機以「金額、分類、描述（選填）」快速記錄；分類下拉選單依本機保存次數排序，自訂分類保存一次後成為可選項，並透過 Financial Event 保留分類 lineage。
- 日常收支固定使用唯一「活動資金」帳戶：支出直接扣除、收入直接增加；finalize 會建立平衡交易、lineage 與 audit。
- 保存帳戶餘額觀察值與帳面差額，支援月結快照。
- 由 PAOS lifecycle 每日保存一次彙總估值；錯過取樣時間時在元件下一次 ready 後補抓，並提供不補零的 1／3／12 個月資產走勢。
- 建立 SQLite online backup、SHA-256 manifest 與 integrity check。
- 透過七個唯讀 MCP 工具查詢總覽、帳戶、部位、近期交易、待處理日常記錄、對帳與系統狀態。
- 由 Windows 托盤固定準備 server、外部 API 能力與 Secure MCP Tunnel，並可重啟 server、開啟 dashboard、執行備份與檢查 health。
- 使用固定 synthetic prompt 驗證 OpenAI Responses API；該檢查不傳送個人財務資料。

目前不包含一般雲端 relay、跨網路手機同步、銀行／券商自動匯入、完整多幣別、稅務引擎或 AI 寫入。dashboard 與 REST API 永遠只綁定 loopback；OpenAI Secure MCP Tunnel 仍只對 read-only `/mcp` 做私有 outbound-only 轉送。Android 寫入路徑只透過本機 USB/ADB reverse 送出已配對裝置的低風險核准意圖，由桌面服務驗證並寫入 Ledger。

## KGI Broker Bridge 架構基線

`.\kgi_broker_bridge\` 是 PAOS-owned、但維持獨立 dependency 與 process boundary 的非 MCP、
唯讀 source architecture：
`broker.health.v1`、相容的 `broker.position.v1`、多市場 `broker.position.v2`、KGI
台股／複委託美股 row normalization、帳號去識別、
ambiguous-empty fail-closed、bearer-protected loopback API，以及在獨立 Python runtime 執行的
`kgisuperpy` worker。

正式 KGI 登入／CA read-only qualification 已完成。PAOS 可透過 bearer-protected loopback HTTP
在 dashboard、REST 與 MCP read model 的讀取當下套用 KGI 市值；Bridge 由 PAOS server 以
exact-path child process 自動啟動，仍保留獨立 dependency 與 credential boundary。

KGI 原始 snapshot、即時價、匯率與逐筆持倉不會寫成交易、Ledger 或 `prices`。每日估值排程或
使用者明確補抓時，只保存圖表需要的 aggregate metrics、資料品質與來源時間，不保存券商帳號或
逐筆 Bridge payload。台股與美股分別由 `PAOS_BROKER_INVESTMENT_ACCOUNT_ID`、
`PAOS_BROKER_US_INVESTMENT_ACCOUNT_ID` 選擇性連結，避免跨市場或其他券商同代號互相覆蓋；
沒有帳本對應的 KGI 持倉會以
「券商唯讀、尚未對帳」納入暫估資產。Bridge 失敗時保留原 PAOS 估值並顯示 warning，不能把
連線失敗解讀為零持倉。KGI `NETPL` 只作券商參考，不覆蓋 PAOS 帳本損益。

美股保留 USD 原幣價格與市值；PAOS 只在取得可追溯 USD/TWD fact 時換算並納入 TWD 暫估總資產。
期交所 `DailyForeignExchangeRates` 是 `official_reference` 首選；它是盤後洗價／保證金計算用
參考值，不冒充即時成交匯率。期交所超齡或失敗時依序嘗試央行 `BP01D01` 的
`official_close`、臺銀 USD 即期買賣中價 `bank_spot_mid`。三者均失敗或超齡時，USD 原幣市值
仍顯示，但 TWD 市值為 `null`
且不納入總資產。所有 cache/fallback 僅存在目前 PAOS 程序記憶體。

本機 `.env` 需設定：

- `PAOS_BROKER_BRIDGE_ENABLED=true`
- `PAOS_BROKER_BRIDGE_API_TOKEN`：與 `kgi_broker_bridge\.env` 的 token 完全相同
- `PAOS_BROKER_INVESTMENT_ACCOUNT_ID`：可選；只在需要把既有 KGI Ledger 帳戶和券商持倉
  去重時設定。未設定時，KGI 部位會以外部唯讀資產納入並標示帳戶未連結。
- `PAOS_BROKER_US_INVESTMENT_ACCOUNT_ID`：可選；只對複委託美股 scope 生效。
- `PAOS_FX_ENABLED=true`：啟用期交所／央行／臺銀官方 USD/TWD 唯讀 provider；預設允許時效為 4 日，
  以涵蓋週末但不接受長期過舊資料。
- `PAOS_DAILY_SNAPSHOT_ENABLED=true`：由 PAOS server lifecycle 擁有每日估值排程；不是由前端
  refresh 或 history GET 觸發。
- `PAOS_DAILY_SNAPSHOT_LOCAL_TIME=06:30`：依 `PAOS_REPORTING_TIMEZONE` 判斷的每日操作性取樣時間；
  若元件當時未啟動，下一次 ready 後會補抓。此時間不代表任何市場的官方收盤保證。

## 文件導覽

- [帳本模型](docs/LedgerModel.md)：`transactions + postings`、debit-positive、immutability、
  idempotency、投資與對帳語意。
- [安全與隱私](docs/SecurityAndPrivacy.md)：本機資料、loopback、read-only MCP、手機與備份邊界。
- [MCP 工具參考](docs/McpToolReference.md)：七個唯讀工具及 freshness／quality／warning 語意。
- [備份與還原](docs/BackupRecovery.md)：online backup、integrity、new-path restore 與 recovery acceptance。
- [手機同步](docs/MobileSync.md)：一次性配對、SecureStore、USB/ADB、outbox retry 與單一活動資金入帳 contract。
- [產品方向](docs/product/ProductVision.md)、[Operating Model](docs/product/OperatingModel.md)、
  [Quality Bar](docs/product/QualityBar.md)、[Roadmap](docs/product/Roadmap.md)。

## Android 手機預覽版

`mobile/` 提供 Android-first Expo App，包含分類式 Quick Capture、手機 SQLite outbox、一次性配對、SecureStore 裝置 token 與 USB/ADB loopback 前景自動同步。保存後、App 回到前景，以及 App 在前景時接上 USB 都會自動嘗試送出；手動按鈕保留給失敗重送。手機不直接接觸桌面資料庫；同步成功時，桌面會在同一 transaction 內建立 Financial Event 並正式計入唯一活動資金。分類會寫入 `category_hint` 供消費占比聚合；選填描述只補充該筆細節。

```powershell
cd C:\GPT_MCPtool\personal-asset-os\mobile
npm install
npm run android:lan
```

也可在不安裝 Expo Go 的情況下產生本機 standalone APK。開發、安全邊界、建置命令及實機 smoke 步驟見 `mobile/README.md`。

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
- `Exit`：確認後完整停止 server、tunnel 與 tray。

選單不提供 Start／Stop 或 tunnel restart。正式 tray 啟動會一起準備 loopback server、
`.env` 中已配置的 Responses API 能力與 Secure MCP Tunnel；Responses API 只有在使用者
明確操作時才會發出 request，不會因 tray 啟動而背景傳送財務資料或消耗 quota。

預設 dashboard：`http://127.0.0.1:18876/`

本機 MCP：`http://127.0.0.1:18876/mcp/`

## 日常記錄與正式入帳

- `活動資金`：唯一、啟用、非系統、TWD、流動的 cash／bank 資產帳戶；投資與券商帳戶不符合資格。
- `直接入帳`：資料完整的 expense／income 固定套用活動資金，不再選擇付款／收款帳戶；桌面 finalize service 建立正式雙式交易。
- Pending Inbox：可修改 event 版本、正式入帳或保留 rejected tombstone，不會直接覆寫 posted transaction。
- 相同 idempotency key 搭配相同內容會回傳既有 event；搭配不同內容會回傳 conflict。
- 手機 App 可透過 USB/ADB loopback 送出低風險支出／收入核准意圖；相同 device sequence 與 idempotency key 受唯一性及 payload hash 保護。
- 新手機記錄使用 schema v3：分類必填、描述選填；舊 v1／v2 outbox payload 與 hash 不重寫，仍依原契約相容處理。
- PAOS server 可選擇性維護單一已授權 Android 裝置的固定 ADB reverse mapping；手機會先完成 authenticated session preflight，transport failure 不會先污染 outbox attempt 狀態。
- desktop 在同一資料庫 transaction 內 capture + finalize；手機只在收到 `matched` event 與 transaction ID 後標記同步成功。
- 活動資金候選為 0 或超過 1 時回 503，整次請求 rollback，手機保留原 outbox row 供安全重試。
- `GET /api/activity-fund` 可唯讀確認目前模式、候選數與唯一選中的帳戶。
- `POST /api/valuation-snapshots/daily` 明確保存當日不可變彙總估值；同一 reporting date 重送
  會回傳既有快照，不會覆寫。
- `PUT /api/transactions/{id}/reporting-annotation` 只建立有版本與 audit 的報表分類／備註修正；不修改 immutable transaction、posting、Financial Event 或既有 payload hash。
- PAOS server 會在 `PAOS_DAILY_SNAPSHOT_LOCAL_TIME` 後 first-ready capture；當日已有快照時不再
  呼叫 KGI／FX。排程失敗不會終止 server，會在下一個 bounded poll 重試。
- `GET /api/dashboard/history?range=1m|3m|1y` 只讀已保存快照，不呼叫 KGI／FX、不寫資料庫，
  缺少日期維持 gap 而不是補零。日界線由 `PAOS_REPORTING_TIMEZONE` 控制，預設
  `Asia/Taipei`。
- Dashboard 的資產歷史可切換暫估淨資產、可用現金、投資市值與負債；少於 8 個保存點時只顯示
  實際觀測點，不連成容易誤判的趨勢線。
- 手機仍不能直接寫 SQLite，也不能執行沖銷、調整、投資、月結或其他高風險操作。
- 配對管理命令為 `personal-asset-os mobile-pair`、`mobile-devices` 與 `mobile-revoke <device-id>`；完整步驟見 `mobile/README.md`。

## 私有 MCP 連線

### Control Center lifecycle

`control-center/component.json` 將 server 與 Secure MCP Tunnel 接到
`MCP Control Center` 的 `unified-lifecycle-v3` 合約。Control Center 只做
loopback health、exact PID／程序血緣驗證與 lifecycle 協調；不讀取帳本、
Financial Event、投資資料、報表、備份或正式資料路徑。

dashboard 仍是主要 UI。Control Center 可開啟 primary UI 或按需啟動
component-owned diagnostic tray；diagnostic tray 關閉時不會停止 runtime。
完整邊界與 rollback 見 [Control Center Integration](docs/ControlCenterIntegration.md)。

原托盤的 dashboard、verified backup、URL 與資料夾操作已透過
`component-menu-v1` 直接接回中樞子選單。verified backup 仍需明確確認，且完全由本元件
執行；中樞不會取得正式資料路徑、備份路徑、帳務內容或 tunnel ID。

連線採用 [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)，不開 inbound firewall port，也不建立 public URL。`tunnel-client` executable、profile、log、PID、`.env` 與 credential 都是 Git-ignored local runtime state。

此元件目前保留 component-local tunnel executable；Control Center inventory 只讀取
path／version／SHA-256，不做 automatic upgrade 或切換。Lifecycle controller 只在 server／tunnel
child spawn 時清除 ambient proxy、bypass `127.0.0.1`／`localhost`，隨後還原 parent environment；
不修改 dashboard、使用者 shell 或 Windows 全域 proxy。兩個 long-lived child 都使用不繼承
controller stdout／stderr capture 的啟動模式，避免 runtime 已 Ready 卻被上層誤判為 action timeout。

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
uv run personal-asset-os serve --host 127.0.0.1 --port 18876
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
