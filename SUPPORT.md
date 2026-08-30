# 支援指南

## 支援範圍

本 repository 以 best-effort 方式處理下列事項：

- 可由目前 `main` 原始碼重現的錯誤；
- 文件缺漏、矛盾、失效連結或不清楚的操作步驟；
- 與公開 MCP contract、schema、tool behavior 或元件邊界有關的問題；
- 安裝、build、test 與已文件化 Windows lifecycle 的診斷；
- 不破壞既有 trust boundary 的功能提案。

這不是託管服務，也沒有保證回覆時間、修復時間或版本支援 SLA。正式 runtime、私人資料與
第三方 backend 仍由各自擁有者管理。

## 提問前

1. 閱讀根目錄與目標元件的 `README.md`、`SECURITY.md` 及相關 tracked `docs/`。
2. 搜尋既有 issue，確認問題尚未被回報或已有替代方案。
3. 使用目前 `main` 或清楚提供 commit SHA；不要只寫「最新版」。
4. 執行最接近問題的最小驗證，不要為了提問重啟或清除無關 runtime。
5. 移除所有 secret、私人資料、公司資訊、實際帳務／記憶／學習內容及本機識別值。

## 開啟 issue

從 GitHub 的 New issue 頁面選擇最接近的表單：

- **錯誤回報**：目前行為與文件或 contract 不一致，且可安全重現。
- **功能提案**：描述問題、期望 outcome、元件 owner 與安全邊界。
- **文件問題**：指出確切頁面、段落、錯誤內容與可驗證修正。
- **使用問題**：已查閱文件，但仍需要釐清設定或操作方式。

請提供元件名稱、commit SHA、Windows／runtime 版本、最小重現步驟、預期／實際結果，以及已
執行的檢查。貼 log 時只保留必要片段，並以 placeholder 取代 token、使用者名稱、私人路徑、
tunnel id、port mapping、資料內容與 endpoint。

## 不應公開的內容

不要在 issue、PR、gist、screenshot 或附件中放入：

- API key、token、cookie、password、private key、authorization header 或 DPAPI 內容；
- `.env`、`.local`、tunnel profile、private endpoint、完整環境變數或 process dump；
- `AGENTS.md`、`.agents`、`.codex`、Agent run notes、Codex session／memory 或 remote attachment；
- SQLite、WAL／SHM、backup、export、log、PID、cache 或正式 runtime artifact；
- 個人財務、記憶、學習、job、workspace diff 或公司機密內容。

疑似安全漏洞或資料外洩請依 [`SECURITY.md`](SECURITY.md) 使用 private vulnerability
reporting，不要建立含細節的公開 issue。

## 不在一般支援範圍

- 代管私人 runtime、資料庫、tunnel 或第三方帳號；
- 復原未經驗證的私人資料、遺失 credential 或未備份的正式資料；
- 任意客製 reverse proxy、跨網路暴露或繞過公司／平台政策；
- 無法以 synthetic 資料描述，且需要接觸私人內容才能診斷的問題；
- 未經元件 owner 核准的 breaking contract、資料 migration 或高風險自動化。

若問題屬於外部 backend，請先確認是哪個系統擁有資料、schema、freshness 或 lifecycle，再到
正確的 repository／support channel 回報。Adapter repository 不會取代 domain owner。
