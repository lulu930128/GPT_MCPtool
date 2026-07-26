# ChatGPT 掛載教學

這個專案會在本機開一個 read-only MCP endpoint，讓 ChatGPT 透過受控 tunnel 讀取五個明確 allowlist root：`projects`、`mcp_tools`、`work`、`data` 與 `desktop`。省略 root 時使用 `projects`。

## 1. 先建置一次

```powershell
cd C:\GPT_MCPtool\project_reading
npm install
npm run build
npm run smoke:http
```

`npm run smoke:http` 是一次性驗證命令。它會自動啟動 HTTP MCP server、檢查 `/health` 和 `/mcp`，然後自動關閉。

## 2. 啟動托盤程式

雙擊：

```text
C:\GPT_MCPtool\project_reading\scripts\start-tray.vbs
```

托盤程式會自動啟動本機 MCP server。

右鍵點托盤圖示可以看到：

- `MCP: Running / Starting / Stopped`
- `Tunnel: Ready / Starting / Stopped`
- `Start MCP server`
- `Stop MCP server`
- `Restart MCP server`
- `Start tunnel`
- `Stop tunnel`
- `Copy MCP URL`
- `Copy tunnel ID`
- `Open health check`

本機 MCP URL：

```text
http://127.0.0.1:8787/mcp
```

健康檢查 URL：

```text
http://127.0.0.1:8787/health
```

## 3. 啟動 OpenAI Secure MCP Tunnel

這個專案已把 `tunnel-client` 安裝在：

```text
C:\GPT_MCPtool\project_reading\vendor\tunnel-client\tunnel-client.exe
```

tunnel profile 已建立在：

```text
C:\GPT_MCPtool\project_reading\.tunnel-client\project-workspace.yaml
```

建立新 profile 前，先從 ChatGPT/OpenAI 的 tunnel 設定取得自己的 tunnel ID：

```text
tunnel_<your-id>
```

把它放在目前 PowerShell session 的 `WORKSPACE_MCP_TUNNEL_ID`，或在
`scripts\tunnel.ps1 -Action Init` 時傳入 `-TunnelId`。已建立的 profile 會把
ID 保存在 ignored 的 `.tunnel-client` 目錄，不需要寫入 README。

先確認本機設定：

```powershell
cd C:\GPT_MCPtool\project_reading
npm run tunnel:selftest
npm run tunnel:key:status
npm run tunnel:doctor
```

啟動 tunnel 前，需要設定 OpenAI control-plane API key。建議不要把 plaintext key 放進專案檔或 YAML；這個專案支援 Windows DPAPI 加密保存。

如果目前 PowerShell session 已經有 `CONTROL_PLANE_API_KEY`：

```powershell
$env:CONTROL_PLANE_API_KEY = '你的 OpenAI runtime API key'
npm run tunnel:key:save-from-env
npm run tunnel:run
```

如果要用不顯示輸入內容的提示保存：

```powershell
npm run tunnel:key:save
```

保存位置：

```text
C:\GPT_MCPtool\project_reading\.secrets\control-plane-api-key.dpapi
```

這是 Windows DPAPI current-user encrypted 檔案，只給目前 Windows 使用者解密；`.secrets/` 已被 git ignore。

`npm run tunnel:run` 會長駐。若你想用托盤啟動 tunnel，先保存 key，再右鍵托盤圖示按 `Start tunnel`。

開機自動啟動：

```powershell
npm run startup:install
```

這會在目前 Windows 使用者的 Startup 資料夾建立捷徑。之後登入 Windows 時會開 tray，並自動啟動 MCP server 和 tunnel。

## 4. 掛到 ChatGPT

ChatGPT 不能直接連到你電腦上的 `127.0.0.1`。請使用 OpenAI Secure MCP Tunnel，或另一個受控的 HTTPS tunnel。

建議流程：

1. 保持這個 server 只綁定 `127.0.0.1:8787`。
2. 保持 `npm run tunnel:run` 或托盤的 tunnel daemon 正在執行。
3. 在 ChatGPT 的 connector 設定中建立 custom connector / MCP connector。
4. 連線方式選 `Tunnel` / `通道`，不要選 `伺服器 URL`。
5. 如果畫面列出 tunnel，就選你剛建立的 `Project Workspace`；如果要手動貼 ID，就填自己的值：

```text
tunnel_<your-id>
```

6. tunnel 的本機 MCP target 是：

```text
http://127.0.0.1:8787/mcp
```

7. 驗證方式若可選，使用 tunnel 預設流程；不要把私人 workspace MCP endpoint 無驗證公開成 `伺服器 URL`。
8. 連上後，請 ChatGPT 列出 tools，或直接呼叫 `workspace_info`。

`workspace_info` 會列出可用 root id。其他工具使用 `root` 欄位選擇範圍。
所有 root 都套用全域秘密與敏感檔案排除規則；個別 root 可再透過
`WORKSPACE_MCP_ROOT_DENY_DIRS` 加上更窄的目錄封鎖。

## Auth 注意事項

使用本機 Secure MCP Tunnel 時，重要安全邊界是：server 只 listen 在 `127.0.0.1`，而 tunnel 由你的 ChatGPT 帳號控制。

不要把這個 server 直接暴露到 public internet。如果你要部署到公開 HTTPS host，請先加正式 OAuth 或 ChatGPT connector 相容的 auth flow，再讓它讀私人 workspace。

## 連上後可以這樣問 ChatGPT

先試：

```text
Use the project_workspace MCP connector. Call workspace_info, then list_projects.
```

接著：

```text
Read the project_context for Open Market Intelligence under root projects, but do not read denied files or secrets.
```
