# Memory Core 資料模型 V3：Batch／Item／Collection

## 目的

V3 將「一次傳送與審核多筆資料」和「正式記憶逐筆保存」分開：

- Batch 是輸入、正規化、審核與執行追蹤邊界。
- Item 是最小可獨立維護的 canonical unit。
- Collection 是 Record membership，不複製 Record 內容。
- Operation 是一個 Item 內實作 Record／Entity／Link 變更的底層步驟。

單筆寫入是包含一個 Item 的 Batch。所有新產品流程、API 與 MCP typed facade 都應
產生 Batch；舊 single／change_set 只保留相容性，不形成第二套業務規則。

## Trust boundary

```text
Local Control Center / MCP / Importer / Kuro
                    |
                    v
              Memory Core API
                    |
           normalization + review
                    |
         item-atomic application service
                    |
        SQLite + FTS + Revision + Audit
```

- Client 不直接操作 SQLite。
- 一般 MCP client 只能讀取與建立 proposal。
- `candidates:review` 使用獨立 credential。
- Profile／Normalizer 只能產生 Operation Plan，不能正式寫入。
- Formal apply 必須綁定 exact sealed revision、review digest 與短效 challenge。

## 三種核心概念

### Batch

一次提交的一整包資料。Batch 本身不是長期記憶，只保存：

- profile identity/version/hash
- source metadata
- idempotency
- draft/sealed revision
- review state
- execution state
- bounded summary/counts

### Item

可獨立查詢、編輯、版本化、封存與重試的 canonical unit。一個 Item 可以產生多個
operations，但必須在一個 top-level transaction 內全部成功或全部 rollback。

例如一款 Galgame experience Item 可以產生：

1. Work Entity create/update
2. Experience Record create/update
3. Record–Entity Link upsert
4. Collection membership upsert

不同 Item 不允許 local reference；需要一起成功的內容必須屬於同一 Item。

### Collection

持久的使用者群組，例如「Galgame 完食清單」。Collection 只保存 metadata 與
Record membership：

- 不保存整份 Item payload。
- 不與 Record 同時成為內容真實來源。
- 刪除 membership 不刪除 Record。
- archive Collection 不自動 archive 成員。

domain、schema、tag 與 Collection 是不同的分類維度：

- domain：`media.galgame`
- schema：`media_experience@1`
- Collection：`Galgame 完食清單`
- payload state：`progress=completed`

## Persistence contract

### `candidate_batches`

- `id`
- `candidate_id` unique FK
- `profile_id`
- `profile_version`
- `profile_hash`
- `normalizer_version`
- `input_hash`
- `current_revision_no`
- `plan_state`: `draft | blocked | ready | sealed`
- `review_state`: `pending | prepared | approved | rejected | expired`
- `execution_state`: `not_started | applying | applied | partially_applied | failed`
- `item_count`
- `created_at`
- `updated_at`
- `started_at`
- `completed_at`

Batch summary counts 是可重建 projection；`candidate_items` 才是唯一狀態來源。

### `candidate_batch_revisions`

- `id`
- `batch_id`
- `revision_no`
- canonical input snapshot/hash
- canonical plan snapshot/hash
- review digest
- `sealed_at`
- `created_at`

同一 revision immutable。Draft 修正後產生下一 revision；舊 challenge 失效。

### `candidate_items`

- `id`
- `batch_id`
- `batch_revision_id`
- `unit_key`
- `position`
- `source_index`
- `input_snapshot`
- `normalized_snapshot`
- `input_hash`
- `plan_hash`
- `decision`: `create | update | noop | conflict | invalid | excluded`
- `execution_state`: `not_started | claimed | applied | failed | unverified | skipped`
- `warnings`
- `error_code` / `error_message`：不可變的 planning diagnostics，參與 sealed plan
- `execution_error_code` / `execution_error_message`：apply／verify 的安全化診斷
- `retry_policy`: `not_applicable | retry_same_plan | verify_only | new_batch_required`
- `claim_token`
- `claim_expires_at`
- `attempt_count`
- `applied_at`
- `verified_at`

約束：

- `UNIQUE(batch_revision_id, unit_key)`
- `UNIQUE(batch_revision_id, position)`
- error 不保存 token、secret、完整 local path 或未過濾 exception repr。

### `batch_item_operations`

V3 Batch operation 必須綁 `candidate_item_id`，並使用：

- `UNIQUE(candidate_item_id, op_id)`
- `UNIQUE(candidate_item_id, position)`
- `change_type` 只允許目前 executor 真正支援的
  `record_create | record_update | entity_create | entity_update |
  record_entity_link_upsert | collection_member_upsert`

Legacy single／change_set 使用原本獨立的 `candidate_operations`，不與 Batch plan 混用。

### `batch_item_results`

- `candidate_item_id`
- `operation_id`
- `operation_outcome`: `created | updated | archived | noop`
- `result_kind`: `record | entity | record_entity_link | record_link |
  entity_relation | collection_member`
- `result_ref` nullable
- `result_locator` bounded JSON
- `result_version` nullable
- `verify_status`: `pending | verified | failed | not_applicable`
- `verify_error_code`
- `verified_at`

### `batch_apply_attempts`

- `id`
- `batch_id`
- `batch_revision_id`
- reviewer client
- approval idempotency key/hash
- `status`: `running | completed | interrupted | failed`
- lease token／expiry
- started/completed timestamps
- bounded summary/error

SQLite apply 使用 atomic compare-and-set claim，不依賴 `SELECT FOR UPDATE`。

### `collections` / `collection_members`

Collection：

- stable key、name、description、domain、lifecycle/version、audit metadata

Membership：

- `collection_id`
- `record_id`
- `position` nullable
- source candidate/item
- timestamps
- `UNIQUE(collection_id, record_id)`

## Normalization Profile

Profile 是 versioned、hash-pinned 的 source artifact。它負責：

- input schema
- item split
- bounded field mapping
- registered transforms/handler
- identity resolver
- output operation planning
- default Collection membership
- limits

Profile 不取代 Record Schema：

- Profile 驗證「輸入如何成為 Item」。
- Record Schema 驗證「正式 Record payload 是否合法」。

JSON 只能引用 registry key；不得包含 Python、eval、SQL、shell、網路、任意 import 或
完整 JSONPath。Apply 使用已保存的 exact plan，不重新執行可能已改版的 Profile。

## Draft、review 與 resolution

1. Client 建立 Batch draft。
2. Normalizer 產生 Item decisions。
3. `conflict`／`invalid` 讓 Batch `blocked`。
4. Reviewer 可以在 draft 中明確：
   - 選定 existing target/ref + base version
   - 選擇 create new
   - 修正 bounded input
   - exclude Item
5. 每次修正產生新的 Batch revision。
6. Prepare review 封存 exact revision、計算 digest 與 challenge。
7. Sealed revision 不可修改；任何變更建立新 revision並使舊 challenge 失效。
8. Approval 只能套用 exact candidate/batch revision/digest。

Digest 至少涵蓋：

- candidate/batch identity
- profile id/version/hash
- normalizer version
- source metadata
- Item order、input hash、plan hash、decision
- operation order、exact target/base version
- Collection membership
- risk flags

## Item-atomic apply

1. 短 transaction 驗證 approval，建立/取得 idempotent apply attempt，標記 Batch applying。
2. 每個 Item 以 atomic compare-and-set claim。
3. 為該 Item 開新 session + top-level transaction。
4. 驗證 sealed plan/hash、target/base version、scope 與 identity precondition。
5. 執行同 Item operations；任一步失敗則整個 Item rollback。
6. Commit 後用新 read-only session fetch/verify結果。
7. 驗證成功 → `applied`；讀回失敗 → `unverified`，不假裝已 rollback。
8. 失敗 Item 以獨立短 transaction 保存穩定 error code，繼續下一 Item。
9. 由 Item rows 重新統計 Batch execution state。

重送相同 approval：

- 沿用相同 apply attempt。
- 已 applied/verified Item 不重跑。
- `unverified` Item 只重做讀回驗證，不重跑已 commit 的 operation。
- 過期 claim 可以 resume。
- 只有明確標成 `retry_same_plan` 的 failed Item 可用同一 sealed plan 重試。
- `new_batch_required` Item 不重跑；必須依目前正式資料重建新 Batch。

## API contract

主要 API：

- `POST /api/v1/candidates/batches/media-experiences`
- `GET /api/v1/candidates/{candidate_id}/batch`
- `GET /api/v1/candidates/{candidate_id}/items?limit=&offset=&execution_state=&decision=`
- `GET /api/v1/candidates/{candidate_id}/items/{item_id}`
- `PATCH /api/v1/candidates/{candidate_id}/batch`
- `POST /api/v1/candidates/{candidate_id}/prepare-review`
- `POST /api/v1/candidates/{candidate_id}/apply`
- `POST /api/v1/candidates/{candidate_id}/reject`
- `GET /api/v1/collections`
- `GET /api/v1/collections/{collection_key}?limit=&offset=`

Batch Item endpoint 使用 bounded `limit/offset` 與 `truncated`，Collection endpoint 回傳
bounded member records；MCP 對外只提供 stable ref，完整內容仍使用 `fetch`。

## MCP contract

內部 Batch API 可以通用；主要 ChatGPT write surface 必須 typed：

- `memory_propose_media_experience_batch`
- 後續 profile-specific typed batch facade

不得把 `items: list[dict]`、unknown `content` 或大型 `oneOf` 當成主要 outward schema。

讀取：

- `search`
- `fetch`
- `memory_list_collections`
- `memory_get_collection`
- `memory_get_batch_candidate(candidate_id, limit, offset)`

`memory_get_batch_candidate` 回傳單一 bounded page；只要 `offset != 0` 或
`truncated=true`，就會明確禁止遠端核准，必須先讀取完整 sealed revision。

## Compatibility 與資料切換

- Legacy single/change_set API 與 tools 至少保留一個版本，但應轉為 Batch facade 或標記
  deprecated，不再擴充第二套 domain logic。
- 現有正式 DB 不做自動推測式內容 migration。
- 先在隔離 DB 建立/驗證 V3，再用 Batch 重建少量已知資料。
- 切換 runtime 前驗證 counts、search、Collection、fetch、Revision/Audit、backup。
- 舊 DB 在使用者明確確認後才 archive/delete。

## 第一個 vertical slice

`media_experience@1`：

- 一次 1～50 個 Item。
- domain 由 media type 固定為 `media.galgame`／`media.anime` 等。
- 每個 Item 可建立/更新 Work Entity、Experience Record、Record–Entity Link。
- completed Item 可加入指定 Collection。
- identity ambiguous 時 blocked，不自行挑最高分。
- Viewer 與 MCP 都能列整群 summary，單筆 fetch 完整 Record。
