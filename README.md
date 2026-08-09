# GPT MCP Tool Workspace

這個 repository 保存六個本機 MCP 專案與一個 Windows runtime 中樞的原始碼。它採用 monorepo：
六個 MCP 元件維持各自的依賴、啟動方式、測試與安全邊界，不把程式碼攤平成單一套件。

> 這是 source-only repository。個人資料、SQLite、DPAPI 密文、tunnel profile、
> token、log、PID、cache、虛擬環境、編譯輸出與下載的 executable 都不應進入 Git。

## 專案一覽

| 目錄 | 定位 | 主要技術 | 外部依賴 |
| --- | --- | --- | --- |
| [`OMI_search`](./OMI_search/) | OMI 的 read-only MCP adapter | Python | 需要 Open Market Intelligence backend 的 `POST /api/ai/ask` |
| [`Memory Core`](./Memory%20Core/) | local-first 個人記憶 API、MCP 與 candidate review system of record | Python / FastAPI / SQLite | 正式資料只存在本機且不進 Git |
| [`japanese_study`](./japanese_study/) | Japanese Study Hub 的 bounded MCP adapter | TypeScript / Node.js | 需要 Japanese Study Hub HTTP API |
| [`project_reading`](./project_reading/) | explicit allowlist、多 root、read-only workspace MCP | TypeScript / Node.js | 需要使用者自行設定允許讀取的本機 roots |
| [`codex_bridge`](./codex_bridge/) | ChatGPT MCP Apps 到本機 Codex App Server 的受控工作交接 | TypeScript / Node.js | 需要可執行且已登入的 Codex CLI、專案 allowlist 與專屬 tunnel id |
| [`personal-asset-os`](./personal-asset-os/) | local-first 個人資產帳本、dashboard 與唯讀 MCP | Python / FastAPI / React / SQLite | 正式財務資料只存在 `%LOCALAPPDATA%\PersonalAssetOS`，不進 Git |
| [`mcp_control_center`](./mcp_control_center/) | 六個 MCP runtime 的 Windows orchestration／observability 中樞；本身不是 MCP | PowerShell / WinForms | 只使用各元件既有 lifecycle 與 loopback health／readyz |

請先閱讀各目錄的 `README.md` 與 `AGENTS.md`；它們才是該元件的正式操作與安全規則。

## 元件邊界

六個元件可分開維護與測試，但目前的 Windows 本機 runtime 有兩類明確相依：

- `OMI_search` 是 OMI backend 的薄 adapter，不持有市場資料或 freshness 邏輯。
- `japanese_study` 是 Japanese Study Hub 的薄 adapter，不直接讀取教材、Anki 或 Hub database。
- `OMI_search` 與 `Memory Core` 的部分 Windows lifecycle script 會重用
  `project_reading` 的 tunnel client／key-store 安裝位置。這是本機 runtime 資源重用，
  不是 MCP protocol 或資料層耦合。
- `codex_bridge` 也重用 `project_reading` 的 tunnel client／key-store 安裝位置，但使用自己的
  tunnel profile、health port 與 `C:\CodexBridge` job store，不共享 MCP session 或 job data。
- `personal-asset-os` 自帶 tunnel client runtime；source 位於 monorepo，但 `.env`、profile、log、
  executable 與正式財務資料仍維持 Git-ignored／repo-external。

因此，在同一台既有 Windows 主機上應保留目前六個頂層目錄名稱。若日後要把其中一個
元件拆成獨立 repository，應先把該元件的 runtime 安裝依賴改成 self-contained，
再更新 README、啟動捷徑與驗證命令。

## Git 與公開安全

GitHub repository 目前是 public。提交前至少要確認：

1. `git status --short` 沒有列出 `.secrets/`、`.tunnel-client/`、`.tmp/`、
   `data/`、`.env`、database、log、PID、cache、`node_modules/`、`.venv/`
   或下載的 `tunnel-client.exe`。
2. `.env.example` 只包含 placeholder，不包含任何可用 credential。
3. 文件與測試沒有不應公開的個人內容、私有資料內容或公司機密。
4. 只提交 source、lockfile、migration、測試、範例與必要文件。

不要用 `git add -f` 繞過忽略規則。若某個 ignored artifact 確實需要發布，
應先確認授權與資料風險，再使用獨立 release artifact 或可重現的安裝腳本。

## 基本驗證

每個元件使用自己的驗證方式：

```powershell
cd C:\GPT_MCPtool\OMI_search
python -B -m unittest discover -s tests

cd "C:\GPT_MCPtool\Memory Core"
uv run pytest
uv run ruff check .

cd C:\GPT_MCPtool\japanese_study
npm test

cd C:\GPT_MCPtool\project_reading
npm test

cd C:\GPT_MCPtool\codex_bridge
npm test
npm run smoke:http

cd C:\GPT_MCPtool\personal-asset-os
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate.ps1
```

Live backend、tunnel 與 browser／ChatGPT connector smoke 不是單純 source archive 的
預設驗證；需要驗證部署狀態時，應依各元件 README 另外確認正確 PID、port、owner
與代表性 MCP call。

## Windows 托盤慣例

六個元件使用 `unified-always-on-v2` 托盤契約：真實 Server／Tunnel 狀態、
`Restart MCP server`、三個 Copy、三個 Open、元件特有操作，以及最後的 `Exit`。
正式 tray 啟動會一起準備本機 server、已配置的外部 API 能力與 Secure MCP Tunnel；
不提供 Start／Stop 或 tunnel restart 前端開關。外部 API 可用不代表背景自動呼叫，
仍須由原本的明確操作觸發。`Exit` 是唯一完整關閉入口，會停止 server、tunnel 與 tray。

一般的 `Start-Tray.cmd` 不會取代既有 instance；程式更新後使用各元件
`scripts\Restart-Tray.cmd`，由 exact-path replacement 流程重載並保留元件自己的資料與
安全邊界。

托盤 Restart 只能證明本機 runtime 已重載。ChatGPT connector 若仍顯示舊的 tool schema，
仍需在 host 端 Refresh Actions／重新連線或開新對話；不要把本機 process restart 當成
host action snapshot 已更新的證據。

`mcp_control_center` 可以在不合併元件資料或 domain contract 的前提下，集中檢查六條
always-on chain、保存 boot／status／action 事件，並以可回復流程把六個 Startup shortcut
收斂成一個入口。詳細操作與安全界線見 [`mcp_control_center/README.md`](./mcp_control_center/README.md)。
