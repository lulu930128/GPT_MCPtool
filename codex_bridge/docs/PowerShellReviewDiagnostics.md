# PowerShell Review 錯誤診斷

## 2026-10-15 Lock lifecycle Source 續修（未部署）

`codex_powershell_status` 沿用原 `reviewStoreDiagnostics`，將兩份證據分開投影：

- `startup.source=CACHE_ON_STARTUP`：只記錄本 Runtime 初始化成功或失敗及固定錯誤碼。
- `current.observation=LIVE_METADATA_ONLY`、`observedAt`：本次 lstat 的 Lock 存在／缺失／不安全／未知。
  `owner=THIS_INSTANCE` 必須有本 Store 尚未關閉的 handle 與相同 file identity；其他一律 UNVERIFIED。
  `lifecycle=OPEN/CLOSING/CLOSED/CLOSE_FAILED/FAULTED/UNVERIFIED` 描述自身已知狀態，
  不以已開始 close 冒充 handles 已關閉。foreign／legacy marker 不被推論為 STALE_VERIFIED。

這個查詢不讀 Journal 或 Lock 內容、不啟動程序、不開第二 Store、不自動重試／解鎖；
不輸出私人路徑、SID、PID、nonce 或例外原文。正常新 Lock 仍由唯一 Store 寫入 instance metadata；
metadata 本身不是外部 Owner 的 OS 證明。目前正式 Lock Owner 仍未查證。

本次將 `STORE_LOCKED` 限定為 **建立 approval.lock 的 wx open** 得到 EEXIST；
後續 Journal 階段的 EEXIST 不再誤分類。啟動失敗只清理由自己取得的 handles／Lock；
任何 close 失敗或 ownership 不符保留 Lock。正常 close 在 Journal／Lock handles 關閉後再次核對
file identity，觀察到替換則保留 foreign 檔並回 STORE_LOCK_OWNER_CHANGED／CLOSE_FAILED。
這不是針對惡意同帳號 writer 的原子 filesystem transaction；受保護目錄與正式 OS 驗收仍需另行完成。

定點測試涵蓋 bind／post-bind failure、cached error 與 current evidence、MCP status 零 open、
替換 Lock、close failure、EEXIST 誤分類與正常同 Journal reopen；結果與操作界線見
[本輪 lifecycle 紀錄](LifecycleReadinessCheckpoint.md)。無正式資料修復、無刪除未知 Lock。

> **2026-10-15 工程說明：** 此文的 OFF／NONEXECUTABLE／STORE_LOCKED 是當前或歷史 Runtime 診斷，不是停止後續 Source 編碼的命令。現行授權允許完成 Production Host、Runner、核准與結果處理；真實 PowerShell 開發測試唯讀且避開 `.env`／敏感設定，正式寫入測試僅依使用者逐筆指令與 OS 授權。已知 Store Lock 不可直接刪除／繞過。見 [主計畫](RemotePowerShellApprovalPlan.md)。

Review 四個工具在 handler 失敗時，同時於可見 MCP `content` 和
`structuredContent.error.code` 回傳相同的已知安全碼。未知 exception 或非白名單
`ApprovalError.code` 收斂為 `REVIEW_UNAVAILABLE`，不輸出 message、stack、路徑或憑證。
`isError=true`、NORMAL/ADMIN OFF、無 execution／production authorization 均保持不變。

## 2026-10-15 `STORE_LOCKED` 根因收斂與修復要求

- **確認的錯誤來源**：`src/powershell-approval/store.ts::ApprovalStore.open()` 使用 `open(approval.lock, "wx")` 建立唯一檔案 Lock；遇到 `EEXIST` 分類為 `STORE_LOCKED`。這是啟動 Store 的失敗，不等於已確認另一活躍程序持有 OS File Handle，也不等於已證實可安全刪 Lock。
- **為何反覆維持 BLOCKED**：`src/powershell-approval/review-runtime.ts::initializePowerShellReview()` 在 Bridge 啟動時只嘗試一次；失敗後 `powershellReviewUnavailable` 被保存在該 Runtime，後續 MCP Review 工具重用該錯誤狀態，不在每次查詢時重新嘗試取得 Lock。**因此現在重查得到的 `STORE_LOCKED` 是載入時的保存錯誤，不證明此刻 Lock 還存在。**
- **Confirmed Source 缺口**：Lock 檔目前沒有能核實的 Owner PID／建立時間／instance nonce／heartbeat 或租約；異常終止可以留下一個不可辨識的 marker。`ApprovalStore.close()` 在正常、未 faulted 情況會在關閉 handle 後 unlink，但 faulted 時刻意保留 Lock 等待復原。`src/http-main.ts` 在啟動 HTTP Server 失敗時也缺少 `runtime.close()` 的完整 cleanup，可能留下已取得的 Lock。這些是要修復或補診斷的實作缺口；**目前尚未證明本輪 Lock 究竟由哪個路徑留下**。
- **當前正式查詢**：2026-10-15 唯讀 `codex_powershell_review_receipt` 仍回 `error.code=STORE_LOCKED`；Bridge Core 本身 Ready 並不代表 Review Store Ready。尚未經受支援的本機維護流程確認 Lock 目前是否存在、正在由哪個 Owner 持有、是否與 Bridge `config.dataDir` 及安裝版本一致。
- **正式修復順序**：先由合法本機 Owner/運維入口僅讀取 canonical dataDir、Lock 的存在與基本 metadata、相關程序的可驗證身份／開啟 handle／Instance 和啟動記錄，避免輸出密碼或 Journal 內容；分類 ACTIVE_OWNER、STALE_VERIFIED、UNKNOWN。ACTIVE_OWNER 應透過唯一 Controller 正常關閉釋放；STALE_VERIFIED 只在經使用者明確批准的專屬復原程序、證實不存在有效 owner、保存既有 Journal 後處理；UNKNOWN 保留 Lock，不任意 unlink、更換 dataDir 或建立平行 Store。
- **Source 驗收**：補上初始化／HTTP bind 失敗的 `runtime.close()`，並確保正常 shutdown 明確關閉唯一 ApprovalStore；加可診斷但不洩露私有路徑的 Owner 狀態，避免把啟動時的錯誤當成即時檔案證據。正式 E2E 應確認同一 Journal 以同一 Instance 取得 Lock、Review Request/Receipt 能使用、正常關閉後可再次啟動，且不因斷線或錯誤跨 Owner 重送。

## 分層判讀

| 層 | 證據與意義 |
| --- | --- |
| MCP argument validation | SDK 先驗證 `reviewInputSchema`，非 UUID 等錯誤在 handler 前回傳 `Input validation error`；不經 Review 的 `safe()`。不得放寬 UUID。 |
| `INVALID_INPUT` | `contract.parse()` 的 schema 拒絕；不同於外層 connector 的 `INVALID_ARGUMENT`。 |
| `REVIEW_SCOPE_REJECTED` | project 不在 allowlist、cwd 非絕對目錄／超出 realpath root，或 realpath/stat 失敗。此碼本身不能區分 ACL 與不存在的路徑。 |
| `STORE_LOCKED` | `ApprovalStore.open()` 捕捉 `EEXIST` 的分類；主要獨佔點是 `open(approval.lock, "wx")`。不能僅憑此碼證明有效 owner 或遺留鎖，亦不能排除其他 open 階段的 EEXIST。 |
| `STORE_UNAVAILABLE` | open 階段其他未分類 IO 失敗（可能含 ACL），或 Store 已關閉／faulted；不等於已確認 ACL 根因。 |
| `STORE_CORRUPT` / `STORE_UNSAFE` | 已識別的 Journal 完整性／檔案型態拒絕；不得自動修復。 |
| MCP／connector wrapping | 外層 `error_code=INVALID_ARGUMENT` 不能覆蓋內層 `error.code`；generic content 也不能用來推斷根因。 |

## 啟動與唯讀證據

`scripts/codex-bridge-runtime.psm1` 將 dataDir 傳入 `CODEX_BRIDGE_DATA_DIR`，
啟動 `dist/src/http-main.js`；config 的 installed binding 優先於環境值。
`createBridgeRuntime()` 只呼叫一次 `initializePowerShellReview(config.dataDir)`，
使用 canonical `powershell-approval` Store。初始化錯誤保存在
`powershellReviewUnavailable`，一般 Bridge 仍可 ready；server 將此碼交給四個 Review 工具。
缺 context 時，handler 在 scope 與 Store 操作之前拒絕。SDK schema validation 仍先執行。

2026-10-14 本次以既有 `review_receipt` 做一次唯讀探測，傳入合法 UUID
`c930eb1c-178d-48d3-8ea3-e6cc8b834350`，取得 `error.code=STORE_LOCKED`，
外層另帶 `error_code=INVALID_ARGUMENT`。該 UUID 原為 caller 的 idempotency key，
此處僅作合法 schema 的探測值，並非宣稱它是已存在的 requestId。初始化拒絕早於查詢收據，
沒有建立提案或寫入 Journal。這確認目前 runtime 的拒絕碼；先前 request 的原始
structuredContent 未取得，不宣稱已重播驗證歷史呼叫。

live Journal、設定與 owner 證據位於本輪禁止讀取的範圍，未探讀、未開第二份 Store。
因此鎖的 owner、是否遺留、實際 dataDir／部署來源與 ACL 根因仍未驗證。
後續由合法本機營運入口核對 canonical owner 與啟動紀錄；若確認重複 owner，
應經既有 lifecycle 正常關閉多餘 owner，使其自行釋放鎖。若無法確認 owner 或為遺留鎖，
維持阻擋，交由明確授權的復原流程處理，不刪鎖、不重設、不改 ACL、不另開 Store。
本次只修 source 診斷，未部署／重啟，live 可見文字仍是舊版。

## 聚焦驗證

在 `codex_bridge` 下使用隔離編譯輸出，不覆寫 live `dist`：

```powershell
node node_modules/typescript/bin/tsc --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck --rootDir . --outDir .tmp/review-diagnostics-20261014/compile tests/powershell-review.test.ts
node --test --test-isolation=none .tmp/review-diagnostics-20261014/compile/tests/powershell-review.test.js
```

測試只使用隔離 fixture，涵蓋合法 UUID、SDK validation 與內部 INVALID_INPUT 的差別、
scope 拒絕、Store 錯誤／未知錯誤安全輸出、四工具啟動錯誤傳遞，以及既有 TTL、
once-only、idempotency、NONEXECUTABLE、無 subprocess 邊界。
