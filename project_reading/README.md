# GPT Project Workspace MCP

目前 application release 為 `1.7.0`，source tool contract 為 `2026-10-14.2`（本次新增診斷尚未 live adoption）。Workspace root、asset scope 與 tool contract 仍依各自的安全契約演進。

圖片、Office 與 PDF 檔案的公開讀取設計、限制與設定方式請見
[docs/Asset-Readers.md](docs/Asset-Readers.md)。

## 文件導覽

- [受限寫入與修改](docs/Write-Operations.md)：通用 write policy、工具、hash、操作收據、audit 與恢復限制。
- [安全模型](docs/SecurityModel.md)：root／asset scope allowlist、realpath containment、
  deny policy、工具權限與輸出限制。
- [故障排除](docs/Troubleshooting.md)：build、root/path、local MCP、tunnel、ChatGPT action
  cache 與 exact-path lifecycle 診斷。
- [ChatGPT 掛載](docs/ChatGPT-Setup.md)：Secure MCP Tunnel 與 Developer Mode 設定。
- [圖片、Office 與 PDF 讀取](docs/Asset-Readers.md)：格式、container safety、隔離解析與 bounded output。

這是一個預設 read-only 的 MCP server，可讀取明確 allowlist 內的多個本機 workspace root。Operator 可透過獨立 policy 啟用受限的文字建立／追加／修改能力；設定 `defaultRootAccess: "read-write"` 後，明確加入的 workspace roots 自動套用文字讀寫權限，既有 deny 與工具自身保護仍有效。

預設範例提供三個 root id：

- `projects` → `C:\project`（預設）
- `mcp_tools` → `C:\GPT_MCPtool`
- `work` → `C:\work`

Workspace 檔案工具接受可選的 `root`；省略時使用 `projects`。路徑仍必須相對於所選 root，不能傳入其他磁碟或任意絕對路徑。Runtime diagnostics 不接受 root 或檔案路徑。

額外 root 與 root-specific deny rule 屬於本機設定。可把
`examples/tray-settings.example.json` 複製成 ignored 的
`.local/tray-settings.json`，再加入實際核准的路徑；不要把個人路徑提交到 Git。

本服務提供 workspace browsing、文字搜尋、靜態 code intelligence、Git review、受限 asset 讀取，以及明確啟用的通用文字寫入。它不提供刪檔、搬移、任意 shell、commit、push 或 database mutation；不預設授權任何既有專案的寫入範圍。

## 工具

Git 工具仍僅提供 read-only status／diff inspection；Git mutation 交由 Codex 在使用者明確授權的
任務範圍使用本機 Git、add、commit、branch、push，依根目錄 Git 與公開安全規則執行。
MCP 沒有 Git mutation 工具不代表 Codex 被禁止執行 Git；不新增任意 shell 或第二套 Git Manager。
同一授權範圍不逐步重複確認，未包含 Push 的任務不外推 Push／公開發布；破壞性 Git 操作須另行
明確指定，實際平台／ACL 拒絕須停止回報，不繞過。

- `mcp_component_status`、`mcp_component_preview`、`mcp_component_receipt` 與 `mcp_component_restart`：七個其他 MCP 的既有 CC 狀態／預覽與 durable receipt；七個固定目標皆可在明確確認中斷後人工 reload；同 UUID 換目標會拒絕。重用現有 authenticated HTTP 與唯一 CC tray／component controller，不做額外真人身分驗證。詳見 [本機元件維護與人工採用](docs/LocalComponentManagement.md)。本輪只做 source／隔離驗證。

- `check_tcp_port`、`list_listening_ports`、`inspect_port_owner`、`resolve_dns`、`ping_host`、`http_health_check`：受限 runtime/connectivity 觀察，參數與限制見下節。
- `create_text_file`、`append_text_file`、`patch_text_file`、`update_json_value`、`make_directory`：只在有效 write policy 啟用時提供，寫入須明確指定 root、路徑與 operation_id。
- `get_write_operation`：operate mode 的唯讀操作收據查詢，處理回應遺失與不確定結果。
- `read_audio`：以 MCP AudioContent 回傳原始音訊；不提供自訂播放器或診斷卡，host 是否播放取決於其支援。
- `workspace_info`：回傳目前 root allowlist、預設 root、限制與安全政策摘要。
- `list_projects`：列出指定 root 的直接子資料夾，標示 README、AGENTS、git repo。
- `project_context`：讀取某個專案的 README、AGENTS、package scripts、pyproject 等入口資訊摘要。
- `list_dir`：受限目錄瀏覽，有深度與筆數上限。
- `read_file`：讀取 root 內允許的文字檔，有大小與行數上限；`includeSha256=true` 從同一份完整原始 UTF-8 快照產生 hash 與文字視窗，供後續修改使用。
- `read_files`：依目前設定的檔數、總行數與 bytes 上限，批次讀取已預先通過相同 path guard 的文字視窗。
- `find_files`：以 relative glob 與副檔名尋找檔案，不回傳絕對路徑。
- `search_text`：在允許範圍內搜尋文字並可回傳前後文；優先使用 npm platform package 內不進 Git 的 `rg`，沒有時使用 bounded JavaScript fallback。
- `git_status_summary`、`git_diff`、`git_diff_file`：只讀且 project-scoped 的 Git status／patch；denied、binary、symlink、submodule 內容不會外流。
- `find_symbol`、`find_references`、`import_graph`、`project_map`：TypeScript、JavaScript、Python 的 deterministic lexical 分析；不是 compiler／LSP 語意解析。
- `inspect_asset`、`read_image`、`read_spreadsheet`、`read_document`、`read_presentation`：受限圖片與 Office reader。
- `fetch_asset`：為明確開啟 original-file return 的 asset scope 建立 content-bound MCP `resource_link`；host 再以 `resources/read` 取得通過既有 path guard、deny policy、大小與 SHA-256 驗證的原始 bytes，不修改本機檔案。
- `inspect_pdf`、`read_pdf_text`、`read_pdf_page`：隔離 worker 內的 PDF metadata、文字與單頁 PNG reader。

`workspace_info` 另回傳 application／contract／build fingerprint、runtime start time 與 active search backend，方便確認目前實際載入的 build。

### 文字預算、續讀與搜尋去重

Source 預設上限為單檔 600 行、批次 12 檔／2400 行、搜尋 120 筆；單檔文字
256 KiB、批次文字與搜尋結果各 512 KiB。實際值由 `WORKSPACE_MCP_MAX_READ_LINES`、
`WORKSPACE_MCP_MAX_BATCH_FILES`、`WORKSPACE_MCP_MAX_BATCH_TOTAL_LINES`、
`WORKSPACE_MCP_MAX_SEARCH_RESULTS` 及既有 bytes 環境變數控制，tool schemas 與說明同步使用設定值。
以現役 `workspace_info.limits` 為準；source Build 不代表現役已採用。

`read_files` 先保留明確指定的 `maxLines`，再將剩餘行數公平分給省略者；明確預算總和超限仍拒絕。
Bytes 依剩餘檔案需求公平保留（每檔仍受單檔上限約束），小檔及前檔未用完的額度可釋出給後檔。
回傳每檔 `appliedLimits`、批次 `totalReturnedLines`／`totalReturnedBytes`；bytes 計算 UTF-8 文字，
不含 JSON 包裝、metadata 或 MCP 相容性保留的重複文字副本。

`read_file`／`read_files` 保留原欄位，另回傳 `completedLines`、`nextStartLine`、
`partialLine`、`truncationReasons`（`max_lines`、`max_returned_bytes`、`partial_line`，
批次可加 `batch_total_lines`／`batch_total_bytes`）。`nextStartLine=null` 才表示讀完；
完整行後放不下的下一行不回傳部分內容，直接從該行續讀。
只有首行可能回傳 UTF-8 安全的部分文字：此時 `completedLines=0`、`eof=false`、
`nextStartLine` 留在原行，並以 `continuationRequiresMoreBytes`／`requiredBytesForNextLine`
指出須提高 bytes 預算才能完成。批次可改用 `read_file`；超過單檔 cap 則需 operator 調整設定，
重複相同預算不會前進。續讀假設檔案未被外部修改；一般讀取不是跨請求快照。

`search_text` 預設維持 `contextMode=per_match` 與原有 `results` schema。
Opt-in `contextMode=merged` 將同檔重疊或緊鄰視窗合併為唯一 `contexts`，每筆
`results` 保留 `path`、`line`、`matchText` 與 `contextId`；`count` 仍為命中數。
Context 的 `id` 對應 `contextId`，並提供 `path`、`startLine`、`endLine`、`text`、`truncated`。
輸出預算先保留命中識別，再放前後文；`contextId=null` 表示前後文因限制未回傳，
不表示沒有命中。部分 context 會標記 `truncated`；命中本身超限也會以頂層 `truncated`／`limitReason` 說明。
兩種模式均沿用既有 path guard、deny policy、ripgrep／JavaScript fallback。

### Runtime／connectivity diagnostics

六個工具均為 readOnlyHint=true、destructiveHint=false；加上元件管理工具共 35 個，檔案 operate mode 為 41 個；只有固定七目標的 restart 工具標記 destructive。
TCP／DNS／HTTP 使用 Node API，Windows listener／PID／ping 使用固定 System32 命令與既有 bounded runner。
不接受任意 command、flags、executable、cwd、env，也不能啟停任何目標程序或服務。

| 工具 | 結構化參數 | 結果 |
| --- | --- | --- |
| `check_tcp_port` | `host`, `port`, `timeoutMs?` | TCP connect、錯誤碼、耗時；不傳送 application payload |
| `list_listening_ports` | `port?`, `address?`, `family?`, `maxResults?`, `timeoutMs?` | Windows TCP listener、PID；精確 port/address 及 ipv4/ipv6 篩選 |
| `inspect_port_owner` | `port`, `address?`, `maxResults?`, `timeoutMs?` | listener／PID／process image name；不是 executable path 或 lifecycle ownership 證明 |
| `resolve_dns` | `hostname`, `family?`, `maxResults?`, `timeoutMs?` | A／AAAA；family=ipv4/ipv6/all；不讀 hosts file，IP literal 直接回傳 |
| `ping_host` | `host`, `timeoutMs?` | 單次 ICMP probe、exitCode、bounded output；exitCode=0 不等於 echo 成功 |
| `http_health_check` | `url`, `timeoutMs?`, `maxBodyBytes?` | HTTP(S) GET、statusCode、healthy、bounded bodyPreview |

`timeoutMs` 預設 3000，範圍 100–10000；`maxResults` 預設 50、最高 100；HTTP body 預設
1024 bytes、最高 16384 bytes，可設 0；header cap 為 8192 bytes。同一 runtime 最多八個進行中的
診斷，超過回傳 `DIAGNOSTICS_BUSY`。Windows subprocess stdout／stderr 上限為 256 KiB／4 KiB，
ping 回傳最多 2048 個字元。Timeout、截斷及 partial evidence 會明確標記。

可觀察 localhost、private 與 public host；此能力不受 workspace root 範圍限制。只對已知唯讀
health endpoint 使用 HTTP GET；禁止 credentials、custom headers、request body、redirect，TLS 保持驗證。
body／命令輸出一律當作不可信資料。`healthy=false` 的 HTTP 非 2xx 仍可是一筆成功取得的觀測；
TCP refusal／ICMP failure 不足以證明服務不存在。Windows PID／image name 是不同時間點的快照，
程序消失、權限或 PID reuse 都可能影響 identity；不提供 kill/start，也不取代 lifecycle controller。
`inspect_port_owner` 的 `ok`／`complete` 描述 listener snapshot；identity 失敗時保留有效 PID，
回傳 `partial=true`、`identityComplete=false`、`identityCode` 及逐列 `identityStatus=unavailable`。

### `project_map` 輸出限制

`project_map` 將檔案數、總 symbol 數與單檔 symbol 數拆成獨立限制，預設分別為
`maxFiles=30`、`maxTotalSymbols=300`、`maxSymbolsPerFile=50`。呼叫端設定仍受
`WORKSPACE_MCP_MAX_CODE_RESULTS`、`WORKSPACE_MCP_MAX_CODE_FILES` 與
`WORKSPACE_MCP_MAX_CODE_SYMBOLS` 的 operator hard caps 約束。

舊的 `maxResults` 暫時保留為 deprecated `maxFiles` alias；新呼叫應改用 `maxFiles`，且不可同時傳入不同值。輸出會回傳 `appliedLimits`、`deprecatedInputs`、`truncated` 與
`truncationReasons`，每個檔案也會標示自己的 symbol 截斷原因。

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

目前正在遷移到 `unified-lifecycle-v3`：`scripts\runtime-control.ps1` 是唯一 lifecycle
owner，以 mutex、listener PID、exact executable、PID file 與 process start-time metadata
管理 detached MCP server／tunnel。它提供固定動作：

- `EnsureRunning`
- `RepairConnectivity`
- `RestartCore`
- `ReloadRuntime`
- `ShutdownRuntime`

`RepairConnectivity` 不會重啟健康 MCP；`RestartCore` 不會替換 tunnel；完整停止前會先
確認兩個 process 都屬於本元件。foreign listener 或 PID reuse 會安全失敗，不會用程序名稱
批次終止。

controller 會先等待 MCP health 通過才啟動 tunnel，避免 OAuth discovery 在
`127.0.0.1:18787` 尚未監聽時永久停在 `/healthz=200`、`/readyz=503`。若自有 tunnel
程序仍未 ready，會依 15／30／60 秒做最多三次 bounded replacement，不會無限重試。

`scripts\show-diagnostic-tray.vbs` 只開啟 optional diagnostic UI；關閉它不會停止 runtime。
既有 `start-tray.vbs` 與 `Restart-Tray.cmd` 暫時保留為 legacy rollback 入口，但 tray 本身
也只委派 controller，不再保存 server／tunnel handles。MCP Control Center 的 registry v3
已將六個元件登記為 `component-controller`。Project Reading 原托盤的 URL／tunnel ID 複製、
health／tunnel UI／runtime logs 操作透過 `component-menu-v1` 直接顯示在中樞子選單，實際值
仍只由 `scripts\control-center-ui.ps1` 在元件內處理，不會回傳給中樞。

Project Reading 同時是 New Component Kit 的 conformance reference：
`scripts\component-runtime.psm1` 提供標準 facade，實際 exact-path lifecycle 仍由
`scripts\project-reading-runtime.psm1` 擁有；`tests\test-runtime-control.ps1` 是標準 targeted-test
入口。完整邊界與驗證方式見
[`docs/ControlCenterIntegration.md`](docs/ControlCenterIntegration.md)。

或從終端測試 tray 設定：

```powershell
npm run tray:selftest
npm run runtime:selftest
npm run runtime:test
npm run component:test
```

這個資料夾也已內建 OpenAI `tunnel-client`：

```text
C:\GPT_MCPtool\project_reading\vendor\tunnel-client\tunnel-client.exe
```

這是目前的 legacy local runtime，不代表所有元件已統一版本。Control Center inventory 只讀取
path／version／SHA-256；不會自動升級或切換。Controller 建立 MCP／tunnel child 時會清除 ambient
HTTP(S) proxy、明確 bypass loopback，並在 spawn 後還原 parent environment；企業 outbound proxy
必須以明確的 component-owned 設定導入。

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
$env:WORKSPACE_MCP_HTTP_PORT = '18787'
node C:\GPT_MCPtool\project_reading\dist\src\http-main.js
```

HTTP MCP endpoint:

```text
http://127.0.0.1:18787/mcp
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
Invoke-RestMethod http://127.0.0.1:18787/health
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
- 寫入須使用已審查的 policy 與 authenticated transport；詳見受限寫入文件。

## 本機 Control Center 通道（source candidate）

Workspace 已改接現有 source schema 3 tray 的固定 local pipe。status／preview 採用
有時間戳的 CC 快照；七個固定元件的明確單一目標人工 reload 使用既有 controller 與 durable UUID 收據。
未驗證 HTTP／STDIO 不啟用 restart；沿用現有 authenticated HTTP，不另外驗證真人身分。
沒有 Program Files G2、跨 SID、第二個 manager 或通用 shell。
本輪未 restart／部署。詳見 [本機維護、限制與採用](docs/LocalComponentManagement.md)。
舊 [G2 證據](docs/ReadOnlyG2Evidence.md) 保留為已被取代的 prototype 記錄。

`workspace_runtime_status()` 讀取 Workspace 開機 identity、目前權限、HTTP listener context、
MCP transport 與 CC 控制通道，彼此獨立標示。`mcp_component_diagnostics({componentId})`
從同一 CC owner 的既有記憶體快照讀取七元件詳細狀態；Ready 不代表 Idle，
缺值／過期／舊版 CC 回報 UNVERIFIED。兩者皆為嚴格 schema 的唯讀工具，
不新增 probe、維護請求或 controller；原 `mcp_component_status` 保持精簡摘要。
來源、工作量判定與限制見 [runtime 診斷契約](docs/RuntimeDiagnostics.md)。
