最新本機 installed 路徑與實際 gate 見 [R1G2Operator.md](R1G2Operator.md)。新版 release contract v3 不再一律阻擋本機 lifecycle；遠端 R1 仍為 HOST_NOT_VERIFIED。以下 source-only 狀態段落保留為前一里程碑紀錄。

# Remote Self-Reload R1

後續 source-only 修復狀態以 [R1 installed-release gate](R1InstalledRelease.md) 為準：
**G0 HOST_NOT_VERIFIED / G1 PARTIAL**。v4 是 inert mapping／closure predicate，所有 mutation 入口拒絕。
legacy R1 deployment 也因未封閉的 dependency bindings 保持阻擋；下列歷史 bootstrap 不構成本輪可執行授權。

狀態：**SOURCE / SYNTHETIC VERIFIED；NOT_DEPLOYED**。本文件不是 live 成功收據。

## 根因與唯一 owner

Codex 執行環境的 Windows Job Object 可能具有 `KILL_ON_JOB_CLOSE`；Bridge/App Server
子程序即使使用 hidden/detached launch，也無法據此證明能穿透整條 parent job hierarchy。
R1 不嘗試從 Bridge 逃離 Job Object。既有 Control Center `tray.ps1` 持有獨立 runspace，
且啟用前要求 tray 不屬於任何 Job Object、可檢查的 ancestor chain 不含 Bridge/Node/Codex。
tray 關閉會結束 worker；下次啟動讀回收據，不重送不確定的 lifecycle action。

Control Center 仍是 orchestrator，不是 MCP server。唯一 mutation 是：

```text
Invoke-McpCcComponentAction -ComponentId codex_bridge -Action reload_runtime
  -> existing fixed mapping -Action ReloadRuntime
  -> codex_bridge/scripts/runtime-control.ps1
```

沒有第二套 stop/start、kill-by-name、OS 提權、general shell、OMI 操作或 project secret 存取。
registry 與既有 tray actions 未改。新增的 Bridge child 是固定 named-pipe client，僅傳遞 bounded
JSON／驗證 server process；它不是 executor，存活與否不影響 owner 的持久收據。

## 資料流與信任邊界

1. MCP `status/preview/request/receipt` 經 Bridge 轉給固定 pipe
   `\\.\pipe\McpCc.CodexBridge.Reload.R1`。request 只接受 idempotency key、preview digest、TTL。
2. owner 以現有 component Status 核對 exact owner/listener、tunnel identity 和 canonical Build ID，
   產生 request UUID、nonce、expiry 與 digest；磁碟 desired build 可以不同於 live build，但兩者都綁定在 exact request。
3. app-only `challenge/approve` 使用 WebAuthn ES256；簽章綁定 digest、credential、RP hash、origin、
   crossOrigin/topOrigin、UP/UV。`human=true`、`source=app`、MCP visibility 或模型文字均不是 grant。
4. Bridge 在 JobStore 同一 admission lock 內建立 drain fence。已開始的 create/append/prepare 先完成登記；
   新 admission 被拒絕。既有 jobs 可完成／取消／解決既有 approvals。health 以 **全部** jobs 計數。
5. owner 先持久化 approved，等待全部 active=0、awaitingApproval=0、controller idle/ready 和 exact fence。
   執行前再次核對 owner、old PID/live build、desired canonical build、期限和 fence，才委派既有 controller。
6. old/new PID、canonical/health Build ID、health、readyz 和工具 discovery 證據寫入收據。
   每次檢查工具都建立新的 MCP session；401/403 表示需要已認證 connector，CC 不讀取 token。

Named pipe 採明確 DACL、拒絕 network logon、`PIPE_REJECT_REMOTE_CLIENTS`、first-instance handle
與單一 server instance。owner 終身保留 handle，dispatch 中不釋放名稱。雙向核對 OS 回報的 peer PID：
server 必須是 exact tray executable/entrypoint、相同 runtime SID 且不在 Job Object；client 必須是固定
IPC helper executable/entrypoint，parent 必須是 controller 剛驗證的 Bridge PID。process handle 持有到訊息處理完成。

**同 SID 不是隔離任意本機惡意程序的強邊界。** R1 威脅模型信任 Windows operator 帳號及 OS；
防護對象是遠端模型、重播、偽造 app 標記和 sandbox 內程式。補強方式是：

- runtime 使用同一個非管理員帳號；現有 controller 啟動的新 Bridge 必須繼承相同身分。
- 正式 source/scripts/dist/web/node_modules/config 與其 workspace root 的 owner／write ACE 只允許
  SYSTEM/Administrators；runtime 帳號只讀。**可寫開發 checkout 不通過啟用 gate。**
- owner state 位於固定 `%LOCALAPPDATA%\McpControlCenter\remote-self-reload-r1`，不接受 remote path。
  私有 state ACL 只允許 runtime 帳號、SYSTEM、Administrators；Bridge 的兩種 Codex permission profiles
  明確 deny `%LOCALAPPDATA%\McpControlCenter`。使用 custom RuntimeRoot 的 tray 不能啟用 R1。
- 每筆 request 必須有外部 authenticator 的 UP/UV 簽章。CC 只保存公開金鑰，不保存私鑰／MCP token。
- 不抵禦已控制 operator 帳號、可逃出 Codex sandbox 的惡意程式或 Windows Administrator。
  這類威脅需要額外的帳號隔離／受保護 broker 與 credential-aware lifecycle，不在 R1；不可聲稱已具備。

原先設想的不同 Bridge/CC SID 不適用既有 lifecycle：replacement 會繼承 CC 身分。
R1 不提供跨帳號 launch 或憑證儲存；不以無法持續運作的 split-account 配置宣稱可部署。

## 狀態、持久化與失敗

`accepted -> approved -> dispatching -> running -> completed | unknown`；執行前拒絕／到期為 `failed`。
`accepted` 不表示 approved；`approved` 不表示已執行。收據包含完整 state history、固定動作及 evidence。

- 同 idempotency key／相同 preview+TTL 回傳原收據；不同內容回 `IDEMPOTENCY_CONFLICT`。
- TTL 60–1800 秒；最多 256 筆收據；保留 tombstone，不自動刪除舊 keys。達限拒絕新請求。
- 同時只容許一筆 accepted/approved/dispatching/running/unknown。unknown 會阻擋新的請求。
- 請求 16 KiB、回覆 32 KiB、policy 8 KiB、receipt store 1 MiB；IPC read/write 有期限。
- owner mutex 與現有 manager/component mutex 都保留。store 同目錄 temp、`Flush(true)`、atomic replace。
- 任一 write/fsync/replace 不確定即 **poisoned**；即使記憶體已更新，也禁止該 owner 後續
  request/approve/receipt/execute。保留 active/temp 證據，不降級成 in-memory success。
- owner restart：accepted 可恢復；approved 轉 failed 要求新 request／新核准；dispatching/running 轉 unknown。
  不從 temp 或備份猜測成功，不自动重送。偵測 clock rollback 也停止該 owner。
- client 的 concurrent receipt=accepted 不清 fence。核准呼叫有 single-flight；delivery error 後透過
  internal `resolve` 將仍 accepted 的收據原子結束為 failed，防止晚到的核准。approved/unknown 不被 resolve 撤銷。
- `completed` 只表示 **local reload verified**。`evidence.schema.verified=false` 或
  `remoteHostVerified=false` 保留尚未完成的 discovery／host gate；不把 401 當 reload 失敗。
- lifecycle failure／postcheck 不確定為 unknown，不自動 rollback 或重啟第二次。先查既有 component logs、
  exact owners、兩個 PID、canonical build，再由 operator 決定恢復。保留收據，禁止把 JSON 改成 approved。

## 一次性 operator bootstrap（本輪未執行）

1. **回到本機，等待所有 Codex jobs terminal。** 保存現有 source WIP；本輪不 commit/push、
   不移動原 checkout、不改 Startup／ACL／帳號、不安裝 task/service。
2. 確認採用上述「信任本機 runtime 帳號」模式。CC 和 Bridge 使用相同非管理員帳號。
   不把 tray 以 Administrator 常駐，也不由 Codex、Bridge 或其 terminal 開啟 tray。
3. 由 operator 完成獨立正式安裝／source promotion：保持 workspace 元件相對布局及既有 registry，
   將 CC/Bridge 正式程式與依賴放在受保護的 installation tree；原始 WIP checkout 保持原位。
   這是人工部署工作，可能需要 Administrator **設定 ACL**，不是遠端功能的 OS 提權。
   Gate 逐項檢查上述 root/程式樹；缺項、reparse point、runtime 帳號可寫正式 code 都會拒絕。
   `.tmp`、logs 與必要 component runtime state 另由既有 controller 管理，不能因此開放 code write。
4. 安裝必須沿用 existing exact-path lifecycle、tunnel identity／已存在的安全設定與 credential owner。
   **不要直接搬移既有 credential 或複製 DPAPI 資料。** 若 protected installation 無法沿用正確路徑／身分，
   停在 `NOT_DEPLOYED`，由 operator 規劃正式 promotion；本輪沒有驗證替代安裝的 tunnel/credential。
5. 建立私有 `%LOCALAPPDATA%\McpControlCenter\remote-self-reload-r1`，權限只給上述私有 state principals，
   審核 `policy.json` 的 exact fields：`contract, bridgeSid, rpId, origin, topOrigin, credentialId, x, y`。
   格式由 MCP Apps「一次性 passkey 登錄資料」產生；`bridgeSid` 由 operator 核對 runtime SID 後填寫。
   只能載入可信裝置登錄的 ES256 public key，不接受模型提供的替代金鑰，也沒有遠端 enrollment/write-policy tool。
6. **Host readiness gate**：實際 MCP iframe 必須同時得到父頁 Permissions-Policy 與 iframe `allow` 的
   `publickey-credentials-get/create` 授權；operator 核對 HTTPS RP suffix、origin、topOrigin。
   JavaScript API 存在不等於可用。host 不支援時停止；不得要求使用者任意修改父頁或回退 human boolean。
   若可信外部 enrollment 已提供同 RP credential，可不在 widget create，但仍須驗證 get。
7. 一次性人工採用新版 Bridge／CC：只能用既有 Control Center 的正式 lifecycle，且現有 job 已 completed。
   升級 tray 時使用既有 launcher／operator logon lifecycle，不從此 Codex job 開啟 replacement。
   新 tray 才會持有 R1 worker。缺 policy 的既有 tray 行為保持不變。
8. 驗證 owner out-of-job、exact parents、程式 ACL、sandbox deny、pipe peer、MCP host 實際 passkey ceremony，
   再由真人建立／核准一筆固定 request。等待 receipt local completion；重新連線並 Refresh Actions，
   用已認證 host discovery 確認六個新 tools 和兩個 app-only tools。不得只看工具數或 health 200。

回滾：保留所有 receipts；先確認沒有 dispatching/running／active job，再由 operator 停用 policy 和更新 tray。
source 回復只還原本次 allowlist 增量，保留使用者 WIP。若真正 reload 已開始或 outcome unknown，先核對 runtime，
不把回復 source 當成 runtime rollback，也不由 R1 自動重送。

## 驗證與已知限制（2026-10-12）

- Bridge `npm test`：174/174，exit 0；包括實際 PowerShell state engine、WebAuthn ES256、MCP/HTTP、
  deferred admission race、真實 write/replace failure、clock rollback、crash/restart、receipt recovery、新 request UI。
- `npm run smoke:http`：40 tools、15 app-only，0 個 Codex jobs；`npm run widget:check` 通過。
- Bridge controller fixture 73 assertions；canonical Build ID fixture 58 assertions，productionRuntimeTouched=false。
- CC R1 fixture 17 assertions，exit 0：真正 Windows named pipe、OS PID/SID、wrong SID、first-instance 防搶名、
  AST、schema 401 分類及正式 callback 的 module binding／固定 controller 委派／執行前 idle 重查。
  此測試的 process 是 synthetic，不是獨立 production owner 的證明。
- CC 全套／SelfTest／tray SelfTest **BLOCKED**：Project Reading `Configured HTTP token file is unavailable.`；
  Bridge SelfTest `Test-Path : Access is denied`。本輪修改前保存的原始 CC test script 也在相同 registry assertion 失敗。
- 實際瀏覽器驗證 **BLOCKED**：CUA `Restricted read-only access requires the elevated Windows sandbox backend`；
  本機 Edge headless 另以 GPU process access failure 結束，無 DOM／畫面證據。沒有停用 browser sandbox。
- live 唯讀：build=`c00f4c4d61f5085c`、active=1、readyz=ready、R1 health contract 缺失、R1 policy 不存在，
  tray CIM ownership inspection 不可用。沒有觸發正式 reload／tray restart。
- 對真正 host 的 WebAuthn、authenticated remote schema、正式 owner 升級、安裝 ACL／tunnel promotion
  均 **NOT VERIFIED / NOT_DEPLOYED**。完整 source/fixture 不取代這些 gate。

規範依據：[W3C WebAuthn authentication](https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion)、
[WebAuthn Permissions Policy](https://www.w3.org/TR/webauthn-3/#sctn-permissions-policy)、
[web.dev Passkeys within iframes](https://web.dev/articles/webauthn-within-iframe)、
[Microsoft NamedPipeServerStream](https://learn.microsoft.com/en-us/dotnet/api/system.io.pipes.namedpipeserverstream)。
