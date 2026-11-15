# OMI Launcher 固定遠端換版交接

本輪狀態：**SOURCE / ISOLATED PASS；正式 CC／OMI 採用 NOT_OPERATED**。本 job 不執行正式 restart/update、Native／券商登入、交易、migration、commit 或 push。

## 最小契約與邊界

- 既有 `WorkspaceLocal.Native.cs` 的同使用者、拒絕網路 client 的固定 pipe 增加 wire v3，能力版本獨立為 `cc-omi-launcher-update-v1`。只接受 `omi_status`、`omi_apply`、`omi_receipt`；不接收 root、script、shell、argv、帳密或其他元件名稱。v1 七列與 v2 九個目標不變。
- 三個已在現役 inventory 的檔案承載全部 owner 變更：`scripts/tray.ps1`、`src/WorkspaceLocal.Native.cs`、`src/McpControlCenter.WorkspaceUpdate.psm1`。使用現役 tray maintenance worker／Exit drain；不新增 listener、manager、service、排程或 inventory 版本。
- 唯一短 client 是 source 端 `scripts/omi-launcher-update-client.ps1`。它只讀 selector／inventory、核對 exact CC tray 路徑與 PID/creation，再驗 pipe server PID／nonce。編譯的是 selected inventory 內的 native code；未部署新版時回 `OMI_CAPABILITY_NOT_DEPLOYED`，不能用 source 啟用路由。client 本身刻意不擴充舊版固定打包 inventory；其 source bytes 仍納入 CC source-update digest。
- `Status` 的 `available=true` 需要已部署、selected 同版 CC、完整 inventory、有效 OMI source pin，且無未決操作。owner 另外唯讀檢查 `IsProcessInJob=false`；未知或仍在 Job 的 CC 拒絕派送，不修改 Job、不使用 breakaway。正式採用後還須由 Reviewer 核對實際 CC lineage；metadata 不替代獨立 owner 證據。
- OMI root 固定為 `C:\project\Open Market Intelligence`。source pin 使用原 `Get-OmiLifecycleSourceId` 與 `ProductionSession.ApplicationRelease`，以 UTF-8 `cc-omi-launcher-update-v1\n<lifecycle>\n<application>` 做 SHA-256。派送前／成功後重查。只讀 code 與原非秘密 source identity，不讀 credential、domain payload 或整份 log。
- CC preflight 透過 OMI 原 exact-owner capture 與 owner-bound pipe 確認舊 Launcher 存活及 ApplyUpdate 能力，檢查 Execution leases。真正 execution PrepareUpdate fence、exact tree、writer/schema gates 與 successor 啟動仍由原 updater 執行；active／unknown Native 保留拒絕，不殺同名程序、不刪 lock。

## UUID、結果與程序存活

CC 在派送前原子保存穩定 request UUID、source digest、CC version；再保存舊 owner、預期 lifecycle/application、updater PID/creation。原生 updater 自建 UUID，CC 只從經結構驗證的最後 JSON 記錄 `nativeRequestId`，並核對 successor operation UUID、舊 owner generation、新 Launcher generation、兩個 expected source IDs、`UPDATE_BACKEND_READY`、`COMPLETE`、HTTP/backend verified 及 exit 0。沒有虛構原生 schema 欄位；驗證原有 receipt shape。Frontend 與 Native／broker 仍未驗收。

stdout 使用每個 stream 最多 32,768 字元的尾段，最後非空行最多 16,384 字元；容許原 updater 的 `EXIT_REQUESTED; waiting...` 前綴。exit 0、進度文字或單獨 HTTP 200 都不是成功。updater 退出後最多等待 stream 收尾 1.5 秒；successor 繼承 stdout 不會把有限 updater 收尾永久卡住，也不會為收尾殺 successor。

receipt 位於既有 CC state 的 `omi-launcher-update-requests/<CC UUID>.json`，保留原子替換歷史。相同 UUID／參數只回原結果，參數不同為 `REQUEST_CONFLICT`。已完成的不同 UUID 可再次明確換同一 source；QUEUED/RUNNING/RECOVERY_REQUIRED 會擋後續換版。owner 重開將未決操作標為 RECOVERY_REQUIRED，不重新派送。client timeout、斷線、未知或 `RECEIPT_NOT_FOUND` 均只查原 UUID，不能換新 UUID 重送。

updater 超過 900 秒時先保存 RECOVERY_REQUIRED，CC worker 仍持有它直到真正退出，阻擋正常 CC Exit；不強殺、不重試。若 updater 在輸出最後 JSON 前失敗／中斷，`nativeRequestId` 可為 null，代表 **原生 correlation UNKNOWN**；保留 updater PID/creation，不以掃 log／新 UUID 猜測。此切片沒有自動清除未知的入口，需獨立核對原生結果後另行處理。

## NORMAL client 的暫存依賴

client 編譯只使用 `GetFolderPath(LocalApplicationData)\Temp`。目錄須已存在、非 UNC／reparse、owner SID 為目前使用者；只在編譯作用域設定 process TEMP/TMP，`finally` 還原原值（包含原先不存在）。沒有改 `C:\Windows` 權限、Host、ACL、sandbox 或 Job。條件不成立回 `OMI_CLIENT_USER_TEMP_UNVERIFIED`，編譯實際失敗回 `OMI_CLIENT_COMPILE_UNAVAILABLE`，不得換入口繞過。

依賴 Windows PowerShell 5.1／既有 .NET compiler、System.Web.Extensions、CIM process metadata 可讀權限，以及該使用者 Temp 的既有寫入權限。57 項 fixture 包含真 PowerShell 子程序將 TEMP/TMP 都移除後，執行產品 client 的原編譯函式並驗證還原；不重跑 Reviewer 曾被拒的命令。這是隔離相容性證據，正式 NORMAL client 仍須於採用後先做唯讀 Status。

## 本輪驗證與 selected 差異

- `tests/test-omi-launcher-update.ps1`：**57 PASS**。私有 pipe、獨立短 client、真 owner → updater → successor，client 先退出；updater 退出且 stdout 確實仍被 successor 持有時，結果仍完成，successor 存活；最後全數以 fixture signal 正常退出。另含拒絕、source drift、dispatch unknown、不重播、UUID conflict、錯誤 source/operation/generation/exit/schema 拒絕及隔離打包。
- 已完成既有回歸：workspace-local **709 PASS**（內含 recovery 67、diagnostics 82）、workspace-update **36 PASS**；delegation 15 PASS；獨立 deployment 66 PASS。未再擴大回歸。
- selected `r2-cc-20261031-01` 的固定 34 項 code inventory 與開始時 source 比對：全部 source-owned code bytes 相同，沒有另帶未驗證的既存 CC WIP 差異。根／CC README 與其他 repo WIP 未進 CC code inventory。
- 最終隔離 candidate 保持 inventoryVersion **2**，34 項，只有上述三個既有 code 檔的 source 差異。`NormalOperator.Host.dll` 按原 packager 重新產生，二進位 hash 與 selected 不同，但 compiler/options/references/source 的完整 nativeBuild.inputs **完全相同**；此為需明列的生成物差異，不宣稱 binary byte-identical，也沒有修改任何 Host source 或權限。
- 現役 Deployment 模組與 source 逐 byte 相同；隔離 Stage 使用同一固定 inventory，已確認三個新 owner 變更都有入包，且沒有 select、正式 Stage 或 lifecycle。freeze manifest／增量 patch／測試 receipt 存在交付的本機 evidence 路徑，詳見 Progress。

## Reviewer 正式採用順序（本 job 不執行）

1. 先核對 freeze hashes 與 selected 差異。使用已成功 preview 的版本 **`cc-20261105-omi-remote-01`** 重新呼叫 Workspace `mcp_component_update_preview`，取最終 `sourceDigest`，不得沿用先前 digest。版本已存在但不等價時停止，不能覆寫。
2. 經現有 Workspace `mcp_component_update_from_source`／`mcp_component_update` 正式更新 **mcp_control_center**：`action=update_from_source`、上述 versionId、最終 expectedSourceDigest、`idlePolicy=wait_for_idle`、`confirmation=interrupt_current_requests`、一個新且保存的穩定 CC update UUID。這一步只更新 CC，會中斷其目前 requests；不夾帶 OMI 操作。timeout 只查 `mcp_component_update_receipt` 原 UUID。
3. 確認官方 CC receipt 為 ACCEPTED、expected inventory／loaded version／唯一新 tray／IPC／independent lineage 齊全。再用固定 client **Status**，要求 `contract=cc-omi-launcher-update-v1`、`ccVersion=cc-20261105-omi-remote-01`、`available=true`。沒有這些證據時，**不能停止舊 OMI Launcher**。正常 NORMAL Temp／CIM 拒絕、Job 未知或 capability unavailable 都是 blocking finding，不可換通道。

   ```powershell
   powershell.exe -NoProfile -NonInteractive -File C:\GPT_MCPtool\mcp_control_center\scripts\omi-launcher-update-client.ps1 -Action Status
   ```

4. 重新取得 OMI runtime status 與 Native 安全離線證據，核對 OMI deployment manifest 沒漂移。固定 client 不會 Stop Native 或登入；若 Execution 活動／未知則停止。以一個保存好的 **不同於 CC self-update UUID 的 OMI request UUID**，及剛剛 Status 回的 `sourceDigest`，只提出一次 ApplyUpdate：

   ```powershell
   powershell.exe -NoProfile -NonInteractive -File C:\GPT_MCPtool\mcp_control_center\scripts\omi-launcher-update-client.ps1 -Action ApplyUpdate -RequestId <OMI-UUID> -ExpectedSourceDigest <OMI-STATUS-DIGEST>
   powershell.exe -NoProfile -NonInteractive -File C:\GPT_MCPtool\mcp_control_center\scripts\omi-launcher-update-client.ps1 -Action Receipt -RequestId <同一OMI-UUID>
   ```

5. QUEUED/RUNNING 是 admission／進行中。ACCEPTED 僅代表該 native correlation 的 Launcher/Backend 依上述條件通過；再以 fresh owner/Backend status 驗 loaded source、generation、HTTP/readyz，證明短 client 結束後仍活著。Native／broker 登入、交易、cold-login 與持續在線是其他 gate，不由本次換版自動驗收。

## 回滾與拒絕處理

尚未採用時，不動 selector 或 runtime；如要撤回 source，使用 freeze manifest 的 before/after hash 與增量 patch reverse-check，只撤本輪增量，保留所有既存 WIP。正式 CC 採用後如需回滾，先確認沒有未決 OMI worker，再由既有正式 CC lifecycle／selector 回復 `r2-cc-20261031-01`；不得在 worker 進行中關 CC 或刪 receipt。OMI 回滾仍走原 OMI 部署／owner 流程，不由此 client 改檔、清鎖或改 DB。未知結果必須停在原 receipt；本輪沒有新增人工放行／強制停止入口。
