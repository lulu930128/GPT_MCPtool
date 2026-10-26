# G3：Workspace 狀態分層與驗證

日期：2026-10-10。範圍僅 MCP UI presentation；本文件依本次授權的 G3 驗收條件記錄成果，不宣稱 G0–G5 全部完成。

## 修正與呈現規則

原本 `criticalStatuses` 將所有 nested status 合成同一集合，`sourceCategory` 再將任意 `blocked/error` 判為來源錯誤。因此成功 Header 內歷史 `acquisition_diagnostics.missing_z_rescue.status=blocked` 會蓋過仍可讀取的市場證據。

現在掃描時保留 root、domain、acquisition diagnostics、history coverage 的欄位層級；既有 `criticalStatuses` 的公開回傳型別與完整狀態集合不變。這是呈現分類，不產生新的市場健康判斷。

| 條件（依優先序） | 來源分類／呈現 |
| --- | --- |
| `pane.error` | 錯誤；保留 error、舊快取及其他診斷 |
| `key=null` | 未請求 |
| 無資料、`dataKey !== key`、pending loading | 未確認；詳情仍顯示 loading、舊選取及其原始證據 |
| 對應當前請求的 root failure／blocked／`ok=false` | 錯誤；不把 nested provider failure 冒充為 root failure |
| nested domain partial／missing／unavailable／decision unusable／blocked／error | 部分受限 |
| `series_coverage` 明示 partial 等限制 | 部分受限；詳情標明歷史查詢範圍 |
| 只有 acquisition diagnostics 降級 | 警告；原始 failure/status/source/detail 保留 |
| stale／delayed／unknown／degraded 或 warnings／limitations | 警告；不漂白為正常 |
| root health 與 freshness 明示可用，且沒有上述限制 | 正常；只有 MCP 成功不足以判定正常 |

主畫面 `StatusBadge` 最多兩個短訊號，保留失敗／存取受限／不可供決策／過期／部分受限／未確認的既有優先序。擷取診斷與歷史覆蓋的長標籤集中在左下 `WorkspaceStatusPanel` 展開後的 `SourceDetails`；只有這些限制時，主 badge 仍顯示簡短的「資料限制」。

詳情不套用兩個標籤的上限，完整保留 warnings、limitations、provenance 路徑、來源、時間、request/data key，以及延遲展開的 raw JSON。收合 panel 不建立大量原始內容。

## 回歸證據與邊界

- Header fixture 來自使用者提供的 2026-10-10 cache-only 證據欄位：`kind=omi.tw_workspace_header`、freshness `latest_completed_session`、session `previous_session`、TWSE partial `1044/1080`、TPEX partial `781/887`，以及歷史 rescue `blocked`。診斷文字與 provider 名稱為合成測試標記，並非本輪 live read。
- 修正前的 baseline 在隔離負向測試中重現 `錯誤 !== 部分受限`；修正後相同 Header 為「部分受限」，沒有 request error alert，歷史細節仍可見。
- 多訊號 fixture 同時含 stale、partial、acquisition blocked、history coverage partial：主 badge 只有「資料過期 · 部分受限」，詳情保留四種訊號及原始 warnings／limitations。另驗證 decision unusable 不被 compact badge 的截斷移除於詳情。
- `chart.series_coverage` 的 `tw.bar.history_coverage.v1` 描述多日查詢，不代表特定當日完整性。2330 的 265 根／09:00–13:24、00631L 的 263 根／09:02–13:24 使用使用者提供的數量與端點建立合成 fixture；測試不把 fixture 當成真實逐分鐘序列，也不計算應有根數或缺 K。
- 不以 local clock、交易日曆、Provider 推導新健康狀態；不改 chart/research 的投影、Schema 或 backend。

## 變更檔案

- `ui/tw-market-dashboard/src/workspace-evidence.tsx`：唯一既有檔案修改。
- `ui/tw-market-dashboard/src/workspace-evidence-g3.test.ts`：獨立新增 10 個 regression tests。
- 本文件。

## 驗證

在 `C:\GPT_MCPtool\OMI_search\ui\tw-market-dashboard`：

```powershell
node --import tsx --test src/workspace-evidence-g3.test.ts
npm test
npm run typecheck
node .tmp/g3-ui-status-20261010/build.mjs
```

- targeted **10/10**；full Node **140/140**，沒有 failed／skipped。
- TypeScript strict typecheck 通過。既有市場卡片、研究摘要、selection、chart lifecycle、height、SYNTHETIC 與 bridge tests 均保留。
- 隔離 build 通過：`.tmp/g3-ui-status-20261010/dist/index.html`，535,744 bytes。沒有執行會覆蓋正式 dist 的 `npm run build`。
- 隔離 build 使用現有 `scripts/build.mjs` 的副本，只將 `projectRoot` 指回原 UI source，將最後 HTML 輸出目錄改為 `.tmp/g3-ui-status-20261010/dist`。bundle 選項、HTML template 與依賴均沿用；原 build script 未修改。
- `git diff --check -- OMI_search` 通過（exit 0，只有既有 LF/CRLF conversion warnings）。baseline 對本次 source 的 `git -c core.autocrlf=false diff --no-index --check` 沒有 whitespace 診斷；exit 1 表示檔案有差異。本次 source 相對 baseline 為 +48/-23 行，三個交付檔案的 strict UTF-8／replacement character／trailing whitespace 檢查通過。
- 額外強制 `core.autocrlf=false` 檢查整個 OMI_search 時，既有 `tests/test_server.py:312–317` 的 CRLF 被回報為 trailing whitespace；該檔前後 hash 相同。本輪沒有修改此範圍外的 WIP，正常 repo EOL 設定下 diff check 通過。
- package 沒有獨立 lint script。此輪用 React SSR 驗證 badge 密度、詳情內容與 lazy disclosure；未做瀏覽器／ChatGPT host 視覺或 live MCP 驗收。

## WIP 與正式產物保護

起始 branch `main`；root `git status --short --untracked-files=all` 共 155 paths，其中 OMI_search 為 52 paths。`workspace-evidence.tsx` 原本即為 untracked WIP，不能用 HEAD diff 宣稱整檔是本次新增。

修改前保存 85 個 OMI_search 檔案（含正式 `dist/index.html`）的 SHA-256，以及原始 `workspace-evidence.tsx` bytes。驗證後，既有檔案只有 `workspace-evidence.tsx` hash 改變；其他 84 個檔案不變。新增路徑只有本次 test 與本文件，無既有路徑消失。

- 保留的本機證據：`ui/tw-market-dashboard/.tmp/g3-ui-status-20261010/baseline.json` 與 `workspace-evidence.before.tsx`。`.tmp` 受 Git ignore 保護。
- Git index SHA-256 前後不變：`E1DD583C7239D02E4131A825C1A56F73CAA026AF2ACE697BB36B6B384268BB40`。
- 正式 dist SHA-256 前後不變：`D96D724A1F32BB924794D61BD05ACF6FD4111441AE4BC9D27D25D26DC9028869`。
- `server.py`、兩份 generated snapshots、`WorkspaceApp.tsx`、`workspace-state.ts`、`workspace-technical.tsx` 及所有既有 tests 均通過原 bytes hash 比對。

未更動或執行主 OMI／Backend G1 job `3a82b4c7-2cf4-4d1d-8a6a-0c88d502fbd6`；未做 G2 Schema／研究投影接線、Provider／DB 操作、正式 runtime 採用、restart、commit 或 push。後續 G2 與正式 UI 採用仍需各自驗證，不能以本輪 source checks 宣稱完成。
