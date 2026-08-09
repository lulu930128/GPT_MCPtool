# Memory Core 資料模型 V2

> V3 已將新產品寫入主路徑改為 Batch／Item／Collection。此文件保留既有
> ChangeSet 相容 contract；新功能請以
> [`memory-model-v3.md`](memory-model-v3.md) 為準。

## 目的

V2 在既有 Candidate 審核邊界內加入 ChangeSet，讓一次明確意圖可以安全地建立或更新多筆 Record，並把 Record 之間的語意關係投影成可查詢的 Record Link。

核心原則：

- MCP 只能提出 Candidate，不能繞過審核直接寫入。
- 一個 ChangeSet 的所有 operation 必須在同一個資料庫 transaction 內全部成功或全部回滾。
- operation 之間只能透過已註冊欄位使用 `op:<op_id>`，不能在任意字串中做替換。
- 每個成功 operation 都必須回傳穩定的 `result_ref`、`result_type`、`result_id` 與 `result_version`。
- Record Link 是目前狀態的 projection；歷史內容仍以 Revision 與 Audit Event 為準。

## ChangeSet aggregate

一個 ChangeSet Candidate 包含：

- `candidate_kind = change_set`
- `summary`
- 依宣告順序保存的 `operations`
- 審核完成後保存的 `results`
- 與單筆 Candidate 相同的 review digest、challenge、有效期限與 idempotency 邊界

V2 支援的 operation：

- `record_create`
- `record_update`

Entity 與 archive operation 暫不納入 V2，避免一次擴大 identity、刪除與跨類型交易風險。

## Local reference

新建立 Record 尚未有 UUID，因此同一 ChangeSet 內可用：

```text
op:<op_id>
```

Local reference 只允許出現在 record schema registry 宣告的 reference field。例如 cocktail tasting 的 `payload.recipe_ref` 可以指向同一 ChangeSet 的 recipe create operation。

驗證階段會拒絕：

- 不存在的 `op_id`
- 重複 `op_id`
- 非註冊欄位中的 local reference
- 來源與目標 schema 不相容
- 依賴循環
- 同一 ChangeSet 重複更新相同 Record

執行時採拓樸順序處理依賴，但 results 仍依使用者宣告順序回傳。

## 原子套用與失敗語意

ChangeSet apply 使用資料庫 savepoint：

- 全部成功：Candidate 成為 `applied`，保存每筆 Candidate Result。
- optimistic concurrency 衝突：所有資料變更回滾，Candidate 成為 `conflict`。
- 其他驗證或目標狀態錯誤：所有資料變更回滾，Candidate 保持 `pending`，讓使用者重新檢視，而不留下半套資料。

不論哪個 operation 失敗，都不會產生部分 Record、Revision、Link 或 Result。

## Candidate Result

每個成功 operation 保存：

- `op_id`
- `change_type`
- `result_type`
- `result_id`
- `result_version`
- 推導出的 `result_ref`

MCP approve 回應必須帶回完整 results；呼叫端應逐筆 `fetch(result_ref)` 驗證，而不是只檢查 Candidate 狀態。

## Record Link current projection

Record schema registry 可為特定 payload path 宣告關係：

- `relation`
- 允許的目標 schema 與版本
- 是否為 collection
- 是否搭配 revision pin

目前 cocktail 關係：

- recipe `parent_recipe_ref` → `derived_from`
- tasting `recipe_ref + recipe_version` → `uses_recipe`
- preference `confirmed_favorite_recipe_refs[]` → `favorite_recipe`

Record Link 保存：

- subject Record
- relation
- object Record
- 可選的 `target_revision_no`
- `created_at`、`updated_at`
- `removed_at`

當來源 Record 更新時，projection 會同步更新；不再存在的 link 採 soft remove。`uses_recipe` 會固定到 tasting 當下使用的 recipe revision，`favorite_recipe` 則只表達 Record identity。

## Compatibility

- 原有單筆 Candidate、API 與 MCP proposal tools 保留。
- 原有 approve scalar result 欄位保留；V2 另外提供 `results[]`。
- migration 將舊 Candidate 標記為 `single`。
- migration 會依 cocktail 現有 payload 回填有效的 Record Link；格式不合法或目標不存在的歷史值會略過，不阻擋整體升級。

## V2.1 安全歷史讀取與 typed façade

Backend 的 Record Revision route 是正式歷史 snapshot 讀取邊界。MCP 以獨立
`memory_fetch_record_revision(record_ref, revision_no)` 暴露它，不改寫同時支援
Record／Entity 的標準 `fetch(id)` contract。

Revision 授權必須同時檢查：

- current Record 的 sensitivity 與 handling policy
- requested revision snapshot 自身的 sensitivity 與 handling policy

因此 Record 從 restricted 降為 personal 後，低權限 client 仍不能讀取歷史 restricted
snapshot。MCP 輸出沿用 bounded external projection、source reference 與 machine-local
path 遮蔽。

通用 `memory_propose_change_set` 保留給 generic 與未來 schema。Cocktail 另外提供
`memory_propose_cocktail_change_set` typed façade：

- operation 以 action 搭配 `recipe_payload`、`tasting_payload` 或
  `preference_payload`
- create/update target shape 由工具 validator 約束
- Tasting occurrence 欄位只允許出現在 tasting action
- payload schema 顯示具體欄位，不使用大型 `oneOf`，也沒有 unknown `content`
- façade 只轉換輸入，仍呼叫相同 ChangeSet API、digest、review、transaction 與 results

Typed façade 中的 `op:<op_id>` 仍只在 registry reference field 受控放行；它不是一般
Cocktail stable reference，也不會擴大任意字串替換。

## V2 明確不做

- MCP direct write
- 任意字串中的 reference substitution
- 自動把 tasting 或一般事實推論成 preference
- Record identity 模型全面改寫
- Entity ChangeSet、archive ChangeSet
- provenance 模型的完整 migration
- 本機審核 UI 與後續品質評分

這些項目應在 V2 實際使用資料累積後，以獨立 migration 與 contract 變更處理。
