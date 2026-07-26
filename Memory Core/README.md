# Memory Core

Memory Core 是 local-first、single-user、可審計的個人資料後端。它是網站、Kuro、MCP 與桌面工具共同使用的 system of record；所有 client 都只能透過 API 存取資料。

目前版本為 `0.1.0`，已完成通用後端核心與第一版 tool-only MCP adapter；尚不包含 Kuro adapter、管理 UI 或 domain-specific 模組。

## 已具備的能力

- FastAPI `/api/v1` contract，以及公開的 `/health`、`/version`。
- SQLite WAL、foreign keys、busy timeout 與 Alembic migration。
- Scoped client token；資料庫只保存 SHA-256 digest。
- Records、entities、tags、record/entity/tag links 與 entity relations。
- `restricted` 資料的獨立 read/write scope。
- Optimistic concurrency、soft archive、revision 與 audit event。
- Candidate create/prepare-review/apply/reject、不可變 review digest、短效 challenge、
  7 天期限、獨立審核 idempotency 與 result id/version。
- Record 的 `occurred_start`／`occurred_end` 與 Entity Relation 的
  `valid_from`／`valid_to` 必須使用含 `Z` 或明確 UTC offset 的 ISO 8601 datetime；
  API 會正規化為 UTC。`timezone_name` 只保存原始時區語意，不會替 naive datetime
  自動補上 offset。
- FTS5 trigram 搜尋；多詞查詢會跨 title／summary／body／payload 或 entity 欄位計算
  coverage 與權重，先正規化自然語句與標點，優先 exact/title matches；嚴格 coverage
  查無結果時才做 bounded token fallback。
- Search 可用 result type、domain、kind/entity type、sensitivity 與 timezone-aware
  updated-at 範圍篩選，並回傳 score、matched fields/terms、normalized query 與實際
  strategy。
- `memory_overview` 可查看目前 scope 可見的 Record／Entity、domain taxonomy、
  schema version、FTS parity 與 Candidate status counts，不回傳記憶內容。
- `memory_detect_duplicates` 以 bounded read-only scan 回報可能重複的 refs、理由與
  confidence，不會自動合併或封存。
- 不含 credential 的 JSON export。
- SQLite online backup、sidecar manifest 與 integrity verification。
- Tool-only MCP adapter：標準 `search`／`fetch`、六個單一動作的 candidate proposal
  tools，以及啟用獨立 reviewer credential 後才出現的遠端審核工具。
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

詳細施工範圍與決策在 [`docs/agent-runs/memory-core-v1/`](docs/agent-runs/memory-core-v1/)、[`docs/agent-runs/memory-core-mcp/`](docs/agent-runs/memory-core-mcp/)、[`docs/agent-runs/memory-core-tunnel/`](docs/agent-runs/memory-core-tunnel/)、[`docs/agent-runs/memory-core-tray/`](docs/agent-runs/memory-core-tray/)、[`docs/agent-runs/memory-core-external-contract-v2/`](docs/agent-runs/memory-core-external-contract-v2/) 與 [`docs/agent-runs/memory-core-production-hardening-v1/`](docs/agent-runs/memory-core-production-hardening-v1/)；Record／Entity 與資料治理 contract 在 [`docs/design/memory-model-v1.md`](docs/design/memory-model-v1.md)。

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
uv run uvicorn memory_core.main:app --host 127.0.0.1 --port 8765
```

- OpenAPI：`http://127.0.0.1:8765/docs`
- Health：`http://127.0.0.1:8765/health`
- API：`http://127.0.0.1:8765/api/v1`

除非已建立完整反向代理、TLS 與獨立驗證，請勿改成 `0.0.0.0` 或直接暴露至網際網路。

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

- MCP endpoint：`http://127.0.0.1:8818/mcp`
- MCP health：`http://127.0.0.1:8818/health`
- Transport：stateless Streamable HTTP，JSON response
- Listener 與 backend URL 都強制限制為 loopback；不能用設定誤綁到 `0.0.0.0` 或外部 API。

MCP tools：

- `search(query, limit=20, ...)`：搜尋可見的 records/entities；自然語句會先做
  Unicode／標點／常見意圖詞正規化，多詞查詢先要求至少 60% token coverage（且至少
  兩詞），查無結果才做 bounded fallback。可選擇 result type、domain、kind、
  sensitivity 與 updated-at filters；結果包含可交給 `fetch` 的 stable id 與 bounded
  diagnostics。
- `fetch(id)`：以 `record:<id>` 或 `entity:<id>` 讀取單一項目，預設最多 30,000
  字元並明確標註是否截斷；輸出 projection 會遮蔽 machine-local path，且不改寫 DB。
  已封存項目的既有 stable ref 仍可讀回，metadata 會明確標示 `state=archived`。
- `memory_overview()`：回傳目前 credential scope 可見的 active/superseded/archived
  counts、domain/taxonomy、schema version、Record FTS parity；MCP 有 reviewer
  credential 時再合併 Candidate status counts。
- `memory_detect_duplicates(limit=50)`：回傳 entity identity、record canonical ref、
  normalized title，或 Experience `work_title` 與 Catalog `categories` 項目的重疊
  finding；只提供 refs 與診斷，不讀出內容、不自動修改。
- 下列六個 proposal tools 都只建立 `pending` candidate，不會直接寫正式資料：
  - `memory_propose_record_create(content, idempotency_key, ...)`
  - `memory_propose_record_update(target_ref, base_version, content, idempotency_key, ...)`
  - `memory_propose_record_archive(target_ref, base_version, idempotency_key, ...)`
  - `memory_propose_entity_create(content, idempotency_key, ...)`
  - `memory_propose_entity_update(target_ref, base_version, content, idempotency_key, ...)`
  - `memory_propose_entity_archive(target_ref, base_version, idempotency_key, ...)`
- Update/archive 的 `target_ref` 必須使用 `record:<id>` 或 `entity:<id>`，並搭配
  `fetch` 回傳的 exact `version`。每個工具各有 operation-specific schema，不使用
  ChatGPT 容易展開成 `any` 的六合一 outward union。
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
  - `memory_prepare_candidate_review(candidate_id, expected_review_digest)`：產生 10 分鐘
    短效、綁定 reviewer 的 challenge；這一步不是核准。
  - `memory_approve_candidate(...)`：只套用已顯示且 digest 相符的原 candidate，不接受
    replacement content；成功時回傳可直接交給 `fetch` 的 `result_ref`，同時保留
    `result_id`、`result_type` 與 `result_version`。
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
  -> fetch(result_ref)
  -> verify result_id + result_type + result_version
```

建立、查看、摘要、編輯或 prepare candidate 都不是核准。若內容要改，必須建立新的
candidate 與新 digest；candidate 預設 7 天到期。approval/rejection retry 必須沿用同一
個 review `idempotency_key`，相同 key 不可改 action、candidate 或 review note。

Codex 或其他可連本機 HTTP MCP 的 host，設定 URL 為：

```text
http://127.0.0.1:8818/mcp
```

ChatGPT 網頁無法直接連 localhost；需要 HTTPS deployment 或獨立的 Secure MCP Tunnel。Tunnel credential 不屬於本 repo，也不能寫入 `.env`、README 或 YAML 明文。請先輪替任何曾貼在聊天中的 credential，再另行設定 tunnel。

## Secure MCP Tunnel（本機私人連線）

本專案提供 Windows lifecycle script，將 backend、MCP 與 OpenAI Secure MCP Tunnel 維持在同一個 local trust boundary。三者都只監聽 `127.0.0.1`；tunnel client 主動建立 outbound HTTPS 連線，不需要開 inbound firewall port。

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

`Setup` 會建立兩個彼此獨立的 client：

- `memory-mcp-tunnel`：`records:read`、`entities:read`、`candidates:create`。
- `memory-mcp-review`：只有 `candidates:review`。

兩把一次性 token 與 tunnel runtime key 都以 Windows DPAPI current-user encryption
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

設定完成後，建議雙擊 `scripts\start-memory-core-tray.vbs`。它會在 Windows 系統托盤常駐，並在需要時隱藏啟動整組服務；若只需要無托盤的背景啟動，仍可使用 `scripts\start-memory-core-stack.vbs`。兩個 script 本身都不會建立 Windows login 自動啟動或排程；目前這台機器另在使用者 Startup 資料夾設定了 `Memory Core MCP.lnk`，由正式根目錄自動啟動 tray。

托盤圖示狀態：

- 藍色資訊圖示：backend、MCP、tunnel 全部 ready。
- 黃色警告圖示：正在執行啟停動作，或只有部分服務 ready。
- 紅色錯誤圖示：整組服務已停止或無法連線。

右鍵選單可啟動、停止、重新啟動整組服務，開啟 backend docs／tunnel UI、複製本機 MCP URL、查看 DPAPI key 狀態，或叫出遮罩輸入的 runtime key 更換視窗。`Exit tray (keep services running)` 只關閉圖示；只有 `Stop all and exit` 會一併停止服務。重開托盤只會取代舊圖示，不會重啟健康中的服務。

- Tunnel local admin UI：`http://127.0.0.1:8800/ui`
- Tunnel readiness：`http://127.0.0.1:8800/readyz`
- Private MCP target：`http://127.0.0.1:8818/mcp`

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
  -Uri 'http://127.0.0.1:8765/api/v1/records' `
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
- Media、tasting、project、career domain schemas。
- Public snapshot 與 publication preview。
- 附件 upload/download API 與附件備份一致性。
- 永久 purge workflow。
- 向量搜尋與多裝置同步。
