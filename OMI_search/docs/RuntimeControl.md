# OMI runtime controller 的窄轉送契約

目前維持既有三個 ChatGPT-facing runtime tools，公開 surface 共 20 tools／2 UI resources。
2026-10-15 已對照本機 OMI backend／launcher source：既有 relay 可以原樣交付新版
status／receipt，不需要新增 Stop／Restart 工具或修改轉送邏輯。此次僅補測試、工具說明與交接。
**狀態／收據讀取已在 source 與離線 SDK 接通；正式安全退出仍為 BLOCKED。**
OwnedShutdown 的 source／disposable fixture 不代表 production active，也不授予 adapter lifecycle authority。

| Tool | 固定轉送 | MCP arguments |
| --- | --- | --- |
| `omi_read_runtime_status` | `GET /api/system/runtime-control/status` | `{}` |
| `omi_restart_backend` | `POST /api/system/runtime-control/restart-backend` | `request_id` UUID、`expected_owner_id` UUID、`confirmation` 固定 `restart_backend` |
| `omi_read_runtime_operation` | `GET /api/system/runtime-control/operations/{request_id}` | `request_id` UUID |

UUID 採標準連字號格式；拒絕缺少／額外參數、path injection、非 UUID 或錯誤 confirmation。
Restart 必須來自使用者明確要求，先讀 status 的 launcher instance UUID 作為 expected owner。
參數不是身分驗證；授權由 backend 專用 credential 檢查及 owner／writer-drain gates 決定。
Restart 帶 `readOnlyHint=false`、`destructiveHint=true` 與 `omi/runtime-control/disruptive=true`。
`idempotentHint=true` 依 backend 的同 UUID durable 去重契約，不表示可以自動 retry。

Adapter 使用既有 launcher-selected `OMI_SEARCH_API_BASE_URL`（預設 loopback 8400），
管理路徑只接受無 userinfo／path／query／fragment 的 loopback HTTP(S) base。
管理請求不繼承 proxy，也不跟隨 redirect。它不建立 launcher、pipe 或 process manager；
same-user ACL Windows pipe、drain、安全檢查、durable queue 與實際程序管理均由主 OMI backend controller／launcher 擁有。

## Credential 邊界

專用 token 僅由 runtime 的本機環境 `OMI_SEARCH_RUNTIME_CONTROL_TOKEN` 提供；
只在 restart POST 放入 `X-OMI-Runtime-Control-Token` header。
Token 必須恰好 64 個小寫十六進位字元（`[0-9a-f]{64}`）；adapter 不 trim、不轉大小寫，
長度不足／過長、大寫、非 hex、空白或 newline 都在 IO 前拒絕。
Backend 的 `OMI_RUNTIME_CONTROL_TOKEN_SHA256` 必須設為同一 token 字串 UTF-8 bytes 的
SHA256 小寫 hex digest（不是先將 token hex decode 成 bytes 再 hash）。
這對設定必須由本機 operator 安全配置；格式合法不代表與 backend hash 配對，仍可能 403。
Adapter 不讀 backend 設定或 secret 檔，
不保存 credential，不 fallback 到 `X-OMI-AI-Trust-Token`，兩個 GET 不傳 token。
缺少或不符合此格式的 token 在 IO 前拒絕。不要把 token 寫入 MCP arguments、
tracked 檔案、命令列範例或 log。Backend response 若回顯 credential，adapter fail closed，
不交付該內容；原始 exception／HTML error body 不會回傳。

## 回覆與結果未知

有效 backend JSON object 放入 `response` 原樣交付，外層僅附
`transport_status="http_response"` 與 `http_status`，MCP `isError=false`。
不另造 runtime schema，不修改 `omi.runtime-control.v1` status、selected endpoints、
backend／frontend／launcher／MCP dependency、attested／unknown identity 或 launcher UUID。

| HTTP / failure | Caller 必須保留的意義 |
| --- | --- |
| 202 | durable queue accepted；不是 restart 完成 |
| 403 | unauthorized，保留 backend reason |
| 409 | blocked／owner mismatch；writer drain false 是合法阻擋 |
| 503 | controller 結果 unknown／unavailable，原樣保留 backend state 與 reason；不得推論未入列或重送 |
| timeout／network failure | transport error；POST 結果 unknown，不能推論未入列 |
| malformed／credential echo response | fail closed；POST 結果仍為 unknown |

Adapter 錯誤回覆為 `isError=true`、`transport_status="error"` 與固定安全 `error` code；
例如 `RUNTIME_TIMEOUT`、`RUNTIME_UNAVAILABLE`、`INVALID_RUNTIME_UUID`、
`INVALID_RUNTIME_CONFIRMATION`、`RUNTIME_CONTROL_TOKEN_MISSING_OR_INVALID`。
POST 傳送後不確定結果附 `outcome="unknown"`、原 `request_id` 與
`next_action="read_runtime_operation_same_request_id"`。
所有呼叫只送一次；無自動 retry、poll、repair 或新的 UUID。
原 request UUID 的 durable receipt 可以是 accepted／running／succeeded／failed／blocked／unknown，
一律保留 backend 內容。重複要求先查同 UUID，unknown 不代表可再次提交。

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
