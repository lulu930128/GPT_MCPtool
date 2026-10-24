# PowerShell 準備度抽屜：Source checkpoint（歷史）

> **2026-10-15 現行規則：** 「固定顯示 NOT_DEPLOYED／NORMAL／ADMIN OFF」只代表 2026-10-14 已交付的 UI／Runtime 版本，不是禁止後續開發可執行 PowerShell 的規則。可以繼續修改正式 Host／Runner、核准 UI 與狀態投影；開發期真實 PowerShell 測試唯讀，正式測試由使用者逐筆核准，實際狀態必須依載入 Runtime 更新，不可硬編造 `DEPLOYED`。詳見 [現行主計畫](RemotePowerShellApprovalPlan.md)。

日期：2026-10-14。範圍：既有 `web/codex-console.html` 的「Codex 狀態」Operator Drawer。

- 接入現有唯讀 `codex_powershell_status`；工作預覽只對選取的 configured allowlist、personal/public、history eligible Bridge job 呼叫 `codex_powershell_job_preview`，服務端仍保留原有資格檢查。
- 只在開啟抽屜或手動重新讀取時取資料，沿用 single-flight 與 5 秒手動／30 秒重開節流；以專案及 job ID 區分快照，過期讀取不覆蓋新工作。
- `deploymentStatus()` 僅增加 Source 宣告欄位：App-only 僅適用既有 native Codex 核准介面、密碼通道 UNVERIFIED、Windows Host NOT_DEPLOYED、OS attestation UNVERIFIED、NORMAL/ADMIN OFF。
- 固定顯示 NOT_DEPLOYED／NORMAL/ADMIN OFF 與不可執行說明。工具失敗、舊 schema 缺欄位及不合契約的回應各自降級；不把 Source 宣告當作 Live OS／Host 證據。
- 工作失敗只顯示已保存快照的 job ID、有限筆數及非零 Exit；原因 UNKNOWN、權限歸因 UNVERIFIED。非零 Exit 不代表已證實權限拒絕。
- 無密碼欄位、核准／執行按鈕、新核准工具、外部 PowerShell 控制或新的執行通道。未修改 `requireProductionHost()`、production blocking、native Codex approvals、Controller、JobStore、V2 Direct/Derived 或 journal。

## 定點驗證

在 `C:\GPT_MCPtool\codex_bridge` 執行：

```powershell
node node_modules/typescript/bin/tsc --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck --rootDir . --outDir .tmp/powershell-readiness-check/compiled tests/powershell-readiness-ui.test.ts tests/workspace-widget.test.ts
New-Item -ItemType Directory -Force -Path .tmp/powershell-readiness-check/web | Out-Null
Copy-Item -LiteralPath web/codex-console.html -Destination .tmp/powershell-readiness-check/web/codex-console.html
node --test --test-isolation=none .tmp/powershell-readiness-check/compiled/tests/powershell-readiness-ui.test.js
node --test --test-isolation=none --test-name-pattern='^drawer reads lazily, coalesces requests, uses bounded refresh and isolates partial failures$' .tmp/powershell-readiness-check/compiled/tests/workspace-widget.test.js
node scripts/check-widget.mjs
git diff --check -- web/codex-console.html src/powershell-approval/contract.ts tests/powershell-readiness-ui.test.ts tests/workspace-widget.test.ts docs/PowerShellReadinessDrawerCheckpoint.md
```

新專用測試 8/8 通過：現有 MCP schema 唯讀、Source gate、完整內嵌 JS 語法、僅開啟／手動讀取、資格限制、失敗分離、舊 schema、非零 Exit 限制、工作切換 race、job identity 不符。
Widget 靜態檢查通過（無遠端資源）。驗證只使用 in-memory MCP 與 UI VM fixture；沒有測試密碼、啟動 Runner、執行 PowerShell artifact 或存取私人 runtime state。

經使用者明確授權，既有 `tests/workspace-widget.test.ts` 僅將三個 RPC 次數斷言由 3／3／6 改為 4／4／8；該 fixture 沒有選取工作，因此只增加 status 讀取。只執行這一個既有 Drawer 測試，1/1 通過。定點 TypeScript 編譯與 diff 檢查通過；未執行整套歷史測試。HTML 複本僅供隔離測試的既有相對路徑讀取，未覆寫 live dist。

## 驗證邊界

僅完成 Source 與定點離線驗證。未部署、未修改 live dist、未重啟、未 commit/push、未重跑 G0/G1，也未重新驗證 live Build ID、ChatGPT 內嵌畫面或 Windows Host。既有大量 WIP 保留；本 checkpoint 不宣稱正式上線或取得任何執行 authority。
