# PowerShell Host 診斷與收據交接（Source）

本次範圍是固定、不可執行 candidate 的 native preflight 診斷與既有 status／receipt 投影。
不代表 P1–P4 完成，也不包含暫時移除 trusted human verification。該要求維持未實作。
未部署、未重啟、未呼叫 live preflight、未寫入正式 ApprovalStore；測試只使用 `.tmp` 隔離 fixture。

## 契約與邊界

- 唯一新增工具 `codex_powershell_host_preflight`：嚴格輸入
  `{"userIntent":"EXPLICIT_USER_DIAGNOSTIC"}`，沒有 script、args、review、requestId 或命令選項。
  此標記只表達呼叫意圖，不是 human approval 證據；只在使用者明確指示後呼叫。
- 工具為 effectful：`readOnlyHint=false`、`idempotentHint=false`。只呼叫 runtime 已有
  `NativeHostTransport.preflight()`；不取得 inspect、HostPort 或 Store 能力，不新增 owner。
- 固定 helper、installed activation 驗證、native channel 與原有授權防線全部保留。
  `requireProductionHost`、`FreshNativeCeremony.Require`、`HostLease.Require`、ADMIN/UAC 均未修改。
- 同一 transport 最多一個操作；busy 不排隊、不重試。frame 上限 131028 bytes，合併前先檢查。
  preflight 回應期限 60000 ms，包含 activation、helper 啟動與兩端安裝驗證；逾時關閉 stdin 並封閉 transport。
  未結束的 helper／activation 仍由原 transport 保留追蹤，不能把期限當成已退出證明；沒有 force kill。
  遲到 activation 不會啟動 helper。既有 close 流程仍可回報不確定。
- preflight 只接受 native `BLOCKED_PLATFORM_CAPABILITY` 完成；RPC 不能進入 receiver，
  `RECEIPT_RECORDED` 也會被拒絕。此 blocker 是診斷正常完成，不代表執行成功。
  missing installed、unavailable、closed、busy、timeout、unknown 均回傳 bounded error；不回傳原始例外、路徑或 native output。

## Status 與 receipt

`codex_powershell_status {}` 沒有 helper launch，也不做修復／解鎖；startup 不再自動 preflight。

| 欄位 | 證據與限制 |
| --- | --- |
| `deployment=EXECUTION_DISABLED` | 執行仍關閉 |
| `sourceDeclaration`、`host.evidence` | Source 宣告，不是 runtime 證據；保留既有 readiness／policy 相容欄位 |
| `installedRuntime` | 當前 process 已載入 binding 是否存在及 startup 宣告；不暴露 path、SID，未重新探測安裝 |
| `nativeTransport` | 最近 preflight 的代碼、時間與 transport 狀態；`NOT_CHECKED` 是從未呼叫，快取不證明目前 readiness |
| `authenticatedOwner=UNVERIFIED` | 不從 binding、PID 或 preflight blocker 推論 owner 已驗證 |
| `reviewStore` | 同一 ApprovalStore 的既有 startup 與 lock metadata；Store owner 不等於 Windows Host owner |
| `externalBlockers` | canonical Host authority、platform human capability、ADMIN local UAC 仍受阻 |

`codex_powershell_receipt` 維持單一註冊，接受原始 `requestId`；DIRECT 不讀 JobStore。
CODEX_DERIVED 的 job 缺失／turn 改變不丟棄 canonical request，correlation 另外呈現。
未知 request 為 `REQUEST_UNKNOWN`；來源失效／Store 關閉為 `RECEIPT_SOURCE_UNAVAILABLE`；
保存資料 schema 不合法為 `RECEIPT_DATA_INVALID`；重複 linked execution 為
`REQUEST_CORRELATION_REJECTED`。全部維持 UNVERIFIED、禁止自動 retry/resume，不轉成授權。

## 晚上由使用者驗證

1. **單純 refresh 不會載入本次 source。** 本次未發佈 `dist`，未安裝或重啟。
   先由使用者另行處理既有 owner 控制的部署／載入流程，再刷新 ChatGPT 工具；本文件不授權部署。
   若今晚只做 refresh，缺少新工具是合理結果，不能改用 generic shell dispatch。
2. refresh 後列出 tools：確認 `codex_powershell_host_preflight`、`codex_powershell_status`、
   `codex_powershell_receipt` 各只有一個。preflight 是 effectful，receipt/status 是 read-only。
3. 呼叫 `codex_powershell_status {}`。新 runtime 首次應為 `NOT_CHECKED`；確認上述分層欄位與
   NORMAL/ADMIN OFF。status 不應啟動 helper，也不會把已存在的觀測時間更新成現在。
4. 明確指示：「只執行一次固定 Host preflight 診斷，不帶 candidate、不重試」。呼叫
   `codex_powershell_host_preflight {"userIntent":"EXPLICIT_USER_DIAGNOSTIC"}`。
   記錄 `code`、`nativeTransport.observedAt`；無 installed binding 可回 `NOT_DEPLOYED`，
   helper 不可用可回 `HOST_TRANSPORT_UNAVAILABLE/UNKNOWN`。成功觀測仍應保留平台 blocker。
   busy／timeout／closed 停在原結果，不自動重試、重啟或要求額外權限繞過。
5. 再讀 status，比對快取觀測與獨立 Store 狀態。用既有 request 的**原 UUID** 呼叫
   `codex_powershell_receipt {"requestId":"<原 UUID>"}`；不要為驗證另建 request。
   審閱意見不是 Grant，保存的 OS receipt 不是本次 Windows 執行證明。

## 離線驗證命令

工作目錄：`C:\GPT_MCPtool\codex_bridge`。使用既有 Node 24.14.1／TypeScript，不安裝工具。

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.json --outDir .tmp/host-diagnostics-check
node --experimental-test-module-mocks --test tests/powershell-host-transport.test.mjs
node --test .tmp/host-diagnostics-check/tests/powershell-host-diagnostics.test.js .tmp/host-diagnostics-check/tests/powershell-job-preview.test.js .tmp/host-diagnostics-check/tests/powershell-production-projection.test.js .tmp/host-diagnostics-check/tests/powershell-review.test.js .tmp/host-diagnostics-check/tests/powershell-host-receiver.test.js
```

native harness 用 Node 模組 mock 取代 installed activation，spawn 完全由記憶體 stream 模擬；
不產生 native channel authority 的 production issuer。未重跑 G0/G1、未測 production E2E。

## 2026-10-16 驗證紀錄

- 完成 source 接線、期限／frame 限制、receipt 錯誤分類與 refresh 交接。
- TypeScript 最終 `.tmp` 編譯通過，沒有產生／覆寫 runtime `dist`。
  新增 server 測試一度出現 SDK 結果型別 `TS2339`，補上 `CallToolResult` 型別後通過。
- 60 個不同測試通過：transport 7、diagnostics 6、job preview 8、production projection 14、review 17、receiver 8。
  實際執行為首輪 57 次、修改後相關補測 20 次，共 77 次；沒有略過或待處理失敗。
- 本次所有修改檔案 UTF-8 讀回通過；scoped `git diff --check` 通過。
- 精確修改前基準保留在 `.tmp/host-diagnostics-audit-20261016/`，
  `source-only.diff` 只包含本次差異，避免把既有大量 WIP 誤算進交付。

## 2026-10-20 等待期限修正

r10 單次 live preflight 在原 20 秒期限回報 `HOST_PREFLIGHT_TIMEOUT`；Tray 隨後顯示
`OWNER_EXITED`。只讀計時重現既有驗證階段合計約 21.3 秒，尚未包含完整 IPC 與 helper
程序啟動成本。Source 將診斷總期限調整為 60 秒，保留所有安裝、ACL、程序與 native channel
檢查，以及 120 秒 session TTL、單一並行操作、逾時封閉與禁止自動重試。

同次 installed core 冷啟動中，cooperative helper 在 core 啟動後約 20.34 秒才建立，晚於
原 20 秒 readiness budget。Source 將 installed runtime 的等待期限調整為 60 秒；
Source runtime 的預設期限維持不變，未放寬 graceful shutdown 的 caller allowlist。

這些是下一版候選的 Source 修正；既有 r10 immutable release 未覆寫，也未重新執行
已逾時的 live preflight。慢速驗證 regression 使用離線 mock clock，不產生 Host authority。
