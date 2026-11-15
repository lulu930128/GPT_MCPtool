> 歷史證據／設計：2026-10-13 使用者已修訂身分與人工維護需求；現行路徑見 [本機管理](LocalComponentManagement.md)。以下原文與先前驗證結果保留，不是目前 adoption 前提。

# G0/G1 驗證證據（2026-10-13）

結論：G0 邊界查核與 G1 source／focused contract 驗證完成；完整回歸因既有
write-policy 測試的 sandbox 路徑限制未完成。G2+ 未部署；正式 runtime adoption、
host discovery 與 ChatGPT E2E 都是 UNVERIFIED。

## 本次增量

新增 `src/component-recovery.ts`、`src/component-recovery-server.ts`、
`tests/component-recovery.test.ts`、`scripts/smoke-component-recovery.mjs`、
`docs/RemoteMcpComponentRecoveryPlan.md` 與本文件。

既有檔案僅增加 `src/server.ts` 的 import／registration、更新 `package.json`
toolContractVersion、README 契約說明，以及 `tests/write-tools.test.ts`、
`scripts/smoke-assets.mjs`、`scripts/smoke-live-mcp.mjs`、
`scripts/smoke-live-diagnostics.mjs` 的工具總數／契約版本斷言。
沒有修改 dependency、lockfile、reader、writer、path guard、diagnostics 或 lifecycle。

## 命令與結果

工作目錄為 `C:\GPT_MCPtool\project_reading`，除另註者外。

| 命令 | Exit | 證據 |
| --- | --- | --- |
| `npm run build` | 0 | TypeScript build 通過；初次測試檔的兩個 TS2339 assertion typing 錯誤已修正 |
| `node --test dist/tests/component-recovery.test.js` | 0 | 9/9；固定七 ID、五 action 共 35 組 preview、正負輸入、限流、MCP schema 及 canonical registration |
| `node --test dist/tests/diagnostics.test.js` | 0 | 14/14；既有 TCP deadline／cleanup、注入拒絕、bounded runner、HTTP、concurrency |
| `node scripts/smoke-component-recovery.mjs` | 0 | 隔離 authenticated HTTP：401、34 tools、自身／中樞拒絕、preview／receipt 未部署 |
| `npm test` | 1（中斷） | build 成功；中斷前 74 個通過、17 個失敗，卡在既有 writer lock test；不是完整 suite 統計 |
| `node --test --test-name-pattern="operator state rejects a canonical path identifying a different object" dist/tests/write-tools.test.js` | 1 | 隔離重現 `EPERM: operation not permitted, realpath '%USERPROFILE%'` |
| `node --check scripts/smoke-component-recovery.mjs`（另含三個修改的 smoke script） | 0 | 語法通過 |
| 根目錄 `git -c core.safecrlf=false diff --check -- project_reading` | 0 | 既有 tracked dirty diff 無 whitespace error；新增檔另以 UTF-8 及增量 patch 檢查 |

`npm test` 使用既有預設 TEMP，write path guard 遍歷到使用者目錄時遭 EPERM，
使 policy 無效；writer lock 測試等待不會進入的 beforeCommit hook。使用 Ctrl-C
停止本次 test session，未終止任何正式 runtime。隔離測試只使用既有 path guard，
不呼叫新 recovery 功能；相關 implementation 的 bytes 與起始雜湊相同。
未改 TEMP、未繞過 policy、未調 ACL 或升權重跑。完整 write regression 仍需在
可正常解析其 TEMP 父目錄的獨立授權環境中執行原命令。

HTTP smoke 於 `2026-10-13T10:41:56.229Z` 至 `.233Z` 觀察七個固定 port 全部
`TCP_CONNECTED`。這只證明本機 TCP 接受連線，service identity、health、ownership、
ChatGPT E2E 全部保持 UNVERIFIED。測試 server 在同一個 Node 測試程序使用 port 0，
並在 finally 關閉；沒有啟動、停止、重啟任何受管元件。

## WIP、HEAD 與 index

起始 HEAD：`a94d12bbdeecc592d3e738b975cc28f83afc72ae`。
起始 index SHA-256：`b4aecea67d482544c1f4c649b34791ec09440f585cbb5a7cb47afd25ccaa894c`。
比對時兩者皆未變；未 stage、commit、push。起始雜湊涵蓋 818 個 Git 列舉的
可讀 tracked/untracked 檔案，不掃 ignored runtime/cache；受政策禁止的
`codex_bridge/.env.example` 也未讀取。這不代表可證明所有 ignored runtime bytes。

本次僅寫入 project_reading。其餘既有 Project Workspace WIP 與 Control Center
source 的起始 bytes 均保留。七個共用檔案保留本次修改前快照，供增量比對及回退。

查核期間存在外部並行變更：`codex_bridge/src/server.ts` 雜湊改變，且新增
`codex_bridge/src/powershell-approval/` 下 broker、contract、local-ui、password、
runner、store、tools 七個 TypeScript 檔案。本次沒有寫入、回復或使用這些檔案；
不能宣稱 Codex Bridge worktree 在整個時段完全未變。其餘非本次 allowlist 的
起始檔案雜湊比對通過。Codex Bridge 核准設計與 Control Center 均未由本次修改。

本機詳細證據保存在 ignored `.tmp/component-recovery-g1-20261013/`：
`evidence.json`（baseline hashes、工具輸出、外部 drift）、`before/`（七個既有檔案
修改前 bytes）、`after/`（本次檔案）、`incremental.patch`（排除先前 WIP 的增量）。
這些是本機工程證據，不應加入 public repository。

回退先在 repo 根目錄檢查
`git apply --reverse --check project_reading/.tmp/component-recovery-g1-20261013/incremental.patch`；
實際反向套用須先檢查後續 WIP 與新增檔案清單。禁止 reset 到 HEAD 或回復整份 dirty
檔案；本次沒有執行回退。完整邊界與後續 gate 見
[計畫](RemoteMcpComponentRecoveryPlan.md)。
