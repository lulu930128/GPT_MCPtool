# Quality Bar

## 產品品質標準

- 日常交易輸入不要求不必要欄位，但正式入帳前一定通過帳務不變量。
- 月底可看到未對帳筆數、差額、缺價與估值時間。
- 相同 idempotency key 重送不會建立重複交易。
- 備份不只建立檔案，還必須通過 integrity check 並可還原到新路徑。

## UX / UI 標準

- 使用 Fluent UI React，維持單一設計系統。
- 第一屏先顯示可對帳的資產複盤表、資產／股票／消費占比與資料品質；圓餅圖必須搭配精確金額表格。
- 歷史圖表資料不足時要說明累積狀態，不把少量離散點連成看似可靠的趨勢。
- 支援 desktop 與窄螢幕，不溢出、不遮擋，表單有 label、helper、error、loading 與 empty state。
- 手機日常記錄只要求金額與分類；描述明確標示選填。常用分類可從 bounded、可捲動且依保存次數排序的下拉選單直接點選，自訂分類保存後可重用。
- 低動效；只使用能表達 loading、成功、錯誤與狀態轉換的動畫。

## 技術品質標準

- SQLite migration 可追蹤，foreign key、WAL、busy timeout 與 transaction boundary 明確。
- domain service 不依賴 HTTP schema 或 React 元件。
- API 回傳 predictable error envelope，並保留 idempotent retry 行為。
- Tray 驗證 PID、command path、listener、health 與 build ID，不以 HTTP 200 單獨宣告成功。
- Mobile USB Bridge 必須在斷線／重連後恢復 exact reverse mapping；多裝置時 fail closed，status 不得
  洩漏 serial，且 bridge degraded 不得拖垮 core readiness。
- Mobile schema 升級不得改寫舊 outbox canonical payload/hash；分類缺失的新版 row 必須 fail closed。
- 舊交易分類／備註修正必須寫入獨立、版本化且有 audit 的報表註記；不得覆寫正式交易、分錄、Financial Event 或其 hash。
- 前景自動同步必須 single-flight；transport 尚未就緒時保留 pending，明確 failed row 只由手動操作重送，避免無界重試。
- MCP 驗證實際 protocol discovery、tool list、代表性 tool call 與 ledger 無副作用，不以 `/mcp` 回應碼單獨宣告成功。
- Tunnel 驗證 executable path、profile、loopback admin listener、`readyz` 與 current log markers；不得在輸出中顯示 key 或 tunnel credential。

## 資料與可信度標準

- 金額使用 Decimal／NUMERIC，不使用 binary float 寫入正式帳務。
- SQLite datetime 在 service boundary 正規化為 timezone-aware UTC。
- 市值揭露 provider、price_at、age 與 quality；缺價不靜默補零。
- dashboard 清楚區分 complete_manual、partial 與 unreconciled。
- 歷史圖表只讀明確保存的估值點；缺日維持 gap，broker／FX 不可用時不得補零。
- 每日排程在設定時間前不得讀取 broker；同日已有快照時不得重讀或覆寫。排程 failure 不可
  終止 server，shutdown 必須由 component lifecycle 收回 task。

## 驗證分級

- Domain：交易平衡、信用卡、投資、沖銷、idempotency targeted tests。
- Contract：API success／validation／conflict regression。
- Data：migration、projection rebuild、snapshot determinism、backup restore smoke。
- Runtime：production frontend、loopback API、health／build ID、representative transaction。
- MCP／Tunnel：in-process contract、local Streamable HTTP、Secure Tunnel doctor／ready 與遠端 discovery。
- UI：desktop／mobile viewport、loading／empty／error、主要工作流實際操作。

## 不可接受的捷徑

- 直接更新 balance、position 或歷史 posting。
- 以成本或零值冒充缺少的即時市價，且不顯示警告。
- 測試只檢查 HTTP 200，不核對帳務與 durable database state。
- 透過 broad process kill 管理 tray runtime。
