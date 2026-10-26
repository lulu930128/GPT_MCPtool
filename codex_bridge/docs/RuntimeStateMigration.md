# 正式 Runtime 資料遷移

此流程將 v5 的 `C:\CodexBridge` 與 `C:\McpControlCenter` 分別遷至
`<workspace>\codex_bridge\.local\runtime` 與 `<workspace>\mcp_control_center\.local\runtime`。
程式仍安裝於受保護的 Program Files release。既有 v5 manifest 與歷史 receipt 保持原貌，
新 manifest 使用 v6、Bridge binding 使用 v4；不能把舊 manifest 的根路徑直接改寫。

`.local` 已由 Git 排除；實體資料在 checkout 內不代表它可進入公開 source archive。備份分別在各
Owner 的 `.local\migration-backups\<release-id>`，不讓 Control Center 接管 Bridge domain data。
本流程不建立第二個 manager、controller、service、MCP 或永久 Junction。

## 前置條件

- 以原操作者從 Windows 桌面獨立開啟 Windows PowerShell 5.1。由 Codex/App Server 程序鏈執行會
  被 `INDEPENDENT_OPERATOR_REQUIRED` 拒絕；不得移除檢查或用另一條控制通道迴避。
- 原 release 為已接受的 v5，所有 Bridge jobs 結束，既有遠端 reload receipt 已完成。
- 若設有 DataDir 環境變數，須先核對；migration plan 不接受隱含的 Process/User/Machine override。
- 明確批准祖先目錄 ACL 收緊。目錄本身不再允許其他帳號／sandbox 寫入；保留原 operator、SYSTEM、
  Administrators、每條 Deny 與 source 子項的繼承權限。先保護子目錄再調整祖先，不遞迴重設 repo ACL。
- 新根目錄與該 release 備份目錄必須不存在，磁碟需至少兩份資料副本加 1 GiB 餘裕。

## 操作階段

所有動作屬於既有 `scripts\installed-release-operator.ps1`。正式動作只有 `Install` 使用管理員
PowerShell，其他動作必須使用原操作者的普通 PowerShell。不要把下列階段合成失敗仍繼續的批次。

1. `Prepare -RuntimeMigration -UpgradeFromReleaseRoot <selected-v5> ...`：使用隔離且已建置的
   candidate，產生 v6 package。重新核對 package 檔案、hash 與 source closure。
2. `Install -PackageFile <zip> -PackageSha256 <hash>`：沿用原不可變 release 安裝機制；不選取、不啟動。
3. 從新 installed operator 執行 `MigrationPlan -ReleaseRoot <v6> -PreviousReleaseRoot <v5>`，
   檢視根路徑與 ACL 範圍，保存 `statePlanSha256`。
4. `MigrationApply -ReleaseRoot <v6> -PreviousReleaseRoot <v5> -StatePlanSha256 <hash>`：
   先保存 ACL／設定／Startup 回復證據，套用已批准的 ACL，透過舊 controller 正常停止 Bridge。
   `STOPPED_EXIT_TRAY` 代表接著只退出 Control Center UI，不能自行 kill 程序。
5. 再執行 `MigrationApply -ReleaseRoot <v6>`：此明確停機階段才允許續接。
   驗證 tray／舊程序／listener／ApprovalStore lock 已退出，才讀 Journal metadata、建立完整備份與
   目的副本。逐檔 SHA-256、檔案樹、ACL 寫入回讀與原始資料再次比對全通過後，才建立新 binding、
   修改正式 source 設定與 Startup、啟動原有 owner/controller。
6. `MigrationVerify -ReleaseRoot <v6>`：核對 loaded binding、selected tray、PID／listener ownership、
   canonical Build、health、MCP discovery、ApprovalStore OPEN/THIS_INSTANCE、全部歷史 job 數及保留資料。
   Journal 在停機時已逐位元比對；啟動後尊重 lock，由唯一 Store 驗證 hash chain/schema，另核對檔案長度。
   不以不同 sharing mode 讀取已鎖定的 Journal。
7. 外部 MCP 回讀與人工驗收通過後，以 `MigrationVerify` receipt 的當前 SHA-256 執行
   `MigrationCleanup -ReleaseRoot <v6> -StatePlanSha256 <receipt-hash>`。它再次核對兩份備份、兩個舊根目錄
   與現役引用，才按已驗證 manifest 逐項刪除，拒絕未知項目、變更檔案或 reparse；不用遞迴刪除或 Force。

Startup 接線、同入口啟動與實際 Windows 冷開機是不同證據；未重新開機時不能宣稱 cold-boot gate 通過。
過去 v5 release 與備份中的舊絕對路徑是歷史／回復資料，不能改成偽造的新歷史。正式選取與現役 binding
必須指向 v6 新根目錄。

## 失敗與回復

任何 UNKNOWN、權限／平台拒絕、資料或 owner 不一致均停止，不自動重試。
最早的 ACL 回復紀錄位於舊 Owner 的 `runtime-migration-<release-id>-acl.json`；建立新私有備份區後，
主 receipt 位於 Control Center `.local\migration-backups\<release-id>\migration.json`。

新 runtime 尚未嘗試啟動時，`MigrationRollback` 支援 `STOPPED_EXIT_TRAY`、`COPIED` 及由
`COPYING/COPIED` 失敗留下的 UNKNOWN；它核對並恢復 Startup／settings，使用原 v5 controller 啟動原資料。
保留更嚴格的祖先 ACL，以繼續保護已複製的私人資料與備份；原 ACL 已保存，不能在私有副本仍留於 repo
之下時直接恢復較寬鬆的祖先權限。

一旦開始新 runtime，可能已有新 job／receipt；`MigrationRollback` 會要求獨立狀態審核，不會用舊備份
覆寫較新的資料。必須先透過已選取的正式 controller 停止現役服務，核對新舊資料與已保存 hash，再決定
回復接線；禁止手改 receipt phase、刪除 ApprovalStore lock 或重放先前 Cutover。

v5 → v6 必須使用上述 migration actions；一般 v5 → v5 與 v6 → v6 升級沿用
`Prepare / PlanState / BindState -UpgradeFromReleaseRoot` 與既有 Cutover 流程，保留相同正式 state。
禁止用一般 upgrade 跨越 v5/v6 資料邊界；初次遷移的回復也不能走會回退 Source 的舊 Rollback。

## v6 已選取但歷史 Cutover 不完整的獨立證明

`AttestSelectedV6` 是既有 Installed Release Operator 的額外本機動作，僅適用於 v6
`STATE_BOUND`、原 `operator-cutover.json` 為 `UNKNOWN / lastPhase=SELECTED`，且全部
`newPid/newTunnelPid/newBuildId/newStartTimeUtc/newTunnelStartTimeUtc` 為 null 的情形。
Cutover 在保存 SELECTED 後若後續驗證失敗，catch 會留下這種歷史；後來程序能運作並不能補足它。
此動作不重放 Cutover、不啟停程序、不改 Startup、ACL、資料或舊 receipt，也不把 UNKNOWN
改成 LOCAL_ACCEPTED。v5 的 Source recovery 與正常 LOCAL_ACCEPTED 升級路徑保持原契約。

目前只完成 Source／隔離合成驗證，沒有執行正式 attestation 或換版。以下是下一階段需要
獨立授權、人工核對的操作規格，不是本輪的 Runtime 驗收紀錄。

1. 原操作者從桌面開啟新的、非管理員 Windows PowerShell 5.1；不得由 Codex／Bridge 程序鏈
   執行。先核對已審閱 Operator source 的 SHA-256、selected release 路徑、受保護 manifest
   SHA-256 與原 cutover receipt SHA-256。不要就地改寫 installed code 來加上這個動作；可以使用
   已審閱的 source Operator，它仍須載入 selected release 的受保護 native code，通過獨立操作者檢查。
2. 執行 `installed-release-operator.ps1 -Action AttestSelectedV6 -ReleaseRoot <selected-v6>
   -OriginalCutoverSha256 <original-receipt-sha256> -RecoveryManifestSha256 <selected-manifest-sha256>`。
   Operator 在同一 `Local\McpCcInstalledOperator` mutex 內，先完成全部必要證據，再保存新的檔案。
   權限拒絕、abandoned mutex、時間倒退、觀測超過 120 秒、任何必要證據未知都停止，不自動重試。
3. 證據包括完整 protected closure／原有 manifest hash 與 reseal baseline 驗證、同一 operator SID
   與 State Binding／plan、rollback Startup hash／old Build linkage、exact Startup selector、
   canonical tray selection／無平行 owner、selected controller 的 native ownership／listener／Build，
   以及 retained process handle 上 core／tunnel 的 PID、建立時間 ticks、image、SID、session、
   非提權與 job membership。MCP discovery／auth、tunnel ready、兩次取得的實際 loaded HTML UTF-8
   hash 與 installed `codex_bridge/web/codex-console.html` 必須相同。最後再核對歷史、selection、
   全量 health idle、R1 terminal receipts 及相同 OS process instances。
4. 新 receipt 位於同一 Owner 的 `installed-bridge/<release-id>/selected-v6-attestation-<sha256>.json`，
   phase 是 `ATTESTED_SELECTED_V6`。採 CreateNew、durable flush、寫後重驗；保留所有歷史 bytes，
   不新增 ReceiptStore。回傳的 SHA-256 必須由操作者核對，不能把任意 JSON 或檔名當作授權。
   中途失敗留下的檔案不得修改或刪除；沒有成功回傳與獨立核對，不繼續升級。這是原 operator／
   私有 ACL 與明確 hash pin 的信任模型，不是新的數位簽章或對原操作者本身的防偽機制。
5. 後續已授權的 v6→v6 `Prepare / PlanState / BindState -UpgradeFromReleaseRoot <selected-v6>`
   額外帶入 `-InstalledRecoverySha256 <attestation-sha256>`。每次都重驗實際 selected evidence；
   receipt 有效期固定四小時，PID／start time／Build／UI／Startup／歷史 hash 改變皆拒絕。
   Prepare 前後都驗證；BindState 保存同一 `ownerReuse.attestationSha256`，不搬移正式資料或變更
   既有 ACL。資料遷移仍須用原 Migration actions，不能混用 recovery 參數。
6. 新 release 的 `Preflight / Cutover / Rollback` 從已綁定的 state plan 取回固定 pin；若另外提供
   `-InstalledRecoverySha256`，必須與保存值相同。Preflight／初次 Cutover 仍要求新鮮現役證據。
   已進入原有 `UPGRADE_STOPPED` 的續接，才使用已綁定歷史證據並執行原本的 UI exit、exact old
   process exit、無 listener 等檢查；不能用一個參數捏造停機階段。停止後不再要求舊程序存活或
   四小時 freshness，以免阻斷合法續接／rollback，但所有 hash、原收據、manifest 與 plan linkage
   必須保持一致。更換 pin 不能修補已綁定 successor；須重新審閱新 candidate／plan。

證據範圍沿用成功 Cutover 的 gate：`Get-Health -Idle` 必須為 `jobs.scope=all`、active=0、
awaitingApproval=0；這裡的 approval 是 Bridge jobs 的等待核准，並非 PowerShell ApprovalStore
所有 request 的逐筆狀態。R1 receipt 必須由原 `Assert-RemoteReceiptsTerminal` 判為 terminal。
不外部讀取 `powershell-approval/receipts.jsonl`、不改 sharing mode、不解鎖或重開 Store。
停機 migration 使用的完整 Journal replay 不屬於一般 Cutover；隔離 Windows 實驗也確認，
Node 以 `a+` 持有合成 journal 時，PowerShell Get-FileHash 不能讀取它。

一般 Cutover 不要求 PowerShell ReviewStore OPEN，因此這項恢復也不新增該要求。既有
`Assert-HttpAuthentication -MigrationStoreStatus` 的 OPEN／THIS_INSTANCE 檢查仍保留給 migration。
即使現役 status 回報 `STORE_LOCKED / UNVERIFIED / EXECUTION_DISABLED`，也不能修改或繞過 Store；
attestation 永遠將 `powerShellReviewStore` 與 `powerShellHost` 記為 `UNVERIFIED`，不證明 Journal
完整性、NORMAL 可執行、Host readiness、外部 MCP 可達或 cold boot。這些維持各自的獨立 gate。

回復邊界：attestation 本身沒有 Runtime／Startup 變更可回復，失敗時保留新舊證據並停止。
一旦 successor 完成原有 LOCAL_ACCEPTED，才依既有 `Rollback` 的 exact instance、saved Startup、
previous installed controller 與 UI exit 流程回復；不得對原 UNKNOWN release 重放 Rollback，
也不得把資料退回 Source／v5。對未涵蓋的 UNKNOWN 或改變的 instance，交由獨立操作審核。

定點驗證（全部只使用隔離檔案／合成權威觀測，不執行 Operator entrypoint）：

```powershell
powershell.exe -NoProfile -File codex_bridge/tests/test-selected-v6-attestation.ps1
powershell.exe -NoProfile -File codex_bridge/tests/test-installed-upgrade.ps1
powershell.exe -NoProfile -File codex_bridge/tests/test-installed-owner-migration.ps1
git diff --check -- codex_bridge
```
