# GPT MCP Tool Workspace

這個 repository 保存七個本機 MCP 專案、一個非 MCP 的 KGI Broker Bridge 與一個 Windows
runtime 中樞的公開原始碼。它採用 source-only monorepo：七個 MCP 元件維持各自的依賴、
啟動方式、測試、PID authority 與安全邊界，不把程式碼攤平成單一套件，也不由中樞接管
domain data 或 component lifecycle。

目前 workspace release 為 `1.1.0`。本次依各元件既有 SemVer 提升 minor：Project Reading 為 `1.5.0`、English Study 為 `0.3.0`，其餘 application／package 為 `1.1.0`。MCP protocol、schema、registry 與 domain contract 版本維持各自獨立演進，不隨 workspace release 重新編號。

> 這是 source-only repository。個人資料、SQLite、DPAPI 密文、tunnel profile、
> token、log、PID、cache、虛擬環境、編譯輸出、下載的 executable，以及本機 Agent／Codex
> 指令與 session state 都不應進入 Git。

## 專案一覽

| 目錄 | 定位 | 主要技術 | 外部依賴 |
| --- | --- | --- | --- |
| [`OMI_search`](./OMI_search/) | OMI 的 read-only MCP adapter | Python | 需要 Open Market Intelligence backend 的 `POST /api/ai/ask` |
| [`Memory Core`](./Memory%20Core/) | local-first 個人記憶 API、MCP 與 candidate review system of record | Python / FastAPI / SQLite | 正式資料只存在本機且不進 Git |
| [`japanese_study`](./japanese_study/) | Japanese Study Hub 的 bounded MCP adapter | TypeScript / Node.js | 需要 Japanese Study Hub HTTP API |
| [`english_study`](./english_study/) | English Study Hub 的獨立 bounded MCP adapter | TypeScript / Node.js | 需要 `C:\project\english-study-hub` HTTP API；第一版不含音訊，tunnel 由元件自行管理 |
| [`project_reading`](./project_reading/) | explicit allowlist、多 root、read-only workspace MCP | TypeScript / Node.js | 需要使用者自行設定允許讀取的本機 roots |
| [`codex_bridge`](./codex_bridge/) | ChatGPT MCP Apps 到本機 Codex App Server 的受控工作交接 | TypeScript / Node.js | 需要可執行且已登入的 Codex CLI、專案 allowlist 與專屬 tunnel id |
| [`personal-asset-os`](./personal-asset-os/) | local-first 個人資產帳本、dashboard 與唯讀 MCP | Python / FastAPI / React / SQLite | 正式財務資料只存在 `%LOCALAPPDATA%\PersonalAssetOS`，不進 Git |
| [`personal-asset-os/kgi_broker_bridge`](./personal-asset-os/kgi_broker_bridge/) | PAOS 專用的 KGI 帳務／持倉唯讀隔離 bridge；不是 MCP | Python / FastAPI | 已接 PAOS read-time valuation overlay；原始持倉不持久化 |
| [`mcp_control_center`](./mcp_control_center/) | 可擴充的 Windows runtime orchestration／observability 中樞；本身不是 MCP | PowerShell / WinForms | 只使用 registry 中各元件宣告的 lifecycle 與 loopback health／readyz |

各元件的公開操作方式、依賴、契約與安全邊界以目錄內的 `README.md` 為入口。本機 Agent
工作指令不屬於產品原始碼，由 `.gitignore` 排除且不作為公開操作文件。

## 目前架構狀態

- 七個 MCP component controller 採用 `unified-lifecycle-v3`，由元件自己持有固定 action、
  mutex、PID／owner metadata、listener 與 process lineage 判斷。
- PID 只是 locator，不是 process identity。可變更 runtime 前必須取得同一個 native process
  instance handle，核對 executable、start time、owner metadata 與 lineage，並透過同一 handle
  執行終止；不能在驗證後重新用 numeric PID 尋找並終止程序。
- `OwnershipUnknown`、`OwnershipMismatch`、foreign listener、multiple listener 或 controller
  inspection failure 一律 fail closed，保留 PID／owner evidence 並交由人工處理。
- MCP Control Center 是 orchestration／observability 中樞，不是 MCP server，也不讀取 domain
  payload、credential 或 private runtime state。Reconcile 在每次自動 mutation 前重新取得
  bounded controller ownership audit。
- Startup adoption、source validation、目前 runtime adoption 與 Windows cold boot acceptance 是
  分開的驗收 gate；source test 通過不代表 running process 已重載或 reboot gate 已完成。

完整 lifecycle contract 與 tunnel PID writer 邊界見
[`LifecycleOwnershipPolicy.md`](./mcp_control_center/docs/LifecycleOwnershipPolicy.md) 與
[`TunnelPidWriterAudit.md`](./mcp_control_center/docs/TunnelPidWriterAudit.md)。

## Repository 文件

- [Security Policy](SECURITY.md)：漏洞回報、敏感資訊處理、元件 trust boundary 與事件原則。
- [Contributing](CONTRIBUTING.md)：元件邊界、文件／驗證標準、Git 與公開安全流程。
- [Changelog](CHANGELOG.md)：尚未發布與未來 tagged release 的變更紀錄。
- [Code of Conduct](CODE_OF_CONDUCT.md)：公開互動、執行標準與事件回報原則。
- [Support](SUPPORT.md)：支援範圍、提問方式、必要診斷資訊與隱私界線。

本 repository 目前未加入 `LICENSE`；公開可見不等於授予軟體使用或再散布權利。

## 元件邊界

七個元件可分開維護與測試，但目前的 Windows 本機 runtime 有兩類明確相依：

- `OMI_search` 是 OMI backend 的薄 adapter，不持有市場資料或 freshness 邏輯。
- `japanese_study` 是 Japanese Study Hub 的薄 adapter，不直接讀取教材、Anki 或 Hub database。
- `english_study` 是 English Study Hub 的獨立薄 adapter，不共用 Japanese Study 的 API、database、PID 或 port。
- `OMI_search` 與 `Memory Core` 的部分 Windows lifecycle script 會重用
  `project_reading` 的 tunnel client／key-store 安裝位置。這是本機 runtime 資源重用，
  不是 MCP protocol 或資料層耦合。
- `codex_bridge` 也重用 `project_reading` 的 tunnel client／key-store 安裝位置，但使用自己的
  tunnel profile、health port 與 `C:\CodexBridge` job store，不共享 MCP session 或 job data。
- `personal-asset-os` 自帶 tunnel client runtime；source 位於 monorepo，但 `.env`、profile、log、
  executable 與正式財務資料仍維持 Git-ignored／repo-external。
- `personal-asset-os/kgi_broker_bridge` 是 PAOS-owned、non-MCP、read-only process boundary。
  它不寫 PAOS Ledger／database，不向其他元件暴露個人持倉，也不提供下單能力；`kgisuperpy`、
  CA、credential 與 session 必須留在獨立 runtime。目前尚未登錄 Control Center 或接入正式帳號。

Control Center 另外提供唯讀的
[`tunnel-runtime-inventory-v1`](mcp_control_center/docs/ChildProcessNetworkPolicy.md)，列出七個
production component 實際使用的 executable path、version、SHA-256 與來源 cohort。候選共用位置
是 `runtime\tunnel-client\`，但 repository 不包含 binary，也不會自動下載、升級或切換；各元件
保留 explicit `TunnelClientPath` override，採用前必須逐元件完成相容性與 rollback 驗證。

所有 component-owned controller 只在建立 child process 時清除 ambient HTTP(S) proxy，並明確
bypass `127.0.0.1`／`localhost`；parent shell 與 Windows 全域 proxy 不會被修改。需要企業 outbound
proxy 時，必須使用 component-owned 明確設定，不依賴啟動 session 的隱含環境。

因此，在同一台既有 Windows 主機上應保留目前七個頂層目錄名稱。若日後要把其中一個
元件拆成獨立 repository，應先把該元件的 runtime 安裝依賴改成 self-contained，
再更新 README、啟動捷徑與驗證命令。

## Git 與公開安全

GitHub repository 目前是 public。提交前至少要確認：

1. `git status --short` 沒有列出 `.secrets/`、`.tunnel-client/`、`.tmp/`、
   `data/`、`.env`、database、log、PID、cache、`node_modules/`、`.venv/`
   或下載的 `tunnel-client.exe`。
2. `.env.example` 只包含 placeholder，不包含任何可用 credential。
3. 文件與測試沒有不應公開的個人內容、私有資料內容或公司機密。
4. `AGENTS.md`、`.agents/`、`.codex/`、`.codex-remote-attachments/` 與
   `docs/agent-runs/` 等本機 Agent／Codex state 沒有出現在 staged paths。
5. 只提交 source、lockfile、migration、測試、範例與必要文件。

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

cd C:\GPT_MCPtool\english_study
npm test

cd C:\GPT_MCPtool\project_reading
npm test

cd C:\GPT_MCPtool\codex_bridge
npm test
npm run smoke:http

cd C:\GPT_MCPtool\personal-asset-os
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate.ps1

cd C:\GPT_MCPtool\personal-asset-os\kgi_broker_bridge
.\.venv\Scripts\python.exe -X utf8 -m pytest -q

cd C:\GPT_MCPtool\mcp_control_center
powershell -NoProfile -ExecutionPolicy Bypass -File tests\run-tests.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\control-center.ps1 -Action SelfTest
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tray.ps1 -SelfTest
```

Live backend、tunnel 與 browser／ChatGPT connector smoke 不是單純 source archive 的
預設驗證；需要驗證部署狀態時，應依各元件 README 另外確認正確 PID、port、owner
與代表性 MCP call。

## Windows 托盤與統一 lifecycle

目前七個正式元件都以 `unified-lifecycle-v3` component controller 接入單一可見的
`MCP Control Center` tray。中樞統一提供狀態、ensure、connectivity repair、core restart、
full reload、逐元件 shutdown，以及由 `component-menu-v1` 接回的舊托盤功能；不提供 Stop All，
也不以 process name 廣泛終止程序。

舊功能直接顯示於每個元件子選單，但由元件自己的 `control-center-ui.ps1` 執行；中樞不接觸
credential、tunnel ID、domain payload 或備份內容。按需 diagnostic tray 則保留為
`Open troubleshooting tools` 的完整故障處理 fallback，且不持有 runtime。v3 啟用後，舊 tray script 的持久化啟動會 fail closed，
避免舊 Startup、helper 或 launcher 再次接管已由 Control Center 管理的服務。

English Study 已完成本機 lifecycle、MCP 與固定埠驗證，現在由 Control Center 常駐 Hub、MCP 與元件自有 tunnel，並透過元件自有 launcher 開啟唯讀 English Study 桌面；
音訊仍不在目前採用範圍；remote registration 與 ChatGPT connector 必須各自驗證，不能只由本機 tunnel ready 推論。
KGI Broker Bridge 已具備隔離式 read-only live adapter，並完成正式 KGI credential／CA
qualification；它由 PAOS server 依設定啟動與消費，仍不是 Control Center component，且不保存
原始持倉 snapshot 或提供交易能力。
這個統一只涵蓋 lifecycle contract，不合併元件實作。七個 MCP 仍各自在頂層資料夾內
持有依賴、資料、測試、安全界線、PID authority 與 primary/domain UI；個別差異由 descriptor
traits/capabilities 與 component-owned controller module 表達。舊 `unified-always-on-v2` tray、
launcher、Startup／restore artifact 目前保留作 rollback，但不再是正式常駐入口。

托盤 Restart 只能證明本機 runtime 已重載。ChatGPT connector 若仍顯示舊的 tool schema，
仍需在 host 端 Refresh Actions／重新連線或開新對話；不要把本機 process restart 當成
host action snapshot 已更新的證據。

`mcp_control_center` 從 registry 載入 component-owned descriptor、集中檢查七條 enabled always-on
chain、保存 boot／status／action 事件，並以可回復流程把 Startup 收斂成一個入口。
`config/components.json` rollback manifest 仍保留。New Component Kit 提供單一 base template、
read-only validator，以及 SHA-guarded Plan／Apply／receipt／rollback 註冊流程；新 entry 固定
從 disabled、非 auto-start 開始，完成自己的 exact ownership 與 targeted lifecycle tests 後才可
啟用。詳細操作與安全界線見
[`mcp_control_center/README.md`](./mcp_control_center/README.md)。

所有 Stop／Reload 路徑都必須在 component mutex 內先完成 bounded ownership snapshot。單一程序
要以已驗證且已開啟 handle 的同一 instance 終止；process tree 則要在第一個 kill 前完成 root
與所有存活 descendant 的 instance binding、owner 與 lineage 驗證，再 deepest-first 終止。
若 PID file、owner sidecar、listener query、process inspection 或 lineage 無法得到肯定證據，
controller 必須回傳 `OwnershipUnknown` 或 `OWNERSHIP_CHANGED`，不得清除 evidence 或嘗試接管。

日常 Control Center tray 已收斂為每個元件最多三項：狀態感知的 `Restart MCP`、統一 `Open MCP health` 詳情頁，以及 descriptor 明確宣告時才顯示的正式 frontend。維修層的 connectivity repair、core-only restart、shutdown、URL/Tunnel/Logs 等能力仍保留在 component controller、Health > Advanced 或 CLI，不由 tray 第一層直接暴露。
