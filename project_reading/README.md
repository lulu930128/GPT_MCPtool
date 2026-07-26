# GPT Project Workspace MCP

這是一個 read-only 的 MCP server，目標是讓 ChatGPT 以受限方式讀取明確 allowlist 內的多個本機 workspace root。

預設範例提供三個 root id：

- `projects` → `C:\project`（預設）
- `mcp_tools` → `C:\GPT_MCPtool`
- `work` → `C:\work`

每個工具都接受可選的 `root`；省略時使用 `projects`。路徑仍必須相對於所選 root，不能傳入其他磁碟或任意絕對路徑。

額外 root 與 root-specific deny rule 屬於本機設定。可把
`examples/tray-settings.example.json` 複製成 ignored 的
`.local/tray-settings.json`，再加入實際核准的路徑；不要把個人路徑提交到 Git。

第一版刻意不提供寫檔、刪檔、任意 shell、commit、push 或 database mutation。它只提供可審計的 workspace browsing、文字搜尋、檔案讀取與 git status summary。

## 工具

- `workspace_info`：回傳目前 root allowlist、預設 root、限制與安全政策摘要。
- `list_projects`：列出指定 root 的直接子資料夾，標示 README、AGENTS、git repo。
- `project_context`：讀取某個專案的 README、AGENTS、package scripts、pyproject 等入口資訊摘要。
- `list_dir`：受限目錄瀏覽，有深度與筆數上限。
- `read_file`：讀取 root 內允許的文字檔，有大小與行數上限。
- `search_text`：在允許範圍內搜尋文字；優先使用 `rg`，沒有時使用內建 fallback。
- `git_status_summary`：固定執行 read-only 的 `git status --short --branch`。

## 安全邊界

所有路徑都必須位於 `WORKSPACE_MCP_ROOTS` 選定的 root 下，並會解析 realpath，避免 `..`、symlink、junction 逃逸。預設會阻擋：

- `.git`、`.secrets`、`.tunnel-client`、`.tmp`、`node_modules`、`.venv`、`.next`、cache、build output。
- `.env`、`.env.*`、常見 private key 名稱。
- `.db`、`.sqlite`、`.pem`、`.key`、archive、model weight 等高風險檔案。
- `$RECYCLE.BIN`、`System Volume Information`。
- 使用 `WORKSPACE_MCP_ROOT_DENY_DIRS` 對特定 root 增加目錄排除，例如
  `data=private-folder,restricted-folder`。

## 安裝與編譯

```powershell
npm install
npm run build
npm test
npm run smoke:roots
```

## ChatGPT 用法

建議用托盤程式啟動，這樣可以直接看 server 是否正在跑：

```powershell
C:\GPT_MCPtool\project_reading\scripts\start-tray.vbs
```

或從終端測試 tray 設定：

```powershell
npm run tray:selftest
```

這個資料夾也已內建 OpenAI `tunnel-client`：

```text
C:\GPT_MCPtool\project_reading\vendor\tunnel-client\tunnel-client.exe
```

目前 tunnel profile 已寫在：

```text
C:\GPT_MCPtool\project_reading\.tunnel-client\project-workspace.yaml
```

建立新 profile 時請使用自己的 tunnel ID：

```text
tunnel_<your-id>
```

既有 ID 會保存在 ignored 的 profile；可用 `npm run tunnel:selftest` 檢查是否已解析，
不需要把實際值寫進 README。

常用 tunnel 指令：

```powershell
npm run tunnel:selftest
npm run tunnel:key:save
npm run tunnel:key:status
npm run tunnel:version
npm run tunnel:doctor
npm run tunnel:run
npm run startup:install
```

`npm run tunnel:key:save` 會把 `CONTROL_PLANE_API_KEY` 用 Windows DPAPI 加密保存到 `.secrets\control-plane-api-key.dpapi`。這個檔案只給目前 Windows 使用者解密，且 `.secrets/` 已被 git ignore。

如果你已經在目前 PowerShell session 設好 `CONTROL_PLANE_API_KEY`，也可以用：

```powershell
npm run tunnel:key:save-from-env
```

`npm run tunnel:run` 是長駐程序。它會先讀目前 process env；如果沒有，就會嘗試讀 `.secrets\control-plane-api-key.dpapi`。

`npm run startup:install` 會把 tray launcher 加到目前 Windows 使用者的 Startup 資料夾。`scripts\start-tray.vbs` 現在會自動啟動 MCP server 和 tunnel。

詳細掛到 ChatGPT 的步驟在 [docs/ChatGPT-Setup.md](docs/ChatGPT-Setup.md)。

手動長駐啟動方式如下：

```powershell
$env:WORKSPACE_MCP_ROOTS = 'projects=C:\project;mcp_tools=C:\GPT_MCPtool;work=C:\work'
$env:WORKSPACE_MCP_DEFAULT_ROOT = 'projects'
$env:WORKSPACE_MCP_HTTP_HOST = '127.0.0.1'
$env:WORKSPACE_MCP_HTTP_PORT = '8787'
node C:\GPT_MCPtool\project_reading\dist\src\http-main.js
```

HTTP MCP endpoint:

```text
http://127.0.0.1:8787/mcp
```

ChatGPT / OpenAI 遠端產品不能直接連你的 `127.0.0.1`。要給 ChatGPT 使用，安全預設是用 OpenAI Secure MCP Tunnel，把 OpenAI-hosted tunnel endpoint 連回這個本機 `/mcp`，而不是把本機 port 開到 public internet。

如果你是在自己的 Responses API 程式中使用 remote MCP，可以把公開或 tunnel endpoint 填到 `server_url`。若 endpoint 不是只在本機或受控 tunnel 內使用，請先加正式 auth，不要把 private workspace read endpoint 無驗證公開。

## Responses API MCP 範例

```json
{
  "type": "mcp",
  "server_label": "project_workspace",
    "server_description": "Read-only access to bounded allowlisted workspace roots.",
  "server_url": "https://<your-tunnel-or-host>/mcp",
  "require_approval": "always"
}
```

保留 `require_approval`，因為這個 server 讀的是私人 workspace。

## 本機健康檢查

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

自動啟停 smoke test：

```powershell
npm run smoke:http
```

驗證目前機器的四 root 與 deny policy：

```powershell
npm run smoke:roots
```

live server 已啟動時，驗證 MCP initialize、tool schema、四 root、UTF-8 路徑與 deny policy：

```powershell
npm run smoke:live
```

不要用 `npm start` 或 `node C:\GPT_MCPtool\project_reading\dist\src\http-main.js` 當一次性驗證命令；那是長駐 server，會持續等待 ChatGPT 或 tunnel 連線。

## STDIO 相容入口

STDIO 入口仍保留給本機 MCP client：

```powershell
node C:\GPT_MCPtool\project_reading\dist\src\index.js
```

這個模式直接執行時會等待 JSON-RPC 輸入，這是正常狀態。

## Codex 設定範例（可選）

把 `examples/codex-config.toml` 的內容加入 `~\.codex\config.toml`，或加入 trusted project 的 `.codex\config.toml`。

```toml
[mcp_servers.project_workspace]
command = "node"
args = ["C:/GPT_MCPtool/project_reading/dist/src/index.js"]
env = { WORKSPACE_MCP_ROOTS = "projects=C:\\project;mcp_tools=C:\\GPT_MCPtool;work=C:\\work", WORKSPACE_MCP_DEFAULT_ROOT = "projects" }
default_tools_approval_mode = "prompt"
tool_timeout_sec = 30
startup_timeout_sec = 10
```

## 暴露到 ChatGPT 前的安全要求

- 使用 Secure MCP Tunnel，或使用有 HTTPS、auth、log review 的受控部署。
- 不要把 `C:\project` read endpoint 無驗證公開。
- 不要用 `C:\` 或使用者家目錄取代明確的 `WORKSPACE_MCP_ROOTS` allowlist。
- 保持工具 read-only；新增寫入工具前先做獨立安全設計。
