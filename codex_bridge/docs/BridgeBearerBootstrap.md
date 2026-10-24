# Bridge Bearer 一次性初始化交接（2026-10-23）

本輪為 **SOURCE／隔離驗證**。未執行正式 Prepare、產生正式 token、讀取正式秘密、
改 ACL、安裝、Cutover、Rollback 或啟停服務。使用者回報現役
`r12-stable-pathfix-20261023` 的 `BLOCKED_NO_BRIDGE_BEARER_PIN` 尚未經部署解除。
本次 source 保留先前 DIRECT NORMAL WIP、唯一 ApprovalStore 與原 Native Host。

## 接線與認證邊界

- 有 token 時，兩條 Bridge tunnel launcher 都使用固定參數：
  `--mcp.extra-headers "Authorization: env:CODEX_BRIDGE_TUNNEL_AUTHORIZATION"` 與
  `--mcp.discovery-extra-headers "Authorization: env:CODEX_BRIDGE_TUNNEL_AUTHORIZATION"`。
  專用 child env 的值為 `Bearer <secret>`；secret 不進命令列、profile 或輸出 JSON。
  Installed launcher 驗證 exact command、專用 env 值及原 executable／context。
  無 token 時不加參數，並清除 child 的 stale header env。
- 這只建立 **Tunnel Client → Bridge 的服務間認證**，不證明遠端 end-user identity。
  Tunnel 遠端入口的認證／權限仍為 **UNVERIFIED**；本輪沒探測外部入口，也不判定 Tunnel 安全失敗。
  `sample_mcp_remote_no_auth` 是 upstream mode，不能作為 Bridge bearer 或遠端使用者認證證據。
- Bridge 原 HTTP 驗證與 SDK auth metadata、NORMAL 的 per-request bearer 比對保持不變。
  userIntent、caller JSON、session ID 或外部任意注入 header 都不新增信任。
  不新增每筆 NORMAL 本機確認、認證服務、Manager、Journal、Host 或 Service。

## 持久化與登入順序

Bridge-owned `scripts/bridge-bearer.ps1` 沿用 Windows PowerShell 的 CurrentUser DPAPI
`ConvertFrom-SecureString`／`ConvertTo-SecureString` 模式。固定位置是 manifest 綁定的
Bridge dataDir 下 `.bridge-http-bearer.dpapi`，即本機
`C:\GPT_MCPtool\codex_bridge\.local\runtime\.bridge-http-bearer.dpapi`。
不使用 HKCU 明文 user env、不建立舊根目錄、不另開 runtime store。

原 operator 驗證 v6、原 SID／profile／LocalAppData、canonical dataDir、完整 private ACL／
non-reparse chain；新檔案繼承已驗證的 private parent ACL，再核對 exact Windows user owner。
不修改既有 ACL。新 token 使用 32 bytes 的 cryptographic RNG；只持久化 DPAPI 密文。
Process env 只在原操作者程序或受保護啟動路徑載入，無需使用者複製／貼上憑證。

登入時的既有路徑為：

1. Startup 啟動受保護 `tray.ps1`，呼叫原 `Assert-McpCcInstalledActivation`。
2. 原 binding 先核對 immutable manifest、完整 closure、原 operator、state／profile 保護。
3. 僅對有 pin 的 v6，核對 closure 內固定 Bridge helper 的 protected path，再由該 helper
   讀取／解密私有檔，驗證保存值與 manifest pin，載入 Process env。
4. 原 binding **仍執行** process token SHA-256 與 manifest pin 的比對，才通過 selection／Activation。
   Tray 隨後才建立 listener／reconciliation；Bridge child 不是首次載入 token 的位置。

Control Center module 不實作秘密 IO／DPAPI；它委派 protected Bridge helper，並保留既有 env hash
驗證。既有 tokenless release 完全不讀取或採用新 secret。錯誤 ambient token、錯 pin、密文錯誤、
不安全 ACL 或 closure 都拒絕，不用清除錯誤 env、跳過驗證或讀其他 secret 作 fallback。

## 一次性升級與中斷恢復

原 `installed-release-operator.ps1 -Action Prepare` 增加 `-InitializeBridgeBearer`，僅接受
原獨立、非管理員 Windows operator 的 v6 InstalledSource upgrade；不得搭配 migration。
第一次在檔案不存在時使用 CreateNew 保留名稱，產生、保存並讀回同一憑證。

若 Prepare 後段失敗，previous immutable pin 仍為空且保存檔通過相同 Owner／ACL／DPAPI 驗證，
再次明確 Prepare 可重用同一保存值；不覆寫、不旋轉、不產生另一憑證。若 process env 已有值，
必須等於保存值。空檔、損壞密文、錯 owner 或衝突值會停止，不能自動刪檔重建。
既有 PackageRoot 仍拒絕覆蓋；完成失敗原因審查後，使用新的、尚不存在的輸出路徑。

`Get-InstalledUpgradeState` 只放行 **v6 空 pin → 小寫 64 位 SHA-256 且精確匹配保存 secret**。
已採用 pin 的變更、清空、v5 初始化、project／profile／原 tunnel ciphertext／dataDir／owner
變更仍拒絕。普通後續升級可保留同一 pin。Prepare、PlanState、BindState 及 cutover baseline
重驗沿用原 helper、immutable evidence 與 receipt；不修改舊 release／manifest。

Prepare／Preflight／Cutover 前的 HTTP probe、controller child env，以及 Rollback 的 tray／
controller／HTTP probe 都依各自目標 release 的 pin 選用 token。舊空 pin 不繼承候選 token；
新有 pin 的 runtime 仍要求成功認證與匿名 401。Rollback 保留原流程與未知狀態停止規則；
新密文保留在私有位置，但舊 tokenless runtime 不會採用它。

## 獨立 operator 命令範本

**本輪不執行此步。** 原使用者必須從 Windows 桌面獨立開啟 Windows PowerShell 5.1，
不是 Codex／Bridge child，也不是系統管理員。這是既有 operator 邊界，不是 NORMAL 每次確認。

尚未建立或認證本次完整 isolated built candidate、package 及新 ReleaseId，因此不能提供已填妥
三個輸入的正式部署命令。下列範本只在 `$CandidateRoot`、`$PackageRoot`、`$ReleaseId` 已經過
原封裝流程確認後使用；CandidateRoot 必須符合原 `ISOLATED_BUILT_CANDIDATE_REQUIRED`，包含
先前 DIRECT NORMAL WIP 與本輪 source／編譯結果。不能直接指向正式 monorepo 或舊 candidate。

```powershell
& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -File `
  'C:\GPT_MCPtool\codex_bridge\scripts\installed-release-operator.ps1' `
  -Action Prepare -InitializeBridgeBearer `
  -UpgradeFromReleaseRoot 'C:\Program Files\McpCcReleases\r12-stable-pathfix-20261023' `
  -LegacyWorkspaceRoot 'C:\GPT_MCPtool' `
  -CandidateRoot $CandidateRoot -PackageRoot $PackageRoot -ReleaseId $ReleaseId
```

此 Prepare 會讀取既有 runtime 的健康／ownership／discovery evidence，並由原 operator
建立或重用私有密文、產生候選 package；它不是零 side effect 的離線測試。
停在 PACKAGED，不執行 Install／PlanState／BindState／Cutover。後續正式操作仍由原 operator
依既有新 release 交接執行；不得在正式 manifest 手動填 pin，亦不得把 token 或其 hash 貼回對話。
遇 `INDEPENDENT_OPERATOR_REQUIRED`、權限拒絕、未知 receipt 或 binding 錯誤即停止，不換入口重送。

## 本輪檔案與驗證

- Source：`scripts/bridge-bearer.ps1`、`scripts/codex-bridge-runtime.psm1`、
  `scripts/installed-release-operator.ps1`、
  `../mcp_control_center/src/McpControlCenter.InstalledRelease.psm1`。
- Tests：`tests/test-bridge-bearer.ps1`、`tests/test-bridge-bearer-activation.ps1`、
  `tests/test-installed-upgrade.ps1`。文件：本檔。

從 repository root 執行的定點命令：

```powershell
powershell.exe -NoProfile -File codex_bridge/tests/test-bridge-bearer.ps1
powershell.exe -NoProfile -File codex_bridge/tests/test-bridge-bearer-activation.ps1
powershell.exe -NoProfile -File codex_bridge/tests/test-installed-upgrade.ps1
powershell.exe -NoProfile -File codex_bridge/tests/test-installed-binding.ps1
powershell.exe -NoProfile -File mcp_control_center/tests/test-normal-production-source.ps1
```

既有 55 項 Node 回歸沿用 [NORMAL 隔離驗證](../../mcp_control_center/docs/NormalOperatorHandoff.md#可重現的-source-隔離驗證)，
本輪只隔離編譯該 HTTP／四個 test entrypoints，使用既有 `C:\Program Files\nodejs\node.exe`；
沒有更新 source dist、安裝 dependency、跑全 repo 或 G0/G1。

本輪結果：

| 驗證 | 結果 |
| --- | --- |
| bearer／兩條 launcher／probe／rollback／安全重入 | 39 checks PASS |
| 實際 Activation 呼叫鏈／實際 Prepare script 複製／空檔 reservation | 14 checks PASS |
| v5／v6 upgrade、首次 pin、替換／降級拒絕與原 baseline | 45 checks PASS |
| 既有 installed binding 定點回歸 | 82 assertions PASS |
| 既有 DIRECT NORMAL 與相關 Node 回歸 | 15 + 40 tests PASS |
| 既有 PowerShell／C# source 檢查 | 14 checks PASS；Runner／native pipe 未執行 |
| 7 份 PowerShell source／test parser、8 檔 UTF-8、文件相對連結 | PASS |
| `git diff --check`、本輪新增內容 secret-pattern 掃描 | PASS |
| 開始時保存的 226 個既有 WIP 檔案 SHA-256 | 全部不變；僅本輪 8 檔加入差異 |
| main／HEAD／staged state | 不變；未 add／commit／push |

合成測試不代替正式 Windows DPAPI／ACL／冷登入或 Tunnel 遠端驗收。本輪實際認證與啟動秘密 IO
只接到 inert fixture／mock DPAPI；所有 process launch、HTTP probe 均攔截，既有 Node HTTP 測試
只使用隔離 ephemeral port。正式外部認證、部署與 NORMAL E2E 仍未驗證。
