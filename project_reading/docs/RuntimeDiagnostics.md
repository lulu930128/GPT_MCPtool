# Runtime 唯讀診斷

Source tool contract：`2026-10-14.2`；application release 保持 `1.7.0`。
兩個新增工具皆有嚴格 input/output schema、`readOnlyHint=true`，不建立維護請求。

`workspace_runtime_status()` 不接受參數。identity 使用已載入 config 的 runtimeIdentity，
不重新讀取磁碟 build，避免把目前 source build 當成執行版本。權限沿用
`writeCapabilities` 的 policy-current 檢查，只回傳 mode、writeEnabled 與
manualMaintenanceEnabled，不輸出 token、policy 路徑／規則、root 或環境變數。
HTTP listener 來自同一 server 的 `listening`；STDIO 不聲稱有 HTTP listener。
MCP handler 正在回應不代表遠端 ChatGPT E2E。控制通道使用原 status IPC；
CC 無法連線不會隱藏 Workspace 自身 identity，也不作 self HTTP probe。

`mcp_component_diagnostics({componentId})` 必須指定且僅接受
`codex_bridge`、`omi_search`、`japanese_study`、`memory_core`、
`personal_asset_os`、`english_study`、`listening_audio`。
Workspace 與 CC 不在 allowlist。每個 evidence 區塊包含 source、observedAt、
value 與 reason；未知值為 null，且明示 UNVERIFIED／NO_PROVIDER／NOT_PUBLISHED。

| 區塊 | 證據與限制 |
| --- | --- |
| state／locality | `CC_TRAY_SNAPSHOT` 的 status、localStatus、readinessScope；不從 Ready 推論 Idle |
| connectivity | 逐 role 的 core、connectivity（tunnel）、dependency 成功與 TCP 觀察；不輸出 URL／原始錯誤 |
| ownership | CC probe 觀察的 known、PID、matchesExpected；不是獨立 attestation，也不是 lifecycle grant |
| workload | `CC_PROVIDER_HEALTH_SUMMARY` 的 Bridge 全部 jobs 計數與 controller；無 provider 則未知 |
| runtimeBuild | 成功 health probe 的 bounded hexadecimal buildId，來源仍是 provider observation |
| sourceBuild／maintenance／componentIpc | 既有快照沒有這些 canonical provider，明示 NOT_PUBLISHED；不掃私有 receipt／runtime 檔 |
| freshness | 使用原 checkedAt，90 秒上限；未更新快照不重新標時間，未來超過 1 秒亦拒用 |
| chatgptE2e | UNVERIFIED；本機 IPC 或 HTTP 不構成 ChatGPT E2E 證據 |

Bridge descriptor opt-in 四個安全 metadata：`jobs.active`、`jobs.awaitingApproval`、
`jobs.scope`、`controller`。CC 既有 health probe 原地擷取；不增加網路請求。
計數必須是 0 至 Int32.MaxValue 的整數，scope 必須精確為 `all`；controller
僅接受 provider 契約的 `idle`、`starting`、`ready`、`unavailable`。
未知、字串數字、負值、浮點、物件及不完整計數不提升成工作量。

工作量 state 必須先有 CC core ownerKnown=true、有效 PID、matchesExpected=true，
且 status/localStatus 不是 OwnershipUnknown、OwnershipMismatch 或 UNVERIFIED。
滿足後，只要 activeJobs 或 pendingApproval 大於 0 即 `ACTIVE`；兩者皆 0 且
controller 為 ready/idle 才 `IDLE`，其餘 `UNVERIFIED`。外來／未知 owner 的
安全原始計數仍可顯示，但 state 必為 UNVERIFIED。`ownershipMatched` 只是 CC
快照觀察；`maintenanceAuthorized=false` 永遠固定。任何 Idle 都不能取代
controller 的當下 ownership／active-work 檢查或使用者的維護授權。

IPC 沿用單一 `mcpcc-workspace-local-v1` owner、nonce/challenge、same-user ACL、
1800ms deadline、2 個 Workspace concurrent requests 與 16KiB frame 上限。
新增固定 `diagnostics` operation 與 `diagnosticsVersion=1` 的獨立回應；舊
status/preview/restart/receipt wire shape、UUID 綁定／防重播與收據語意不變。
舊 CC 不理解新 operation、schema mismatch、逾時或缺快照時，診斷回報 UNVERIFIED，
不降級成 TCP Ready。原 status 的既有 TCP fallback 不受影響。

驗證指令（source／隔離 fixture）：

```powershell
cd C:\GPT_MCPtool\project_reading
npm run build
node --test dist/tests/runtime-status.test.js dist/tests/cc-readonly.test.js dist/tests/component-recovery.test.js dist/tests/component-maintenance.test.js dist/tests/diagnostics.test.js
cd C:\GPT_MCPtool\mcp_control_center
& C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -File tests\test-runtime-diagnostics.ps1
& C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -File tests\test-workspace-local.ps1
```

本次不 restart、切換 Tray 或部署。採用必須另行授權：先依既有 owner／maintenance
流程安全更新 CC 與 Workspace，再由 ChatGPT tools/list 確認兩工具、比對 boot
buildId/runtimeStartedAt 與契約版號，並查詢唯讀診斷；不以測試 UUID 提交 reload。
