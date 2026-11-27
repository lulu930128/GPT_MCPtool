# Open Intel Atlas 遠端 MCP

Control Center 管理 OLA 專用 Secure MCP Tunnel。OLA Tray 持有採集、DB、正式 HTTP 與 MCP。只有完整的 loopback /mcp 路徑經 tunnel 對外提供，管理 API 保留在原服務。CC 的 core probe 讀取 tunnel healthz，connectivity 讀取 readyz，dependency 讀取 Atlas runtime。遠端註冊與 ChatGPT 呼叫各有獨立狀態。

## 專用 connector 設定

在 OpenAI Platform 的組織 Tunnels 建立或選擇本服務專用的 tunnel。於本元件 PowerShell 設定環境變數 OLA_TUNNEL_ID，再執行以下命令。SaveKey 以安全輸入視窗讀取這個 tunnel 的 runtime key，儲存在目前 Windows 帳戶的 DPAPI。完成後在 ChatGPT Connectors 選取同一個 tunnel，重新整理工具，從外部呼叫 atlas.sources.status 與 atlas.macro.release。

    .\scripts\setup-tunnel.ps1 -Action Init
    .\scripts\setup-tunnel.ps1 -Action SaveKey
    .\scripts\setup-tunnel.ps1 -Action Doctor
    .\scripts\runtime-control.ps1 -Action EnsureRunning

預設使用既有 Atlas loopback 8790 與 tunnel 管理埠 18949。若移動 Atlas port，要同步調整專用 profile、component descriptor 與上游身分查核，再由既有 owner 換版。遠端故障請查元件 .tmp 的 tunnel-client.log，保留原 connector 身分。已註冊元件可以透過 CC 啟用與停用。CC 關閉本元件只停止 tunnel。

## LifecycleOwnershipPolicy.md

共用現有 tunnel 程序管理實作。每次停止前比對 process start time、完整 executable、profile 身分、listener、owner receipt 與目前持有的 process handle。針對 unrelated PID reuse、foreign listener、cleanup races 的既有 ownership tests 驗證 unrelated processes remain alive。CC 不讀取或回傳 runtime key。
