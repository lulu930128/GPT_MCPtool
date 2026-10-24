> 已被取代的 G2 prototype 交接；保留先前證據。現行 owner composition 與人工採用見 [Workspace 本機管理](../../project_reading/docs/LocalComponentManagement.md)，不再要求 protected G2／跨 SID。

# Workspace G2 唯讀 IPC 交接

2026-10-13：**source candidate 與隔離 transport 已驗證；G2 authenticated host acceptance 尚未完成。**
這份交接不授權安裝、ACL 調整、tray 啟動／重啟、元件 lifecycle 或 G3。
Workspace source toolContractVersion 為 `2026-10-13.2`；使用者提供的 G1 live
仍為 `2026-10-13.1`，本輪沒有 runtime adoption／ChatGPT refresh。

| 驗收面 | 目前結果 |
| --- | --- |
| 封閉 request、frame、timeout、Node ↔ .NET named pipe | 隔離 fixture PASS |
| 真實受保護 owner 身分／實際 script 與 loaded modules | `NOT_VERIFIED`／`PROTECTED_OWNER_SOURCE_UNVERIFIED` |
| 真實 CC tray 啟用 G2 | `NOT_ACTIVATED`／`PENDING_TRAY_INTEGRATION` |
| 保護的 owner 與 client bootstrap | `MANUAL_PENDING`，需要後續設計、人工部署與獨立驗證 |
| Workspace 對有效 pipe 回應的信任 | `CLIENT_TRUST_UNPROVEN`；保留 G1，絕不提升 authority |
| Personal Asset OS restart | 未執行；後續另行人工驗收 |

## 已實作邊界

`src/McpControlCenter.ReadOnlyG2.psm1` 是既有 owner 的候選唯讀 adapter。
import 不開 listener、不 probe、不寫檔；`New-McpCcReadOnlyG2Owner` 與
`Update-McpCcReadOnlyG2Owner` 才是候選 owner composition API。
production `Owner.Open()` 的 source gate **無條件拒絕**
`PROTECTED_OWNER_SOURCE_UNVERIFIED`，沒有 config、環境變數或 JSON 開關能解除。

候選 snapshot 路徑使用既有 `Read-McpCcManifest`、`Get-McpCcSystemState` 與
`Get-McpCcComponentStatus`；先排除 Workspace，再讀七個 allowlisted 元件。
`RemoteEvidence=$null`，不讀 remote evidence state；不呼叫 CLI `Status`、
controller `Status`、reconcile、action、state/event writer。查詢在 owner refresh
runspace 採樣，IPC worker 僅讀 immutable memory snapshot，不因 request 啟動 probe。
每次 probe timeout 1s；整個 refresh 仍受既有 core probe 數量與 Windows 查詢時間影響，
不是 1s total deadline，也未完成 live refresh 時間驗收。

snapshot 只投影 component ID、封閉 status、checkedAt 與五種 capability。
不傳 displayName、URL、path、PID、SID、錯誤文字、probe body 或 domain data。
component 狀態不等於 lifecycle ownership。preview 僅報 capability 是否支援；
`allowed=false`、`executable=false`。G2 沒有 request journal 或核准功能，
receipt 回 `RECEIPT_SOURCE_UNAVAILABLE`，`found/completed/receipt=null`；不能偽造
NOT_FOUND、完成或成功。沒有 request／approve／execute opcode。

## Transport 與部署 gate

`src/ReadOnlyG2.Native.cs` 使用固定本機 pipe `mcpcc-readonly-g2-v1`：

- first-instance、單一 instance、reject remote clients；DACL 僅 owner 與指定 client SID。
- client 僅 data read/write + synchronize，不能建立額外 pipe instance。
- OS 查詢 client SID/session/token；native client 以 retained process handle 核對
  server PID、start time、SID、session、image，拒絕 elevated peer。
- client 使用 Identification SQOS；沒有 credential、token 或 caller-selected executable。
- 每次 connection 只有一個隨機 challenge、一個 request、一個 response；challenge
  不符即拒絕，跨 connection replay 失敗。這是 request freshness，**不是 owner attestation**。
- 4-byte little-endian length、strict UTF-8、frame ≤16 KiB、request ≤2 KiB；
  request 只允許固定欄位與未 escape ASCII string，拒絕 duplicate/unknown key。
- connect 後 read/write 共用 1800ms deadline，timeout 關閉該 connection；沒有重試 queue。
  idle listener 只等待本機連線，Dispose 關閉它；無 daemon/process launcher。

API 依據：[Windows pipe server PID](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid)、
[named pipe access rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)。

候選 installation gate 固定 `C:\Program Files\McpControlCenterG2`，檢查 root、
binding、全部檔案與 dependency tree 的 owner/DACL、ancestor、reparse、SHA-256、
extra/missing files、大小／數量 cap。要求 owner 與 client 為不同 SID；一般同使用者
dev tray 不會因此成為受保護 authority。registry v3 與八個 descriptor 都必須在
protected tree；拒絕 R1 installed-release import 與指向 mutable checkout 的 descriptor。
這是新的**未部署候選 layout**，不相容於現有 schema-v4 installed release，不可把
原 release 的 ACL／bootstrap 改成符合此候選來強行啟用。

上述檔案完整性＋process identity 仍無法證明該 PowerShell 的實際 entry script、
loaded modules、runspace 與已載入 code bytes。即使 binding 綁定真實 PID，也可能是
dev tray。故 production source gate 維持硬阻擋；目前不能說 protected closure 已通過。
受保護安裝目錄本輪只做 `Test-Path`，結果 `False`，沒有建立它。

Workspace Node client 直接使用固定 pipe，不 spawn helper。Node 沒有已接入的 OS
server-token verifier，也沒有 protected client dependency closure。收到 schema、nonce、
target 都吻合的回應仍只是 self-attested data，會丟棄 owner claim 並回
`CLIENT_TRUST_UNPROVEN`。新建後已失去引用的 `cc-readonly-client.ps1` 已移除。

## Tray 與 NORMAL Operator

使用者回報 job `ac6d650f-5ffa-4fda-9c0b-eb9eaa2faf40` 已於
`2026-10-13T11:58:49Z` completed。本輪已重讀最新 tray source 與完整 working diff。
NormalOperator、SelfReload、installed-release 與 core 變更完整保留。
未加 G2 tray hook：目前獨立 source gate 尚不可滿足，而且候選 layout／SID 邊界尚未
對接現有 installed tray；加上永遠無法啟用的 runspace 不能完成可信連線。

## 後續最小工作

1. 人工確認唯一既有 Control Center owner 的正式 protected release、帳戶與程序邊界。
   先設計可驗證的 entry script／loaded dependency closure 與 client verifier；不能只比
   PowerShell image、命令列、磁碟 hash 或讀取自述 JSON，就宣稱 loaded source 相符。
2. 對齊現有 installed release；review 後才替換 `AssertOwnerSource` 的硬阻擋與 client
   trust gate。維持同一 lifecycle orchestrator，不新增平行管理 owner。
3. 另行授權後部署、在唯一 tray 加 narrowly scoped startup/shutdown hook，驗證
   spoofed PID、reused PID、mutable module、dependency substitution、wrong SID/session、
   reparse、ACL denial、timeout、replay、disconnect、stale snapshot 與撤回。
4. 再做 live MCP tools/list／call 與 ChatGPT discovery。這仍不授權 G3 或 PAOS restart；
   真正 PAOS lifecycle 驗收由使用者後續獨立執行。

測試與精確回退見 [Workspace G2 證據](../../project_reading/docs/ReadOnlyG2Evidence.md)。
