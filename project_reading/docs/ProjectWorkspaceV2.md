# Project Workspace V2 工程規格（2026-11-20）

沿用 root/path guard、File/Segmented Transfer、git-tools 與 Control Center。read_file 與 read_files 接受 20,000 行、至少 1 GiB 的文字與 binary 工作，支援原始範圍、可續讀 manifest、來源 identity 與 SHA-256。單筆 Secure Tunnel 訊息上限 10 MiB，請求時限 120 秒。保留小檔欄位、行號與舊工具，避免整檔配置記憶體。

核准 root 內 Git 原始資料與歷史內容完整可讀。工作樹 .env/.env.* 維持原政策，寫入沿用既有 guard。SQLite 使用真正唯讀連線，支援 WAL、schema、indexes、參數化 query/explain 及大結果續讀。Access 資料庫提供 raw bytes。

inspect_git 提供 status/log/history/show/blame/diff/refs。inspect_runtime 以既有 registry 提供 health/performance/full，標記證據來源、觀測時間、程序與涵蓋範圍。搜尋提供 glob、檔案類型、排序與續讀，保留 lexical 工具。提供可實測的執行、掃描、I/O、序列化與輸出量，Host/Tunnel 未知照實標示。

「不得自行加入其他阻擋行為」。第一輪授權範圍為 source 與隔離驗證。第二輪授權原 Control Center 更新 `project_reading`，並以正式 MCP 驗證兩個發現案例。GPT 刷新由使用者操作。各輪結果見[驗收紀錄](ProjectWorkspaceV2Evidence.md)。
## 讀取與續傳契約

| 入口 | 客戶端行為 | 證據 |
| --- | --- | --- |
| `read_file` 文字 | 傳 `startLine/maxLines`。下一頁帶 `nextOffset`、`nextStartLine`、`snapshotId`，可直接定位。 | `eof`、行數、bytes、encoding、stat identity，大檔行數未知時為 null。 |
| `read_file` binary | 指定 `format=binary`、`offset`、`length`。解碼 base64，按實際 `length` 和 `nextOffset` 接續。 | `rangeSha256` 是該段雜湊。檔案 identity 改變時失敗。 |
| 完整原件 | 明確要求 `delivery=resource`，或使用 auto 的 transfer。依序呼叫 `get_segmented_transfer`、`list_segmented_transfer`、`resources/read`。 | ready 提供 archiveSha256。讀取扣款含失敗投遞與重讀，僅在客戶端重組且以匹配的 SHA 完成工作後標示 caller attestation。 |
| `read_files` | 每檔可指定相同格式。維持原陣列，回傳 `nextFileIndex` 時以該位置續頁。各原件保有自己的 taskId。 | 每檔報 appliedLimits、來源 identity 與各自可恢復的工作。 |
| 已有大分段 | 使用原 taskId 查 manifest 的 `ranges`。依 offset 讀取 `workspace-transfer-range` URI，重組後核對原 part SHA。 | 原 part URI 及 SHA 保留。新版 manifest 對超過 Tunnel 預算的 part 僅列出小 range 作為 resource_link。 |

Tool 傳回的大型結構化輸出只附一段短文字。小結果保留舊的 JSON 文字與 structuredContent。MCP `_meta` 記錄 handler 執行、結果 JSON 編碼時間及該 JSON 的 UTF-8 bytes。含 envelope 的端到端輸出量在 SDK 基準中另測。磁碟 read await 時間包含 OS cache 與排程。遠端排隊、Tunnel 與 Host 耗時均標 UNKNOWN。

## SQLite、Git 與 Runtime

- `inspect_sqlite` 接受 `operation`、`sql`、位置或命名 `parameters`、`pageSize`。傳相同 root/path 與 cursor 讀下一頁，或帶 `close=true` 釋放 reader。單一 statement iterator 保有 SQLite 快照。未讀完的回應以 cursorIdleTimeoutMs 告知下一頁期限。每次成功續讀會更新期限；到期後釋放快照，須重新查詢。讀完、錯誤或 MCP session 關閉會釋放 reader 子程序。BLOB 使用 base64，超出 JS 安全整數的值以十進位字串保存。個別 SQL row 超出傳輸預算時，可用 SQL substr 切片。
- SQL 要求具備原生 setAuthorizer 的 Node SQLite runtime。本次隔離機為 Node 24.14.1。使用 readOnly、query_only、trusted_schema=OFF、停用擴充載入及 SQLite authorizer。WAL 使用原生共享鎖，已提交資料與資料庫/WAL 內容雜湊分開驗證。缺少 WAL sidecar 時回傳 WAL_SIDECAR_UNAVAILABLE，仍可取 raw bytes。raw 檔未提供跨檔交易一致性。依據見 [SQLite WAL](https://sqlite.org/wal.html)、[SQLite PRAGMA](https://sqlite.org/pragma.html) 與 [Node SQLite](https://nodejs.org/api/sqlite.html)。
- `inspect_git` 使用既有 git-tools runner，可指定 project、path、revision/branch/tag/commit、followRenames。log/history/show/blame/diff/refs 的歷史輸出可按 offset/length 續讀。多頁歷史應帶首回傳的 commit 固定版本。show(path) 的 base64 是解壓後 blob。實際 pack/index/reflog/loose object 內容走 read_file。發現 linked gitdir 或 common dir 在所選 root 外時回報原因。工作樹 diff/status 保留原路徑限制。
- `inspect_runtime` 採既有九個 update target IDs、CC 診斷快照、release status、TCP、port owner 與 HTTP reader。Workspace 自身能觀察 CPU 累積時間、RSS、heap、eventLoopUtilization。外部 PID 缺少 provider 的指標回未知，HTTP 樣本標記連線範圍。windowMinutes 被保留為請求範圍，目前 coverage 為 point_sample。瀏覽器 navigation、React、main thread 與 GC 未接上觀測器時標 NOT_INSTRUMENTED。
- 搜尋支援 includeGlobs/excludeGlobs/fileKinds 與顯式 git internals。先按類型、路徑與行號排名，再取頁面。cursor 代表最後已回傳的排序位置，檔案變更或 scan timeout 時不保證跨頁快照。原 find_symbol/import_graph 保留 lexical 定義。

## 第一輪操作範圍與回滾說明

本輪只修改 Project Workspace，使用隔離 source copy 與獨立暫存、測試資料庫、合成 Git repository。正式採用須另授權既有 Control Center 的 project_reading update preview/update，沿用同一 request UUID 讀回 terminal receipt，核對 Installed 與 Running buildId。之後經正式 Secure Tunnel 由 ChatGPT 列工具、讀 Resource、在接收端重組驗 SHA。回滾由同一 Owner 選擇先前 recorded release，核對 receipt 與 running identity。source 回退以本次精確路徑的反向 diff 為界。處理前先保留後續 WIP 與未完成 transfer，舊版對新 workspace manifest 的辨識不同。

本輪量測、基線、回歸與正式 Runtime 查核見[驗收紀錄](ProjectWorkspaceV2Evidence.md)。
