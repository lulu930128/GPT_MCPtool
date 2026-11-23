# 券商委託：嚴格當日清單

延續 `UX-2026-11-16.md`，本次要求取代該文的「跨日／歷史委託仍在券商頁」呈現，以及「本地卡優先、券商卡收合」安排。深色卡片、名稱查詢與原位操作延用；沒有修改 CSS、Raw、Identity、Lifecycle、Cancellation Owner 或 Backend。

## 根因與呈現

原 `brokerOrderViews.history` 同時代表已結案和非當日；用 `!history` 會漏掉今日已撤／已成交。`mainStages` 又讓歷史 UNKNOWN 及 focus 強制進入首屏，剩餘歷史仍藏在同頁折疊區。

`DeskOrders` 的 `orders` 頁改以 `todayOrderPresentation` 統一兩套已送紀錄：

- 唯一今日基準為已讀回的 `data.trade_date`。本地 submission 的 draft／receipt execution／正式 linked identity 必須給出一致的有效交易日；券商卡使用 `broker_key.trade_date`。不使用選股日期、瀏覽器時鐘或 `recorded_at`。
- 嚴格相等才進今日清單，不依狀態／focus／highlight／UNKNOWN 例外。今日 ACCEPTED、PARTIALLY_FILLED、FILLED、CANCELLED、REJECTED 均保留；過去與未來不渲染卡片或隱藏的歷史內容。來源資料不刪除、不改寫。
- 本地與券商合成一個時間排序：精確 Native review `created_at`，或本地 receipt `created_at`／`confirmed_at`；缺少時才用券商 facts 首次 ACCEPTED `source_at`。不取最後更新、讀回或撤單 ACK 時間。沒有可靠建立時間則標明並排在最後，同時間以穩定 identity 排序。
- 同筆經 execution／account／trade_date／broker_order_id／symbol 精確唯一關聯後只顯示券商卡；原本本地來源及讀回留在收合入口。不同 3702 委託不合併。
- 日期未知／衝突只在今日清單外的「委託日期未確認」提示，可讀回原紀錄。無法確認 Backend 交易日則不產生今日清單；讀取失敗保留上次回覆並標記可能過期。
- 原 BrokerOrderControls、read-before-cancel 和共享 latch 完全保留；美股原詳情控制仍可用。本地待送草稿不按日過濾，成交／庫存邏輯不變。

## 修改範圍

正式程式：`src/DeskOrders.tsx`、`src/order-presentation.ts`。

驗證：新增 `src/today-orders.test.ts`、`scripts/today-orders-fixture.ts`、`scripts/today-orders-browser-fixture.tsx`；更新既有 runner 與 broker／crossday／desk／trade-ux browser fixtures，替換已結案移至歷史的舊預期，繼續實測原互動。

開始時 25 個既有 WIP 檔案保存於 `.tmp/today-baseline`；其中 19 個未涉及的檔案保持 SHA256 相同，包含 `server.py`、broker-orders／desk-contract／OrderProtection、stock-name、CSS、中波段研究相關修復。原本乾淨的 broker browser fixture 另有本次必要修改。未 commit／push。

## 驗證

在 `ui/tw-market-dashboard` 執行：

- `npm test`：432 tests，431 PASS、0 FAIL、1 個既有 ASGI skip。
- `npm run typecheck`：PASS。
- `npm run build -- --output-dir .tmp/today-build`：PASS，714620 bytes。
- `node scripts/check-desk-orders-browser.mjs "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" .tmp/today-final today`：375／390／650／1280px PASS。具體 11/16 fixture：11/13 1802 82.8、11/02 2409 32.5、11/09 2330／8227 在整個券商頁 DOM 皆不存在；10:09 建立的 3702 83.1／1000 ACCEPTED 排在 09:11 的 82.5／800 CANCELLED 前，剩餘分別 1000／0。focus 無法突破日期，跨日台美草稿保留，日期未知及本地來源可展開讀回，零送／撤／改／刪呼叫。
- 同 runner 的 `broker`／`crossday`／`ux` 四寬度 PASS：原位控制、精確身份、成交競態零撤單、NOT_SENT 明確重試、UNKNOWN latch／remount／讀回、停損停利、名稱與可觸控按鈕。
- 既有預設 presentation／interaction／submission 共 12 組 PASS：本地 CRUD、503、單一 modal、revision／digest、UNKNOWN 不重送。
- `git diff --check -- OMI_search`：PASS，僅既有 CRLF 提示。

所有互動 fixture 皆是隔離合成資料，沒有連 Backend／Native 或真實券商。已檢視 375px 與 650px 截圖；四寬度 DOM 驗證無橫向溢出。結果位於 `.tmp/today-final`、`.tmp/today-regression`，主截圖是 `.tmp/today-final/desk-orders-yTuxGn/today-{375,390,650,1280}.png`。這些是本機驗收資料，不進 Git。

## 正式發布證據

發布版本 `omi-20261116-today-orders-01`，Source digest `c0d394d840ccedabe329c74dec8c2c71b7bf78e29815535518367e2c70c9d9df`。依既有 CC component update 契約執行 source build／widget publish／MCP adapter reload；不呼叫 Backend／Native 更新或重啟。

CC receipt、loaded build、actual MCP v4 resource hash 與隔離產物 byte parity 存於 `.tmp/today-final/deployment.json`。正式 Host／使用者瀏覽器渲染為 UNVERIFIED；離線 Browser fixture 與 loaded runtime 證據分開，不以 build PASS 代替 Host 驗收。

正式採用結果（2026-11-16 11:01 台北）：

- Request ID：`30b1cb21-b5c2-476e-8b42-a80529eb1a82`；終態 `ACCEPTED / UPDATE_ACCEPTED`，`ready=true`。
- CC prepared／observed 及 `/health` loaded build：`dcfc8e657f64aba8`，三者相同。服務版本保持 `1.2.0`；此次以 immutable versionId 與 buildId 識別。
- 正式 widget SHA256：`a2e20ffe24beba9359cd9b68caaa579f979ccadaae1e015cff7120743be6b56b`，714620 bytes，與隔離 build 完全相同。
- 實際 `resources/read` 的 `ui://omi/tw-workspace/v4.html` SHA256：`e8ba78dbb8b60bc401ec6fa82b0451c83b230c8d4b4194fa15f8b165d2887f09`，714646 bytes；與隔離 build 加上既有 workspace 標記完全相同。
- CC wrapper 的 `ownerVerified=false` 原樣保留，不宣稱 owner 硬驗證。`Host rendering=UNVERIFIED`。
- 沒有真實 send／cancel／amend，沒有改寫券商／Backend 狀態，沒有更新或重啟 Backend／Native。
