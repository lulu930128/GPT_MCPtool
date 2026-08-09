# Codex Handoff Bridge

此元件把 ChatGPT 對話中的結構化工作包交給本機 Codex App Server，並把狀態、
diff、測試結果與核准請求投影回 MCP Apps 控制台。

## 安全邊界

- 這是私人、受控的遠端工程入口，不得用來規避公司、workspace、網路或資料外傳政策。
- MCP 工具只接受設定過的 `project_id`；不得接受任意絕對路徑、任意 shell command、
  commit、push、delete、database mutation 或公開發布要求。
- Codex App Server 只能由本機 controller 以 stdio 啟動。不要把 App Server WebSocket
  listener 暴露到 public internet。
- 寫入型 job 必須使用 `approvalPolicy=on-request`，且預設停用 network access。
- `codex_job_dispatch`、`codex_job_cancel`、`codex_job_steer` 與
  `codex_approval_decide` 是 UI-only actions；不得讓模型自行核准自己的動作。
- 核准只適用於目前 request 的 exact id。第一版不提供 session-wide approval。
- Job、event、diff 與 result 是本機 runtime state，放在 `CODEX_BRIDGE_DATA_DIR`，
  不得進 Git。Log 與 UI payload 不得輸出 token、secret 或完整環境變數。
- 不自動 commit、push、套用到其他 worktree 或清理使用者既有變更。

## 專案與路徑

- 專案 allowlist 來自 ignored 的 `.local/projects.json` 或
  `CODEX_BRIDGE_PROJECTS_FILE`。
- 所有專案路徑必須解析為現存目錄，重複 id、未知 id、相對路徑與檔案路徑都拒絕。
- Job 目錄由 server 產生 UUID，不能由 MCP caller 指定。

## 驗證

- TypeScript 或 MCP contract 變更後執行 `npm test`。
- HTTP transport、health 或工具 wiring 變更後執行 `npm run smoke:http`。
- Widget 變更後至少執行 widget 靜態檢查；可用時再做 ChatGPT Developer Mode smoke。
- Tray 變更後先執行 `npm run tray:selftest`；replacement 必須使用 exact-path ownership。
