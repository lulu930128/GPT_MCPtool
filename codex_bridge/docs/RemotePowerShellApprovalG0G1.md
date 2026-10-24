# G0 / G1 實作證據與交接（歷史）

> **2026-10-15：** 本文所有「正式功能仍禁用」「本輪不可執行／不可部署」均為 2026-10-13 G0/G1 的歷史狀態及範圍，不是禁止後續 Source 開發。現已授權完成真實 Windows Host、NORMAL／ADMIN、核准／Runner／Receipt，並在開發階段允許唯讀 PowerShell 診斷、排除 `.env`／敏感檔；正式可寫測試須由使用者逐筆發起並核准。依 [最新工程決策](RemotePowerShellApprovalPlan.md) 執行，不重跑本輪已通過的 Fixture 測試。

更新：2026-10-13（Asia/Taipei）。**正式功能仍禁用；無 host / 外部授權驗收。**

## 已完成的 source

- `src/powershell-approval/contract.ts`：固定 `fixture.marker.v1` 完整 script snapshot / SHA-256、NORMAL / ADMIN、project / job / turn、server-owned cwd、空 args、固定環境政策、target / side-effects / risk、TTL 120 秒、idempotency、request / receipt / boot identity。failure evidence 有 source / event / code / classification / 時間 / digest，code 與 classification 必須吻合，job / turn 必須相符；目前 source 僅為 `OFFLINE_FIXTURE`。
- `store.ts`：100 requests、1,000 entries、4 MiB 上限，exclusive lifetime lock、hash chain、revision / digest / state transition 驗證；append + fsync 成功後才讓觀察者看到結果。非完整尾端、lock 衝突或寫入失敗停止；不自動修復、不刪收據。Hash chain 只檢查損壞，不能防止有寫權限的人重寫。
- `broker.ts`：唯一新版 proposal owner；PROPOSED → REVIEW_PENDING → APPROVED / DENIED / EXPIRED → DISPATCHING → RUNNING → SUCCEEDED / FAILED / UNKNOWN。持久化 dispatch intent 後才呼叫 Runner，terminal lookup / idempotent proposal 不重送。重啟時未用核准 EXPIRED、派送中 UNKNOWN。每次核准產生新的 approval event，綁同一份 request digest（含 SID / executor / mode）。
- `password.ts` / `local-ui.ts`：隔離的 local-review capability、30 秒單次 challenge、最多 3 次密碼失敗、scrypt + random salt、timing-safe compare、KDF 後重查到期。HTTP handler 僅離線 fixture 使用，loopback / exact Host / 獨立 session / Origin / CSRF / 嚴格 form / body limit / read timeout / no-store / CSP / frame denial；不是 Bridge route，也沒有正式 listener 啟動器。UI 完整顯示 snapshot、mode、target、args、side effects、digest、expiry；ADMIN 核准按鈕 disabled，backend 亦拒絕。
- `runner.ts`：固定 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`，`-NoLogo -NoProfile -NonInteractive -Command` 的內容只能是 module-owned constant；沒有 caller command / path / environment。固定 script 先拒絕 elevated token 才輸出 marker。執行環境只有 SystemRoot / WINDIR；驗證 canonical cwd、SID、child PID、elevated=false、exit=0、exact marker；5 秒 timeout、4 KiB stdout+stderr，超限或 timeout 只終止 exact child 並保留 UNKNOWN。此固定 artifact 不建立 descendants；不得據此推論可安全管理一般 script tree。
- `tools.ts` + `src/server.ts` 兩處接線：`codex_powershell_status` / `codex_powershell_preview`，僅固定 enum、strict schema、read-only；沒有 request / approve / execute / 密碼 MCP 工具，app visibility 也不能核准。Legacy Broker / R1 source 未修改。

密碼測試只在執行時產生隨機暫時 enrollment，不含靜態密碼 fixture；密碼不進 MCP、process argv、journal 或測試輸出。可控制的 Buffer 使用後歸零，但 HTTP form 的 JavaScript 字串不能保證記憶體清零；正式 protected UI / IPC 與 OS secret store 尚未實作，不可當作正式秘密保存方案。

## 實際驗證

工作目錄：`C:\GPT_MCPtool\codex_bridge`。

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.json --outDir .tmp/powershell-approval-20261013/dist
node --test --test-isolation=none .tmp/powershell-approval-20261013/dist/tests/powershell-approval.test.js
```

- 最終 isolated compile：PASS。新版 targeted tests：**16 / 16 PASS**，包含隔離 HTTP smoke、UI handler、MCP registry、evidence correlation、digest / TTL / idempotency / deny / replay、restart recovery、store lock / corruption、result scope / identity / output / timeout。
- 最後加入 HTTP request body 的絕對 5 秒截止，防止持續少量傳送延長等待；isolated compile 與受影響 UI 單例 **1 / 1 再次 PASS**。其餘已通過且不受影響的測試未重跑。
- 固定 marker 的 Windows 子程序 E2E 實際通過：`LOCAL_INHERITED_PROCESS`、NORMAL、SID 相符、elevated=false、child PID 相符、exit=0、marker confirmed。它繼承目前程序的 Job Object；**不是 out-of-job Operator，不是 host runtime acceptance**。
- `privileged-tools.test.js`：本輪首次執行 **2 / 2 PASS**，包含既有 MCP contract 與 HTTP bearer gate。後續沒有改舊 contract / server 接線，不重跑無關既有測試。
- 首次新版測試 12 / 13 通過；UI forged-Host 負例失敗源於 Node fetch 正規化 Host。改用 `node:http.request` 發送真正偽造 header，單例 PASS；最終全新版 16 / 16 PASS。初次 typecheck 的 Zod optional marker 型別問題已修正。
- 沒跑會覆寫 live `dist` 的 `npm test` / `npm run smoke:http`；改用同一 TypeScript project 的隔離 outDir 與最小實際 HTTP fixture。沒有啟動 App Server、dispatch 真實 job 或測試 Self-Reload。

本機 evidence（ignored，不是 public source）：`.tmp/powershell-approval-20261013/` 的 `baseline-source.json`、`baseline-live.json`、`targeted-tests.txt`、`source-only.patch`、`preservation.json`；各隔離 fixture 的 journal 留在 `.tmp/powershell-approval-tests/case-*/journal/receipts.jsonl`。證據含本機 paths / identities，不應 commit。

## Gate 結論

| 驗收面 | 已取得證據 | 狀態 |
| --- | --- | --- |
| G0 source / offline | strict request、journal、local review/verifier、否定案例 | PASS；不等於 protected host 核准 |
| G1 synthetic | 單筆 proposal → review → approve → durable dispatch → result / receipt | PASS |
| G1 本機繼承子程序 | 固定 marker 的真實 PowerShell / token / PID / exit 驗證 | PASS；仍在目前 Job 限制內 |
| G1 正式 host runtime | 獨立 out-of-job Operator、OS-owned 資產 / 依賴 / ACL / IPC | BLOCKED / 未部署 |
| G2 ADMIN | mode / backend fail-closed / UI 明示 | source PASS；UAC 執行未實作、未授權 |
| G3 Bridge / ChatGPT | source registry 僅禁用 status / preview | live failure capture、真人正式 review、JobStore 結果回填 / 原 job 續接未接線 |
| G4 正式外部授權 | 尚無 host acceptance / 人工正式核准 | OFF；不是 production PASS |

本輪沒有重啟 Bridge、部署、修改 live dist/web/build、JobStore、Control Center、ACL、Startup、全域 policy 或 service；沒有 commit / push。使用者提供的既有 runtime buildId 是背景資料，本輪未將它當作新版載入證據。

SHA-256 保留核查：152 個既有 source 候選中，只有允許的 `src/server.ts`、README、權威計畫 3 檔變更；其餘 **149 檔位元組一致**，包含舊 Broker / R1 / Control Center WIP。指定 live dist/web/build 的 **48 檔全部一致**。三個修改檔案也已逆向還原本輪 diff 並核對原始雜湊，確認保留各檔原有 WIP。`source-only.patch` 含本輪 15 檔差異，與對 HEAD 的混合 WIP diff 分開；其中 3 份 `docs/agent-runs/` 任務文件按既有 ignore 規則留在本機，本公開文件保存必要交接內容。

## 最短重現與人工驗收

**目前可重現的 source/offline 驗收：**

1. 在上述工作目錄執行兩個驗證命令。編譯輸出僅在 `.tmp`。
2. 檢查 16 項通過；最後一項應顯示 `evidence=LOCAL_INHERITED_PROCESS; state=SUCCEEDED; protectedHost=UNVERIFIED; externalAuthorization=OFF`。若 Windows、身分或 sandbox 不允許，保留實際失敗，不改成 skip、不換工具或權限。
3. 查看對應 journal，核對 requestId / jobId / turnId / mode / digest / approvalEventId、DISPATCHING 在執行前已持久化、SUCCEEDED 的 exact marker / exitCode；重跑同 key 只得到原 terminal receipt。UI 測試使用暫時 loopback server，結束即關閉；沒有人工可用的正式核准頁。

**後續正式 NORMAL 人工 E2E（本輪不可執行）：**

1. 先另行授權 protected Operator / 本機 UI / OS secret provisioning 的部署；驗明 Bridge、Codex、其他 MCP 無法改寫 executor、policy、依賴、秘密或 receipts。取得精確 Windows identity / token / ownership、out-of-job 及 authenticated IPC 證據。任何一項缺失，保持 OFF。
2. 從真實 Codex failure event 建立 allowlisted immutable marker proposal；核對原 job / turn、分類與時間證據，不能只用模型文字或 Access denied 字串。
3. ChatGPT 展示 NORMAL、完整 snapshot / target / args / effects / digest / expiry；本人從獨立可信本機 UI 重新輸入密碼核准這一筆。不得把密碼放進 ChatGPT、MCP 或命令列。
4. 受保護 Operator 核對同一 grant / digest / SID / mode，再派送一次；取得 child PID / token / Job ownership / exit / bounded result。ADMIN 仍維持 BLOCKED_AWAITING_LOCAL_UAC。
5. 經過待實作的 correlation adapter 將 receipt 關聯原 JobStore job / turn，再由使用者另開續接回合；不讓本機 UI 啟動新的 lifecycle 或自動重送 UNKNOWN。
6. 驗證一次拒絕、過期、跨 mode / turn、重播及派送後失聯；拒絕不派送，失聯 UNKNOWN 不重試。這些實機證據完成前，不把本輪 PASS 升格為 host / production PASS。
