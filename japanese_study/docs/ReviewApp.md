# 日文複習室

`study_open_review({ kind?: "vocab" | "grammar" })` 開啟 ChatGPT MCP App，
resource URI 為 `ui://japanese-study/review-v1.html`。原有工具與本機管理工作台保留。

## 操作

- 單字／文法庫提供搜尋、JLPT、熟悉度篩選，每頁 50 筆，可前後換頁或輸入頁碼。
  清單先顯示摘要及資格狀態。可見列會批次讀取詳情，自動顯示例句及翻譯。
  單字的意思只顯示一次，文法的接續、用法、語感與比較放在「展開用法」。精簡速覽縮小列距。
  「遮住意思」同時遮住完整意思、用法與例句。
- Hub 以穩定的 `item_id` 保存最近閱讀位置，同時保留篩選、排序版本和鄰近項目。
  與首屏摘要一起讀回，開啟時會提示已接續。可從頭閱讀。標記可能讓項目離開目前篩選，此時將焦點移到鄰近項目。
- 翻卡提供獨立的「等級」及「熟練度」多選，預設全部。全選不限制該維度，未選就沒有題目。
  `N4-5` 使用原值，非列出的等級歸為「未分類」。熟練度由 Hub 人工標記決定。
  設定在翻卡時持續顯示。Hub 按教材類型保存偏好，變更套用於下一輪。
  每次按「開始翻卡」都會洗牌整個合格集合並建立新一輪，每張卡在該輪出現一次。
  暫停與略過並排在卡片下方。暫停後可依目前設定開始新一輪，已完成的評分仍會保留。
  顯示答案後，讀音、中文意思和有資料的詞性置中，用法與例句直接顯示在評分前。
- 清單底部的「用目前條件隨機翻卡」帶入清單的等級與熟練度。文字搜尋保留給教材清單。
- Again、Hard、Good、Easy 分別保存 `again`、`hard`、`correct`、`easy`。
  顯示答案與略過不寫入 attempt，略過只保存目前佇列的位置。這是學習者自評。

## 責任與寫入

Hub 的 `review_content` 判定資格並提供內容投影。缺少 canonical 中文意思、待審、暫停與
退役維持既有資格規則。Hub health 提供 `review-content-v1`、`manual-label-filter-v1`、
`review-workspace-v1` 與新版所需的 `review-workspace-v2`。舊 Hub 會收到正式開啟工具的版本提示。

人工熟悉度與答題證據分開保存。App 送出 `preserveNotes`，Hub 在同一寫入交易內保留既有
`manual_note`。正常儲存使用已確認的摘要回應局部更新，結果未知時先按原 item id 讀回。
舊版 MCP 呼叫仍可依原有參數設定筆記。

評分、SRS 投影與卡片位置在同一交易更新，事件 ID 由 session id 及位置組成。重試使用相同
payload，結果未知時先讀回該輪的提交收據。Host widget state 保存尚待核對的 payload 與介面偏好，
Hub 則保存已確認的位置供精確讀回。重開時先處理待確認的寫入，再開始新一輪。既有單題 attempt 工具及其 `eventId` 契約可繼續使用。

新的翻卡 attempt 帶 `srs_policy=four-grade-v1`，以現有 `sm2-v1` 投影寫入與重播。
首次評分的間隔分別為 1、1.5、2、3 天，之後按評分、目前間隔與 ease 更新。歷史事件重播
沿用原規則，`seen` 仍可讀。Hard 是吃力但成功的回想，會單獨統計。此版採日尺度排程。

## Host、資源與建置

使用標準 MCP Apps `ui/initialize`、`tools/call`、host-context / tool-result 通知及
`ui/request-display-mode`。僅初始化失敗時選用 `window.openai` 相容介面；
寫入逾時不會切換 transport 重送。
只有開啟工具掛載畫面，新增的工作區工具使用 app visibility，避免每次操作重新掛載。
視覺跟隨 Host 的亮／暗色；支援 fullscreen 時提供「展開」。

HTML、CSS、JavaScript 全部隨 resource 內嵌；沒有 CDN、字型下載或瀏覽器直連 Hub。
CSP 的 connect / resource domains 都為空。工具回傳的文字以 textContent 或跳脫後
HTML 顯示，不能執行教材內的 HTML。

`npm run build` 編譯 TypeScript 並複製固定四個 UI 資產到 `dist/src/ui`。
source updater 的隔離 staging 也執行相同複製。buildId 涵蓋原本四個核心 JS、
`review-ui.js` 與四個 UI 資產；runtime owner 和 tray 使用相同順序計算。
未增加 production dependency。

## 隔離驗證

```powershell
npm test
npm run smoke:http
powershell -NoProfile -ExecutionPolicy Bypass -File tests/test-runtime-control.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/test-review-build.ps1
python tests/review-browser.py --hub-root C:/project/japanese-study-hub --output docs/agent-runs/review-app-local/browser
```

驗證期間可把 MCP source 和 tests 複製到暫存 checkout，再使用既有依賴建置，
保留正式 runtime 的 `dist` 與程序。瀏覽器腳本需要既有 Python 的 Hub dependencies、Playwright 與 Chromium。
它只建立 temporary SQLite 合成教材、臨時 loopback Hub/MCP 與測試 Host，
不讀正式 DB、環境檔或學習素材。驗證分頁、XSS、顏色範圍、筆記保留、亂序搜尋、
翻面／略過、每次建立新輪次、遺失回應重試、重開後精確讀回，以及桌機與手機的設定與答案版面。
產物不得納入公開 Git。

## 正式採用

本機隔離驗證不等於 ChatGPT Host 已載入。正式採用需先透過既有 component owner
載入 Hub source，再更新 MCP；不另開一套正式服務或改資料位置。
Hub health 必須具有上列 capability，schema 為 12，MCP health 必須為 `1.3.0` /
`learning-content-v8.1` / `toolCount=37` 且符合此次 artifact buildId。
之後更新 ChatGPT connector 的工具與 resource discovery，執行 `study_open_review`。
需在正式 Host 確認 CSP、fullscreen、theme、按鈕寫入權限與讀回；
不可僅憑 npm build 成功宣稱已完成正式採用。


## 回滾

若需撤回本次 Source，使用任務開始前的逐檔快照，只還原本次變更的檔案；有後續編輯時先合併差異。
正式採用後若需要退回介面，可透過既有 component owner 回滾 MCP artifact，保留支援 schema 12 的
Hub 及已記錄的書籤、attempt 與排程。較舊 Hub 啟動會拒絕較新的 DB schema。確認資料保全之前
不得用遷移前備份覆寫目前資料庫。
