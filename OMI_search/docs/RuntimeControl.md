# OMI Launcher 固定遠端命令契約

2026-10-26：在既有 direct named-pipe transport 上新增三個 source-only MCP tools。
公開 surface 為 **23 tools／2 UI resources**；原 17 個市場工具與 `omi.decision.v4` 不變。
本輪只改 OMI_search Source／Docs／Tests，不部署、不讀 credential、不呼叫正式 pipe 或 DB。

## 固定映射

| MCP tool | Launcher action | MCP literal confirmation | Wire 欄位數 |
| --- | --- | --- | --- |
| `omi_read_runtime_status` | `Status` | 無 | 4 |
| `omi_read_runtime_operation` | `ReadOperation` | 無 | 4 |
| `omi_restart_backend` | `RestartBackend` | `restart_backend` | 4（既有相容 wire） |
| `omi_start_backend` | `StartBackend` | `start_backend` | 5 |
| `omi_recover_failed_start` | `RecoverFailedStart` | `recover_failed_start` | 5 |
| `omi_upgrade_db_schema` | `SchemaUpgrade` | `upgrade_schema` | 5 |

四個 mutation 的公開 arguments 恰好為 `request_id`、`expected_owner_id`、`confirmation`。
兩個 ID 必須為 hyphenated UUID；大小寫機械正規化，不能換 UUID 重試。先讀 Status 的
owner_id，再依使用者當次明確 chat 意圖提交一次固定操作。不得從市場查詢、離線狀態或
歷史失敗推斷操作授權。四個工具均為 `readOnlyHint=false`、`destructiveHint=true`，
`idempotentHint=true` 表示 Controller UUID 去重，不授權 caller retry。

Wire 為單行 UTF-8 JSON。基本四欄都是 string：`action`、`request_id`、`expected_owner_id`、
`token`。Status 的後三欄皆空；ReadOperation 只帶 request UUID，其餘未用欄位為空。
Restart 的 literal 在 MCP 邊界驗證，保持舊四欄 wire；後三個新 action 必須帶第五欄
`confirmation`，值與上表完全相同。每個 action 有精確 allowlist／key set，拒絕任意
actor、approval flag、Backend preflight、DB／schema-lock path、PID、pipe、URL 或 shell。
沒有 `UpgradeDBSchema`／`ApplyRelease`／generic Stop action。

## 遠端授權與 Backend 缺席

**無本機 Windows human approval。** 授權是明確遠端使用者指令＋專用 token＋OS-pinned
同 Windows 使用者 Launcher。沒有 MessageBox／OpenFileDialog 或假 local actor 替代層。
主 Controller 的 receipt actor 是由真 pipe caller 產生的 `authenticated_pipe_client`，
不是 caller 可以傳入的欄位。Controller 先保存 durable receipt，再入列並 consume 一次。

- `Status`／`ReadOperation` 不讀 token，不依賴 Backend HTTP，Backend 完全不存在仍可讀。
- 三個新 action 可以在 Backend 缺席時接受一次 remote intent；是否可 Start／Recover
  仍需 Launcher 自己證明 stopped／failed-start exact-exit generation。
- SchemaUpgrade 只使用 Launcher configured DB target／schema.lock；選取失敗、writer lease、
  backup、migration transaction、rollback 或 unknown receipt gates 均不能由 adapter 略過。
- Restart 可由獨立 adapter caller 提交；Backend 本身缺席時的阻塞由 Controller 回覆。
  尚存 Backend 的 source／schema compatibility、graceful writer drain、exact stop／start
  仍屬主 Launcher lifecycle，不在本 adapter fixture 驗收。

## 身分與 transport

沿用固定 repo `C:\project\Open Market Intelligence` 小寫 UTF-8 SHA256 前 24 字元導出的 pipe。
每次連線在寫入 token 前驗證真實 server PID、creation FILETIME、retained process handle、
OS image、完整 Launcher `-File` argv 與同使用者 SID；回覆前重驗 pin。只接受 hidden launcher
既有完整 grammar，不接受 caller/environment 覆寫身分。OS 拒絕就停止，沒有提權或其他入口。
這是 OS process identity，不是 loaded source/release attestation。

Mutation credential 僅取 adapter Process 環境 `OMI_SEARCH_RUNTIME_CONTROL_TOKEN`，嚴格限
64 個小寫 hex；不讀 .env、registry、credential file 或 Backend hash，不 fallback 到 AI token。
Reader 不取 token。測試只使用 synthetic token；本輪不讀真實 token／密碼／secret hash。

兩秒 bounded IO、16 KiB frame、一個 connection／write；沒有 reconnect、HTTP fallback、retry
或自動 poll。保留原 response envelope：

```json
{"transport_status":"pipe_response","response":{"schema":"omi.runtime-control.v1"}}
```

安全的 Controller object 原樣保留，包括 null、缺欄、opaque future fields。Credential echo、
private path／SID／secret key、malformed／duplicate JSON、錯 request UUID 整包拒絕。
`accepted`／舊 HTTP 202 只是接受，不是完成。blocked／unknown 是 business result，
MCP `isError=false`；validation／transport error 才是 `isError=true`。
送出後 timeout／owner change／不可信 response 帶 `outcome=unknown` 及原 UUID；只允許
ReadOperation 查原 UUID。NOT_FOUND、STORE_UNAVAILABLE、unknown 或 cross-action UUID collision
都不授權重送或換 UUID。Adapter 不建立第二份 durable receipt ledger。

## Source 與驗證邊界

已核對主 job `b3b8be47-f5cb-49ae-bce3-d8f7bc8b9604` 的實際狀態及磁碟 C#/PowerShell source。
精確 job 最終狀態、fixture source hashes、命令與結果見
[本輪證據](agent-runs/remote-launcher-alignment/Progress.md)。主端持續變更時不能把先前 hash
視為最終同步；本輪收尾重新比對。

隔離 Windows fixture 使用臨時 repo pin、不同 pipe、synthetic token、臨時 receipt store。
編譯 `OmiRuntimeControl.cs`／`OmiOwnedShutdown.cs` 的 byte copies；不修改主 source，
不 dot-source 主 Launcher，不啟動 Backend／HTTP listener，不接 DB，不執行 stop/start/migration。
真 Controller 接受三個 offline action 後，由 fixture 呼叫一次 TakePending／BeginRemoteOperation，
第二次 consume 必須 false；最後刻意以未執行 lifecycle 的 `unknown / LIFECYCLE_FAILED` 結束。
這證明 transport、admission、一次性 intent 與 receipt，**不證明 owner lifecycle 成功**。
Restart admission 的 owned binding 是 fixture 身分；不冒充正式 Backend 驗收。
負面 replay 只在 disposable fixture 刻意送出，驗證 durable unknown／cross-action collision
不建立新 intent；production adapter 沒有 retry。
PID reuse 測試使用真 retained handles 加 injected PID／creation 變更，未讓 OS 實際回收 PID。

官方 MCP SDK legacy `2025-06-18` 與 current `2026-07-28` 都驗證 catalog／call／annotations；
ASGI/in-memory 測試封鎖外連、正式 pipe 與 process creation，Win32 stdio 未納入驗收。
HTTP build ID 與 tray hash 清單已包含 `server.py`／`launcher_transport.py`，本輪無需修改 HTTP
或 tray implementation；source hash 改變不代表 loaded runtime 已採用。

- Source／隔離 fixture：見本輪結果。
- 正式 Launcher／adapter Loaded Runtime：UNVERIFIED，本輪未部署或重新載入。
- 正式 identity／release adoption、Remote MCP E2E：UNVERIFIED；沒有正式 attestation，整體仍 partial。
- 後續須另行授權 adoption，再驗證 loaded identity、catalog、唯讀 status／receipt；正式 mutation
  仍需使用者明確指定，不由本次 source 任務外推。

## 前一輪 direct-pipe 紀錄（歷史，非現行主端限制）

以下保留前一輪當時觀測及更早 HTTP 事故；其中三工具數量、Backend-only caller／local dialog
阻塞與當時 source hashes 已由本輪上方契約更新，不能當作目前 readiness。

# OMI Launcher 的 Backend-independent 窄轉送契約

2026-10-26：三個既有 tools 改為直連唯一 Launcher named pipe。名稱、input schema、
annotations 與 20 tools／2 resources 不變；17 個市場／render tools、`omi_ask` v4 與 generated
snapshots 不改。**目前交付 Source／Fixture；Loaded Runtime 與 Remote MCP E2E 為 UNVERIFIED。**

| Tool | Launcher action | MCP arguments |
| --- | --- | --- |
| `omi_read_runtime_status` | `Status` | `{}` |
| `omi_read_runtime_operation` | `ReadOperation` | `request_id` UUID |
| `omi_restart_backend` | `RestartBackend` | `request_id` UUID、`expected_owner_id` UUID、literal `confirmation=restart_backend` |

UUID 必須為連字號格式，大小寫只正規化為同一 UUID 的小寫表示。拒絕缺／多參數、token、
URL、pipe、PID、command、DB path、approval、backend_preflight 等 caller 控制值。
不新增 recovery／schema／release tools，因為現有 Controller 尚無符合遠端授權要求的協定。

## Caller、Owner 與固定 wire

正常授權模型為明確使用者指令、authenticated caller、expected owner UUID 及 durable receipt。
Adapter 不新增本機 Windows 確認框。既有 MCP host／tunnel 認證與專用 runtime credential
分屬不同邊界；tool annotations 不是認證。Restart 維持 `readOnlyHint=false`、
`destructiveHint=true`、`idempotentHint=true`、`openWorldHint=false` 與 disruptive `_meta`。
Idempotent hint 描述 Controller 的 UUID 去重，不授權自動重送。

`launcher_transport.py` 只開啟本機 `\\.\pipe\omi-runtime-<suffix>`；suffix 是固定 repo
`C:\project\Open Market Intelligence` 小寫 UTF-8 SHA256 的前 24 hex 字元，與 main source 相同。
Public input 與環境變數都不能更改 repo／pipe／executable pin；`OMI_SEARCH_API_BASE_URL`
僅供原市場 HTTP，不影響 runtime tools。無 HTTP fallback、WMI discovery、shell、process launch
或第二個 controller。Main Launcher 仍是唯一業務生命週期 owner；Control Center 的
`restart_core` 只管理 OMI Search MCP，本輪不更動它或 component descriptor。

寫入前依序驗證：

1. 用 Win32 `GetNamedPipeServerProcessId` 取真實 server PID，開啟 query＋synchronize process handle。
2. 保留該 handle，讀 creation FILETIME、`QueryFullProcessImageNameW` 的 OS executable。
3. Executable 必須是 OS system directory 下 Windows PowerShell；command line 必須完整符合
   `start-omi-launcher-hidden.vbs` 的 `-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden
   -File <固定 repo>\scripts\omi-launcher.ps1`，不接受額外／縮寫／encoded／Command 參數。
4. 同 handle 的 TokenUser 必須等於 adapter Process 的 TokenUser，只在記憶體比較，從不輸出 SID。
5. 寫入前與回覆前重驗 server PID、creation 及 retained process 的未退出狀態。

Client handle 使用 `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`，不讓連線中的假 pipe
取得 adapter impersonation 權限。任何 ACL／OS query／身分拒絕直接失敗，沒有提權、修 ACL、
重試或換入口。Native command-line query 僅讀 command line，不讀 PEB／process environment。
`NtQueryInformationProcess` class 60 是 OS-specific 依賴；本機 fixture 已執行，未支援或拒絕時
fail closed。這不代表其他 Windows 版本均支援，亦不構成 hostile same-user process injection
或 loaded source 的硬隔離。OS handle identity 不能取代 release adoption 證據。

API 依據：[pipe server PID](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid)、
[CreateFileW SQOS](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)、
[native query 相容性限制](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntqueryinformationprocess)。

Wire 為單行 UTF-8 JSON，恰好四個 string 欄位：`action`、`request_id`、`expected_owner_id`、
`token`。Reader 的未用欄位為空字串；Restart 的 confirmation 只在 MCP 邊界驗證，因為
Controller wire 沒有 confirmation 欄位。不得加上 `actor=launcher_local_operator` 或偽造
`backend_preflight`。兩秒 bounded nonblocking IO、16 KiB frame、單次 connection／write；
pipe busy／unavailable 直接回錯，不 WaitNamedPipe/reconnect。沒有 automatic poll。

## Credential 與回覆

只有 mutation 讀取 adapter Process 環境的 `OMI_SEARCH_RUNTIME_CONTROL_TOKEN`；必須精確為
64 個小寫 hex 字元。空值／大寫／非 hex／多餘空白在任何 pipe IO 前拒絕。
Reader 不讀 credential。Token 只在 owner 驗證後放進 pipe wire 的 `token` 欄位；
不讀 `.env`、User registry、Backend hash、secret file，不 fallback 到 AI trust token。
既有 runtime 的 credential 注入方式不變，本輪沒有讀取、修改或部署 credential。

安全的 Launcher JSON object 原樣放進 `response`，外層是：

```json
{"transport_status":"pipe_response","response":{"schema":"omi.runtime-control.v1"}}
```

這是 transport envelope 的刻意變更：不再回傳 `http_status`／`http_response`，也不偽造 202。
原 tool input 相容，沒有 outputSchema 鎖定 HTTP wrapper；consumer 應使用 Controller `state`／
`reason`／`owner_id`。安全 opaque fields、null 與缺欄原樣保留；private path／SID／credential
欄位、token echo、duplicate JSON keys、NaN、非 object、錯誤 schema、超限或錯 UUID receipt
整包拒絕，不產生投影後的成功結果。Response safety guard 不改市場 v4 envelope。

accepted（包括舊 relay HTTP 202）只表示入列，不是完成。Controller 的 forbidden／blocked／
unknown 是 authoritative business response，MCP `isError=false`；transport／validation
failure 才是 `isError=true`，只回固定安全 error code，不回傳原始 OS exception。

寫入可能已發生後，timeout／partial write／失聯／owner change／不可信 response 一律附
`outcome=unknown`、原 `request_id`、`next_action=read_runtime_operation_same_request_id`。
未送出前的 credential／owner 拒絕沒有偽造 accepted 或 receipt。
所有情況都不 fallback、retry、改 UUID。Unknown／NOT_FOUND 不是重送權限；只允許 caller
以原 UUID 查 durable receipt。Adapter 不持久保存第二份 receipt ledger。

## Main Controller 的實測缺口

已只讀 `scripts/OmiRuntimeControl.cs`、`scripts/omi-runtime-control.ps1`、`scripts/omi-launcher.ps1`
與既有 Backend relay；主 repo job `4716b6db-c257-4297-9c65-00cdf43e6cf5` 仍可能更新 source。
本輪不覆寫 main source，不執行其 launcher script。

- `Status`／`ReadOperation` 不依賴 Backend；真實 Controller source 的 disposable pipe 測試已通。
- `RestartBackend` 在 `Dispatch` 仍要求 `SameIdentity(pipeClient, backend)`。
  專用 token 與 owner UUID 正確的獨立 adapter，仍得到 durable
  `state=blocked, reason=BACKEND_PREFLIGHT_NOT_ATTESTED`。這是實際 Controller fixture 結果。
- `StartBackend`／`RecoverFailedStart`／`SchemaUpgrade` 屬 `LocalAction`，要求
  `actor=launcher_local_operator`；`Invoke-OmiLocalControlOperation` 仍顯示 `MessageBox`。
  它們已存在但不符合本次「authenticated remote intent、不另跳本機確認」的要求。
- 尚無此遠端 wire 的 `ApplyRelease`／`UpgradeDBSchema` action，不能依名稱猜測加入。
- 合成 fixture 的 accepted 回覆只測 adapter 的保留／不重送語意，**不是實際 Controller
  接受獨立 adapter mutation，更不是正式 restart／recovery／migration 驗收**。

後續 main owner 必須先完成獨立 remote caller 的固定 action 協定與 durable provenance，
保留自身 stop／writer／start／schema／release gates；adapter 才同步已落地 actions、固定
confirmation、負面測試與 disruptive annotations。不冒用 Backend／local actor，不加假 approval。

## 驗證與最小 adoption

完整命令、source hashes 與結果見 [本輪紀錄](agent-runs/launcher-direct-adapter/Progress.md)。
Windows fixtures 只使用臨時 repo identity／隨機化 pipe、synthetic token 與臨時 receipt store；
Controller fixture 編譯 main C# 的位元組副本，不 dot-source 主 Launcher、不啟動 Backend，
也不呼叫 TakePending 或 lifecycle。PID recycle 以真實 retained handles 加上 injected
PID／creation 變更測試；未刻意讓 OS 回收某個 PID。ACL denial 為 native boundary fault injection，
未改正式 ACL。所有 fixture 子程序隱藏啟動、合作退出，不 force-kill。

- Source／Fixture：見本輪定點結果，與正式環境分開。
- Loaded Runtime：UNVERIFIED，未 reload／restart／deploy。
- Remote MCP E2E：UNVERIFIED，未連正式 MCP、Tunnel、Backend 或 Launcher pipe。

本輪修改 `OMI_search/AGENTS.md`（此檔被既有 Git ignore 規則忽略，未 force-add）；
根 `C:\GPT_MCPtool\AGENTS.md` 因使用者明確限制修改範圍而不改。
`launcher_transport.py` 已加入 HTTP build ID 與既有 tray source hash 清單，僅 source 變更，
沒有改 Control Center lifecycle 或 installed Runtime。

後續最小步驟（本輪未執行）：

1. 先由 main job 完成／驗證遠端命令；若只採用 reader，可先保留明確的 mutation blocker。
2. 另行授權 adoption 時，以原 owner 正常載入 main Controller 與 adapter source，既有安全設定
   注入 credential；不要把目前磁碟檔案或先前 HTTP 200 當作 loaded proof。
3. 先唯讀驗證 Launcher PID／creation／argv 與 status、同 UUID receipt；重新驗證 MCP
   modern／legacy catalog，並記錄來源／載入身分及 ChatGPT action cache 採用。
4. 只有使用者明確要求一次固定 mutation 時才提交；取得 accepted／unknown 後只查同 UUID
   receipt，不重送、不替換 UUID。正式 Backend-offline／遠端 E2E 驗收仍須單獨安排。

## 歷史紀錄（2026-10-15 及以前）

以下保留原 HTTP relay 的事故與驗收紀錄，不是現行 transport 規格，也不能用其中舊
safe-stop blocker／runtime PID／測試計數宣稱目前 readiness。現行契約以上方為準。

## 新版安全退出通道的交接與驗收（2026-10-15）

Canonical source 位於 `C:\project\Open Market Intelligence`；此次只讀檔案，未 import、
執行或修改 backend，也未呼叫 live GET／POST。下列欄位由 backend 擁有，adapter 不補值、
投影、判斷 readiness 或建立另一份 production schema：

| Surface | 必須原樣保留的 source 契約 |
| --- | --- |
| status | `owner_id` UUID、launcher/backend ownership、readiness、`serving_backend.writer_preflight`、`restart.blockers`、`source.disk_matches_import` 與 loaded identity |
| writer preflight | `schema`、boolean `runtime_started`／`all_writers_drained`、`registered_drain_state`、integer `unknown_writer_count`；這是觀測，不是 drain 命令或 approval |
| operation | `state` accepted／blocked／unknown 等、原 `request_id`／`owner_id`、typed `backend_preflight`、`backend_preflight_identity`、`blockers`、`after=null`、loaded identity |
| 相容性 | optional 欄位缺少仍缺少、null 仍 null、未知／future extension 原樣保留；HTTP 200 不等於 restart ready，202 不等於 succeeded |

Backend receipt 的正式欄位是 `state`；adapter 不將它改成 `status`，也不將既有／future
payload 中的 `status` 改成 `state`。Writer preflight 可為 null；未知 writer 數量與 blocked
reason 不得被強制改成 0／true／ready。`source` 的 build ID 僅涵蓋 runtime-control bundle，
不是完整 release loaded attestation；即使 disk/import 相等，也不能自行宣稱 source adoption。

本次 source 證據：

- `backend/app/routers/runtime_control.py`：status 讀取 `runtime.restart_preflight()`；
  restart 轉送至 launcher，依 `state` 回傳 202／409／503；operation 原樣回傳 launcher receipt。
- `backend/app/runtime.py::restart_preflight`：memory-only 觀測；沒有觸發 terminal drain。
- `scripts/OmiRuntimeControl.cs::Receipt`／`EvaluateRestartPreflight`：保存 typed preflight、
  caller-bound identity、blockers；`UnavailableRestartGates()` 仍列出
  `WRITER_ADMISSION_NOT_ATTESTED`、`ALL_WRITERS_DRAIN_UNAVAILABLE`、`OWNER_APPROVAL_REQUIRED`、
  `GRACEFUL_TRANSPORT_UNAVAILABLE`、`SAFE_START_UNAVAILABLE`、`READINESS_NOT_ATTESTED`、
  `SOURCE_ADOPTION_NOT_ATTESTED`。
- `scripts/omi-runtime-control.ps1::Restart-Backend`：只執行 `EvaluateRestartPreflight`；
  沒有 production Stop／Start，也沒有呼叫 OwnedShutdown。Status 的 `restart.available=false`
  及 blockers 仍由 launcher 決定，adapter 不覆寫。
- `scripts/run-service-logged.ps1 -OwnedShutdownChannel`、`scripts/OmiOwnedShutdown.cs`、
  `backend/app/owned_uvicorn.py`：存在 Launcher→Runner→Uvicorn ASGI cooperative transport source；
  `owned_uvicorn.py` 仍拒絕 production writer coverage 未證實的 shutdown。
  `backend/tests/architecture/test_owned_shutdown_boundary.py` 明確檢查 public／legacy route
  不能取得 disposable authority；此次只讀該測試，沒有執行 backend fixture。

使用者提供 job `956f638c-2324-437a-8557-0ed791f58be9` 的 21 checks 為先前
source＋disposable fixture 紀錄，**不是本次重跑結果或 live acceptance**。正式 writer fencing／
全域 drain、launcher approval、安全 startup／readiness／source adoption 尚未接通。
不得用 fixture capability 或固定／假布林值放開 gates；後續由 backend owner 補足權威證據，
adapter 保持固定 API relay。

此次驗證命令（在 `C:\GPT_MCPtool\OMI_search` 執行，無 install）：

```powershell
python -B tests/run_offline_sdk_tests.py test_runtime_control_sdk.py test_runtime_control.py
python -B tests/check_workspace_contract.py
git -C C:\GPT_MCPtool diff --check -- OMI_search
```

- **Source：PASS**。AST 檢查固定三條 routes、unprojected response 與禁止的 process／shell calls；
  source review 確認沒有新增 pipe／writer authority。Server 僅改三段 tool descriptions，轉送邏輯不變。
- **離線 SDK／protocol：PASS**。25 tests、0 failure／error／skip。真正 `mcp==2.1.1`／
  `mcp-types==2.1.1`，Python 3.13.9／Pydantic 2.12.2，沿用既有 offline runner；
  Win32 stdio/process 入口 fail closed，ASGI 不監聽 port，所有 upstream IO 為 mocks。
  Legacy `2025-06-18` 與 modern `2026-07-28` 共 34 次新增／擴充矩陣內的 `tools/call`：
  巢狀 status、optional receipt populated/null/absent、202 accepted／409 blocked／503 unknown、
  同 UUID explicit replay、timeout 後同 UUID GET。逐一比對 structuredContent／text JSON、
  型別、null／缺欄、固定 URL／method／body、專用 header 及一次 IO；future fields 不丟失。
- **市場契約：PASS（本次保留）**。20 tools／2 resources、原 17 tools 與 resources baseline
  digest 不變；兩份 generated snapshots 不寫入。檔案 SHA256：
  `public_contract_snapshot.json` = `8feb596051a5175e320d9478ff69103c4ea6bf1c45a4e97450bfed3984ea883a`；
  `tw_market_dashboard_contract_snapshot.json` = `10fc31367d154156da1e1c6bb17b15850dade44c0b500bb51e77fde388b5b287`。
  檔案 hash 與 public manifest digest 是不同概念；既有 public snapshot parity 差異見下方歷史紀錄，
  不屬於本次修補範圍。
- **Runtime adoption／Live／ChatGPT host：UNVERIFIED**。未重啟 adapter/backend、未部署、
  未執行 live request、未驗證正式 stdio。使用者提供的 live HTTP 200、PID 49592、
  `ALL_WRITERS_DRAIN_UNAVAILABLE`、`disk_matches_import=false`、backend `UNATTESTED`
  為先前觀測，未於本次刷新；不能當作目前 process identity 或 production readiness。
- **Production safe stop：BLOCKED（source）**。接通 status／receipt 不代表安全退出已啟用。
  無 DB／provider／trading 操作、無 secret 讀取、無安裝／提權、無 commit／push。

## 原有市場契約

原 17 個 tools、隱藏 `omi.search` alias、兩個 UI resources、official Python MCP SDK transport
與 generated snapshots 不改。市場 `omi.ask` 仍固定 `omi.decision.v4`、
`allow_llm=false`、`allow_write=false`；管理例外不授予任意寫入、交易、DB、provider 或 shell 能力。
主 OMI `agents/omi_mcp_server` 不是本次 ChatGPT adapter 修改位置。

## Source 驗證

```powershell
cd C:\GPT_MCPtool\OMI_search
python -B -m unittest discover -s tests -p test_runtime_control.py -v
python -B -m unittest discover -s tests -p test_workspace_transport_core.py
python -B -m unittest discover -s tests -p test_workspace_g2b_core.py
# 僅在有效且符合 lock 的官方 SDK 環境執行；ASGI/in-memory mock，不啟動 listener：
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -p test_runtime_control_sdk.py -v
```

純標準庫 tests 執行實際 adapter AST（只略過 SDK imports），不可稱為 SDK handshake 驗收。
新增 SDK-specific suite 在 `find_spec("mcp")` 為空時由 `unittest.skipUnless` 跳過，避免新增
collection error；此結果固定標記 **SDK_E2E_UNVERIFIED**，不計入 SDK acceptance。
Custom `_meta` 與 annotations 的 SDK wire roundtrip 已由下節驗證；ChatGPT host 解讀仍為 Unverified。
測試比較修改前 dirty source 的原 17 tools／2 resources digest，並涵蓋在線與離線 20 tools、
固定 routes、UUID／confirmation、token 缺失／隔離、202／403／409／503、unknown、收據與 no retry。
本次不執行 live POST、service restart、tunnel 變更、commit 或 push；完整結果見
[任務驗證紀錄](agent-runs/runtime-control-adapter/Progress.md)。

## tools/list 協定修復驗證（2026-10-14）

根因是既有 `omi_read_tw_stock_research`，不是三個 runtime tools。
已安裝的 `mcp-types==2.1.1` 在 `methods.SERVER_RESULTS` 將 `2025-06-18`
映射到 `_v2025_11_25.ListToolsResult`；其 `OutputSchema.type` 必填且限 `object`。
Generated research schema 的根只有 `$defs`／`anyOf`／title，兩個 `$ref` 分支
各自都是 object，但缺根層 type。直接驗證完整 20-tool result 的唯一錯誤是：

```text
tools.15.outputSchema.type
Field required [type=missing]
```

同一 payload 使用 SDK `ListToolsResult.model_dump(by_alias=True, exclude_none=True)`，
含 SDK 預設 `ttlMs=0`、`cacheScope=private`、`resultType=complete`；
`validate_server_result('tools/list', '2026-07-28', payload)` 原本即通過。
省略這三個 envelope 欄位會造成額外的 modern 測試輸入錯誤，並非本次 server 缺陷。
ASGI fixture 也以未修正投影重現 HTTP 200、JSON-RPC -32603
`Handler returned an invalid result`，由真正 `mcp/server/runner.py` 捕捉同一 ValidationError。

修正只在 `_mcp_tool` 的 negotiated legacy projection 補上冗餘 `type: object`。
完整保留兩個 union 分支與所有 definitions；modern 投影及 generated 原檔不改。
Regression 同時核對兩分支都是 object，原 17-tool catalog／2 resources digest 不變。
Restart 仍為 `readOnlyHint=false`、`destructiveHint=true`，兩版均保留 disruptive `_meta`；
未新增另一套 protocol layer 或移除工具。

測試使用既有 `C:\miniconda3\python.exe` 3.13.9，載入本專案 `.venv/Lib/site-packages`
內真正的 `mcp==2.1.1`／`mcp-types==2.1.1`，Pydantic 使用該 interpreter 可用的 2.12.2。
原 `.venv/Scripts/python.exe` 回報 `No Python at ...Python312/python.exe`，未安裝或提權。
`run_offline_sdk_tests.py` 只將未使用的 Win32 stdio/process API 替換成一呼叫即失敗的 stub；
SDK schema、runner、negotiation、ASGI transport、application handlers 均未替換。
urllib 外連封鎖，controller IO 全為 mocks；不代表原生 stdio 或完整 lock 環境驗收。

在 `C:\GPT_MCPtool\OMI_search` 執行：

```powershell
python -B tests/run_offline_sdk_tests.py `
  test_runtime_control_sdk.py test_runtime_control.py test_http_server.py `
  test_workspace_g2b_core.py test_workspace_transport_core.py `
  test_workspace_g2b_sdk.WorkspaceG2bSdkTests.test_exact_legacy_protocol_discovery_variants_and_http_errors `
  test_server.OmiSearchMappingTests.test_minimal_canonical_request_is_read_only_and_not_interpreted `
  test_server.OmiSearchMappingTests.test_caller_cannot_override_fixed_trust_boundary_flags `
  test_server.OmiSearchMappingTests.test_refresh_is_enabled_only_by_explicit_boolean_alias `
  test_server.OmiSearchMappingTests.test_shortcuts_keep_fixed_read_only_flags `
  test_server.OmiSearchMappingTests.test_tools_list_falls_back_to_generated_snapshot
```

結果 **46 tests PASS、0 failure、0 error、0 skip**，其中 runtime SDK suite 為 6 tests：

- 完整 catalog 的 online/offline fixture 在兩個版本直接 result validation 都通過。
- Legacy initialize → initialized → tools/list 成功；20 names 包含三個 runtime tools。
- Modern 使用 SDK 正式的 sessionless discovery/adopt → tools/list。此版本沒有 legacy
  initialize method；raw requests 帶完整 `_meta`、`Mcp-Method`／`Mcp-Name` routing headers。
- 兩版各有 2 resources；status／operation 各呼叫一次 mocked GET，共四次唯讀 `tools/call`，
  structuredContent 與 text JSON 保留 blocked／unknown／owner／future fields，無 token header。
- 既有 mock restart outcomes、no-retry、token isolation、trust flags 與 snapshot fallback 通過。

初次額外執行既有廣一點的定點套件時，stdio subprocess test 被上述 fail-closed stub 阻擋，
未啟動 child；modern research call test 的客戶端 JSON Schema 驗證因 `rpds.rpds` binary
不適用目前 interpreter 而無法執行，未 mock 掉 validator 或安裝套件。這兩項不計入 46 項通過。
既有 legacy research error test 另修正 JSON text 解析後再比對 error，避免把 escaping 誤判為
server 改寫；其兩種 research projection 與 413／422／503 回覆現在通過。

`python -B tests/check_workspace_contract.py` 通過 AST、20/2 count、generated dashboard
digest 與 backend byte parity；dashboard SHA256 為
`10fc31367d154156da1e1c6bb17b15850dade44c0b500bb51e77fde388b5b287`。
另比對 `public_contract_snapshot.json` 發現既有 **parity 不一致**：adapter manifest digest
`bdffd32134558affc4f7ea053c87e4a6a17f7e75fc2fc80e22d193bf564eba81`，backend artifact 為
`e557cd226ebf0bb3a57a99a25647ebc8f49010b1aff27bc3c151abee27c19dfc`。
差異限於 `ask_input_schema`／digest：hot_groups 與 screening.intraday 的 lane，以及 capability
metadata。Public digest 是 backend manifest digest，不是整份 snapshot 的 JSON hash。
本次未寫入兩份 snapshot，原 17-tool baseline digest 測試通過；依保留市場契約的範圍限制，
未把這個不同步問題混入 wire 修補，也不宣稱所有 snapshots parity 通過。
六個本輪檔案 UTF-8／syntax／whitespace 與 `git diff --check -- OMI_search` 通過。

本次只到 **source／offline SDK gate**。未重啟、live POST、改 backend、部署、commit 或 push。
正式 runtime 載入修補及 ChatGPT catalog 更新仍為 **UNVERIFIED**；須另外授權後，在 restart
完成後以正式 endpoint 重跑 protocol smoke 才能宣稱 live 修復。
