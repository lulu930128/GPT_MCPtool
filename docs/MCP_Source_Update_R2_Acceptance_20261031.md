# MCP Source Update R2 — 實作／部署驗收紀錄

- 日期：2026-10-31（Asia/Taipei）
- 相關規格：`docs/MCP_Source_Update_R2_Repair_Plan_20261031.md`
- 結論：**R2 修復已實作、主要受影響正式路徑成功換版；可以封版，但保留已知 Debt／未驗證情境。**
- 計畫基線不代表目前 Runtime。以本文件的正式收據與 Runtime 觀測為準。

## 1. Codex 執行結果

- Job：`c41316af-eef4-469e-b66e-635e11a1daeb`；模型選用 `gpt-6.1-sol/xhigh`，Standard；狀態 `completed`。
- R2 增量：19 檔（11 程式、8 測試）。使用既有 Owner；未建立平行 updater。
- 工作前 Git 已有 107 筆 WIP，Codex 表示未修改無關基線檔案；驗證用增量 Diff：`C:\GPT_MCPtool\.local\engineering\r2-repair-20261031\task-only.diff`；同目錄有 file-pins 與測試輸出。
- Codex 工作中未部署、未重啟、未 Commit／Push；後續部署由正式 Workspace/CC 通道另行執行。

## 2. 隔離測試／靜態檢查

以下是工作紀錄中最終重新執行、Exit Code = 0 的結果（不是正式故障注入）：

| Gate | 結果 |
| --- | --- |
| Control Center source-update receipt / admission | 36 checks PASS |
| Control Center IPC / Native owner regression | 709 checks PASS |
| Control Center Bootstrap / rollback fixture | 20 checks PASS |
| Shared Node source-update | 79 assertions PASS |
| OMI Search source-update fixture | 76 checks PASS |
| Bridge ACTIVE／STOPPED／UNVERIFIED 分流 fixture | 7 checks PASS |
| Memory Core／PAOS callback fixture | 15 checks PASS |
| PAOS 定點 pytest | 7 tests PASS；identity/schema 最終重跑 5 tests PASS |
| PAOS 定點 Ruff、PowerShell／Python 語法與 Diff whitespace | PASS |

測試初期曾發生 Fixture helper 未載入、Preview 缺必填版本、Fixture 寫入不可變檔案、Python 格式錯誤；修正後最終檢查通過。不能把初次 Fail 誤認為仍存在正式程式 Defect。

## 3. 正式 Source Update / Installed / Runtime

所有更新均透過 Workspace 的正式 `mcp_component_update` → Control Center 持久化收據 → 既有 Component Owner；使用原始 Request ID 讀回結果，無新 ID 盲目重送。

| 元件 | 最終選用版本 | Original Request ID | Receipt | Prepared == Observed Build | Ready |
| --- | --- | --- | --- | --- | --- |
| Control Center | `r2-cc-20261031-01` | `00a09ab1-5593-483d-a0e3-116eb5ca31c6` | `ACCEPTED / CC_OWNER_AND_IPC_VERIFIED` | `af56d97a2a8e1dadaa66645a1a23a565260a050a8fb2597428f858ed6e611b13` | true |
| Project Workspace | `r2-ws-20261031-01` | `05266723-3ad5-46a1-bcd7-84b7e0a8f9b1` | `ACCEPTED / UPDATE_ACCEPTED` | `aae505c04e14f53ff98d` | true |
| OMI Search | `r2-omi-20261031-01` | `8b94435a-12d7-47cb-a762-aeaedfc5bf8d` | `ACCEPTED / UPDATE_ACCEPTED` | `805692d396f3b325` | true |
| Personal Asset OS | `r2-paos-20261031-01` | `a1d88990-618e-467b-b649-7904664b3b50` | `ACCEPTED / UPDATE_ACCEPTED` | `3b85e48b163643bd` | true |

交叉驗證：
- Control Center：`mcp_control_center/Runtime/current.json` 已選 `r2-cc-20261031-01`；新版 CC 的 IPC 已重新連線，9/9 source-update targets 重新發布 `supported=true`。
- Workspace：`workspace_runtime_status` 已載入 `aae505c04e14f53ff98d`，啟動時間 `2026-10-31T08:51:59.700Z`；HTTP listening、MCP handler running、CC connected。
- OMI Search：本機 `/health` HTTP 200，Build `805692d396f3b325`，工具數 48；OMI MCP `omi_read_runtime_status` 取得 launcher pipe response，receipt store AVAILABLE。此 Build ID 與更新前相同，因 R2 變更 updater 而非 HTTP 可執行檔 Build 的輸入；不能用 ID 相同反推未 Reload。
- PAOS：`/api/health`、`/api/readyz` HTTP 200；`databaseReady=true`、`frontendReady=true`，Build `3b85e48b163643bd`，`buildIdentity=startup-v1`。獨立 PAOS MCP `get_asset_system_status` 回傳同一 Build ID 與 Identity。Code-only Schema Preflight 與現有 Schema `0005_reporting_annotations` 相容；未額外執行 Schema Upgrade。
- Codex Bridge：未修改 Bridge executable，故沒有硬做無程式變更的 Bridge DailyCode 版本升級。仍為 `bb52b3a8e5c15cf1`，Controller Ready、activeJobs=0、pendingApproval=0。Bridge 停機管理修復位於已載入的新版 CC。
- Japanese／English／Listening／Memory：本 R2 未改其個別正式執行程式碼，不因 Shared Update helper 修正而逐個強制重啟。9/9 更新目標可觀測且支援；正式災難恢復情境仍未逐一故障注入。

## 4. 已知 Debt／未驗證

1. **正式故障注入未執行**：CC 新版啟動失敗回退、Bridge 完全停止更新、Shared Node/OMI Reload 模糊結果主要由隔離 Fixture 驗證；本次正式部署驗證的是正常成功路徑。
2. Memory Core PrepareOnly、PAOS mutable Python source、OMI 無法重現舊 Source 時，仍保留 `RECOVERY_REQUIRED`，不將未知判定為回滾成功。
3. 完成收據仍保留原 ID 查詢／重送去重，不會占用 pending 容量；**尚未實作實體歷史歸檔**，超大量收據的效能與磁碟保留策略待後續觀察。
4. 兩筆早期 Bridge Reload `UNKNOWN` 沒有因本次 R2 操作被改寫。
5. 本次沒有為無關正式工具重跑全部端到端測試；所有 ChatGPT 客戶端路徑的完整 E2E 仍不因單一 HTTP／MCP 健康檢查而推定。
6. Git worktree 保留大量既有 WIP；**本輪尚未 Commit 或 Push**。

## 5. 封版與下一步

- **目前實際狀態**：四個實際換版目標收據均已 `ACCEPTED` 且 Loaded Build 匹配；CC/Workspace/OMI/PAOS 基本正式路徑運作，Bridge 未被中斷。
- **原始問題**：R2-01 至 R2-09 的修復已實作並經指定 Fixture 驗證；「實際失敗時一定能自動回復」尚未經正式故障注入證明。
- **封版**：可以封版，但保留上述已知 Debt。後續若要求更高等級的故障回復保證，新增定點故障演練 Gate 即可，不需重新掃描整個 Repository。
- **下步**：可正常繼續開發；需要永久 Git 交付時僅精確 stage R2 增量，先檢查大量既存 WIP、untracked 檔案及變更相依，不擅自執行 Push。
