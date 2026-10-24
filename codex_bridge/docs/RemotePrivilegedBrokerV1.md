# Remote Privileged Broker V1

> **2026-10-15：** 本檔是早期獨立特權 Broker 方案的歷史設計與驗收證據，不再是 Codex Bridge PowerShell 雙入口交付的 Source-only 限制。正式 PowerShell 以 [RemotePowerShellApprovalPlan.md](RemotePowerShellApprovalPlan.md) 的唯一 ApprovalStore／Control Center Owner 為準；允許繼續編寫必要 Source，但不因此將舊 Synthetic Broker、預覽測試或未部署的 Executor 冒充正式權限。本文件的 OS／ACL／人工核准要求仍是重要安全約束。

## 本輪交付與狀態

**正式 Elevated Executor：NOT DEPLOYED。正式模組 ACL／其他 MCP 防更動：NOT ENFORCED。**

這是預設關閉的 source / offline contract 版本。開發者本輪獲准修改
`codex_bridge` source；這不等於部署後允許 Codex 或一般 MCP 修改正式特權模組。
Project_Workspace 目前的 operate/read-write 不因 Codex App Server permission profile 而變成唯讀。
本輪沒有修改 Windows ACL、Registry、Task Scheduler、service 或 Project_Workspace policy；
沒有啟動管理員 worker、重啟 live Bridge，也沒有驗證正式防更動權限。

| 表面 | 本輪可用能力 | 不代表的能力 |
| --- | --- | --- |
| MCP `codex_privileged_status` | 固定 policy、部署缺口與防更動缺口 | OS 檢查、服務健康或 ACL 證明 |
| MCP `codex_privileged_preview` | enum 固定操作的 dry-run policy preview | 執行診斷、建立 request、授權或提權 |
| 離線 Broker data plane | request、exact review decision、receipt/result、TTL、restart、idempotency | 真人已審核、正式 executor 可用 |
| 合成 worker fixture | 以固定資料完成 `SYNTHETIC_ONLY` 端到端測試 | 任何 Windows 管理員操作或正式診斷資料 |
| 正式人工 UI／核准 authority | NOT IMPLEMENTED | app-only、`human: true` 或文字承諾都不是授權證據 |
| 正式 native executor、IPC、ACL | NOT DEPLOYED / NOT ENFORCED | 可寫 workspace 中的 JS 不是特權安全邊界 |

沒有 environment/config 啟用旗標、generic shell、`powershell -Command`、任意 executable
或 caller-supplied path/command/flags/env。沒有安裝腳本，也沒有把不完整的安裝方案當作可部署成果。

## Owner 與資料流

```text
Secure MCP Tunnel -> 既有 HTTP MCP bearer gate
  -> privileged/tools.ts -> RemotePrivilegedBroker.status / preview
  -> NOT DEPLOYED / NOT ENFORCED；零診斷執行、零 request 寫入

純本機 syntheticFixture（只由離線測試明確建構）
  -> 固定 policy -> 獨立 receipt journal -> exact reviewer fixture
  -> durable delivery intent -> synthetic worker -> closed result schema -> receipt

日後需獨立實作、人工部署並驗證的邊界
  MCP request -> local policy/preflight -> protected request authority
  -> independent human approval authority -> protected native executor
  -> executor 自行驗證 policy / target / grant / replay / TTL -> bounded signed receipt
```

`src/privileged/contract.ts` 持有固定操作與 schemas；`broker.ts` 是此資料面的唯一狀態 owner；
`receipt-store.ts` 只實作合成 journal；`tools.ts` 只註冊兩個唯讀工具。
`runtime.ts` 建立 `RemotePrivilegedBroker.notConfigured()`，`server.ts` 直接接 Broker。
這條 handler 不呼叫 Codex Controller、App Server、JobStore、project discovery 或模型。
原有 Codex 工作流仍由原 owner 負責；`:workspace`、`:read-only`、`approvalPolicy=on-request`、
stdio-only、Secure MCP Tunnel 與 project allowlist 均未放寬。

這不是第二個 Codex execution gateway，也不是 OMI REAL_SIM／KGI broker 下單通道。
Broker request/approval **不是金融交易授權**；operation allowlist 沒有交易、帳務、登入或秘密讀取。

## V1 操作與輸入契約

| operationId | 固定 targetId | 最低權限要求 | 合成 result 允許欄位 |
| --- | --- | --- | --- |
| `diagnostics.os_summary` | `local_machine` | `standard_user` | `platform=windows`, `architecture=x64/arm64` |
| `diagnostics.memory_summary` | `local_machine` | `standard_user` | bounded 整數 `totalMiB`, `availableMiB` |

兩者都是 non-destructive read-only 示範，不應為此要求 Administrator。正式診斷未實作。
沒有 mutation operation。日後每個 mutation 必須另訂固定 operationId、server-pinned target、
high-risk exact manual approval、local allowlisted native handler；不可由 generic command 接手。

- Preview 只有 `{ operationId }`，不建立 receipt。
- 合成 request 只有 `{ requestId, operationId }`；requestId 必須是 retry-stable UUID。
  新 UUID 建立一筆提案；相同 UUID / operation 回傳原 receipt；相同 UUID 不同 operation 拒絕。
  terminal/expired requestId 不再使用，不以新 id 自動重試 unknown delivery。
- approvalId、bootId、固定 120 秒 TTL、policy 版本與 digest 由 owner 建立。
  Digest 綁 requestId、approvalId、bootId、operation、policy、target、最低權限、建立時間與期限。
- 合成 reviewer 必須同時指定 exact requestId、approvalId、digest 與 approve/deny。
  closure 只交給測試中的 reviewer fixture，不在 broker public API、MCP args 或 runtime 中。
  **此 closure 只測試角色分離，不證明真人點擊，也不能作為正式核准 authority。**
- receipt/result 查詢是合成 Broker 的 `get({ requestId })`。正式 MCP 不開放這個資料面，
  直到可信 UI／authority 完成；也沒有隱藏 HTTP approval route。

未來 request tool 必須標 `readOnlyHint=false`（建立提案也是 side effect）。Approval 必須 app-only，
而且由獨立受保護 authority 驗證真人 exact 決策；MCP bearer、visibility metadata、模型宣告的
source/role/human boolean 或現有 `codex_approval_decide` 都不能簽發 Broker grant。

## 狀態與 fail-close

| 欄位／狀態 | 意義 |
| --- | --- |
| `mode=dry_run`, `state=not_configured` | 正式 preview；未建 request、未執行 |
| `approval=pending`, `execution=not_executed` | 已保存合成提案，尚未核准 |
| `approval=approved`, `execution=not_executed` | 僅完成合成核准，沒有執行 |
| `execution=executing` | 已持久化 delivery intent；不能因此宣稱完成 |
| `execution=executed`, `evidence=SYNTHETIC_ONLY` | 合成 worker 回傳 exact identity 與有效結果；不是實際提權 |
| `execution=unknown` | timeout、delivery/result 不可信或 restart；不重送 |
| `approval=denied/expired` | grant 關閉，不得以舊 id 重新核准 |

每個 Broker instance 串行處理 request/review/execute/read/close。執行前先 fsync intent，再核對 TTL，
才交給 worker；固定 timeout 後保留 unknown，即使 worker 稍後回覆也不提升為成功。
單一 journal 有 exclusive lifetime lock，第二個 owner 拒絕；意外中斷留下 lock 時不自動搶鎖。
正常重開時 pending/approved-not-executed 變 expired，executing 變 unknown，completed result 保留。
clock 倒退拒絕後續需要 grant 的操作。這是 synthetic state-machine 保證，尚非 Windows
跨程序、跨開機或電源故障的 production exactly-once 證明。

合成資料僅在測試建立的 temporary directory：

```text
<test-generated-temp>/broker/synthetic-broker.lock
<test-generated-temp>/broker/synthetic-receipts.jsonl
```

不寫 `CODEX_BRIDGE_DATA_DIR/jobs`、Codex JobStore、`.local`、既有 runtime 目錄或其他專案。
Journal 上限為 1,000 request、10,000 entry、8 MiB，達限拒絕，不清除 requestId tombstones。
每筆以完整 receipt、sequence 與 hash chain 保存；截斷、損壞或非法轉移拒絕，不自動修復。
Hash chain 只檢查一致性，不能抵擋有 write 權限的人重寫整份檔案、刪除尾段或回復舊備份。
寫入失敗保留 lock 並停止 store；不可把 fixture journal 當作正式授權紀錄。

Result 是封閉 schema：不保存 hostname、username、path、command、stdout/stderr、原始錯誤、
完整環境或任意文字。Unknown field、錯誤型別、越界值、錯誤 request/approval/boot/digest/operation
全部丟棄，receipt 只留固定 reason；不靠 regex redaction 猜測未知秘密。

## 人工部署前置（本輪全部未執行）

1. **獨立審查 native artifact。** 正式 executor 必須是另行建構、驗證簽章／hash 的固定 native
   executable。不得以 Node/PowerShell elevated service 指向 repo、`dist`、`node_modules`、
   workspace JS/PS1、動態 import、可寫 plugin、工作目錄或 PATH 中依賴。固定 handler 直接使用
   bounded Windows API；依賴也必須保護並固定解析來源。
2. **人工 Administrator 安裝與實際 ACL 驗證。** 建議候選路徑是
   `%ProgramFiles%\CodexPrivilegedBroker\releases\<version>`（executable／依賴）與
   `%ProgramData%\CodexPrivilegedBroker\{policy,authority,receipts}`（policy／秘密／授權 journal）。
   路徑名稱本身不是安全證明；須驗證 owner、DACL、inheritance、祖先目錄的 rename/delete-child、
   reparse/link replacement、實際解析目標與全部依賴。Bridge、Codex、Project_Workspace、其他 MCP
   及一般使用者身份最多只有所需的 read/execute，不能 write/replace/delete/change-owner/change-DACL；
   approval 私鑰／密鑰還必須禁止讀取。保護 service config，禁止一般身份改 binary path 或 service DACL。
3. **分開查每個 MCP 的權限。** 盤點 Project_Workspace operate/read-write 的 roots/policy 及執行帳號，
   排除正式 executable、policy、authority、receipt 及可替換祖先路徑；逐個 MCP 做受控負向測試。
   Codex App Server profile 只約束該 sandbox，不能用它替其他 MCP 宣稱唯讀。
   本輪 ACL／Project_Workspace policy 狀態維持 **NOT ENFORCED**；不自動修改它們。
4. **least privilege 與 IPC。** 診斷由一般權限執行；需要特權的未來固定 operation 才授必要最小權限。
   用專用本機身份與 explicit local IPC DACL／peer identity／remote-client rejection，驗證兩端身份，
   不依賴 loopback、pipe 名稱或 MCP token。預設 pipe ACL 不可當作此設計已完成。
5. **獨立真人核准 authority。** 實作受保護的本機人工 UI 或等價獨立驗證通道，exact 顯示操作、
   target、影響、requestId、digest、到期時間。Grant 綁 caller/audience、request、approval、operation、
   target、policy hash、executor hash、boot/epoch、nonce、expiry；密鑰留在受保護 authority。
   不得只把可偽造 widget click 或 app-only metadata 當真人證據。
6. **executor 自行驗證。** 不信任 Bridge 傳來的 `approved`／workspace policy。
   Executor 重新驗證 grant 簽章、peer、allowlist、pinned target、時間、policy/executable hash 與 durable
   one-use nonce。定義 crash/restart/restore 後的 anti-replay；unknown 不重試，result 限制先於出口。
7. **獨立部署驗收。** 完成 source tests 後，真人另行授權安裝、啟動、權限負向測試與有限操作驗收。
   實測一般使用者、Codex 及其他 MCP 不能替換正式模組／policy／service config 或讀寫 secrets。
   再驗證 authenticated Widget approval；通過前仍只開放 preview/status。不得在其他 job 活躍時
   自動重啟 Bridge，也不得將此部署接到 OMI／KGI 或交易授權。

這些是部署要求，並非本輪完成的 ACL audit。Microsoft 文件說明 service config 權限與
[service security](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights)、
[named pipe DACL](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)、
[DLL dependency search](https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-security)
的安全影響；本設計據此要求額外的部署驗證。

## Rollback 與事故處理

目前無正式部署，因此無需停止服務或還原 ACL；本輪不自動撤銷既有變更。
未來只有真人 Administrator 可停用 exact executor／IPC admission、撤銷 authority epoch/grants，
按已驗證簽章切回舊版 artifact。保留 receipts、nonce tombstones 與事故證據；不要刪 state、
回復舊 journal 或放寬 ACL 來使啟動成功。重新啟用必須重新驗證 policy、artifact、權限與人工核准通道。
不 kill-by-name，不影響其他服務、OMI 或 KGI，也不自動重送 interrupted/unknown request。

## 驗證命令

```powershell
npm run build
node --test --test-isolation=none dist/tests/privileged-broker.test.js dist/tests/privileged-tools.test.js
npm test
npm run smoke:http
```

所有 worker 都是純本機 synthetic callback；HTTP 使用 isolated runtime、loopback ephemeral port，
不連 live Bridge、不啟動 Codex turn。專用 MCP test 用會拋錯的 Controller/JobStore proxy，
證明 Broker handlers 不跨 owner。沒有改 Widget，因此本輪不以 UI 截圖或 widget:check 代替真人驗收。

2026-10-12 本輪驗證：targeted tests 21/21 PASS、`npm test` 150/150 PASS、
`npm run smoke:http` PASS（34 tools、13 app-only、previewCreatedJobs=0、controller=idle），均 exit 0。
UTF-8／whitespace／本機文件連結檢查與 `git diff --check` 通過。
八個指定既有 WIP 的 SHA-256 核對通過：六檔 bytes 未變，README/smoke 移除本輪最小增量後也與
起始 hash 完全相同。完整本機證據在 ignored `docs/agent-runs/remote-privileged-broker-v1/Progress.md`，
該任務紀錄不屬於公開 source archive；本頁保留可公開重現的命令與結果。
