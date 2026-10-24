# 最小音檔下載測試

此版只驗證 MCP App host-mediated download，不是播放器或正式下載相容性保證。

## 使用

1. 更新 Listening Audio App 的工具清單（Refresh／重新連線），確認有 `listening_render_question`。
2. 使用現有 setId／questionId 呼叫 `listening_get_question`。音檔 ready 後呼叫 `listening_render_question`。
3. 卡片只呈現題號、檔名、大小及下載按鈕，不呈現題幹、選項或答案。
4. 按下載；若回報不支援，展開「測試狀態」記錄 capability。不要把自訂 URI 當 HTTP URL。
5. Client 接受請求不代表已寫入檔案。以實際下載檔案、WAV 可播放及相同 bytes／SHA-256 驗收。

下載使用 `ui/download-file` 的 ResourceLink，URI 仍由 server 生成。
不新增 download endpoint、不複製 WAV、不使用 attachment、data URL 或 iframe anchor fallback。
missing/stale 不提供 link；取消、拒絕、timeout 會保留可理解的失敗狀態。

## Build 與驗證

- `npm run build`：esbuild 將官方 App SDK 與 UI 打成單一 HTML，再編譯 MCP。
- `npm test`、`npm run smoke:http`：資料工具相容性、UI MIME／metadata、ready/missing/stale、安全投影。
- `node scripts/smoke-ui.mjs`：需現有 Playwright 與 Edge；可設定 `PLAYWRIGHT_PACKAGE` 為已安裝套件路徑。
  以官方 AppBridge 的本機模擬 host 驗證支援／不支援／拒絕／失敗及 WAV 下載，不能當成 ChatGPT 驗收。
- `node scripts/smoke-managed.mjs`：正式六工具、UI resource bytes、buildId 及 tunnel 採用。
- buildId 包含 UI；controller 拒絕缺少或比 source 舊的 UI bundle。UI URI 為 `ui://listening-audio/question-download-v1.html`。

選用 ext-apps 1.7.5，與現有 MCP SDK 1.29.0／Zod 3 相容，不追隨 SDK 2 的 main。

## 官方依據

- https://developers.openai.com/plugins/build/chatgpt-ui
- https://github.com/modelcontextprotocol/ext-apps/blob/v1.7.5/src/app.ts
- https://github.com/modelcontextprotocol/ext-apps/blob/v1.7.5/src/spec.types.ts

ChatGPT 真實 host 的 capability、自訂 resource URI 解析及下載落地尚待使用者測試。
本次最小測試可使用現有 `LIVE-JA-SIMPLE-20260912-02`／`Q001`（445484 bytes），不需要重新生成音訊。
