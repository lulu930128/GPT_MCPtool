# Codex 工程權限與秘密讀取邊界

2026-10-25 使用者產品決策。適用 Codex Bridge；不改其他 MCP、Control Center 或全域 Codex 設定。

## 一般工程與當次秘密授權

- 一般工程可依任務授權讀寫程式，執行 shell、Git、PowerShell、Node、Python、建置、測試與 HTTPS。
  Plan／Native Review 保持檔案唯讀並開啟網路；一般寫入保留 Full Access 與 `on-request`。
  不要求一般工作經 Control Center，NORMAL／ADMIN 驗收也不會自動收窄 Codex 權限。
- 預設不讀真實 `.env`／`.env.*`、密碼、Token、私鑰、Credential／DPAPI secret；非秘密
  `.env.example` 可讀。使用者當次明確指定「哪些檔案／資料可讀」後，只讀指定範圍，
  不跨任務延用，也不因預設規則反覆拒絕同一合法授權。
- 讀取不等於寫入或揭露。秘密不得自動進入模型結果、日誌、外部 API、Git、附件或驗收資料。
  對只需本機運算的資料，應只回傳事先限定的非秘密結果；不能把原文讀取到模型上下文當作
  「只在本機使用」。需要傳送原文時，必須另有明確的資料目的地授權及可執行的政策支持。
- Windows、平台、Host 真實拒絕仍須停止；文字授權不能變更 ACL、解除平台拒絕或換入口重送。
  本次沒有任何具體真實秘密的讀取授權，測試只使用假資料。

## 已實作的 Source 邊界

兩個自訂 profile 的 `network.enabled=true`；Plan 不改用 Full Access。Controller 在新 Plan
的 `thread/start` 回覆及續接的 settings notification／readback 核對 `readOnly` 與
`networkAccess=true`，缺失或不符時不開始 turn。這證明回報設定一致，並不證明 HTTPS 成功。

Installed release tree 內含 Node、Codex 與工具，改為 read；owner/runtime、部署設定、
`.local`、`.secrets`、`.tunnel-client`、projects file、dataDir 及原 credential 路徑 Deny 保留。
`.env.*` 改為排除完整 `.env.example` 名稱的互斥 globs，保留 `.env.example.bak` 等拒絕。
Windows 原生 deny glob 展開不採用額外 read exception，所以不能用「先 deny 全部，再 read example」。
未存在的精確 `.env` 路徑仍可能被原生 helper 建成目錄；這項上游行為未在本輪更動。

Source 在 projectRoot、handoff、shared roots 或工具 read root 落在精確 Deny 父目錄時，
回 `PERMISSION_PROFILE_DENIED_PARENT`；不把子目錄重新開放。一般 `.tmp/codex-inbox`
與 `.local` 是兄弟目錄，沒有固有的父子衝突。重疊的父子 Deny 保留，因為刪除子規則可能失去
其 reparse target 的保護。這只是 lexical 檢查，不能作為 reparse／OS 隔離證明。

Installed child 保留原 env allowlist，只增加固定 `PATHEXT` 及本機已核對的
`C:\work\Git\cmd`、`C:\miniconda3`。工具須存在、檔案與祖先目錄不可為 symbolic link；
其他錯誤直接回報。Node/npm 仍取自 release。未繼承 ambient PATH、Node preload、proxy 或秘密 env；
未找到可核對的 uv 入口，沒有增加 uv、Scoop 或整個工具箱。這些固定路徑只適用目前 Windows
host layout；其他主機需另做明確的工具 binding，不會掃描或下載工具。檢查不是 executable hash pin
或消除替換競態的機制，也不宣稱一般使用者工具與 immutable release 有相同信任等級。

## G0 證據與未知

使用者提供的前輪觀測：build `4d414a1b6c30e972`、App Server 0.154.0、ready/allowed，
但 Plan job `aa799e2c-3b73-4103-b197-8090a5686692` 在讀 AGENTS 前得到
`windows sandbox failed: helper_unknown_error: apply deny-read ACLs (-32603)`；workspace_write 可完成。
這是前輪證據，本輪未重新讀取 JobStore 或探查現役服務。

核對固定版本上游原始碼：

- [setup helper](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/windows-sandbox-rs/src/bin/setup_main/win.rs)
  的 `run_setup_full` 同步呼叫 `sync_persistent_deny_read_acls`，錯誤 context 即 `apply deny-read ACLs`。
- [deny ACL implementation](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/windows-sandbox-rs/src/deny_read_acl.rs)
  會 canonicalize 現存路徑、為缺少的精確路徑建立目錄，再加入 ACE；因此 schema allowed 不代表可執行。
- [glob resolver](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/windows-sandbox-rs/src/deny_read_resolver.rs)
  在 startup 前展開現存匹配；只用 deny entries 重建 matcher。
- [官方 profile schema](https://learn.chatgpt.com/docs/config-file/config-reference)
  定義 `extends`、filesystem deny、network.enabled；實際 0.154.0 parser 另以離線 script 核對。

目前不能從這個外層錯誤區分：哪個路徑的 ACE 寫入失敗、既有 persistent deny state、
helper 問題、OS WRITE_DAC／建立目錄權限問題。Release root Deny 是已確認的可讀工具衝突，
但尚未證明它就是現役 job 的根因。保留其餘 Deny 後仍可能因 OS/helper 狀態失敗。
本輪禁止 ACL 變更，因此不執行會寫入 ACL 的 Sandbox helper；沒有重試 Plan job。

## 尚未實作的逐任務受控例外

現有 App Server 共用全局 profiles，沒有可信的逐任務 grant schema、隔離 executor 或撤回機制。
不可把自然語言授權解析成全局 Deny 刪除，也不可用 Full Access 充當秘密例外。
同一 Windows 身分下的 Full Access 可以讀取該身分可讀的資料；流程規則和 redaction 不能保證硬隔離。
所有專案的預設不讀秘密是工作規則；現有 profile 只涵蓋列出的路徑，沒有完整秘密分類器。

可執行的後續方案需另外授權與實作，不在本輪部署：

1. 將一般 Codex 工作置於沒有使用者私有憑證的專用 OS 身分／VM，保留工程工具與允許的 HTTPS。
   私有資料由既有受控 owner 保持在 executor 外；不複製到共享 workspace。
2. 在可信使用者入口記錄 exact task/turn、檔案 realpath／file identity、允許欄位、唯讀用途、
   到期／撤回與輸出目的地。grant 不接受模型自行宣告，不進共用 profile、不跨任務或 resume 繼承。
3. 若只需本機使用，owner 以限定操作讀取 exact handle，只回傳核准的非秘密投影；若明確授權原文
   進入模型，使用任務專屬隔離程序／唯讀掛載與限定資料出口，完成即銷毀。兩種用途須明確區分。
4. 執行前重驗 scope、撤回、expiry、file identity 與 OS 權限；測試跨任務重用、路徑替換、
   同時任務、取消、crash、stdout／stderr／artifact 洩漏；只記 grant metadata 和結果狀態，
   不保存秘密值或其 hash。任何實際拒絕都停止，不能把此方案當作拒絕後的替代入口。

原則上允許合法的當次指定讀取；現有 Native Deny 無法精準例外時，須如實回報技術缺口。
秘密硬隔離與逐任務例外實作均為 **UNVERIFIED**，不是 PASS。

## 驗證與交付

- `npm run build`：TypeScript 編譯；此 package 沒有獨立 lint script。
- `node --test --test-isolation=none dist/tests/config.test.js dist/tests/installed-runtime.test.js dist/tests/controller.test.js`
  覆蓋 profile、假秘密名稱、`.env.example`、Deny 父子配置、工具解析、新舊對話與失敗停止。
- `node scripts/check-permission-profiles.mjs`：隔離假資料／空 CODEX_HOME，以固定原生 0.154.0
  產生 schema 並讀回 profile；不啟動 thread／turn、不載入真實憑證、不呼叫 ACL helper。
- `doctor-app-server.mjs` 明列 Plan startup／HTTPS／secret isolation 為 `UNVERIFIED`；
  不因 capability ready/allowed 宣告 E2E。

Source 驗證結果與本次 Diff 見 [任務紀錄](agent-runs/plan-permissions-20261025/Progress.md)。
Runtime 未部署、未重啟；Plan 真實啟動、HTTPS、Native Deny fixture、NORMAL Production 仍為 `UNVERIFIED`。
