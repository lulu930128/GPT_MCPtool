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
