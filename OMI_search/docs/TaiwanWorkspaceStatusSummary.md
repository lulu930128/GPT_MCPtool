# Taiwan Workspace 資料狀態與技術摘要

日期：2026-10-09。本輪只調整前端 presentation、相關測試與本文件；保留既有未提交 WIP。未修改 backend、provider、adapter business logic、schema、交易或 SYNTHETIC 流程，未 commit、push、啟動或重啟 runtime。

## 實作

- 左側欄最後一個 sibling 為「資料狀態／更新狀態」，位於群組樹外，預設收合。展開區上限 280px，與樹的 scroll 隔離；desktop 側欄仍為 820px，沒有新增 viewport/host height 相依。
- 集中 header、watchlist、holdings、search、hot groups、chart、research 七個獨立來源。來源分類互斥且每個來源只計一次；警告／限制項數在來源詳情中按原始路徑列出。相同文字出現在不同原始路徑仍會完整保留，不假裝是唯一事件數。
- 分類優先序為錯誤、部分受限、警告、未請求、未確認、正常。正常要求明確頂層健康狀態與 freshness，且請求 identity 相符、沒有 loading/error；缺少這些證據不會因 MCP transport 成功就算正常。讀取中另外計數，不表示獨立的市場 snapshot。
- 詳情保留來源時間、freshness、warnings/limitations、錯誤、舊快取、request/data key 及延遲建立的原始證據。缺時間或 freshness 明示未提供。主畫面仍有短品質 badge、loading 與 role=alert 更新錯誤。
- TAIEX/TPEX 仍在左欄右方並排、齊頂；依 index_id 配對 TWSE/TPEX 廣度。卡片分為指數／漲跌、廣度／覆蓋、session／品質／來源／proxy 三層，不放 raw JSON。grid 市場列使用 min-content，避免跨列側欄高度分配出多餘空白。
- 技術摘要位於既有 InteractiveMarketChart 上方，不改 crosshair、zoom/pan 或 instance lifecycle。手動圖表重讀同時重讀研究；30 秒 chart / 120 秒 research 自動 cadence 不變。

## 正式資料對應與限制（2026-10-09 修正）

前輪 87/87 tests 未能發現結構化欄位映射缺口；本輪移除英文 momentum row 的數值解讀，以及固定的「K/D：目前來源未提供」宣告。下列規則取代前輪映射說明。

唯讀核對主 OMI 的 `backend/app/market/technical_report.py`、`tw_market_dashboard.py`、`schemas.py`、`tw_market_dashboard_schemas.py` 與 generated snapshot；未 import 或修改 backend。`_aggregated_indicator` 負責區分已完成 indicator 與 current_partial_indicator，前端不重算。

| 摘要欄位 | 唯一數值來源 |
| --- | --- |
| 日期、開、高、低、收、成交量 | daily/weekly/monthly 的最新 `chart.points`；today 的最新 `intraday_chart.points` |
| 成交金額 | 歷史週期最新 point 的 `trade_value`；today contract 未提供，顯示「—」 |
| 量／金額單位 | 同一 active chart 的 `volume_unit`／`trade_value_unit`；缺單位為「—」，不自行換算張、股、元 |
| MA5/20/60 | 同份 chart envelope 的 `moving_averages`，只配對完全相同 `time` |
| RSI14 | indicator 的 `rsi.rsi14` |
| MACD 線／Signal／Histogram | indicator 的 `macd.macd`／`macd.signal`／`macd.histogram`，三者分欄 |
| K9／D9 | indicator 的 `kd.k9`／`kd.d9` |
| 漲跌幅 | 同一 indicator 的 `change_pct`；不取可能屬於盤中情境的外層 change_pct，不推算前收 |

daily 路徑為 `technical.data.daily_indicator`；weekly/monthly 為 `technical.data.indicator`。J9 本輪不增加顯示欄位，以控制摘要密度；沒有計算或修改來源數值。

- chart/research 的 dataKey 各自等於 request key；解析 key 後的 stock_id/timeframe 必須對應 payload。兩個 envelope、technical report、歷史 chart 內層 identity 均需一致。
- RSI/MACD/KD/漲跌幅只在 indicator 與 K 棒的 **time、有限 close 完全相同**、且不是明示 partial bar 時呈現。時間／收盤不符或缺值時隱藏研究數值，另列研究資料時間、產生時間及不對應原因。
- today 從不借用 daily_background、daily_indicator 或意外出現的 indicator 作分 K 指標；只保留分 K OHLCV 與同時間的 backend MA。
- 顯示 backend decision_snapshot 與 period.status，缺欄位為「—」。current_partial 只有在 period.latest_period_start 等於顯示 K 棒時間時，才標示該棒為部分 K 棒；不自行推算交易日、週末或月末。
- 同選取 refresh 可以保留仍對應的數值，同時保留 loading/error 和 backend 品質 badge；不同選取的舊圖仍明示「舊選取快取」，不搭配新／舊研究混用。
- MA 不取 research.ma 替代，不在前端計算。來源精度可能不同，例如 chart MA60 `2413.6666666666665` 與 daily indicator MA60 `2413.6667`；摘要保留 chart 原值，只作兩位小數格式化。
- 0 為有效值；null、NaN、Infinity、字串數字與缺值為「—」。最新 point malformed 或缺 time 時，不偷偷挑前一棒替代。未知狀態不宣稱正常。

## 本輪唯讀資料證據

2026-10-09 約 13:20–13:24（Asia/Taipei），2330，production Workspace bars：today 500、daily 240、weekly 156、monthly 120。均為既有 cache-only read，沒有 provider fetch、backfill、refresh、資料寫入或 runtime restart。

| 週期 | 最新 chart time／close | 同棒 MA5／20／60 | 研究結果 |
| --- | --- | --- | --- |
| today | 2026-10-08T13:24:00+08:00／2560 | 2558／2558／2557.75 | 僅 intraday、daily_background，沒有同週期 indicator；RSI/MACD/KD 為「—」 |
| daily | 2026-10-08／2550 | 2559／2476.5／2413.6666666666665 | 同 time/close；RSI14 61.5111，MACD 40.703／30.5897／10.1133，K9 83.5116，D9 85.1391，change_pct -1.354 |
| weekly | 2026-10-05／2550 | 2479／2405.25／1900.75 | 同 time/close；RSI14 71.5151，MACD 130.3711／143.3459／-12.9748，K9 83.9538，D9 78.5295，change_pct 2；period completed |
| monthly | 2026-10-01／2550 | 2454／1712.5／1015.9916666666667 | 本機 MCP 成功，但 indicator 是 2026-09-01／2480；period current_partial，因此目前 10 月 K 棒不顯示 9 月指標 |

歷史 K 棒的 volume_unit 均為 shares、trade_value_unit 均為 TWD：

| 週期 | open／high／low／close | volume | trade_value |
| --- | --- | --- | --- |
| today | 2555／2560／2555／2560 | 157000 | 未提供 |
| daily | 2550／2575／2550／2550 | 23145193 | 59167379273 |
| weekly | 2550／2590／2545／2550 | 87688365 | 225249276138 |
| monthly | 2490／2590／2485／2550 | 124146663 | 316459881045 |

本次 production bars 的 MA60 都有值。短歷史請求造成 null 只代表該回傳的資料不足，不代表後端完全沒有 MA60。

### Monthly 分層診斷

- 連接器 `omi_read_tw_stock_research(2330, monthly)` 兩次失敗，約 14691 ms、12519 ms；錯誤 `Mcp error: -32603: Internal error`。
- Launcher log 指向 `http://127.0.0.1:8400`，health 自述 project root 為主 OMI checkout。未做 runtime 採用或重啟。
- 直接 `GET /api/market/tw-dashboard/stocks/2330/research?timeframe=monthly` 兩次 **HTTP 200**，4199／4588 ms，每次 10,588,934 bytes。
- 同一既有本機 adapter `http://127.0.0.1:18797/mcp`，initialize 後 tools/call 成功，`isError=false`，5666.56 ms；Python 重新序列化 structuredContent 為 11,248,402 bytes（不是 HTTP wire bytes）。
- 本機 MCP 讀到 monthly 已完成 indicator：time `2026-09-01`、close `2480`、RSI14 `81.0632`、MACD `413.932 / 334.974 / 78.958`、KD `91.1786 / 89.9935 / 93.5486`、change_pct `3.1185`。period.latest_period_start=2026-10-01、period.status=current_partial、decision_snapshot=completed。
- **沒有重現獨立 backend endpoint 缺陷**，也不能宣稱連接器已恢復。故障邊界位於本機 MCP 以外的連接器／傳輸路徑；大型 response 是待驗證的可能因素，尚無 gateway log 或限制證據可以定因。後續診斷 owner 為 MCP 連接器／傳輸層；若要縮減 response，必須另由 backend contract owner 設計，本輪不改 backend 或 adapter payload。
- monthly 映射及拒絕錯週期混用有測試；不宣稱 ChatGPT 連接器 monthly end-to-end 成功。

## 本輪變更檔案

本次相對前輪 WIP 僅修改：

- `ui/tw-market-dashboard/src/workspace-technical.tsx`
- `ui/tw-market-dashboard/src/workspace-summary.test.ts`
- `ui/tw-market-dashboard/scripts/workspace-browser-fixture.tsx`
- 本文件

`dist/index.html` 是 ignored 本機 build 產物。未修改 WorkspaceApp、status panel、market cards、CSS、iframe height、chart lifecycle、polling、selection generation、SYNTHETIC 或真實交易流程。未 commit/push/restart，保留其他既有 WIP。

## 驗證結果

在 `C:\GPT_MCPtool\OMI_search\ui\tw-market-dashboard`：

~~~powershell
npm run typecheck
npm test
npm run build
~~~

- TypeScript strict typecheck 通過。
- Node tests **122/122 通過**，0 failed／skipped。四週期正常、缺 technical、所有跨週期組合、舊／新選股與 request key、時間／收盤不符、零值、非有限數字、部分欄位、malformed 最新 point、MA 時間錯配／不足歷史、refresh error、daily/weekly live-format 與 monthly 已完成／未完成期間均有覆蓋。描述 row 與 nested 數值刻意矛盾，證明 structured source 優先。原有 layout、height、navigation、chart 與 SYNTHETIC regression 保留。
- Build 通過，dist 532,991 bytes。
- package 未提供獨立 lint script。

在 `C:\GPT_MCPtool\OMI_search`：

~~~powershell
python -B tests/check_workspace_contract.py
python -B tests/check_workspace_resource.py
~~~

- Contract AST、主 OMI generated snapshot byte parity、digest 通過：
  `5f8defdefb513730f0ab7d239fa745d79cda342b3d200c6ee0f9f91bffc8fb87`。
- 實際 MCP initialize／resources/list／tools/list／resources/read 通過，協定 `2025-11-25`、17 tools、2 resources；progressive input/output schemas 與 snapshot 一致。
- Workspace resource 與最新 dist 加 marker 完全一致；legacy resource 與 dist 完全一致；MIME/CSP 通過、network allowlists 為空。Workspace resource 533,017 bytes，SHA-256：
  `506dab876b1f696fe746586cf4c2ede7774e94b2b3dd702842473f4ee3ef9172`。
- 原有 `tests/check_workspace_resource.py` 未修改。
- 額外嘗試 adapter Python targeted suite：

~~~powershell
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -p test_workspace.py
~~~

啟動前即失敗：`No Python at '"C:\Users\thoma\AppData\Local\Programs\Python\Python312\python.exe'`，沒有收集或執行測試。可用的 `C:\miniconda3\python.exe` 沒有 mcp／anyio，未用不同依賴環境冒充通過，未安裝／修復 runtime。此 blocker 不影響標準庫 contract/resource checks 與 Node tests，但不能宣稱 Python adapter unit suite 通過。

根目錄 `git diff --check -- OMI_search` 通過；本輪四個文字檔另做 strict UTF-8 讀回與 trailing whitespace／replacement-character 檢查（包含 untracked WIP 檔）。

## 視覺驗收限制

~~~powershell
node scripts/check-workspace-browser.mjs 'C:\Program Files\Google\Chrome\Application\chrome.exe'
~~~

離線 fixture 已補結構化 RSI/MACD/KD 與摘要不溢出斷言，但本輪第一個 1440px 啟動發生 `spawnSync ... ETIMEDOUT`（20 秒界限），無 DOM PASS／screenshot；1150/650/390px 未執行。未重試或處理無關瀏覽器程序。

現有 flex-wrap 保留，沒有新增 J9 或改 CSS。Node SSR 與 mock height regression 通過不等同 browser／ChatGPT iframe 實測。Source、build、resource parity 已有證據；視覺與連接器 monthly acceptance 仍未通過。
