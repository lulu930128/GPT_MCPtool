# V2 Request／Binding 來源分流工程 checkpoint（歷史證據）

> **2026-10-15 現行開發決策：** 本文件記錄 2026-10-14 那次工作的完成範圍，不能再作為後續限制。已授權繼續修改全部必要 Source（包括正式 Windows Host／Runner／派送／結果管線），也可以做唯讀 PowerShell 驗證；正式的可寫或特權端到端測試僅在使用者明確發起並對每筆操作確認後進行。`.env`／憑證等敏感檔案禁止讀取，其他檔案仍以當前工具與 OS 實際存取權為界。歷史與現行權威規格見 [RemotePowerShellApprovalPlan.md](RemotePowerShellApprovalPlan.md) 首節。

日期：2026-10-14。依據當時的 [RemotePowerShellApprovalPlan.md](RemotePowerShellApprovalPlan.md)
第 0、6、9 節；**當輪**僅修復 Source 資料契約，未實作特殊 PowerShell 派送。

## 契約與信任邊界

- 新 Request 保持 `version=2`、`PRODUCTION` 與
  `powershell-approval-production-v1`，明確要求 `origin`。
- `DIRECT` 不要求也不接受 `jobId`、`turnId`、`failureEvidence`，包括顯式
  `undefined`；不建立虛構 Job。
- `CODEX_DERIVED` 要求 UUID Job、非空白 Turn，以及
  `BRIDGE_CANONICAL_JOB_EVENT` 來源描述。證據必須包含 Event／Project／Job／Turn／Thread／Item、
  觀察時間、原始證據 SHA-256 與結構化故障分類。Project／Job／Turn 必須等於 Request，
  觀察時間不能晚於建立時間或早於 TTL 範圍。
- 分類只接受成對的 `SANDBOX_POLICY/SANDBOX_POLICY_DENIED`、
  `JOB_OBJECT/JOB_OBJECT_RESTRICTION`、`OS_PERMISSION/OS_ACCESS_DENIED`。
  這些是資料契約的分類詞彙，不是已實作的 native fault adapter。
  不接受任意非零 exit、自由文字判斷、`UNVERIFIED` 或 offline fixture 作為合格來源。
- **Schema 只驗證來源描述與關聯，不證明事件存在或來源可信。** 未來 canonical Host
  必須獨立回查既有 JobStore 的原始事件、身份關聯、內容摘要及實際故障分類。
  現有 Job preview 仍僅為 `OBSERVED_NONZERO`／`UNVERIFIED`，不能直接升格。
  本次沒有增加 adapter、caller verifier 或可信旗標；目前新 Request 即使 schema 合格，
  截至本歷史 checkpoint，Store admission 仍固定 `BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED`；這是當時 Runtime 狀態，不是禁止後續實作正式 Host 的永久施工規則。
- Binding 明確包含相同 origin／Request ID／Receipt ID／Request Digest／Mode／Nonce／TTL／身份。
  衍生來源另含 Job／Turn／完整 `failureEvidenceDigest`；完整 Request Digest 亦涵蓋全部證據。
  Grant、Consume、Result 必須等於 Request 推導的完整 Binding；Journal transition
  不允許換 Request、來源、Digest、Grant 或已 consume 的資料。`UNKNOWN` 不重送。

## 舊 V2 與 V1 相容性

採**明確 legacy schema 分流，沒有 migration 或 silent upgrade**。同一個
`version=2` 下，有 origin 是新版；缺 origin 且符合原有 Job／Turn 結構才是 legacy。
未知 origin、混用新版與舊版 Binding 均拒絕。缺 origin 永遠不解讀為 `DIRECT` 或
`CODEX_DERIVED`，也不替舊資料合成故障證據。

`legacyProductionReceiptSchema` 只供同一 ApprovalStore 的 Journal 重播與降低權限的恢復使用。
原欄位順序、Request Digest、Binding Digest、歷史行與 hash chain 保留；恢復僅在原 chain
追加 `EXPIRED`／`UNKNOWN`。`listProduction`／`getProduction` 回傳明確的
`ProductionJournalReceipt` union，讀取者必須檢查 origin 是否存在。
`appendProduction`／`consumeProduction`／`ingestProductionReceipt` 只接受新版契約。
原 `V1/OFFLINE_ONLY` schema、fixture 與 legacy runner 路徑不變。

原始碼仍未部署，因此保留相容性讀取即可；沒有讀取或修改任何 live Journal。
測試中的歷史 Journal 只是不可信資料向量，hash 正確並不構成 Host／OS 授權。

## 修改範圍與驗證

僅修改 `src/powershell-approval/contract.ts`、`src/powershell-approval/store.ts`、
`tests/powershell-production-contract.test.ts` 與本文件。保留原有未提交 WIP。

在 `C:\GPT_MCPtool\codex_bridge` 執行：

```powershell
node node_modules/typescript/bin/tsc --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck --rootDir . --outDir .tmp/approval-origin-20261014/compile tests/powershell-production-contract.test.ts
node --test .tmp/approval-origin-20261014/compile/tests/powershell-production-contract.test.js
git diff --check -- src/powershell-approval/contract.ts src/powershell-approval/store.ts tests/powershell-production-contract.test.ts docs/PowerShellApprovalV2OriginCheckpoint.md
```

定點 TypeScript compile：exit 0。定點測試：12/12 通過，保留原 9 個案例並更新來源資料，
新增 3 個案例涵蓋來源缺漏／跨 Job、Turn／錯誤分類／不可變 Binding／legacy 原始 hash
重播；兩來源與兩模式的資料狀態轉移、跨來源 identity replay 與 Host 拒絕亦納入既有案例。
最初 legacy 測試向量的 Receipt 欄位順序不符歷史序列化，已修正向量後通過；未改寫
Journal hash 演算法或降低驗證。三個既有目標檔案原為 untracked，因此另外以本次修改前
的精確檔案快照做 `git diff --no-index --check`，避免一般 diff 漏檢。

未重跑 G0／G1、密碼 11/11、Job preview 8/8 或全套 npm test；編譯產物僅在 `.tmp`。
`requireProductionHost()`、Broker production 拒絕與 NORMAL／ADMIN OFF 保持不變。
未修改 Runtime dist、MCP tools、Host、Executor、Runner、Tray、ACL、UAC、Startup，
未 commit／push／restart。**Source 契約驗證完成不等於 Live／Production 授權或執行驗收。**
