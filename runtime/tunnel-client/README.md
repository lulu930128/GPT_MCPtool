# Shared tunnel-client runtime

此目錄是 future shared `tunnel-client` runtime 的受控落點，不含 executable。
`tunnel-client.exe` 由 root `.gitignore` 排除；不得 commit、下載到 Git history 或由
Control Center 自動更新。

目前六個 production component 仍使用既有 explicit path。先執行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File C:\GPT_MCPtool\mcp_control_center\scripts\tunnel-runtime-inventory.ps1 `
  -Action Inventory
```

只有在選定版本完成六元件 compatibility 驗證後，才可由人工流程放置 binary 並建立
`version.json`。正式 manifest 至少應包含 `version`、`sha256`、`installedAt` 與來源 release；
hash 或版本差異只產生警告，不授權自動複製、替換、restart 或下載。

Component-specific override 必須保留 explicit `TunnelClientPath`，供版本不相容時回復原路徑。
