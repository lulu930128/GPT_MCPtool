# Roadmap

## 北極星目標

每天願意記、月底對得起來、隨時知道自己有多少資產，並能追溯每個答案使用的交易、價格與對帳證據。

## 近期優先順序

1. 建立本機帳務核心與可用 dashboard。
2. 建立月結、對帳、備份與 exact-path tray lifecycle。
3. 讓 Financial Event、Quick Capture、Pending Inbox 與低風險 finalize 成為可連續使用的日常入口。
4. 以相同 contract 建立手機 SQLite outbox、裝置配對、加密 relay 與桌面 pull worker。
5. 再設計 import staging 與銀行／信用卡 CSV mapping。
6. 以唯讀 MCP 累積真實查詢案例，再決定 AI proposal／approval 的最小資料契約。

## 里程碑

- First version：TWD 核心帳本、手動投資、估值品質、月結、備份、托盤。
- Import version：銀行／信用卡／券商匯入、去重、配對與人工核准。
- Capture version：Financial Event、Quick Capture、Pending Inbox、低風險 finalize 與第七個 pending read-only MCP tool（第一個垂直切片已完成）。
- Mobile version：手機 SQLite、加密 relay、device identity、idempotent sync 與低風險 approval envelope。
- AI read version：read-only MCP 工具、Secure MCP Tunnel、OpenAI 連線檢查。
- AI proposal version：解釋與 proposal／approval workflow；尚未實作，且 AI 不得自行核准。

## 延後事項

- 完整多幣別與 FX realized/unrealized accounting。
- 銀行與券商即時 API。
- 電子發票、PDF OCR、稅務估算。
- 家庭多使用者與跨裝置即時編輯。

## 風險與依賴

- 多幣別與證券 lot accounting 會顯著增加 schema 與對帳複雜度。
- 金融機構匯出格式不穩定，需要 importer version 與 raw row lineage。
- 加密 relay 的 key recovery、device revocation 與 metadata leakage 需要獨立 security design。
- 使用者真實操作三個月前，不應過早擴張自動化範圍。
