# Japanese Study Review App — UX、複習流程與效能改版計畫

> 日期：2026-11-18  
> 狀態：**審查與計畫完成／尚未開始實作**  
> 類型：工程修復規格（可交付 Codex）  
> 適用元件：Japanese Study Hub + Japanese Study MCP App  
> 原則：**僅處理前端體驗、學習位置、翻卡抽題、SRS 評分及資料載入效能；教材內容由使用者另案處理。**

## 0. 不可縮減的最終目標

使用者能在單字／文法庫中連續閱讀、調整熟悉度而**不失去目前位置**；可按每頁 50 筆瀏覽並在下次開啟時**回到最後讀到的單字／文法**；翻卡模式一次僅需專注一題、從完整合格題庫產生合理不重複的複習順序、以 **Again／Hard／Good／Easy 四階段**評分，且閱讀、換題與保存回饋不再因多餘的序列呼叫明顯拖慢操作。分類／篩選、既有有效學習紀錄與正式寫入保證必須維持。

**本次交付範圍：只建立本 MD 計畫。不得修改 Source、DB、教材、正式 Runtime、排程或部署。**

## 1. 範圍與明確排除

### 納入
1. 熟悉度更新後清單跳回頂部、焦點遺失、無差異地重畫整張清單。
2. 將目前「50 筆增量載入、最多顯示 200 筆後換段」改成**明確 50 筆分頁**，含上一頁、下一頁、頁數與查詢結果數。
3. 記錄並恢復學習位置；優先用 `item_id` 作穩定錨點，而非只記頁碼或捲動像素。
4. 翻卡抽題公平性、跨輪次／重新開啟後的進度連續性、避免總是回到清單前段。
5. 單題式連續翻卡、四階段回饋、原 Hub SRS 語意及必要相容處理。
6. 清單 Payload、到期卡片取得、寫入讀回與前端重新渲染的效能優化。
7. 對應自動化測試及正式 ChatGPT Host 驗收。

### 明確排除（使用者另案處理）
- 文法、單字中文翻譯；例句翻譯；語感、接續、解說內容的編寫或補齊。
- 對尚未審核之 `meaning_tc_proposal` 的大量核准、合併、寫入 canonical。
- 教材匯入、來源更新、來源品質整理、學習資料清洗或任意更動複習資格規則。
- 新增平行資料庫、學習平台或獨立 Scheduler。
- 未授權的正式環境資料寫入、服務重啟及部署。

**接口注意：** `review_content.eligible` 仍以 Hub 的既有 canonical 與 review status 為準；本案不能以「前端想抽到更多題目」為由放寬缺譯、未審、暫停或退役題目的排除邏輯。缺教材造成的題量不足，應回報為另案依賴，而不是偷偷改變資格。

## 2. 已知程式與系統基準

### 2.1 正式 Owner 與路徑

- MCP App：`C:\GPT_MCPtool\japanese_study`
  - `src/ui/review.js`：閱讀清單、翻卡、分頁、Widget 狀態、寫入與讀回。
  - `src/ui/review.html`、`src/ui/review.css`：清單與單卡 UI、捲動容器和狀態呈現。
  - `src/ui/bridge.js`：MCP Apps / Host transport，`call()`、`saveState()`。
  - `src/server.ts`、`src/api-client.ts`：MCP 工具契約與 Hub API 呼叫。
  - `tests/review-browser.py` 及既有 Node tests：UI 與 adapter 回歸測試。
- Canonical Hub：`C:\project\japanese-study-hub`
  - `src/japanese_study_hub/api.py`：versioned HTTP API。
  - `src/japanese_study_hub/repository.py`：查詢、篩選、人工熟悉度、attempt 讀寫。
  - `src/japanese_study_hub/review_content.py`：複習內容投影／eligibility（原契約保留）。
  - `src/japanese_study_hub/srs.py`：`sm2-v1` 排程與 attempt quality。
  - `tests/`：既有 API、Repository、SRS 測試。
- 既有設計與驗證：`japanese_study/docs/ReviewApp.md`、`docs/agent-runs/review-app-20261116/Progress.md`。

### 2.2 查核狀態（2026-11-18，唯讀）

- MCP health HTTP 200：version `1.3.0`、contract `learning-content-v8.1`、toolCount `35`、buildId `05651d6c7d65518c`。
- Hub health HTTP 200：version `0.6.1`、schema `9`、`review-content-v1`／`manual-label-filter-v1`。
- Control Center 觀察到 japanese_study `Ready`；僅證明本機可連通／其觀察狀態，**不證明正式 ChatGPT 端互動 UX 已通過驗收**。
- MCP repo 在開始本計畫前已有大量已修改／未追蹤檔案，包含本次涉及的 UI 原始碼；**不可把前輪工作視為已提交乾淨基線，也不得順手 stage 或 commit 既有 WIP**。
- 尚未對正式 Host 執行完整「第 20 頁修改熟悉度／恢復書籤／長輪次抽題」端到端重現；本文件根因以直接 Source 路徑與使用者觀察共同定位。

## 3. 問題清單、證據與優先級

| ID | 判定 | 等級 | 原始症狀 / 直接證據 | 正式完成條件 |
|---|---|---|---|---|
| UX-01 | Confirmed Defect（Source 路徑） | P1 | `renderRows()` 重建 `tbody.innerHTML`；`runPending()` 寫入後無條件 `renderRows()`，篩選中另外 `loadRows()`，會將 `scrollTop=0`。 | 修改任意位置熟悉度不跳回第一筆，不錯置選擇與焦點。 |
| UX-02 | Confirmed Defect（Source 缺口） | P1 | `save()` 保存了 kind/query/level/label/density 等，沒有 page/scroll/item anchor；`boot()` 不還原閱讀位置。 | 不只可記住第 20 頁，還能回到最後閱讀的實際 `item_id`。 |
| UX-03 | 設計缺陷 | P2 | 查詢 `limit=50`，捲動自動增載，最多 200 筆才進下一段；沒有清楚頁碼與跳頁。 | 明確 50 筆一頁、有頁數與導覽，不必無限向下尋找。 |
| QUIZ-01 | Confirmed Defect（選題覆蓋） | P1 | Hub 按 `jlpt_level,title,item_id` 排序；`startRound()` 依序收集前 20 個 eligible，掃描 cursor 只存在 frame 記憶體；到期模式只看首 100 筆且逐筆讀 detail。 | 自由練習涵蓋完整合格題庫、避免近期重複；重新開啟不總是回到前段。 |
| QUIZ-02 | 設計差異 | P2 | 前端只有 `again/correct/easy`；Hub SRS 原有 `seen` quality 3，但不等於明確的 Hard 學習語意。 | 明確四階段、合法儲存且後續排程／紀錄符合新語意。 |
| QUIZ-03 | 體驗問題 | P2 | 畫面本身一張卡，但先整輪讀最多 20 張、結束需按下一輪；這是批次準備而非真正連續複習。 | 顯示與互動一次一題，使用者可連續做題、暫停、接續。 |
| PERF-01 | 已定位多餘呼叫；瓶頸比例待量測 | P2 | 熟悉度更新含讀前狀態→寫→讀回→可能重新查詢；翻卡評分也寫後讀回並重繪清單。 | API 往返與 DOM 工作量減少，且保留安全讀回與 idempotency。 |
| PERF-02 | 已定位 N+1 讀取；瓶頸比例待量測 | P2 | 到期模式 `study_get_due_reviews(limit=100)` 之後逐筆 `study_get_item` 最多 20 次、序列 await。 | 一次或少量批次拿到可用卡片，不卡在逐筆往返。 |
| PERF-03 | 大 Payload 已觀察；根因占比待量測 | P2 | `study_search_items` 回傳完整項目含長說明／來源／例句；50 筆文法負擔不小。 | 清單先只載入需要的摘要；開細節才拿完整內容。 |

> 等級根據學習路徑是否中斷與功能完成程度判定；不是資安優先級。若正式重現顯示不同原因，須更新本表證據與修法。

## 4. P1：熟悉度更新後的閱讀位置穩定性

### 根因
- `review.js` 約第 49 行：`renderRows()` 使用 `rows.innerHTML = state.rows.map(...).join('')`，每次全部重建。
- 約第 88–110 行：`loadRows()` 置換資料時把內層 `scroll` 的 `scrollTop` 設為 `0`。
- 約第 199–220 行：`runPending()` 寫入成功會讀回單筆後重新渲染；若熟悉度篩選不是 `all` 又重新 `loadRows()`。
- 例如「N3 + 未標記」選了一筆「熟悉」，該筆會離開篩選結果；如果直接回第一頁，原位置與後續項目也會丟失。

### 修改方向
1. 將熟悉度更新處理改為**該列局部更新**，成功回應才更新已確認狀態；不要為一筆標記重建整張表。
2. 保存互動前的視覺錨點（當前 `item_id`、相鄰有效項、容器內相對位置、聚焦控件）；當該筆因篩選條件消失，移到原位置附近下一個仍符合條件的項目。
3. 避免呼叫整頁 `loadRows()`；必要時重新查詢則應恢復合理錨點／頁碼，並明確顯示目前篩選筆數變化。
4. 視覺即時反應、儲存結果、逾時待確認、失敗重試各有不同狀態；**不得失敗後假裝已儲存**。
5. 保留既有 `manual_note` 與 Hub `manual_label` Owner，不以 self-review grade 覆寫人工熟悉度。

### Acceptance
- 第 1 頁、第 20 頁及內層清單中段均可修改 `known/uncertain/unknown`；畫面不回最上面。
- 使用「全部」、「未標記」、「不熟」、「不確定」、「熟悉」篩選均可驗證。
- 目前項目被移出篩選時，繼續閱讀的位置穩定；筆數與所在頁合理。
- 待確認／超時重試後不會重複寫、不中斷原閱讀位置。

## 5. P1：50 筆明確分頁及跨次續讀書籤

### 5.1 UI
- 清單每頁 50 筆（使用者指定的目標），上／下頁、目前頁數、總頁數／總筆數。
- 保留原搜尋、JLPT、熟悉度、單字／文法切換、詳略模式與遮住意思。
- 主要內容只顯示摘要；長文法說明可展開，避免 50 筆完整說明造成高畫面密度。
- 不再依賴向下無限捲動來移動到第 20 頁。
- 明確標示「接續上次學習」及重新從頭的入口，不在無提示情況下跳頁。

### 5.2 進度模型
- 記錄：`kind`、`query`、`jlptLevel`、`manualLabel`、排序版本、`page`、`lastItemId`、頁內相對位置、更新時間。
- **`lastItemId` 才是閱讀定位主鍵；頁碼與像素只是 UI 提示。** 人工標記及未標記清單變動時，原第 20 頁可能已經不是原本項目。
- 恢復：先以相同 filter/order 尋找 `lastItemId`；若不再符合篩選，移到相鄰仍有效項目（要說明「原單字已不在目前篩選中」），不直接失去整個進度。
- 在 UI 當次 frame 保存輕量位置；**跨對話／重開持久保存須評估 Hub 既有能力**，優先在原 Canonical Hub 內加入最小學習書籤契約，避免只依賴 Host 的 `setWidgetState`（部分 Host 可能不支援或不保證跨會話）。
- 不建立獨立 Progress Service/Database；若改 Hub schema，需使用既有 migration 與 repository ownership。

### Acceptance
- 在第 20 頁第 17 筆離開，再開啟時能繼續相同項目，或因篩選變更獲得明確合理的相鄰位置。
- 重新開啟／頁面切換／調整熟悉度後的保存、還原一致；搜尋或主動更換篩選時可明確開始新瀏覽，而非混用舊書籤。
- 不需按上一頁 19 次才能回到之前的位置。
- 有明確無資料、資料已移除、書籤無法讀取的 fallback 表示。

## 6. P1/P2：翻卡抽題與單題連續操作

### 6.1 現行行為
- `startRound()` 在 `review.js` 約第 132 行開始：filtered/weak 依序讀取；前段 eligible 優先。
- `state.cursors` 是 frame 內 `Map`，重新開啟即消失；即使同一次會話下一輪略有推進，也不代表真正隨機。
- `due` 模式取得前 100 筆到期摘要後序列讀取詳情；當前最多形成 20 張卡。
- 三個選項目前是自我回想，不是客觀題組計分；不要混成正式 JLPT 試卷的測驗分數。

### 6.2 建議設計
- 保留「目前清單」、「不熟／不確定」、「今日到期」及日→中／中→日切換。
- **自由練習**：在整個符合 filter 且 eligible 的集合抽題；以明確 seed／穩定 ID／最近已見歷史避免每次取第一段，並對重開或續接保有一致性。必要時引入 Hub 一次產生的 session queue／cursor，但應先檢查現有 API 可否組合完成。
- **今日到期**：到期優先且對全部待複習集合負責，不只取首 100 筆。若內部分批，批次上限只能影響單次請求，**不得代表整體任務已處理完畢**；可逐批接續直到做完或使用者結束。
- 顯示層**一次一題**；預取接下來有限量內容作為 IO 優化，但不再要求每完成 20 題就人工開下一輪。
- 提供「暫停／接續」、進度與本次已複習統計；已評分與尚未提交狀態明確區分。
- 不強制更動 `review_content.eligible`；缺乏有效教材要顯示可用數量不足與原因。

### Acceptance
- 在大量合格單字／文法的測試 DB 中連續多輪／重開後，不再只反覆前 20／100 筆；可重現完整合格集合覆蓋。
- 篩選分類正確；停用／缺譯／未審項目仍不當作可自評卡。
- 首張顯示正常、下一張接續正常、重新開啟有明確續接方式；略過不會誤寫 attempt。

## 7. P2：四階段 SRS 評分

### 7.1 既有契約
- UI 選項：`again`（沒想起來）、`correct`（想起來了）、`easy`（很熟）。
- Hub `srs.py` 的 `ATTEMPT_QUALITY`：`again=0`、`wrong=1`、`seen=3`、`correct=4`、`easy=5`。
- 現行 `sm2-v1` 的 quality <3 會將重複次數歸零並將間隔設為一天；不等同 Anki 的完整分鐘級 Learning Steps。
- 單筆 attempt 的 `eventId` 具 idempotency；人工熟悉度標記與 SRS attempt 不可混寫。

### 7.2 修改提案
顯示四個獨立選項：

| UI | 語意 | 後端處理方向 |
|---|---|---|
| Again／重來 | 完全沒想起來 | 保留 `again` |
| Hard／困難 | 勉強想起來或非常吃力 | **新增正式 Hard 語意**；確認 schema、品質映射與排程規則，不直接把 `seen` 假裝等同 Hard |
| Good／正常 | 正常回想成功 | 可沿用 `correct` |
| Easy／簡單 | 輕易想起來 | 保留 `easy` |

- 先確認需求是「四階段回饋與合理間隔」還是「完整 Anki Learning/Relearning 分鐘級排程」。**本計畫先要求四階段正確運作，不擅自宣稱與 Anki 演算法完全相同。**
- 若新增 `hard`，需擴充 Hub `ATTEMPT_RESULTS`、schema/constraint、API/MCP type 與 SRS mapping，同時保留既有 attempt/result 讀取相容性，依現有 migration 流程變更。
- 選擇評分之後立即顯示下一題，必要時在上方顯示已確認儲存狀態，不以未確認回應推進已完成計數。

### Acceptance
- 四個結果都能合法寫入、正確讀回、正確更新 schedule；歷史舊三選項資料可讀。
- 同一 `eventId` 重試不得增加第二次 attempt，也不得使排程重算兩次。
- Hard 的結果統計與後續間隔可驗證，不能只是 UI 增一顆按鈕。

## 8. P2：效能與 Payload 最小化

### 8.1 初始觀察，**不是瀏覽器 Benchmark**
2026-11-18 MCP 唯讀抽樣：
- N3 文法 50 筆：約 2.7 秒、JSON 約 23 萬字元。
- N3 單字 50 筆：約 2.4 秒、JSON 約 8 萬字元。
- 單一完整文法讀回：約 2.5 秒。
- 到期摘要 100 筆：約 2.2 秒、JSON 約 3.6 萬字元。

上述數值混合了 Tool/MCP/Hub 往返成本，**不能直接認定全部延遲都在 Hub SQL 或前端 DOM**。在改版時應分別量測 Hub API、MCP 轉送、Host 工具調用、Browser render 及使用者點擊→可操作時間。

### 8.2 已確認的放大路徑
1. Library 每次 `study_search_items` 返回完整 item／review projection，列清單時多數長文不需要。
2. 手動標記需要事前讀取筆記、write、readback；選定篩選時額外重新搜尋。
3. 每次 `study_record_attempt` 後又 `study_get_item`，接著 `renderRows()`。
4. `due` 先取得簡要排程，再逐筆串行 `study_get_item`，有 N+1 往返。
5. 前端 50/200 的顯示上限屬 UI 設計，不應被誤用為「全部題庫只查 100」的完成邊界。

### 8.3 建議改法
- 優先重用既有 Hub API/repository 與 MCP adapter，將**清單摘要**（id、title、reading、meaning summary、level、manualLabel、review eligibility、版本資訊）與**展開詳情**拆分，避免重複搬運來源 metadata 與長文。
- 對 due deck 增加一次回傳完整可用卡片或以既有批次 API 整併；避免 20 次序列讀取；內部批次並不縮減應複習母集合。
- 標記寫入若正式回應已包含經確認的最新項目，就直接做局部狀態更新；若結果未知，保留原有固定 payload + readback-only 流程，不為減少呼叫犧牲可恢復性。
- 避免每個 attempt 都把 library 重新畫一遍。切換 UI page 不應重新啟動不必要資料請求。
- 啟動時只讀當前 50 筆；必要時對臨近頁與下一張卡預取，但以實測延遲/記憶體與 Host 需求調節，不預設阻止完成的過小硬限額。
- 搜尋結果與篩選的 `total` 需由 Hub 計算，正確反映篩選結果；若新增 query 排序，需確定穩定性與書籤還原契約。

### Acceptance
- 相同資料庫、相同查詢、相同 Host 條件下，紀錄操作前後：P50/P95 延遲、每次動作 MCP/Hub 呼叫數、Response bytes、渲染耗時及錯誤數。
- 載入第一頁、跳頁、修改熟悉度、開始今日到期、連續作答 20 張與重開續接均量測；若效能仍慢，依 Trace 判斷瓶頸，不以純測試 PASS 宣稱改善。
- 正式回應的資料、標記、例句與分頁數量沒有回歸或錯位。

## 9. UI/UX Pro Max Skill 審查原則

以「導航連續性、資訊密度、觸控、回饋、可理解性、效能」為重點：
- 操作焦點與列表位置不能因一次 label 儲存而突然消失；這是 state-preservation / back-stack-integrity 問題。
- 導覽應可預期：清楚的頁碼、結果總數、上一頁／下一頁、恢復前次學習。
- 清單預設摘要，必要資訊以展開揭露；深度學習時單卡成為主要視覺焦點，非大量長文本一齊佔版。
- 儲存中、成功、待確認、失敗重試須區分，操作按鈕禁用時給原因。
- 保留鍵盤操作、aria-label、可見焦點、行動端可觸控的操作區；避免內層多重捲動互相搶焦點。
- 按鈕與狀態的語意高於裝飾性動效。保持目前的亮／暗色設計，不引入與教材無關的大型視覺重做。

## 10. 建議分工與修改邊界

### Phase A — 最先處理閱讀位置與分頁（P1）
- 主要修改：`src/ui/review.js`、`review.html`、`review.css`。
- 若需跨次真正持久位置：以既有 Hub API + repository 對接最小 bookmark 契約；先確認既有可重用能力。
- 驗收：第 20 頁標記不跳頂、再次進入可續讀、搜尋/篩選切換無混亂。

### Phase B — 選題覆蓋與單題連續互動（P1/P2）
- 主要修改：`review.js`、MCP `server.ts/api-client.ts` 與 Hub 選題／due 查詢 Owner。
- 去除固定前段限制造成的永遠重複，改全合格集合的可恢復抽題。沿用原 SRS 的 due ownership。
- 驗收：多輪覆蓋、長單不卡首 20/100、終止與接續、skip 不寫入。

### Phase C — 四階段 SRS（P2）
- 主要修改：`review.html/js`、MCP attempt contract、Hub schemas/database/repository/srs、相關 migration/tests。
- 新增 Hard 明確語意，確定 schedule 與既有歷史相容；不做無需求證據的完整 Anki 模擬。
- 驗收：四種結果均合法，排程可讀回，exact retry 沒有重複 attempt。

### Phase D — 資料精簡與效能（P2）
- 主要修改：Hub list/detail projection、MCP adapter/API、前端 detail 按需載入、due 批次。
- 建立可比較 benchmark，決定哪些層需優化；不以任意節流或小批次妨礙完成。
- 驗收：回傳量與呼叫數改善；真實使用延遲改善；既有查詢與內容完整可用。

> 建議先 A，B/C/D 可視 Owner 依賴關係共同實作；每階段應完整涵蓋受影響的 Hub→MCP→App 正式鏈路。不要為拆階段而引入平行 Writer/Service。

## 11. 回歸與端到端驗收 Gate

| Gate | 執行與觀察 | 能證明 | 不能單獨證明 |
|---|---|---|---|
| G0 Source/contract | 核對 Git diff、Schema/Owner 邊界、現有 WIP | 未越界修改教材、未新增重複 Owner | Runtime 已載入 |
| G1 Local tests | Hub API/repository/SRS tests + MCP `npm test` | 型別、資料規則、排程與單元契約 | ChatGPT 真實 Host 正常 |
| G2 Browser integration | `tests/review-browser.py` 增加第 20 頁、label、恢復、全池抽題、四階段、失聯重試 | 可重現操作邏輯與 Host 模擬 | 正式 Host／資料全量已驗 |
| G3 Build/health | `npm run build`、`npm run smoke:http`、兩端 health 與 artifact buildId | 準備好的 Build 與服務連通 | 正式 Widget UX 無問題 |
| G4 Runtime / ChatGPT | 由既有 component owner 更新後，開 `study_open_review` 操作正式 UI | 實際 Connector/Host 讀寫與恢復可用 | 所有教材內容已補齊 |
| G5 效能 | 同環境前後 P50/P95、bytes、calls、render、可操作時間 | 使用者感受到的瓶頸是否改善 | 沒量到的裝置／網路都正常 |
| G6 整體驗收 | 用大量合格資料從位置保存→多頁標記→重開→自由抽題→四階段寫入→due 讀回完整跑過 | 原始學習目標是否達成 | 教材翻譯另案已完成 |

具體測試應包含：
1. 分頁第 20 頁第 17 筆，標記後仍在附近；關閉 Widget 再開可回原 `item_id`。
2. 在「未標記」修改一筆為「熟悉」後，這筆移出結果但視覺不跳第一頁，筆數與頁碼更新。
3. 所有篩選、N4-5 合併程度、中文查詢、空結果、首末頁與長文法顯示。
4. 對未完成／暫停／退役教材，抽題資格依原 Hub 判定，不能擅自提高總數。
5. 題庫大於 100 且有大量不合格條目：確保選題能跨越前 100 筆、各輪不只抽第一批；到期佇列同理。
6. 四個評分、略過、頁面切換、關閉重開、Host timeout、寫入成功但讀回逾時、重送同 `eventId`。
7. 人工熟悉度與 SRS grading 不混用；既有 manual_note 與舊 attempt 可讀。
8. 與原始版本相比，Browser 實際開啟與下一題回應速度無倒退，呼叫／回應負擔有實際證據。

### 回滾方向
- 沿用 `japanese_study` 現有 component owner、stage / reload / build identity / rollback 能力；不以重啟取代部署。
- UI/MCP 若有新契約需考慮新版 App + 舊 Hub 相容或明確 reject；schema migration 必須能回讀舊紀錄，並有可審核資料遷移計畫。
- 不清理正式學習紀錄；回滾時保留已產生的 manual labels、attempts、bookmark，不以丟失進度換回舊版 UI。
- 若任一 Gate 未通過，只封局部結果，不宣稱整體學習路徑完成。

## 12. 開始實作前的決策點

1. **書籤持久化範圍**：此案要能「下次回來繼續」，建議由 Hub 保存跨 Widget 的 last item；優先沿用既有契約，不應僅依賴不保證跨會話的 Host state。
2. **四階段與 Anki 的對齊深度**：本案先處理四評分與有根據的 SRS 後果；是否精確模擬 Anki 分鐘級 Learning Steps，是另一個需使用者決定的演算法契約，不自行擴大。
3. **抽題策略**：自由模式要整個 eligible pool 的公平／去近期重複；到期模式保留 due priority。兩者不要混成單一 random。
4. **性能基準**：正式延遲來源仍需分層量測；不因一兩次 MCP 觀察就先加入短 Timeout、低併發或硬性掃描上限。
5. **教材依賴**：本案只尊重既有 eligibility，不做 canonical/translation 的內容改動。若文法測驗可用題量少，留在教材專案處理。

## 13. 本次交付聲明

- [x] 依已讀 Source、既有設計文件、正式 MCP 抽樣及 UI/UX Skill 審查整理工程計畫。
- [x] 限定教材內容由使用者另案處理。
- [x] 包含根因、原 Owner、實作方向、效能量測、E2E Gate 和回滾方向。
- [ ] 尚未修改前端或 Hub 原始碼。
- [ ] 尚未做 schema migration、任何學習記錄寫入、部署／重啟。
- [ ] 尚未用正式 ChatGPT Host 驗證修改後效果（修改尚未開始）。

**封版狀態：目前不建議封版。待進入實作後逐 Gate 驗收，最終以使用者可連續學習並可靠續接為準。**
