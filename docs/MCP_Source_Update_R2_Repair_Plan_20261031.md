# MCP Source Update R2 — 修復計畫與問題紀錄

- 文件日期：2026-10-31（Asia/Taipei）
- 專案：C:\GPT_MCPtool（九個 Source Update 目標）
- 文件狀態：PLAN_ONLY／待後續授權實作
- 本輪授權：唯讀盤點、整理 Defect、寫入本 Markdown；**禁止改程式、建立 Codex Job、Build、換版、重啟、清理歷史資料或中斷既有工作**。
- 本文件用途：下次接續的單一工程工作包與 Reviewer 驗收依據。此文件不代表測試或正式部署已完成。

## 0. 最終目標與不做的事

目標：指定 Source 經正式 update_from_source 管道完成建置、採用與載入驗證；失敗時能使用**原始 Request ID／Operation ID**辨認最後實際運作的版本，成功則 ACCEPTED，確認未採用／已回復則可結案，只有結果確實無法判斷時才保留 RECOVERY_REQUIRED。**一次失敗不應使後續換版永久不可用。**

不做：重寫 Control Center、建立平行 Updater／資料庫／Manager、替換既有 Owner、擅自調整 MCP 權限、清空 lock/receipt、發出新 ID 規避原操作、修改 OMI 市場 DB、PAOS 正式財務 DB、更新無關 MCP 業務功能或干擾現存 Codex Job。完整資料備份不應成為一般 Code-only 更新的附帶步驟。

### 三種不同的驗證事實

1. Source 可觀測：更新描述檔與 Digest 回傳 SOURCE_OBSERVED；**不代表已 Build 或 Deploy**。
2. 更新收據：PREPARED/SELECTED/ACCEPTED 等流程證據；**不能直接代替正式 Runtime Identity**。
3. Runtime：Owner、PID/啟動時間、已載入 Build ID、Ready/Health、必要的 MCP/API 回應；**不以 Reload 指令成功推論新版已載入**。

## 1. 目前基線（2026-10-31 的唯讀查詢）

- 九個 Source Update 目標都回傳 SOURCE_OBSERVED：mcp_control_center、codex_bridge、project_reading、omi_search、japanese_study、english_study、listening_audio、memory_core、personal_asset_os。
- 四個主要目標 CC、Bridge、Workspace、OMI Search 有最近 ACCEPTED 收據，當時的 Source Digest 與收據所記錄 Digest 一致；Workspace/Bridge/OMI 有對應 Runtime Build 觀測。
- 已觀察七個 MCP 的 Ready 狀態；這是 Control Center 局部觀測，不等於九個更新目標的 E2E 已通過。
- 最近查詢 Codex Bridge 有至少五個 running 工作；**現階段不可因修此問題而換版、停止、取消或重啟 Bridge**。下次使用前重新讀真實工作狀態，不把此快照視為永久。
- Git main 的 mcp_tools workspace 當時有 98 個未提交變更（其中 31 個 untracked）。OMI 的 update 描述檔／更新腳本／Launcher transport 等部分正式來源仍未納入追蹤。禁止為本任務批次 stage 其他工作的 WIP。
- CC Source Update 主收據約 13 筆、Reload 收據約 18 筆、OMI Source Update 操作目錄 3 個；**目前未達 256 容量限制**。
- 本輪未執行正式更新故障注入、完整測試套件或部署。以下缺陷按已證實的程式分支／歷史操作和條件式風險分類。

## 2. 正式 Ownership 與更新路徑（不可新增平行實作）

ChatGPT Workspace Update MCP
→ mcp_control_center IPC (v2 update_status / preview / update / receipt)
→ CC 持久化 Request ID 與派送
→ 依 componentId 交給獨立 Owner：

| Owner | 目標 | 正式入口／主要來源 |
| --- | --- | --- |
| Independent Bootstrap | mcp_control_center | mcp_control_center/scripts/runtime-bootstrap.ps1；Runtime/versions + current.json |
| DailyCode | codex_bridge | codex_bridge/scripts/daily-code-update.ps1；mcp_control_center/src/McpControlCenter.DailyCode.psm1 |
| Dedicated OMI Updater | omi_search | OMI_search/scripts/update-from-source.ps1 |
| Shared Node Source Update | project_reading、japanese_study、english_study、listening_audio、memory_core、personal_asset_os | project_reading/scripts/node-source-update.ps1 + 各 component scripts/update-from-source.ps1 |

共用 Build／子程序工具：project_reading/scripts/component-update-common.ps1。
派送／佇列／收據 Owner：mcp_control_center/src/McpControlCenter.WorkspaceUpdate.psm1、mcp_control_center/src/WorkspaceLocal.Native.cs、mcp_control_center/scripts/tray.ps1。

不把 CC Source、CC Installed Release、Bridge Runtime、Git HEAD 混成同一版本。**修改 CC 的更新模組後必須先確認新版 CC 已真正被選用並載入，再驗證 Bridge 更新入口使用的是新版 Owner。**

## 3. Defect 與風險清單（按修復優先級）

### R2-01 [P1 / Architecture Risk] Shared Node：Reload 之後的失敗恢復無法完成舊版結案

- 受影響六目標：Workspace、日文、英文、聽力、Memory Core、PAOS。
- 程式證據：project_reading/scripts/node-source-update.ps1:158-200、243-257。
- 原因：reload-requested.json 存在後 Recover 只接受原候選新版的 Loaded Identity；如果目前是已確認正常的舊版，無法回傳已回退／未套用的終止結果。下一次 Update 因前一筆沒有 terminal.json 而被 UPDATE_PRIOR_OPERATION_RECOVERY_REQUIRED 拒絕。
- 現狀：錯誤路徑已在原始碼與 Fixture 顯示；**未實際證明正式六個元件均發生此故障**。
- 修改：只擴充共用 Recover 的觀測與終止狀態；若舊版本（原 artifact pin、原 loaded Build／Owner）確定可用，輸出 ROLLED_BACK 或 NOT_APPLIED/REJECTED 的確切終止證據。無法判斷已送出 Reload 是否生效時仍維持 RECOVERY_REQUIRED，不重送 Reload。
- 附帶：Memory Core 採 PrepareOnly，沒有舊版編譯產物的完整原子回滾保證；不能虛構舊碼已回退，須以實際 Loaded Identity 辨認結果。

### R2-02 [P1 / Architecture Risk] OMI Search：同類型 Recover 結案缺口，但走獨立路徑

- 程式證據：OMI_search/scripts/update-from-source.ps1:127-169、216-224。
- 原因：Reload dispatch 之後的恢復只比對新 Widget、新 Source 快照與預期 Build；沒有完整辨認「原版本健康並已恢復」的終止分支。前一筆不結案時，新 ID 又會被 UPDATE_RECOVERY_REQUIRED_USE_ORIGINAL_REQUEST 擋下。
- 修改：沿用現有 candidate、rollback-index、request/result journal、原操作 Restore；增加舊 Widget/Loaded Runtime 的實際觀測與 REJECTED/ROLLED_BACK 結案。保留新舊產物 pin 與原 ID；不可直接忽略 LOADED_IDENTITY_NOT_ACCEPTED。
- 不觸碰 OMI Backend 正式市場資料庫或 Trading Runtime。這次只修 OMI Search Adapter 的程式換版。

### R2-03 [P1 / Architecture Risk] Control Center：新版啟動失敗後缺少舊版回退閉環

- 程式證據：mcp_control_center/scripts/runtime-bootstrap.ps1:43-110；既有 fixture 主要覆蓋同一新版重試與 SUPERSEDED。
- 原因：完成選版後若新 Tray / IPC 無法 Ready，現有程序進 RECOVERY_REQUIRED，重入優先再啟動已選用的新版本；未完整支援「新版本確定不可用、舊版完整且可正常啟動」的回退。
- 修改：在原 transition-intent、old version、candidate inventory、原 owner 已停止證據一致時，使用現有 Deployment/Bootstrap Owner 將 selection 恢復至舊版，啟動舊 Tray、驗證 PID/start time/IPC，再對原 ID 結案 ROLLED_BACK；無法確認時保留 RECOVERY_REQUIRED 與獨立恢復入口。
- 禁止新增另一套 Tray 或由 Workspace 直接 Kill/Start CC。不可把「已選版」等同「新版健康」。

### R2-04 [P1 / Architecture Risk] Bridge：Stopped 與 Active State Unknown 被混為一談

- 程式證據：mcp_control_center/src/McpControlCenter.WorkspaceUpdate.psm1:70-81、178-180。
- 原因：Bridge 預檢硬依賴 HTTP /health 取得 jobs.active、awaitingApproval；服務已停止時會得到 ACTIVE_STATE_UNKNOWN，進而一再 QUEUED。無法正常進入已確認停止狀態的版本安裝路徑。
- 修改：讓既有 Bridge Controller 對「確定已停止且擁有正確 ownership」提供明確證據，從 ACTIVE_WORK_PRESENT、UNVERIFIED 分離；只對 STOPPED_CONFIRMED 走正常新版本啟動，不將單純 HTTP 失聯視為已停止。
- **重要依賴**：本問題涉及 CC 的更新模組，應先採用修過的 CC。Bridge 運作中有任何工作時保持 wait_for_idle，不能強迫停機。

### R2-05 [P1 潛在故障 / Architecture Risk] Control Center 收據滿額可能影響 Owner 初始化

- 程式證據：mcp_control_center/src/WorkspaceLocal.Native.cs:389-405、459-465。
- 原因：UpdateStore.Pending() 掃描收據超過 256 筆會擲出 RECEIPT_CAPACITY，而 Owner 建構時直接呼叫 Pending()；影響可能不只「新更新被拒」，也包括超額後 Tray 重新啟動時失去 IPC Owner。
- 本輪收據數量遠低於上限，**不是目前實際卡住的原因**。
- 修改：把有效 pending/uncertain 收據與已 terminal 收據的長期保存分離；以同一 Store 的可查詢 archive/index 保留原 Request ID、防重送與歷史查詢，避免已完成歷史筆數阻止 Pending() 掃描和初始化。不要直接刪除 UNKNOWN、QUEUED、RUNNING、RECOVERY_REQUIRED。
- 測試：超過 256 筆歷史 terminal 收據時，Owner 能啟動、status/preview/receipt 能讀、有效 pending 能恢復、原 ID 不重新派送。

### R2-06 [P2 / Confirmed Design Debt] 不變的 WAITING_FOR_IDLE 會反覆寫入

- 程式證據：mcp_control_center/src/WorkspaceLocal.Native.cs:503-521（QUEUED 重排），Save() 在 406-417 每次更新寫入 immutable history。
- 歷史證據：Bridge 同一 update operation 的 history 有 76 筆，大量為等待閒置狀態。
- 修改：狀態與必要內容均未變時不新增歷史檔；佇列保留既有重試語意，可採固定、受限的重新檢查間隔。不能用假 terminal 解決等待，也不能讓已停止/已閒置的 Bridge 永遠沒機會再次檢查。
- 驗收：同一筆持續等待不持續線性膨脹；最後閒置後仍能以原 ID 正常完成。

### R2-07 [P2 / Architecture Risk] OMI Source Update 自有 256 操作目錄上限

- 程式證據：OMI_search/scripts/update-from-source.ps1:159-169。
- 修改：按照可確定的 terminal/result、保留的原版本 pin 和回退需求設計歸檔或可查詢索引；保留未結案原操作，且歸檔後同 ID / 同版本要求不會被視為全新請求。
- 不可用刪除歷史作為修復；不影響 Market DB、Backend DB Migration 或 Trading journal。

### R2-08 [P2 / Confirmed Design Defect] PAOS Loaded Identity 與磁碟 Source Identity 混用

- 程式證據：personal-asset-os/src/personal_asset_os/app.py:41、104（啟動時固定），personal-asset-os/src/personal_asset_os/mcp_server.py:244（每次查詢重算 source_build_id），personal-asset-os/src/personal_asset_os/build.py:10-30。
- 修改：區分 loadedBuildId（啟動時固定）與 currentSourceDigest（磁碟當前）；MCP Runtime 狀態不應在服務未重啟時因磁碟 Source 改動而冒充已載入新版。檢查 Build 來源覆蓋前端交付產物／依賴鎖定與相關設定，維持同一 canonical identity 規則。
- 驗收：服務啟動後改 Source、未 Reload 時 Loaded Build ID 不變；正式 Reload 才改變，Backend/MCP 對同一 loaded version 的回報一致。

### R2-09 [P2 / Architecture Risk] PAOS Stopped 無法進純程式更新；Schema 與健康檢查耦合

- 程式證據：personal-asset-os/scripts/update-from-source.ps1:35-45；personal-asset-os/src/personal_asset_os/app.py:41-44 會在 app 初始化期間執行 migration。
- 修改：區分已確定停止、Schema 已相容與狀態未知。對純 Code-only 且 Schema 無變動的更新提供可驗證的停止狀態採版路徑；Schema 不相容時明確回傳 MIGRATION_REQUIRED，留給既有資料庫 owner 處理。
- 不以跳過 Schema 比對換取表面成功，也不為此改動正式資產 DB 或進行完整備份。

### R2-10 [P2 / Observation] Source／Build／Git 的可重現性與工作中變更

- 現象：98 個 Git 未提交變更，部分 OMI Source Update 正式入口為 untracked；四主要工具近期 Source Digest 與成功收據一致，但 Git HEAD 無法重建所有尚未追蹤的正式來源。
- 修改範圍：**本修復階段不要替其他工作補 commit**。後續各模組完成既有 WIP 後，針對更新所需的檔案做精準 Git 交付檢查；適當時保留可重建的版本、產物 pin 及來源 Commit 關聯。
- 此點不應被拿來宣稱現行 Runtime 未採用新版。

## 4. 修復順序與分批工作包

順序依 Owner 與共用依賴排序，不因問題多就重構所有模組。以下全部為**尚未執行**。

### G0 — 基線與衝突確認（唯讀）

- 重新取得 Bridge activeJobs/pendingApproval、所有未結案 update receipts、目前 Git status/diff 與選用 Runtime Build。
- 確認現存 Codex 工作沒有同時修改本計畫指定檔案；重疊時保留現有工作成果，不直接覆蓋。
- 列出 Source checkout／CC selected installed version／Bridge installed version 的差異，只辨認受影響路徑。
- 交付：Baseline + affected files + no-conflict 結論。**不重跑所有既有測試**。

### G1 — Control Center 核心 Owner（R2-03、R2-05、R2-06）

- 檔案優先：mcp_control_center/scripts/runtime-bootstrap.ps1、src/WorkspaceLocal.Native.cs、src/McpControlCenter.WorkspaceUpdate.psm1、相關既有測試。
- 修復 CC 自身失敗回退、收據超額初始化、重複 WAITING_FOR_IDLE 寫入。
- 先以隔離的 CC fixture 驗證；不碰正在工作的正式 CC/Bridge。
- CC 新版要經原 Independent Bootstrap 採用；不能把在 Source 修改完成當作 CC Runtime 已更新。
- 验收：新版失敗 → 舊版 Ready/IPC → 原 ID terminal；>256 terminal receipts 仍能初始化；pending original ID 可追蹤。

### G2 — Shared Node（R2-01、Memory Core 特例）

- 修改 project_reading/scripts/node-source-update.ps1，保留各 component 各自的 Build/Status/Preflight/Reload callback。
- 補上 Reload 後舊版可確認時的 ROLLED_BACK/NOT_APPLIED；UNKNOWN 保留原 ID 與手動處理資訊。
- 擴充 project_reading/tests/test-node-source-update.ps1（舊版仍活、新版未載入、成功恢復、無法證明、曾發送 Reload 不得再發一次）。
- 若 Shared callback 有修改，只對受影響代表元件做定點 smoke；不強制重啟所有六個服務。
- Memory Core 的 PrepareOnly 必須獨立判斷真實 Loaded 狀態，不虛構檔案級回退。

### G3 — OMI Search（R2-02、R2-07）

- 修改 OMI_search/scripts/update-from-source.ps1 與測試，不進入 OMI 市場 Backend。
- 加入確認舊版已恢復的 terminal 流程、原始操作歸檔可查詢及 256 上限處理。
- 隔離 Fixture 後，再經正式 OMI Update Owner 驗證一次受影響的更新路徑。
- 不自動重試真實交易、Broker API 或研究候選提交。

### G4 — Bridge Stopped Update（R2-04；必須等待 jobs idle）

- 修改的 Owner 主要仍是 CC 的 WorkspaceUpdate module；需要確認 G1 所採用的 CC 版本包含該修改。
- 在隔離測試中分別演練 Bridge ACTIVE、STOPPED_CONFIRMED、STATE_UNVERIFIED。
- **Bridge 正在運行的 Codex Job 沒結束前禁止換版／停止**。未來獲准部署時只走原 DailyCode Owner／wait_for_idle 路徑。
- 若修復不需更動 Bridge runtime code，只更新 CC owner，不為了形式強迫 Bridge 換版。

### G5 — PAOS 單獨修復（R2-08、R2-09）

- 更正 Loaded Build ID/Source Digest 分離，修復停機 Code-only preflight；依既有 Migration Owner 確認 Schema 相容。
- 測試 Source 編輯後 Loaded Identity 不漂移、Reload 後一致、Schema mismatch 不意外更新 DB。
- 只修改 PAOS 更新與 Build Identity 的必要檔案，不碰財務／券商業務資料。

### G6 — 受影響 Runtime 驗收與文件封版

- 檢查 CC → Shared Node/OMI → Bridge/PAOS 的正式 Owner 路徑。
- 各驗收僅核對受影響模組的 Source Digest、Prepared Build、Loaded Build、Ready、收據 terminal 與下一次合法更新可執行性。
- 確認現存 Git WIP 未被 stage/覆寫，不為測試無條件換版九個 MCP。
- Reviewer 獨立讀 Diff／Test output／Runtime；未經 Runtime 證明者記為 UNVERIFIED。

## 5. 必須維持的交易語意與停止條件

| 條件 | 預期狀態 | 後續更新 |
| --- | --- | --- |
| 新版實際載入，Build/Owner/Ready 一致 | ACCEPTED | 可以 |
| Build/Preflight 失敗，尚未修改正式版本，舊版完整 | REJECTED / NOT_APPLIED | 可以 |
| Reload 已派送，但能確認舊版已恢復且候選未採用 | ROLLED_BACK / REJECTED，原操作 terminal | 可以 |
| CC 選版後新 Tray 失敗，舊 Tray 可恢復並驗證 IPC | ROLLED_BACK，原操作 terminal | 可以 |
| 仍有活動 Job 或未核准作業 | WAITING_FOR_IDLE（原 ID） | 等待，不中斷工作 |
| 未能確認原 Reload 結果、PID identity 或發現非預期第三版本 | RECOVERY_REQUIRED + 原 operation + 明確 blocker | 不能以新 ID 規避；需先辨認原結果 |
| 同一 requestId + 相同參數重送 | 返回原收據，不重派 Lifecycle | 不重複執行 |
| 同一 requestId + 不同參數 | REQUEST_CONFLICT | 不影響原交易 |
| 收據容量接近／超過歷史上限 | terminal 可歸檔且 Owner 正常啟動 | 保留同 ID 查詢與阻止 replay |

修復目標是讓**可判斷的失敗能結案**，而非把所有 UNKNOWN 都強行改成成功，也不因失敗新增無關限制。

## 6. 最小驗收矩陣

| Case | 受影響 Owner | 驗收條件 |
| --- | --- | --- |
| T01 正常更新 | 全部適用 | Prepared Build == Loaded Build，Ready + 原收據 ACCEPTED |
| T02 Build 前失敗 | Shared Node / OMI / Bridge | 原始舊版本不變，操作可結案，無 Reload |
| T03 Reload timeout 但新版實際載入 | Shared Node / OMI | 原 ID Recover 成 ACCEPTED；不重複 Reload |
| T04 Reload timeout 但原版健康 | Shared Node / OMI | 舊版 pin/Loaded 可信，原 ID terminal，下一筆 Update 可通過 admission |
| T05 Loaded Identity 不明或不同 | Shared Node / OMI | 保留 RECOVERY_REQUIRED 與 blocker；不可虛構成功 |
| T06 Bridge Active / Stopped / Unknown | CC → DailyCode | Active 等待；Stopped（已證明）可更新；Unknown 回報而非無限重排 |
| T07 CC 新版無法啟動 | CC Bootstrap | 確認舊版可用時回退並驗證 IPC；無法回退提供明確恢復資訊 |
| T08 256+ terminal receipts | CC Store / OMI | 歷史可查、不影響 Owner 初始化與新請求；UNKNOWN 不被清除 |
| T09 長時間等待 idle | CC queue | 無變化狀態不爆量寫入，恢復 idle 後能繼續 |
| T10 Source 修改但沒有 Reload | PAOS | Loaded Build Identity 不變；Source Digest 可獨立改變 |
| T11 依賴與 Schema 不相容 | Memory / PAOS | 明確 REJECTED / MIGRATION_REQUIRED，不隱式改 DB |
| T12 修改後實際正式入口 | CC／Workspace／Bridge／OMI | 不只測 fixture；確認 Runtime 正在執行的已安裝 Build，並讀到確定終止收據 |

T01/T12 不要求九個元件全部重啟：僅對實際改變的 Owner/Production Path 及其受影響代表實例驗收，避免破壞正在使用的工具。

## 7. 部署、回滾及後續人工作業

- **本輪 Gate：PLAN_ONLY；所有 Build / Deploy / Restart / Codex dispatch 均 Pending**。
- 未來實作 Code Review 通過後，再檢查 Bridge jobs 是否為零、Owner 工作狀態與選用版本；無法證明時不換版 Bridge。
- 依相依性換版：先 CC owner（包括新版 DailyCode/WorkspaceUpdate）→ Shared Node 修正所需 Runtime → OMI Search → PAOS；Bridge 實際換版只在自身程式也需更新且完全 idle 時才執行。其餘元件不要求無意義的重部署。
- 失敗回退沿用該元件現有 rollback artifact／previous version／原操作 id。不得刪除 lock、重寫收據、用新 ID 重送或跳過真實 Build Identity。
- 若功能已確認失敗：停止進一步 Deploy，只恢復已驗證的上一版本；將不能驗證的範圍保留 BLOCKED/UNVERIFIED。
- Commit 僅包含本次修改的精確檔案；推送 GitHub 與正式換版屬不同操作，未來按當次授權執行。

## 8. 交付狀態（建立文件時）

- Completed：前一輪原始碼／Runtime 唯讀盤點；四主要目標最近成功收據與 Source Digest 比對；九目標 Preview；本 R2 問題清單與修復規格。
- Pending：全部程式修復、測試、Installed Release 更新、正式 Runtime 驗收、Git Commit/Push。
- Blocked：Bridge 現有多個 Running Jobs，暫不更動它的正式 Runtime。
- Unverified：未知失敗路徑的正式故障注入、另外五個 Shared Node 元件的個別真實 Source Update、CC 自身新版本啟動失敗的真實回退。
- Reviewer 暫定結論：**目前不建議對更新系統封版；可繼續其他業務開發，R2 另案執行。**

## 9. 下次接續時給 Codex 的工作說明

Project：mcp_tools（C:\GPT_MCPtool）

Objective：依本文件 G0→G6 修復既有 Source Update 失敗恢復、CC Receipt 累積、Bridge Stopped Preflight 與 PAOS Loaded Identity；不重新設計更新架構。

Constraints：
1. 先唯讀檢查正在工作的 Job、Git WIP 與 Current Runtime，避免覆蓋其他任務。
2. 僅修改本規格列出的既有 Owner／Helper／測試；遇到新根因先回報，不自行擴大。
3. 本次文件建立不授權執行；日後使用者明確開始實作時才建立 Codex Job。
4. Fast Mode 預設 Standard，不自行更改模型／Effort／Execution Mode 或消耗額度。
5. Reviewer 要獨立檢查原始 Diff、受影響測試與正式 Runtime，Codex 完成宣告不構成封版。

Acceptance：每項 R2 缺陷都能對應一項真實修復、必要的 Fixture Test、原始 Update Receipt/Runtime 規則及最終封版判斷。

Rollback：仍使用原有 Owner 管理的 Immutable Candidate、Previous Version 和操作收據；任何無法證實的恢復狀態不得被轉成 ACCEPTED。
