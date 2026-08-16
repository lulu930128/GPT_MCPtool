# Memory Core

Memory Core 是 local-first、single-user、可審計的個人資料後端。它是網站、Kuro、MCP 與桌面工具共同使用的 system of record；所有 client 都只能透過 API 存取資料。

目前 application release 為 `1.1.0`，已完成通用後端核心、tool-only MCP adapter、Cocktail Record
Schema v1、相容舊流程的 ChangeSet、Batch／Item／Collection v3 架構，以及本機
Tkinter 管理控制中心；尚不包含 Kuro adapter。Batch v3 的第一個可用 profile 是
`media.experience.v1`。

## 文件導覽

- [安全與隱私](docs/SecurityAndPrivacy.md)：資料、scope、restricted content、network、
  external projection 與 backup 邊界。
- [Candidate 審核流程](docs/CandidateReview.md)：review digest、prepare challenge、
  approve/reject、idempotency、ChangeSet 與 Batch 語意。
- [維運手冊](docs/Operations.md)：安裝、migration、stack readiness、exact-path recovery、
  backup 與還原原則。
- [MCP 工具參考](docs/McpToolReference.md)：read、proposal、typed、Batch 與 conditional
  reviewer tools。
- [資料模型 V1](docs/design/memory-model-v1.md)、[V2](docs/design/memory-model-v2.md)、
  [V3](docs/design/memory-model-v3.md)：Record／Entity、ChangeSet／Link 與
  Batch／Item／Collection 的正式設計。

## 已具備的能力

- FastAPI `/api/v1` contract，以及公開的 `/health`、`/version`。
- SQLite WAL、foreign keys、busy timeout 與 Alembic migration。
- Scoped client token；資料庫只保存 SHA-256 digest。
- Records、entities、tags、record/entity/tag links 與 entity relations。
- `restricted` 資料的獨立 read/write scope。
- Optimistic concurrency、soft archive、revision 與 audit event。
- Candidate create/prepare-review/apply/reject、不可變 review digest、短效 challenge、
  7 天期限、獨立審核 idempotency 與 result id/version。
- ChangeSet Candidate 可在同一 transaction 建立或更新多筆 Record；支援受 schema
  registry 限制的 `op:<op_id>` local reference、依賴循環檢查、完整 rollback 與逐筆
  results。
- Batch Candidate 是新的主要批次入口：一次接收 1～50 個 typed Item，先以固定版本與
  hash 的 normalization profile 產生可審查 plan；同一 Batch 內每個 Item 有獨立
  decision、operation/result、claim、transaction、post-commit readback 與 retry 狀態。
  單筆只是含一個 Item 的 Batch；Batch 本身不是正式記憶。
- `Collection` 只保存群組 metadata 與 canonical Record membership，不複製 Item
  payload。正式資料仍是一筆一個 Record，可從 Collection 看整群，也可逐筆 fetch。
- Record schema 中的 reference field 會同步成 revision-aware Record Link current
  projection；更新時採 soft remove，歷史仍由 Revision 與 Audit Event 保存。
- Record 的 `occurred_start`／`occurred_end` 與 Entity Relation 的
  `valid_from`／`valid_to` 必須使用含 `Z` 或明確 UTC offset 的 ISO 8601 datetime；
  API 會正規化為 UTC。`timezone_name` 可省略；提供時必須是 IANA timezone，例如
  `Asia/Taipei`，且不會替 naive datetime 自動補上 offset。Record 有
  `occurred_start` 時 `date_precision` 不得為 `unknown`；沒有開始時間時必須使用
  `unknown`，`occurred_end` 也不能單獨存在。
- FTS5 trigram 搜尋；多詞查詢會跨 title／summary／body／payload 或 entity 欄位計算
  coverage 與權重，先正規化自然語句與標點，優先 exact/title matches；嚴格 coverage
  查無結果時才做 bounded token fallback。
- Search 可用 result type、domain、`schema_name`、kind/entity type、sensitivity 與
  timezone-aware updated-at 範圍篩選，並回傳 score、matched fields/terms、
  normalized query 與實際 strategy。`schema_name` 只適用於 Record，指定時不會混入
  Entity。
- `memory_overview` 可查看目前 scope 可見的 Record／Entity、domain taxonomy、
  schema version、FTS parity 與 Candidate status counts，不回傳記憶內容。
- `memory_detect_duplicates` 以 bounded read-only scan 回報可能重複的 refs、理由與
  confidence，不會自動合併或封存。
- 不含 credential 的 JSON export。
- SQLite online backup、sidecar manifest 與 integrity verification。
- Tool-only MCP adapter：標準 `search`／`fetch`、安全的 Record revision/link、
  Collection 群組讀取、typed media-experience Batch、通用與 typed Cocktail
  ChangeSet、既有 candidate proposal tools，以及啟用獨立 reviewer credential 後才
  出現的遠端審核工具。
- MCP `fetch` 與 Candidate outward detail 使用獨立 external projection；正式資料與
  audit digest 不變，但輸出會遮蔽 Windows 絕對路徑、使用者 home path 與
  path-shaped payload fields。含 machine-local path 的新 MCP proposal 會在送入
  backend 前拒絕；無法顯示 exact digest input 的 Candidate 不能遠端核准。

## 架構與 trust boundary

```text
MCP / Kuro / Admin UI
          |
          v
     Memory Core API
          |
     application services
          |
  SQLite + FTS + audit/revision
```

- Client 不可直接操作 SQLite。
- 一般 MCP／Kuro client 應只有 read 與 `candidates:create` scope。
- `candidates:review` 只交給明確受信任、具有完整審核流程的 client；它使用獨立
  credential，不與一般 MCP 讀取／提案 credential 共用。
- Reviewer credential 預設只有 `candidates:review`，不能直接讀寫 records/entities，
  也不含 `restricted:write`。
- Public website 未來只讀獨立 public snapshot，不連私人資料庫。
- Password、API key、token、cookie、private key 與原始公司機密不得寫入 Memory Core。

既有 Record／Entity 與資料治理 contract 在
[`docs/design/memory-model-v1.md`](docs/design/memory-model-v1.md)，legacy ChangeSet 與
Record Link contract 在 [`docs/design/memory-model-v2.md`](docs/design/memory-model-v2.md)，
Batch／Item／Collection 的 primary contract 在
[`docs/design/memory-model-v3.md`](docs/design/memory-model-v3.md)。本機
`docs/agent-runs/` 只保存施工紀錄且不進 Git；可長期引用的決策必須整理到上述正式文件。

## 安裝

需求：Python 3.12 與 [uv](https://docs.astral.sh/uv/)。

```powershell
cd "C:\GPT_MCPtool\Memory Core"
Copy-Item .env.example .env
uv sync --all-groups
uv run alembic upgrade head
```

Runtime 不會自動執行 migration。每次更新程式後，先閱讀 migration，再明確執行 `alembic upgrade head`。

## 建立第一個管理 Client

```powershell
uv run python .\scripts\memory_core_admin.py create-client --name local-admin --scope '*'
```

Token 只顯示一次。請保存在安全的本機 secret store；不要寫入 `.env`、repo、log 或文件。

若要建立未來 MCP 使用的低權限 Client：

```powershell
uv run python .\scripts\memory_core_admin.py create-client `
  --name memory-mcp `
  --scope records:read `
  --scope entities:read `
  --scope candidates:create
```

這個 token 由 MCP process 持有；MCP host 看不到它。不要使用管理 token，亦不要加入 `candidates:review`、write 或 admin scope。

若要啟用 MCP 遠端審核，再建立一把彼此獨立的 reviewer token：

```powershell
uv run python .\scripts\memory_core_admin.py create-client `
  --name memory-mcp-review `
  --scope candidates:review
```

Reviewer token 只授權 candidate 審核入口，不授權直接 records/entities API。除非你已
明確設計 restricted 資料的額外確認流程，請勿加入 `restricted:write`。

## 啟動

```powershell
uv run uvicorn memory_core.main:app --host 127.0.0.1 --port 18765
```

- OpenAPI：`http://127.0.0.1:18765/docs`
- Health：`http://127.0.0.1:18765/health`
- API：`http://127.0.0.1:18765/api/v1`

除非已建立完整反向代理、TLS 與獨立驗證，請勿改成 `0.0.0.0` 或直接暴露至網際網路。

2026-08-09 起，Windows lifecycle 的 internal backend 預設由舊 `8765` 移到 `18765`，
避免 Windows／Hyper-V／Docker 動態 excluded range 擋住 bind。Stack 會以同一個
`BackendPort` 產生 uvicorn argument、`MEMORY_CORE_PORT` 與 MCP API URL；不會讀取或
改寫私人 `.env`。若使用自訂手動 launcher，必須同步更新 backend、MCP 與 viewer URL。
對外 MCP 與 tunnel admin 已移至 reboot-stable 固定埠 `18818` 與 `18800`。

## 啟動 MCP adapter

先啟動 backend，再執行：

```powershell
cd "C:\GPT_MCPtool\Memory Core"
.\scripts\start_memory_core_mcp.ps1
```

腳本會以隱藏輸入提示讀取低權限 Memory Core client token，只放在目前 MCP process
environment，結束時清除。若要用這個單機腳本啟用審核工具，請另外透過安全的
process environment 提供 `MEMORY_CORE_MCP_REVIEW_CLIENT_TOKEN`；不要把任何 token
寫入 `.env`。它不需要也不會讀取 OpenAI API key。

- MCP endpoint：`http://127.0.0.1:18818/mcp`
- MCP health：`http://127.0.0.1:18818/health`
- Transport：stateless Streamable HTTP，JSON response
- Listener 與 backend URL 都強制限制為 loopback；不能用設定誤綁到 `0.0.0.0` 或外部 API。

MCP tools：

- `search(query, limit=20, ...)`：搜尋可見的 records/entities；自然語句會先做
  Unicode／標點／常見意圖詞正規化，多詞查詢先要求至少 60% token coverage（且至少
  兩詞），查無結果才做 bounded fallback。可選擇 result type、domain、
  `schema_name`、kind、sensitivity 與 updated-at filters；結果包含可交給 `fetch` 的
  stable id 與 bounded diagnostics。
- `fetch(id)`：以 `record:<id>` 或 `entity:<id>` 讀取單一項目，預設最多 30,000
  字元並明確標註是否截斷；輸出 projection 會遮蔽 machine-local path，且不改寫 DB。
  已封存項目的既有 stable ref 仍可讀回，metadata 會明確標示 `state=archived`。
  Record 同時具有 UTC occurrence 與有效 `timezone_name` 時，metadata 會動態加入
  `occurred_start_local`／`occurred_end_local`，資料庫仍只保存 UTC。
- `fetch` 讀取 `cocktail_tasting@1` 時會以 `recipe_ref + recipe_version` 查詢不可變
  revision snapshot，並加入 `recipe_title`、`recipe_version_available` 與
  `recipe_resolution_status`。Recipe 或 revision 缺失時只回報
  `missing`／`version_missing`，不讓整筆 Tasting 讀取失敗。
- `memory_fetch_record_revision(record_ref, revision_no)`：讀取指定的不可變 Record
  snapshot，回傳 requested/current version 與 `is_current`。它沿用 `fetch` 的 bounded
  external projection；current 或 historical snapshot 任一方為 restricted 時，都不會
  對缺少 `restricted:read` 的 client 洩漏內容。
- `memory_overview()`：回傳目前 credential scope 可見的 active/superseded/archived
  counts、domain/taxonomy、schema version、Record FTS parity；MCP 有 reviewer
  credential 時再合併 Candidate status counts。
- `memory_detect_duplicates(limit=50)`：回傳 entity identity、record canonical ref、
  normalized title，或 Experience `work_title` 與 Catalog `categories` 項目的重疊
  finding；只提供 refs 與診斷，不讀出內容、不自動修改。
- `memory_list_record_links(record_ref, direction="outbound", include_removed=false)`：
  讀取 Record Link current projection，可選 outbound／inbound；revision pin 與已移除
  狀態都會明確回傳。
- `memory_propose_media_experience_batch(items, idempotency_key, ...)`：一次提出 1～50
  筆 `galgame`／`anime`／`manga` experience。輸入 schema 直接顯示
  `work_title`、`progress`、`rating`、`tags` 與明確 resolution 欄位；只建立 pending
  Batch，不直接寫正式資料。identity 不唯一或同批重複時會標成 blocked，不自行猜測。
- `memory_list_collections(domain?, limit=50)`：列出可見 Collection 與 member count。
- `memory_get_collection(collection_key, limit=100)`：以 bounded summary 回傳整群
  `record_ref`；完整內容仍使用 `fetch(record_ref)` 逐筆讀取。
- `memory_propose_change_set(summary, operations, idempotency_key, ...)`：在一個 pending
  Candidate 中提出多筆 `record_create`／`record_update`。只有 schema registry 註冊的
  reference field 可使用 `op:<op_id>`；核准時全部成功或全部回滾，並回傳每筆
  `results[]`。它不會從 tasting 或一般事實自動推論 preference。
- `memory_propose_cocktail_change_set(summary, operations, idempotency_key, ...)`：使用
  `recipe_payload`、`tasting_payload`、`preference_payload` 顯示完整 Cocktail v1
  欄位，再轉換成相同的 generic ChangeSet executor。其 schema 不含 `oneOf` 或 unknown
  `content`；Tasting 引用同組 Recipe 時可用 `op:<op_id>` 並省略 `recipe_version`，
  backend 會固定實際 result version。
- 下列六個通用 proposal tools 都只建立 `pending` candidate，不會直接寫正式資料：
  - `memory_propose_record_create(content, idempotency_key, ...)`
  - `memory_propose_record_update(target_ref, base_version, content, idempotency_key, ...)`
  - `memory_propose_record_archive(target_ref, base_version, idempotency_key, ...)`
  - `memory_propose_entity_create(content, idempotency_key, ...)`
  - `memory_propose_entity_update(target_ref, base_version, content, idempotency_key, ...)`
  - `memory_propose_entity_archive(target_ref, base_version, idempotency_key, ...)`
- Cocktail v1 另提供六個固定 envelope、typed payload 的 proposal tools：
  - `memory_propose_cocktail_recipe_create(payload, idempotency_key, ...)`
  - `memory_propose_cocktail_recipe_update(target_ref, base_version, payload, idempotency_key, ...)`
  - `memory_propose_cocktail_tasting_create(payload, occurred_start, timezone_name, idempotency_key, ...)`
  - `memory_propose_cocktail_tasting_update(target_ref, base_version, payload, idempotency_key, ...)`
  - `memory_propose_cocktail_preference_create(payload, idempotency_key, ...)`
  - `memory_propose_cocktail_preference_update(target_ref, base_version, payload, idempotency_key, ...)`
- Cocktail tools 與通用工具共用 backend validator；錯誤會在 propose 階段拒絕，不建立
  Candidate。Recipe 使用 `fact`、Tasting 使用 `event`、Preference 使用 `state`，三者
  固定為 `domain=lifestyle.cocktail` 與 schema version 1。
- Update/archive 的 `target_ref` 必須使用 `record:<id>` 或 `entity:<id>`，並搭配
  `fetch` 回傳的 exact `version`。每個工具各有 operation-specific schema，不使用
  ChatGPT 容易展開成 `any` 的六合一 outward union。
- Record proposal 的 raw MCP schema 與 tool description 都明示 datetime 規則。
  可預期的 temporal input error 會回傳欄位化 `code`、`field`、`message`，並在安全時
  附上 `received_value`／`example`；不會用 HTTP 500 表示使用者輸入錯誤。
- Record update proposal 會先讀取 exact target/version，將 patch 與目前 occurrence
  狀態合併驗證，再建立 pending Candidate；無效 range 或 precision 不會留下一筆
  無法套用的 Candidate。
- Record create/update 可在 `content.entity_links` 受審地建立 Entity links；Entity
  create/update 可在 `content.relations` 建立 edition 等關係。Archive 可選填同類型
  `merged_into_ref`，核准後會在單一 transaction 建立 `merged_into` 關係並封存來源。
- 舊 `memory_create_candidate` 預設不註冊；只有短期 migration 明確設定
  `MEMORY_CORE_MCP_EXPOSE_LEGACY_CANDIDATE_TOOL=true` 時才會出現。正式 ChatGPT
  action surface 應保持 `false`。
- 修改 MCP input/output schema 並重啟 stack 後，既有 ChatGPT conversation 仍可能保留
  舊 action snapshot；請在 connector 執行 Refresh Actions／重新連線，或以新對話
  重新載入。Local `tools/list` 與 tunnel ready 只證明 server/deployment，不能替代
  host action refresh。
- 下列工具只有在 MCP process 取得獨立 reviewer token 時才會註冊：
  - `memory_list_candidates(...)`：只列出 bounded summary，不回傳完整
    proposed content、source reference 或 review note。
  - `memory_get_candidate(candidate_id)`：讀取單筆不可變內容的安全投影與 review
    digest；必須檢查 `display_mode`、`redacted_fields` 與
    `remote_approval_allowed`。
  - `memory_get_batch_candidate(candidate_id)`：讀取目前 Batch revision 的逐筆
    normalized input、decision、operation plan、execution 與 verify 狀態；支援
    `limit/offset`，partial page 會禁止遠端核准。
  - `memory_prepare_candidate_review(candidate_id, expected_review_digest)`：產生 10 分鐘
    短效、綁定 reviewer 的 challenge；這一步不是核准。
  - `memory_approve_candidate(...)`：只套用已顯示且 digest 相符的原 candidate，不接受
    replacement content；成功時回傳可直接交給 `fetch` 的 `result_ref`，同時保留
    `result_id`、`result_type` 與 `result_version`。ChangeSet 回傳完整 `results[]`；
    Batch 則以每個 Item 的 `results[]` 與 `verified_at` 為準，並明確回傳
    `batch_execution_state`、逐狀態計數、`any_item_committed` 與
    `failed_items[].retry_policy`；部分失敗不會回滾其他已成功 Item。
  - `memory_reject_candidate(...)`：拒絕同一個已準備的 candidate，不寫正式資料。

若 Candidate detail 為 `display_mode=redacted`，顯示內容不是 digest 的 exact input，
`memory_prepare_candidate_review` 與 `memory_approve_candidate` 會以
`candidate_requires_local_review` 拒絕。不要以遮罩內容冒充已完整審閱。

所有 tool result 都同時提供 MCP `structuredContent` 與文字 JSON fallback。正式資料沒有
direct-write tool；唯一寫入路徑是：

```text
explicit save request
  -> matching memory_propose_* tool
  -> show exact candidate + review_digest
  -> memory_prepare_candidate_review
  -> separate explicit approval of that exact candidate
  -> memory_approve_candidate
  -> fetch each result_ref
  -> verify every result_id + result_type + result_version
```

建立、查看、摘要、編輯或 prepare candidate 都不是核准。若內容要改，必須建立新的
candidate 與新 digest；candidate 預設 7 天到期。approval/rejection retry 必須沿用同一
個 review `idempotency_key`，相同 key 不可改 action、candidate 或 review note。

Codex 或其他可連本機 HTTP MCP 的 host，設定 URL 為：

```text
http://127.0.0.1:18818/mcp
```

ChatGPT 網頁無法直接連 localhost；需要 HTTPS deployment 或獨立的 Secure MCP Tunnel。Tunnel credential 不屬於本 repo，也不能寫入 `.env`、README 或 YAML 明文。請先輪替任何曾貼在聊天中的 credential，再另行設定 tunnel。

## Secure MCP Tunnel（本機私人連線）

本專案提供 Windows lifecycle script，將 backend、MCP 與 OpenAI Secure MCP Tunnel 維持在同一個 local trust boundary。三者都只監聽 `127.0.0.1`；tunnel client 主動建立 outbound HTTPS 連線，不需要開 inbound firewall port。

Tunnel executable 目前仍來自 legacy `project_reading` 安裝位置；Control Center inventory 只讀取
path／version／SHA-256，不做 automatic upgrade。Lifecycle script 只在 backend／MCP／tunnel child
spawn 時清除 ambient proxy、bypass `127.0.0.1`／`localhost`，完成後還原 parent environment；
不修改 Windows 全域 proxy。Tunnel child 的 stdout／stderr 另寫入 component-owned runtime log，
不繼承 controller capture handle，避免 runtime 已 Ready 但 cold-boot action 仍等待 pipe EOF。
需要企業 outbound proxy 時必須使用明確、component-owned 設定。

第一次設定：

```powershell
cd "C:\GPT_MCPtool\Memory Core"

# tunnel ID 不是 API key；profile 會存放在 ignored data/ 目錄。
.\scripts\memory_core_stack.ps1 -Action Setup -TunnelId "tunnel_..."

# 只在隱藏輸入提示貼一把未曾出現在聊天或 log 的新 runtime API key。
.\scripts\memory_core_stack.ps1 -Action SaveRuntimeKey

.\scripts\memory_core_stack.ps1 -Action Doctor
.\scripts\memory_core_stack.ps1 -Action Start
```

本專案刻意使用 tunnel-client 的 `sample_mcp_remote_no_auth` profile：MCP authentication 由本機低權限 Memory Core client token 負責，外部連線由 tunnel control plane 驗證。此模式下 OAuth protected-resource metadata 回傳 `404` 是預期行為；lifecycle script 只在它是 doctor 唯一失敗項時降級為 warning，其他失敗仍會中止啟動。

`Setup` 會建立四個彼此獨立的 client：

- `memory-mcp-tunnel`：`records:read`、`entities:read`、`candidates:create`。
- `memory-mcp-review`：只有 `candidates:review`。
- `memory-core-viewer`：只有 `records:read`、`entities:read`。
- `memory-core-control-center`：目前完整且明確列出的 read/write/review/admin scopes，
  只供本機 Tkinter 控制中心使用。

四把一次性 token 與 tunnel runtime key 都以 Windows DPAPI current-user encryption
保存在 ignored `data/secrets/`，不寫入 `.env`、YAML 或 git。已完成舊版 Setup 的機器
可在 migration 後執行下列命令只補 reviewer credential，再用 `Restart` 讓 MCP 載入：

```powershell
.\scripts\memory_core_stack.ps1 -Action SetupReviewCredential
.\scripts\memory_core_stack.ps1 -Action Restart
```

日常操作：

```powershell
.\scripts\memory_core_stack.ps1 -Action Status
.\scripts\memory_core_stack.ps1 -Action Stop
```

`Status` 的 `pid` 是 launcher 管理的 process-tree root；`listenerPids` 是目前實際綁定
對應 loopback port 的程序。Windows venv shim 可能使兩者不同，診斷時應同時核對。

正式日常啟動由根目錄的 MCP Control Center 透過
`control-center/component.json` 與 `scripts/runtime-control.ps1` 管理。Memory Core 仍
保留自己的資料夾、stack、PID authority、Tkinter viewer、依賴與測試；Control Center
不讀取 Memory Core 的正式資料或 credential。整合與 rollback 邊界詳見
[`docs/ControlCenterIntegration.md`](docs/ControlCenterIntegration.md)。

`scripts/start-memory-core-tray.vbs`、`scripts/Restart-Tray.cmd` 與舊 Startup shortcut
暫時保留作 rollback，不再是統一架構的正式常駐入口。需要元件專屬診斷時，可由
Control Center 開啟 `scripts/show-diagnostic-tray.vbs`；diagnostic tray 不會 auto-start、
接管或停止 runtime，關閉它只會關閉該診斷 UI。無托盤背景啟動仍可使用
`scripts/start-memory-core-stack.vbs` 作元件級維護。

`Start`／`Restart` 會要求 backend、MCP 與 tunnel 各自連續通過三次 readiness probe，
避免把冷開機時短暫可連線的程序誤判為穩定。啟動失敗時只會清理通過 ownership check
的 managed process tree，並依 5／15／30 秒間隔做三次 bounded retry；四次仍失敗就停止
重試並保留明確錯誤，不會無限循環或廣泛終止同名程序。

Backend 啟動前另會檢查 Windows IPv4 excluded TCP range、既有 loopback listener 與實際
bind 能力。Excluded、foreign occupied 或無法 bind 屬 non-retryable configuration failure，
會在第一次嘗試後安全停止，不浪費後續 retry；`SelfTest`／`Status` 只回傳 port 狀態與安全
error code，不包含原始系統錯誤、secret 或資料內容。

托盤圖示狀態：

- 藍色資訊圖示：backend、MCP、tunnel 全部 ready。
- 黃色警告圖示：正在執行啟停動作，或只有部分服務 ready。
- 紅色錯誤圖示：整組服務已停止或無法連線。

舊托盤仍使用 `unified-always-on-v2` 契約；diagnostic 模式則把 reload 委派給
`unified-lifecycle-v3` controller，並保留 viewer、backend docs、tunnel UI 與 key/status
等元件特有入口。正式的 ensure、connectivity repair、core restart、full reload、shutdown
與整體狀態都由單一 Control Center 托盤提供。

上述 Copy／Open／viewer／backend docs／runtime key／key status 功能也已透過
`component-menu-v1` 直接出現在 Control Center 子選單。中樞只傳送固定 action ID；viewer、
stack prompt、credential 狀態與 storage path 仍由 `scripts/control-center-ui.ps1` 在元件內處理。

## Tkinter 本機控制中心

Memory Core Control Center 是本機、單一使用者的最高權限管理介面。它仍只透過
loopback FastAPI 操作資料，不會直接開啟 SQLite；所有新增、更新、封存、Candidate
審核、export 與 backup 都會保留 backend validation、optimistic concurrency、Revision
與 Audit。

控制中心使用獨立的 `memory-core-control-center` credential，具備目前明確定義的完整
管理 scopes：

- `records:read`、`records:write`
- `entities:read`、`entities:write`
- `restricted:read`、`restricted:write`
- `candidates:create`、`candidates:review`
- `admin:export`、`admin:backup`

它不使用 wildcard `*`，避免未來新增 purge 或其他高風險能力時自動擴權。這把 token
只以 Windows DPAPI current-user encryption 保存在 ignored `data/secrets/`，不與
MCP、tunnel 或舊版 read-only viewer credential 共用。

日常使用可從 MCP Control Center 選擇 `Open Memory Core viewer`。也可直接雙擊：

```text
scripts\start-memory-core-viewer.vbs
```

控制中心預設使用內容優先的 v2 介面：左側整合「記憶庫／實體／待審核／系統資訊」
與分類，中間顯示標題、摘要及日期，右側先顯示摘要與正文。Record ID、Schema、
結構化資料與原始 JSON 收在「技術資訊」；JSON 匯出與 SQLite 備份收在「系統資訊」；
「刪除（移至封存）」則位於已選取資料的「更多」選單。刪除採 soft archive：一般
清單不再顯示該資料，但 Revision 與 Audit 會保留，不會執行永久 purge。

若新版介面在特定 Windows／Tk 環境無法正常啟動，可在啟動前設定下列 process
environment variable，暫時回到既有版面；這只切換 UI，不會修改 API 或資料：

```powershell
$env:MEMORY_CORE_VIEWER_LAYOUT = "legacy"
.\scripts\start_memory_core_viewer.ps1
```

第一次開啟時，launcher 會建立 control-center credential 並以 Windows DPAPI current-user
encryption 保存於 ignored `data/secrets/`。若要預先建立，可執行：

```powershell
.\scripts\memory_core_stack.ps1 -Action SetupControlCenterCredential
```

控制中心可查看 Overview、Records、Collection 清單、Entities、Candidates、全文搜尋、
Record 的 inbound/outbound Links 與指定歷史 Revision；也可執行：

- 新增、編輯與 soft archive Record／Entity。
- 新增 `media.experience.v1` Batch；可一次貼入 1～50 個 Item，先在待審核區逐筆查看
  normalized input、decision、plan、execution error 與 retry policy，再
  prepare／approve。主閱讀區只顯示批次摘要，完整 JSON 保留在技術資訊。
- Collection 依 domain 分類顯示；清單成員維持一列一筆 Record，可雙擊或按 Enter
  開啟正式記憶，不把 Collection 變成第二份內容來源。
- 未 prepare 的 Batch 可修訂成新 immutable revision；blocked Item 可用明確 target、
  `force_create` 或 `exclude` resolution 處理。prepare 後內容封存，若正式資料在核准前
  發生 version race，該 Item 會獨立失敗，其他 Item 照常提交並讀回驗證。
- 以完整 JSON 文件編輯 backend 允許變更的欄位與 schema-specific payload。
- Candidate detail 檢查、prepare-review、核准寫入或拒絕；核准後逐筆讀回正式結果。
- 明確確認後建立含 manifest/hash 的 JSON export 或 SQLite online backup。

Record 的 `kind`、`domain`、`source_type` 與 Entity 的 `entity_type` 建立後維持身份
穩定，不在 update 文件中開放；需要更換身份時，建立新資料並 soft archive 舊資料。
永久 purge、restore、credential 管理與直接 SQLite 寫入仍不屬於控制中心能力。

Records 左側分類導覽預設依 `domain` 分組，Entities 依
`entity_type` 分組，搜尋結果則依 Record／Entity 類型分組；每種模式都固定保留
「全部」並顯示各分類筆數。列表目前依 API contract 顯示單頁最多 100 筆；
「包含已封存」只影響 Records／Entities 清單與詳細讀取，不改變搜尋結果。
中間清單刻意只保留資料標題；Kind、Domain、Schema、版本、時間與來源等完整欄位統一
在右側詳細內容呈現，避免重複資訊與水平捲動；選取中間項目即載入右側內容。

- Tunnel local admin UI：`http://127.0.0.1:18800/ui`
- Tunnel readiness：`http://127.0.0.1:18800/readyz`
- Private MCP target：`http://127.0.0.1:18818/mcp`

在 ChatGPT developer mode 建立 app 時選擇 **Tunnel** connection，再選取 Platform 已建立且已關聯到目標 workspace 的 tunnel。若 ChatGPT 看不到 tunnel，需在 Platform tunnel settings 檢查 workspace association 與 `Tunnels Read + Use` 權限。

## 基本呼叫

```powershell
$token = Read-Host "Memory Core token"
$headers = @{ 'X-Memory-Core-Token' = $token }

$body = @{
  kind = 'reflection'
  domain = 'general'
  title = '開始使用 Memory Core'
  body_markdown = '第一筆正式記憶。'
  timezone_name = 'Asia/Taipei'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri 'http://127.0.0.1:18765/api/v1/records' `
  -Headers $headers `
  -ContentType 'application/json; charset=utf-8' `
  -Body $body
```

更新和封存都必須提供目前 `version`。過期版本會得到 `409 version_conflict`，避免 MCP、Kuro 與管理介面互相覆蓋。

## Candidate lifecycle

```text
pending -> applied
        -> rejected
        -> conflict
```

Candidate client 只需要 `candidates:create`。套用或拒絕需要另一個具 `candidates:review` scope 的 client。建立 candidate 時必須提供 `idempotency_key`；同一 client 重試相同內容會取得原 candidate，同 key 不同內容則回傳 `409`。

## Export 與 Backup

- `POST /api/v1/admin/export`：需要 `admin:export`，輸出至 `data/exports/`。
- `POST /api/v1/admin/backup`：需要 `admin:backup`，輸出 SQLite backup 與 manifest 至 `data/backups/`。

JSON export 刻意排除 `client_credentials`。SQLite backup 仍包含 credential digest，因此 backup 必須視為敏感私人資料並加密保存。

驗證備份：

```powershell
uv run python .\scripts\memory_core_admin.py verify-backup `
  .\data\backups\memory-core-YYYYMMDDTHHMMSSffffffZ-xxxxxxxx.db
```

目前沒有 restore endpoint，避免遠端或誤操作覆蓋正式資料。未來還原流程必須先還原到新路徑、跑 integrity/migration/data count 驗證，再由使用者明確切換。

## 開發驗證

```powershell
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest
```

Migration round-trip 與 FTS5 由 `tests/test_migrations.py` 驗證；API、scope、candidate、revision、search、export 與 backup 都有 regression test。

## 尚未實作

- Kuro adapter。
- Candidate review 管理 UI。
- Media、project、career domain schemas。
- Cocktail bar inventory、由多次 tasting 自動建議 preference，以及 generic Cocktail
  Record 的人工 migration workflow。
- Public snapshot 與 publication preview。
- 附件 upload/download API 與附件備份一致性。
- 永久 purge workflow。
- 向量搜尋與多裝置同步。
