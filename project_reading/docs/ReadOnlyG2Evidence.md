> 歷史證據／設計：2026-10-13 使用者已修訂身分與人工維護需求；現行路徑見 [本機管理](LocalComponentManagement.md)。以下原文與先前驗證結果保留，不是目前 adoption 前提。

# G2 唯讀通道：source、驗證與回退

2026-10-13。目標為 G1 Workspace 與獨立 Control Center owner 的 bounded read-only IPC。
**目前交付的是 fail-closed source candidate；完整 authenticated G2 acceptance 未達成。**
原 G1 live `toolContractVersion=2026-10-13.1`、buildId `692a1325cb8def33ee53`
來自使用者提供的前次驗收，本輪未重驗正式 runtime，也沒有 restart/adoption。
input allowlist／工具數／G1 fallback contract 未變；source `toolContractVersion` 升為
`2026-10-13.2`，區分 G2 behavior/output 與 G1 live。相關 live smoke assertions 已同步，
但沒有對正式 runtime 執行它們；G1 live 對這些新 assertions 預期尚不相符。
build 產物不表示正式 server 已載入此 source。

## 已達成與未達成

| 面向 | 結果與限制 |
| --- | --- |
| source 邊界 | 只動 `project_reading`、`mcp_control_center` 的精確清單；無 lifecycle mutation |
| schema | SDK 驗證三個既有 recovery tools、七個 ID、五個 action、strict extra-key denial；無新增 mutating tool |
| framing／connectivity | C# named pipe fixture 與 Node ↔ C# 真實本機 fixture 均 PASS；使用隨機 fixture namespace |
| OS 身分測試 | fixture 的 kernel server PID／start/SID、wrong SID 拒絕 PASS；不是正式 owner 身分 |
| 真實 protected owner | `NOT_VERIFIED`；`Owner.Open()` 明確 `PROTECTED_OWNER_SOURCE_UNVERIFIED` |
| 真實 tray launch | `NOT_ACTIVATED`；保留 `PENDING_TRAY_INTEGRATION` |
| client 信任 | matching fake JSON/nonce 仍 `CLIENT_TRUST_UNPROVEN`；`ownerVerified=false` |
| 後續 protected bootstrap | `MANUAL_PENDING`，本輪未安裝、未改 ACL |

原需求「verified owner 可用時回 trustworthy status/preview/receipt」仍受上述 owner 與
client source-attestation gate 阻擋。不能把這份 source 或 fixture 說成已連上受保護
正式 Control Center。實際固定安裝目錄 `Test-Path` 為 `False`。

## 實作與安全修正

`src/cc-readonly.ts` 整合到既有 `component-recovery-server.ts`；先驗證工具輸入，
才嘗試固定 pipe。process-wide 最多兩個 IPC exchange，單次 1800ms、16 KiB output、
不重試、不排隊。status 隨後使用既有 G1 TCP observation（最多 5250ms）；總設定
預算 7050ms，不包含 event-loop scheduling delay。無 child process、generic shell、
path/executable/URL/env 參數。

missing pipe 回 `NOT_CONNECTED`；權限／transport 問題安全分類為 `DEPLOYMENT_BLOCKED`、
`IPC_TIMEOUT` 或 `IPC_INVALID_RESPONSE`，不回 raw exception。即使 response 有效也只回
`CLIENT_TRUST_UNPROVEN`，不採用其中的 status claim。G1 status 保留 `UNVERIFIED`，
preview 維持 `AUTHORITY_NOT_DEPLOYED`、`allowed=false`、`executable=false`；
receipt `found/completed/receipt=null`，不偽造 not-found 或完成。

review 指出的 writable helper self-attestation 已移除：production adapter 沒有
`runBoundedProcess`／`child_process`／helper 執行路徑；新建的 orphan helper 已刪除。
另一 finding 為 exact PowerShell PID 不證明實際 source，已加入 non-configurable
production owner hard stop。fixture-only internal construction 只供測試，沒有 MCP、
CLI 或環境變數可啟用它。fragmented-response 測試使用單一時間戳 fixture，避免 flake。

## 實際驗證

PowerShell 命令從 `C:\GPT_MCPtool` 執行；Node/npm 從 `project_reading` 執行。

| 命令 | Exit | 實際結果 |
| --- | --- | --- |
| `npm run build` | 0 | TypeScript PASS；先前動態 schema union 的 TS2322 已以明確 string narrowing 修正 |
| `node --test dist/tests/component-recovery.test.js dist/tests/cc-readonly.test.js dist/tests/diagnostics.test.js` | 0 | **30/30**：G1 9、G2 7、既有 diagnostics 14 |
| `powershell -NoLogo -NoProfile -NonInteractive -File mcp_control_center/tests/test-readonly-g2.ps1` | 0 | **70 checks PASS**；初次 static mutation regex 誤命中 `StartTime`，已限縮為方法呼叫 |
| `powershell -NoLogo -NoProfile -NonInteractive -File mcp_control_center/tests/test-readonly-g2-interop.ps1` | 0 | Node ↔ native isolated named pipe PASS；有效回應仍不提升 trust |
| `node scripts/smoke-component-recovery.mjs` | 0 | 隔離 authenticated HTTP：401、34 tools、自身／中樞拒絕、G1 fallback；ownerChannel=`NOT_CONNECTED`；版本更新後另驗 source `.2` |
| `node --check` 四個本輪 smoke scripts | 0 | syntax PASS；不執行 live assertions |
| `git diff --check -- project_reading mcp_control_center` | 0 | PASS；既有 CRLF 提示，不修改換行／index |

負測試包含：unknown/self component、35 action/component preview 組合、duplicate key、
unknown field、execute opcode、version、過大 request/frame、malformed JSON／UTF-8、
fragmentation、額外 frame、nonce mismatch、跨 connection challenge replay、idle timeout、
stale/future status、重複 rows、untrusted code owner、writable/null DACL、wrong SID、
PID start-time mismatch、dev owner boot、fake matching helper response。

沒有重跑 full `npm test`。使用者已明確提供既有 write-tools sandbox
`EPERM realpath %USERPROFILE%` blocker，要求不得放寬 policy 或重複 full suite。
未執行正式 `control-center.ps1 -Action Status`（它會寫 state/event）、tray selftest／restart、
任何元件 controller action、Codex Bridge runtime 操作或 PAOS restart。

## 精確變更與 rollback

既有檔案只修改（含先前 G1 untracked WIP）：

- `project_reading/src/component-recovery-server.ts`：換成 G2 fail-closed adapter，更新說明。
- `project_reading/README.md`：附加本交接連結與部署限制。
- `project_reading/package.json`：source toolContractVersion `.1` → `.2`。
- `project_reading/scripts/smoke-component-recovery.mjs`：隔離 HTTP 驗證 `.2`。
- `project_reading/scripts/smoke-live-mcp.mjs`、`scripts/smoke-live-diagnostics.mjs`：只同步版本 assertions；未執行 live smoke。

新增檔案：

- `project_reading/src/cc-readonly.ts`
- `project_reading/tests/cc-readonly.test.ts`
- `project_reading/scripts/smoke-readonly-g2-interop.mjs`
- `project_reading/docs/ReadOnlyG2Evidence.md`
- `mcp_control_center/src/ReadOnlyG2.Native.cs`
- `mcp_control_center/src/McpControlCenter.ReadOnlyG2.psm1`
- `mcp_control_center/tests/ReadOnlyG2.Check.cs`
- `mcp_control_center/tests/test-readonly-g2.ps1`
- `mcp_control_center/tests/test-readonly-g2-interop.ps1`
- `mcp_control_center/docs/ReadOnlyG2Handoff.md`

變更前 exact-byte copies、hash 與 HEAD/index baseline 位於 ignored local evidence：
`project_reading/.tmp/g2-readonly-20261013/`。原 component-recovery-server.ts 本身就是
G1 untracked WIP，因此不能用 HEAD 或普通 git diff 代表它的回退原點。
版本調整前的三個 smoke script 快照及 hash 另列 `version-baseline.json`；
build 更新 ignored `dist`，沒有改 lockfile。

回退先比對同目錄 `after.json` 的精確 hash；有後續變更時先 review，不直接覆蓋。
僅把上述六個既有檔案恢復至 snapshot bytes，再移除本次新增清單，保留所有其他 dirty WIP。
不要 reset、checkout HEAD、stash、批次刪目錄或以目前 HEAD 取代 WIP 身分。
本輪沒有部署，所以沒有 runtime rollback；日後 build/adoption 必須獨立驗證。

CC core/tray/NormalOperator 與根 README 沒有修改；Codex Bridge 沒有修改；
HEAD/index 應保持 baseline，最終 hash 比較記錄於 `after.json`。
受保護部署／root README 的正式共享 runtime 描述需在未來 adoption gate 對齊；本輪沒有新增
共享正式 runtime，且使用者只授權修改這兩個元件目錄。

後續 gate 詳見 [CC handoff](../../mcp_control_center/docs/ReadOnlyG2Handoff.md)。
