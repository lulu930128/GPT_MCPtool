# Taiwan Workspace M2：手動委託 UI 純模擬

本輪是 **source-only／frontend-only presentation prototype**。新版 Workspace 右欄可切換研究／手動委託，提供選股 → 填寫 → 預覽 → 人工確認 → 固定 fixture 回報。所有委託操作均標示 `SYNTHETIC / simulated / no broker`，只存在本機記憶體。這不是 authenticated app dry-run、正式交易預覽、M1 後端結果或 OAuth。

## 與規範的相容性

`OMI_search/AGENTS.md` 的「不得加入 execution/trading」仍適用。本輪使用者只授權 UI fixture 演練，沒有增加 execution transport、public/app-only action、`allow_write`、broker SDK、login/session、網路寫入或 DB；不需要修改 AGENTS。17 tools／2 resources、`omi.decision.v4`、bridge、市場唯讀流程與 adapter public contract 不變。

`SyntheticOrderPanel` 的唯一輸入是 symbol，沒有 bridge、quote、portfolio、account 或 callback 注入點。`synthetic-ticket.ts` 無 import、IO、持久化或外部事件入口。它只處理表單、過期提示與固定 storyboard 的顯示位置，並非第二套交易 domain。研究 pane 的 cache-only tools/call 與 polling 仍按既有流程運作；演練操作本身不呼叫任何 tool 或 HTTP。切換選股仍會觸發原本的唯讀圖表／研究載入。

未修改舊 `App.tsx` disabled OrderShell；它不是券商介面。未更動 OMI backend、M1 `execution/` 或 PAOS KGI read-only。既有 dirty WIP 保留。

## 使用與假資料

- 右欄由 280px 加寬為 360px；小於 1150px 移至下排。研究與委託皆在原生可收合區塊內，手機亦可收合。
- 選股只帶入 symbol；不預填方向、交易單位、委託類型、價格或股數。切換標的重建元件，即使當時在研究分頁也會清空舊票據。
- 假標的 catalog：2330、2317（TWSE 現股）、0050（TWSE ETF）、6488（TPEX 現股）。名稱／venue／asset 是固定 fixture identity，不是本輪已驗證市場 snapshot；其他 symbol 顯示 fixture unavailable，不猜規則。
- 假參考價 100 TWD（不帶入價格）、假可用額度 1,000,000 TWD、假可賣 10,000 股、買進假費用預留 20 TWD。假價格 1–200、tick 0.01、BOARD 1,000 股倍數、ODD 1–999 股、quantity 上限 10,000 股。所有標的共用這些刻意簡化的假數字；不是交易所 tick 表、正式稅費或真實額度。
- 僅 TW 現股／ETF、BUY/SELL、CASH / LIMIT / DAY、TWD / PER_SHARE。不提供融資、融券、short、市價、期貨、其他市場或自動交易。
- 使用整數分計算 UI 估計，拒絕空白、負數、非整數股數、NaN／Infinity／指數字串、多餘小數與不符合 fixture 的 lot／額度。這是 fixture 表單驗證，不能代替 M1 assess 或未來真實 market/account/permission owner。
- 按「產生模擬預覽」後須人工核對並勾選模擬聲明，再按「明確確認本次模擬」。任何欄位（含回報情境）變更都清除 preview 與勾選。預覽 60 秒到期；確認 handler 重新檢查期限，即使背景 timer 暫停也不接受過期點擊。
- 確認只顯示一次 `SIMULATED_PENDING`、attempts=1；重複點擊不建立第二次模擬。之後每筆 fixture 回報都須手動播放，沒有自動排程。清空後可重新演練，不宣稱跨演練現金／持倉預留。
- reload、離頁／bfcache 恢復會清空記憶體；無 localStorage、sessionStorage、IndexedDB 或恢復機制。清空或編輯亦會丟棄舊展示結果，沒有持久審計。

## M1 語意對照與刻意未實作部分

Canonical source 是 OMI `execution/contracts.py`、`execution/state_machine.py` 與 `docs/architecture/ManualTradingExecutionV1.md`，本輪僅讀取對照，沒有 Python import 或轉譯。本機 checkout 為 `C:\project\Open Market Intelligence`。

| M1 語意 | UI 展示 | 不可宣稱 |
| --- | --- | --- |
| Instrument / Draft | 明確選 BUY/SELL、BOARD/ODD、LIMIT，單位為股 | 真實 instrument admission 或可送單 |
| Assessment / Preview | 固定 fixture 驗證、估計、60 秒展示期限 | backend preflight、可信 evidence、正式 tick／費用 |
| Confirmation | 本機 preview 序號綁定勾選和明確點擊；變更／過期失效 | principal/account auth、digest/HMAC、nonce、2FA 或安全授權 |
| 首次確認 | SIMULATED_PENDING，attempts=1 | 券商接受／送出／成交 |
| 固定回報 | ACCEPTED → PARTIALLY_FILLED → FILLED；另有 REJECTED | 任意事件處理、完整 M1 reducer 或 broker callback |
| 未確認取消 | SIMULATED_CANCELLED，attempts=0 | 正式券商撤單 |
| 確認後取消 | CANCEL_PENDING → 手動播放 CANCELLED；保留部分成交 | 取消意圖等於成功；真實剩餘額度釋放 |
| timeout／空／錯誤 | UNKNOWN，不自動重試；選定情境可人工播放 RECONCILING 與固定結果 | 查無結果等於沒送達，或自行恢復真實訂單 |
| UNKNOWN 取消 | 保持 UNKNOWN，之後人工播放 RECONCILING 和取消 fixture | 立即取消成功 |
| 重複確認 | 本機 receipt 不增加 attempts；過期後重播 receipt 仍不重送 | durable idempotency、重啟去重或 exactly-once |

UI 不支援任意 report 注入、晚到／矛盾事件、event ID／sequence conflict、跨 worker race、canonical digest、challenge token、完整 evidence 或審計 ledger。這些語意仍由 M1 domain 擁有。UI 固定 storyboard 的 scope 不應外推成正式 state machine parity。將來正式結果應由 single execution owner 交付，不可把此檔接上 broker。

## 後續 gates 全部 BLOCKED

| Gate | 本輪不具備的證據 |
| --- | --- |
| 真實預覽 | trusted market/account/permission snapshots、owner provenance、有效期限、撤權與額度預留 |
| M2 authenticated app-only actions | server principal/account binding、session/auth expiry、origin/CSRF、權限／限額；不得新增 public MCP action |
| 正式 confirmation | durable nonce、digest 綁定、server atomic consume、expiry/replay/revocation、step-up auth／2FA |
| single execution owner | 獨立 command owner／worker／broker session、lease/fencing；不得借用 PAOS 或 OMI quote/account session |
| durable idempotency | transaction、唯一鍵／CAS、outbox、journal、crash recovery、重啟去重、可追蹤對帳 |
| M3 broker sandbox | 另行授權、隔離登入／session、send/query/reconcile/cancel、timeout／callback ordering、kill switch 與復原驗收 |
| Runtime／Live／Product | 未部署、未重啟、未掛載 host 驗收，更沒有真實交易授權 |

source 通過不解除上述 gates。本輪不需要且沒有執行 runtime restart、Refresh Actions、正式登入、市場 refresh、commit 或 push。

## 驗證

證據與精確命令見 [本輪 Progress](agent-runs/taiwan-workspace-m2/Progress.md)。Node tests 包含原 M0 tests、純表單／storyboard 測試、SSR、import/IO 邊界與實際 React handler 的 controlled-effects 測試。後者不是 browser acceptance。

離線 browser harness：`node scripts/check-synthetic-order-browser.mjs <installed Chromium executable>`。它建立 repo-local `.tmp` fixture 和獨立 profile，`file://` 開啟；CSP 封鎖 connect/form action，tripwires 阻止 fetch/XHR/WebSocket/postMessage/storage。沒有 server、host 或 provider。2026-10-09 Chrome 嘗試在 1440px 啟動／取 DOM 階段 25 秒 ETIMEDOUT；沒有 DOM PASS 或可驗收 screenshot，390px 尚未執行。browser／視覺／手機實際操作與 ChatGPT host 仍 **unverified**；未重試或修復環境。
