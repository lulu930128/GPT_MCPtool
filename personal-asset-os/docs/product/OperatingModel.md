# Operating Model

## 核心模組與責任

- Ledger Core：建立 immutable transactions／postings 並執行 balance invariant。
- Capture：保存可修改、可拒絕、可重送的 Financial Event；尚未 finalize 前不影響正式報表。
- Finalize：驗證 event version、核准來源與帳戶決策，原子化建立正式交易、lineage 與 audit。
- Portfolio：保存 trade detail 與 price facts，從帳本推導持倉及估值。
- Reconciliation：保存外部餘額證據，計算帳面差額，不直接改帳。
- Reporting：建立 dashboard read model 與可重現月結快照。
- Backup：使用 SQLite online backup、hash 與 integrity check 建立可驗證備份。
- HTTP API：驗證輸入與轉譯錯誤，不自行實作帳務規則。
- MCP Adapter：只投影既有 read model，所有工具宣告 read-only 且不提供 mutation schema。
- OpenAI Adapter：只有使用者手動觸發時才呼叫 Responses API；連線 smoke 不傳送個人財務資料。
- Frontend／Tray：操作與展示層，不是財務真相來源。

## 真相來源

- 正式帳務：`transactions + postings`。
- 日常捕捉：`financial_events`；它是 staging／外部證據，不是正式帳務真相。
- 捕捉與正式交易 lineage：`financial_event_transaction_links`。
- 投資事件細節：reference 到 transaction 的 `trades`。
- 投資持倉：由 trades 重建，不允許人工覆寫 positions cache。
- 市場估值：具 provider、price_at、quality 的 `prices`。
- 實際帳戶餘額：`balance_observations`，只作對帳證據。
- 月結：固定 as-of 與 metrics payload 的 `snapshots`。

## 權限與確認邊界

- 本機 UI 可建立 pending event，並核准資料完整的低風險 expense／income；正式交易仍只由 Finalize service 建立。
- 未來已配對手機可送出低風險核准意圖，不需電腦二次點擊；desktop 仍是唯一 validator／executor。
- 沖銷、期初餘額、調整、投資修正、匯入衝突、月結與裝置管理不得走手機低風險核准。
- 不提供 transaction update/delete 或 balance overwrite。
- 還原預設只能寫入新目標，不能覆蓋目前資料庫。
- AI 只能讀取 read model 或建立未來的 proposal，不能核准自己的提案。

## 外部整合邊界

- dashboard 與 REST API 永遠維持 loopback-only，不提供 public HTTP。
- Secure MCP Tunnel 只允許 outbound-only 連線到本機 `/mcp`，不可轉送 dashboard、REST write routes 或資料庫檔案。
- 目前 MCP 有既有六個工具，加上 bounded 的待處理 Financial Event 摘要，共七個唯讀工具。
- 目前沒有 mobile relay 或 bank API。
- 未來匯入與手機資料先進 staging；資料完整的低風險事件可帶已驗證核准意圖，其餘完成去重、檢查與人工核准後才能進 ledger。
- 市場資料 provider 只提供 price facts，不可替代 ledger 或交易證據。

## 資料保存與可回復性

- 正式資料與備份預設位於 `%LOCALAPPDATA%\PersonalAssetOS`。
- source repository 只保存程式、migration、測試、範例與文件。
- 每次備份保存 SHA-256 與 SQLite integrity result。
- restore smoke 必須在新路徑重建並核對帳戶、交易、快照與 audit 筆數。
