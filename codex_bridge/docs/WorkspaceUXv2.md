# MCP Apps Workspace UX v2 第一版交付

## 2026-10-09 failure presentation 微調

本次只修改 `web/codex-console.html`、`tests/workspace-widget.test.ts`、`scripts/check-widget.mjs`、
`docs/ConversationModel.md` 與本文件，保留既有 dirty state；未修改 backend truth / action safety / fork policy。

主對話與 inline 改用共用的純前端 failure classification。Recovery 僅在同 turn 後續確認成功，且 MCP server/tool、
exact command/cwd 或非空 file path set 有明確對應時成立；redacted/truncated identity 不採認。
Historical/recovered 留在 Workstream 技術活動與真實 failure 計數中；原始 status/error 不變。
Current unresolved error、失敗終止原因與 pending/declined/expired approval 保持可見。
Workstream 摘要顯示技術活動 / 成功 / 失敗 / 已恢復 / 非零待處理，recovered 卡保留「失敗」與中性「已恢復」標記。
Inline 保留完整最後 narrative turn，技術警示最多一張；無公開原因的工具失敗只顯示安全說明。
完整判定規則見 [ConversationModel.md](ConversationModel.md)。

驗證：`npm run build`、`npm test`（129/129，含 19 個 widget deterministic tests）、`npm run widget:check`、
`npm run smoke:http`（isolated random port/temp runtime，32 tools / 13 app-only / previewCreatedJobs=0）與
`git diff --check -- codex_bridge` 通過。
Isolated smoke 候選 buildId 為 `c00f4c4d61f5085c`，controller=idle；不是 live runtime identity。
本輪未 restart core/tunnel、未 commit/push、未執行 browser/host adoption 驗證。
Reviewer 在本輪後續已獨立確認：前一版 UX v2 已正式 live adoption，runtime buildId=`f0863c07c80b37e9`、controller=`ready`，且多個正式 Codex 對話持續使用正常。此次 failure-presentation 微調候選 buildId=`c00f4c4d61f5085c` 尚未 adoption；因當時仍有其他 active Codex jobs，依 lifecycle guard 不應重啟 core。以下保留前輪當時的交付快照，僅作歷史紀錄。

## 前輪交付紀錄

2026-10-09：source / deterministic fixture / isolated HTTP gates 通過。未 adoption live runtime。

## 本輪變更檔案

- `src/conversation-projection.ts`、`src/types.ts`：timestamp lineage、live immutable createdAt、native metadata merge。
- `src/job-store.ts`：snapshot/delta metadata、journal observation/activity 分離、direct action history eligibility。
- `src/unified-conversation-registry.ts`：沿用 projection merge 保留已證實時間及 telemetry，native content 仍 authoritative。
- `web/codex-console.html`：rail 搜尋/真實時間、sticky header/control actions、lazy status drawer、turn summaries、inline last narrative turn、reduced motion。
- `src/server.ts`、`scripts/smoke-http.mjs`、`scripts/smoke-live-mcp.mjs`：resource URI 更新為 `chat-workspace-v15.html`；未執行 live smoke。
- `tests/conversation-projection.test.ts`、`tests/job-store.test.ts`、`tests/workspace-widget.test.ts`、`scripts/check-widget.mjs`：regression 與 deterministic frontend fixture。
- `scripts/preview-workspace-fixture.mjs`：使用實際單檔 App 的隔離 MCP host 視覺 fixture，不連接 live runtime。
- `README.md`、`docs/ConversationModel.md`、本文件：資料語意、操作方式及驗收證據。

上述檔案以本輪開始時的 dirty worktree 為基礎局部修改，不能把整份 git diff 當成本輪新增內容。
其他 component 未修改；未 reset/revert/checkout/clean、commit、push 或 restart core/tunnel。

## 關鍵資料流

Native history → projection timestamp lineage → JobStore durable snapshot/revision patch → unified registry metadata merge → App keyed timeline。
Message UI 只顯示 createdAt；未知不顯示。Legacy checkpoint 無 lineage 的時間降為可靠 turn time 或 unknown。
Native item time 優先，exact Bridge user metadata 次之；assistant fallback completedAt/startedAt。Hydration/streaming 不以現在覆寫訊息建立時間。

既有 tokenUsage/modelRouting 經完整與增量投影進 header；累計用量不被當成 context pressure。
Usage/runtime/inventory 僅由 fullscreen drawer 開啟/手動刷新讀取，各分項獨立顯示 unknown/unavailable/error。
Review/Compact 經明確 click、exact job/thread/turn、新 requestId 進既有 Controller；accepted 後沿用 job polling/history。
前端同一 identity 不自動換 requestId 重試；真正 eligibility、native idle、classification 與 replay safety 仍由後端控制。

## 驗證

| 指令 / gate | 結果 |
| --- | --- |
| `npm run build` | 通過 |
| `npm test` | 119/119 通過，0 failed / skipped |
| `npm run widget:check` | 通過，MCP Apps、0 remote resources |
| `npm run smoke:http` | 通過，isolated random port/temp runtime；32 tools、13 app-only tools、previewCreatedJobs=0 |
| `node --check scripts/preview-workspace-fixture.mjs` | 通過 |
| `git diff --check -- codex_bridge`（monorepo root） | 通過；Git 僅提示現有 LF/CRLF normalization |

Isolated smoke buildId：`f0863c07c80b37e9`。此值不是 active runtime identity。
新增 fixture 覆蓋不同 hydration 時刻、native/durable/turn fallback、legacy clock、streaming、journal-only replay、
createdAt rendering、inline grouping、error 可見性、telemetry delta、lazy single-flight/cache、partial/null/error、exact actions、sticky/reveal/reduced-motion。

## 尚未驗證與 adoption

Browser visual gate：**Unverified**。Chrome CUA 初始化只嘗試一次，在取得 DOM/screenshot 前失敗：
`Restricted read-only access requires the elevated Windows sandbox backend`。
沒有重試、變更 sandbox、或因環境失敗修改視覺實作。Fixture server 已關閉。
因此 desktop/mobile 像素品質、實際 keyboard/focus/scroll 與 ChatGPT host presentation 尚無 browser 證據；現有證據限 source 與 deterministic fixtures。

Active Bridge buildId 未在本輪探測；使用者提供的 `905058b1dd60edbd` 是背景資訊，不是本輪驗證結果。
新版要進 live 需要 Reviewer 決定並執行既有 lifecycle adoption/restart；本輪未重啟 core/tunnel，也未執行 real Review/Compact。
Adoption 後仍需確認 v15 resource 與 host card，舊卡片可能需要重新開啟。
