## 摘要

<!-- 說明改了什麼、為什麼需要，以及使用者或維運者會看到的差異。 -->

## 變更範圍

<!-- 列出受影響元件、public contract、資料邊界與明確不在範圍內的項目。 -->

## 驗證

<!-- 列出實際執行的命令與結果。若未執行，請說明原因。 -->

## 風險與相容性

<!-- 說明 behavior、schema、資料、Windows lifecycle、deployment 或 UI 風險。沒有已知重大風險時請明寫。 -->

## 檢查清單

- [ ] 我已閱讀根目錄與受影響元件的 `AGENTS.md`／`README.md`。
- [ ] 此 PR 沒有夾帶無關重構、dependency upgrade 或格式化-only diff。
- [ ] public tool／API／path／launcher 相容性已保留，或已清楚文件化 migration。
- [ ] 我已檢查 staged files，沒有 secret、私人資料、runtime state、database、log、cache、build output 或下載的 executable。
- [ ] 範例與 fixture 使用 synthetic placeholder，不含可用 credential 或私人識別值。
- [ ] 文件、測試與實作彼此一致；未驗證或未部署的狀態已明確標示。
- [ ] 我已列出實際執行的最小充分驗證，且沒有把未執行的檢查寫成通過。
