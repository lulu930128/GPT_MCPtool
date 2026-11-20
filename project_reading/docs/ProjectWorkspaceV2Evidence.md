# Project Workspace V2 隔離驗收紀錄

## 第一輪基線

2026-11-20，Windows x64，Node 24.14.1。基線為 `62de2d3184463efbcb8e92486823c2c18d5103b9`。開始時 project_reading 的 Git 路徑乾淨，根 repository 已有其他元件的 WIP。此次未 stage、commit、push 或部署。

| 表面 | 紀錄 |
| --- | --- |
| Source | application `2.0.0`，tool contract `2026-11-20.1`。沿用原 Workspace server、path guard、文字 reader、SegmentedTransferStore、git-tools 與 CC adapter。SQLite 新增單一 reader。 |
| Build | 在隔離 source copy 以既有 node_modules 執行 `npm run build`。實際 HTTP 測得 buildId `e6d9a78597761106a6f9`。隔離 checkout 沒有 Git metadata，buildId 與 Git 基線分別記錄。 |
| 基線 | 修改前完整 `npm test` 通過 195/195，234.325 秒。 |
| 最終全套回歸 | `npm test` 通過 203/203，失敗、跳過與取消均為 0，267.001 秒。包含 ZIP64、Asset、音訊、Git、SQLite、CC、診斷及 guarded writes。 |
| Windows 診斷 | 獨立執行 `node --test dist/tests/diagnostics.test.js` 通過 14/14。有一輪 Windows IPv6 listener 的 `listed.ok` 取樣失敗，該輪為 202/203。當次測試未保留原因碼。另行重跑診斷及最終完整執行均通過。 |
| 隔離 MCP | Streamable HTTP client 先 tools/list，取得 53 個唯讀模式下的工具，再實際完成 SQLite 兩頁、Git status、文字搜尋、runtime performance，以及讀檔、分段 Resource、重組與 complete 收據。 |
| 隔離 Owner adapter | `tests/test-workspace-source-adapter.ps1` 執行真實 build/identity callback 與合成 Status preflight，21 項檢查通過，69 個編譯檔一致，liveReloadCalls=0。修正 fixture 在 PATH 含兩個 Node 時把兩個路徑一起當成 executable 的問題。 |
| 正式 Runtime | 02:22:23 UTC，既有 `workspace_runtime_status` 回報 `1.9.0`、契約 `2026-11-08.2`、buildId `67b8283673f61982068a`。正式 CC readback 為 `OWNER_OBSERVATION`，目標 project_reading 支援更新，ownerVerified=false。 |
| ChatGPT E2E | 正式 V2 Secure Tunnel 與 ChatGPT 接收端重組未執行。此次只有既有版本的正式唯讀查核。 |

## 1 GiB 與傳輸

在隔離目錄執行 `node --max-old-space-size=192 scripts/benchmark-workspace-v2.mjs`。以同一筆 read_files 取得兩個 taskId。client 先讀 tool schemas，再逐頁讀取 manifest、下載每段、驗每段 SHA、依 offset 重組並核對獨立產生的來源 SHA。每個來源均為精確 1,073,741,824 bytes。

| 來源 | 分段 | 重組 SHA-256 |
| --- | ---: | --- |
| UTF-8 多位元字元、CRLF | 138 | `3fbe40c94f260f56bce52840fc70c713e0c48a709badb64e55456458f3c8eef3` |
| 含 NUL 與無效 UTF-8 的 binary | 138 | `0e4ff35aec3ad254b4856bbb9ecea2f751eb8fa79782aaf40d39f43eb99204f0` |

兩檔批次、準備、讀回及驗證耗時 32.923 秒。最大序列化 JSON-RPC 測量值 10,420,484 bytes，10 MiB 為 10,485,760 bytes。此測量含測試 envelope，正式 Tunnel 的額外延遲與 Host 行為未知。單程序內同時執行 SDK client 與 server，峰值 RSS 349,160 KiB。192 MiB 是 V8 old-space 啟動設定。文字連續兩頁各讀取 20,000 行，第二頁 disk read 計數 262,148 bytes。

八個 600 行視窗的 A/B 使用相同 8 MiB、524,288 行 UTF-8 fixture。基線每頁中位數 70.10 ms。V2 以 nextOffset/snapshotId 續讀，八頁合計讀取 2,097,184 bytes，中位數 1.53 ms。兩者共回傳 4,800 行。這是本機檔案讀取，不含網路時間。

## 研究工具與相容性

- Git fixture 核對真實 commit、歷史 .env blob、pack、index、packed refs、reflog、loose object 及未封裝 branch ref。測試 Git 操作後的 index 原始 bytes 相同。工作樹 .env 與 .env.* 拒絕直接讀取，linked gitdir 位於 root 外時回報錯誤。
- SQLite WAL fixture 的 reader 跨頁時，同一 writer 另行提交新列，原 reader 持續取得同一 statement snapshot。INSERT、UPDATE、DELETE、DDL、ATTACH、extension、checkpoint 與 query_only 關閉嘗試均失敗。核對主檔和 WAL 雜湊。SQLite 的共享鎖由原生 reader 使用。持久 WAL 模式且缺 sidecar 的關閉資料庫仍可 raw 讀取，驗後目錄清單一致。
- 可用相同 taskId 恢復舊 8 MiB 原始分段。新的 range links 經 SDK 重組後仍匹配原 part SHA，實際扣量等於原分段長度。六個 ready workspace captures 經同一 Owner 重開後可逐一讀回。
- SQL 長查詢在實際 120 秒預算下測得 119.032 秒結束並釋放隔離 fixture。專用 child 只執行固定 SQLite reader 模組，工作樹與正式資料庫未參與。
- 搜尋 fixture 含 2,000 個翻譯命中及 8 個來源命中。兩種查詢各執行 15 次，前 8 筆皆落在 source。全部類型 p50/p95 為 61.18/743.41 ms，指定 source 為 46.87/941.01 ms。數字包含 Windows 啟動 ripgrep 與讀取 context，且測量期間主機還有隔離工作。未據以推定所有查詢都加速。
- OMI 唯讀案例核對 `ResearchCandidates.tsx` 的 grouped summary GET 及候選明細的 `buildDashboardHref`。台股連結傳 market 與 stockId。針對 `/api/research/trade-proposals?view=stock_grouped_summary&market=TW&limit=1&offset=0`，第一次 10 秒逾時，另一次 GET 回 200、12,426 bytes，TTFB 13.154 秒，總耗時 13.154 秒。未取得瀏覽器 navigation、React 或 main-thread trace。此案例沒有啟動研究或變更 OMI。

## 證據檔案

從基線正向 `git apply --check` 及對工作樹反向 `git apply --reverse --check` 核對 patch。兩者均僅做檢查。

本機交付目錄為 `.tmp/workspace-v2-e6d9a78597761106a6f9/`，保留 patch、測試日誌、基準結果與逐檔 SHA-256。`verified-inputs.sha256` 涵蓋 72 個 TypeScript 來源／測試及 package、lockfile、tsconfig 輸入，逐檔比對工作樹與隔離 build copy。該清單本身的 SHA-256 為 `795b3c884adc5286d99efddf1a3cbe7b796aabbfeb27a5d21fef13197b7629bc`。

## 部署與回滾

由正式 Control Center 的 project_reading update owner 另行預覽、採用與讀回原 UUID。對照 Source/Installed/Running identity，重新列出 tools/resources，再從 ChatGPT 驗分段重組。回退應先盤點並處理 V2 workspace 工作與保留中的 state；1.9.0 recovery 的四個工作限制可能拒絕含多個 V2 工作的 staging。保留仍需續讀的原 taskId 與收據，透過同一 Owner 採用上次已驗證 release。來源 patch 可用 `git apply --reverse --check` 核對回退範圍。

## 第二輪發現工具與回歸（2026-11-20）

Bridge 新 Job `6c38ee59-dbd2-4c29-8eb0-76f1164783e7` 以 Astra high、Standard、workspace_write 啟動獨立 Thread `01a1f7ed-83c9-7191-920f-f69b8ef8b19f`。原 Job `2c38b4a0-2172-4df9-8e80-fe535f449180` 終態為 failed。

正式舊 build `afc61043d297d3629601` 的 `find_files` 對 `mcp_tools/.git` 的 HEAD 查詢回 `INVALID_ARGUMENT`、`Path includes denied directory: .git`。在 `projects/Open Market Intelligence/data/execution-runtime` 查 `**/*.sqlite` 則走訪 62 項、略過 2 項、命中 0 筆。Source 的修正將起始目錄及走訪時的路徑檢查接回研究讀取政策。含斜線的 glob 比對搜尋目錄下的相對路徑，單一 basename 可命中任意深度。

| 第二輪驗證 | 實際觀測 |
| --- | --- |
| Build 與回歸 | 使用現有 node_modules 與隔離 source copy；109 個 source、test、script 與建置設定檔的 SHA-256 相符。`npm test` 內的 `npm run build` 成功。初次 199/204，5 個文字讀取測試因共用 Windows temp 遇到 `TRANSFER_BUSY`。為測試程序配置獨立 TEMP、TMP 後重跑，204/204 通過，0 fail/skip/cancel，299.465 秒。獨立 diagnostics 14/14。兩次日誌均在 `.tmp/v2-round2-6c38ee59/`。 |
| find_files | 隔離 HTTP MCP 在兩個正式 root 路徑命中 HEAD 與 production.sqlite。另以 fixture 核對 .git/index、pack、loose object、六種 DB/binary 副檔名、basename 與相對 glob、排除工作樹 .env、跳過 junction 並拒絕越界起點。 |
| 讀取、搜尋、分段 | 隔離 HTTP MCP 讀回 Git index 檔頭 DIRC；依 snapshotId、行號及 offset 續讀；以 includeGlobs、excludeGlobs、fileKinds 及 cursor 取得第二筆命中。SQLite overview 使用合成資料庫，讀前後主檔 SHA-256 相同。read_files 回傳的 Resource 經 manifest 重組、比對原檔 SHA-256 並 complete。全套回歸包含歷史 .env blob、SQLite WAL snapshot 與舊 8 MiB part 的同 taskId range 重組。 |
| 專用 Asset | `node scripts/smoke-assets.mjs` 在隔離 HTTP MCP 驗證 GIF 預覽與原件 hash、XLSX、DOCX、PPTX、PDF。fixture 註冊 53 個工具。 |
| 驗證範圍 | 第一輪 1 GiB × 2 基準與 203/203 保存在上節，本輪未重跑該基準。12 MiB 舊 part 的 Host 下載與 GPT 刷新後的端到端重組均未實測。 |

### 正式換版與 MCP 讀回

原 Control Center Owner 從 preview 取得 source digest `67480b91f6d08556c073939c4d0a5da265e26d5b1c83ab6afac553b2672bb291`，採用 `workspace-v2-find-20261120-r2`。以同一 requestId `332f4ecd-6ed9-4e97-966e-f2e258f55413` 讀回 durable receipt，終態為 `ACCEPTED / UPDATE_ACCEPTED`、`ready=true`，完成於 2026-11-20 16:03:33 台北時間。收據的 preparedBuildId、observedBuildId、已安裝 dist/build-info.json 與正式 MCP 開機 identity 均為 `85db28e2f01e9c40a860`。Application 為 `2.0.0`，契約為 `2026-11-20.1`。

| 正式 find_files | 結果（均未截斷） |
| --- | --- |
| `root=mcp_tools, path=.git, pattern=HEAD` | 走訪 261 項，命中 `HEAD`、`logs/HEAD`、`logs/refs/remotes/origin/HEAD`、`refs/remotes/origin/HEAD`。 |
| `root=projects, path=Open Market Intelligence/data/execution-runtime, pattern=**/*.sqlite` | 走訪 62 項，命中 `production.sqlite`、`production.us.sqlite`。 |

收據與正式查詢原始回應保存在本機 `.tmp/v2-round2-6c38ee59/formal-readback.json`。收據標示 `ownerVerified=false`、`chatgptE2e=UNVERIFIED`。GPT 端由使用者自行刷新。
