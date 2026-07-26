# Memory Core Data Model V1

本文件定義 Memory Core 第一版可執行的 Record／Entity／relation／taxonomy 規則。
它是技術 contract，不取代使用者對最終產品方向的確認。

## 核心原則

- Entity 表示穩定、可被多筆記憶引用的對象。
- Record 表示使用者與時間有關的經歷、狀態、判斷、事件或來源快照。
- 同一件事不能同時由 Catalog 與 Experience Record 各自成為可更新的真實來源。
- Alias 用於 identity resolution，不代表多個 Entity。
- Edition、續作、重製版是獨立 Work Entity，透過 relation 表達關係。
- 所有 AI 產生的 Entity、Record、link、relation、merge 或 archive 都必須經 Candidate
  review；MCP 不直接操作 relation table。

## Work Entity

建議欄位：

```json
{
  "entity_type": "work",
  "name": "サクラノ詩 -櫻の森の上を舞う-",
  "canonical_name": "サクラノ詩 -櫻の森の上を舞う-",
  "payload": {
    "aliases": [
      "櫻之詩",
      "桜の詩",
      "Sakura no Uta"
    ],
    "media_type": "galgame",
    "identity_version": 1
  }
}
```

規則：

- `name` 是目前顯示名稱；`canonical_name` 是 identity comparison 使用的正式名稱。
- `payload.aliases` 必須去除空值、正規化 Unicode、同一 Entity 內不重複。
- Alias 命中應回傳 canonical Entity，不建立別名 Entity。
- 不把遊玩狀態、完成日期或個人評價放在 Work Entity。

## Experience Record

建議欄位：

```json
{
  "kind": "state",
  "domain": "media.galgame",
  "schema_name": "media_experience",
  "schema_version": 1,
  "title": "完成《サクラノ詩》",
  "payload": {
    "canonical_entity_ref": "entity:<uuid>",
    "progress": "completed",
    "completed_at": null,
    "evaluation": {
      "writing": "excellent",
      "interpretation_difficulty": "high"
    }
  }
}
```

規則：

- `canonical_entity_ref` 必須指向一個未封存的 Work Entity。
- 一個 Work Entity 可有多筆 Experience Record，但同一 schema 的目前狀態只能有
  一筆 active canonical Record；歷史版本以 revision／supersedes 表達。
- 評價與完成狀態屬於 Record，不放在 Entity。
- Record–Entity link 是正式 relational truth；payload ref 是 bounded outward
  projection／migration aid，不能永久取代 relation table。

## Canonical Completion Catalog

2026-07-26 使用者確認：

- `media_experience_catalog` 是「已完成哪些 Galgame」與原始使用者分類的長期
  system of record，不是一次性 import snapshot。
- Catalog 維持 active，後續新增、移除或分類調整直接以 Record update Candidate
  維護；不得從單篇心得自動反推清單成員。
- Work Entity 與個別 Experience／Reflection Record 可保存作品 identity、版本關係、
  日期與詳細評價，但不能在統計時與 Catalog 重複計算完成作品。
- Catalog 使用 `catalog_role=canonical_long_term_memory`、
  `snapshot_only=false` 與 `maintenance_mode=direct_catalog_updates` 明示權責。
- 原始絕對路徑不延續到 v2 payload；只保留不含機器資訊的 logical provenance。
- 舊 `evaluations_included` 改為可辨識語意：

```json
{
  "freeform_reviews_included": false,
  "folder_categories_preserved": true,
  "categories_are_user_defined": true
}
```

Catalog 內仍有版本合併名稱時，先忠實保存來源文字，不可自行推論使用者完成了哪個
edition；需要版本級查詢時，再由使用者確認後建立獨立 Work Entity／relation。

## Edition Relation

`Summer Pockets` 與 `Summer Pockets REFLECTION BLUE` 是兩個 Work Entity：

```json
{
  "predicate": "expanded_edition_of",
  "subject_entity_id": "<REFLECTION BLUE entity id>",
  "object_entity_id": "<base edition entity id>"
}
```

Experience Record 必須指向實際玩過的 edition；不以斜線合併名稱代替 relation。

## Domain Taxonomy

第一版 canonical registry：

- `general`
- `media`
- `media.galgame`
- `media.anime`
- `media.manga`
- `project.personal`
- `project.work`
- `career`
- `education`
- `language.japanese`
- `finance.investment`
- `health`
- `preference`

現有 `entertainment`、`study`、`work` 視為 legacy/custom，需要逐筆 Candidate
正規化；在來源語意未確認前不得自動猜映射。

第一階段只在 overview 回報 taxonomy status，不立即拒絕 custom domain。待現有資料
完成 migration 後，再決定是否將未知 domain 升級為 validation error。

## Duplicate / Supersede / Merge

- Record 新版本使用既有 `supersedes_id`；舊 Record 改為 `superseded` 或 archive。
- Record 間的 `duplicate_of`／`merged_into` 使用 `record_links`。
- Entity edition／same-as／merge 關係使用 `entity_relations`。
- Merge 不做 hard delete；canonical target 保留，來源 Entity archive，relation、
  audit 與 revision 保留。
- Duplicate detector 只能建立 read-only finding 或 merge Candidate，不能自動套用。

## Candidate Relation / Merge Contract

第一版維持六個 operation-specific proposal tools，不另外增加難以選擇的 link／relation
工具：

- Record create／update 的 `content.entity_links` 可在同一 Candidate transaction 建立
  Record–Entity links。
- Entity create／update 的 `content.relations` 可在同一 Candidate transaction 建立
  edition 或其他 Entity relations。
- Record／Entity archive 的 `merged_into_ref` 可選填；核准後先建立固定語意的
  `merged_into` link／relation，再在同一 transaction soft-archive 來源。
- Relation-only update 仍檢查 `base_version`，但不虛增 Record／Entity version。
- Merge target 必須是同類型、未封存且不是來源自身；失敗時不得留下部分 link 或
  archive。

`memory_detect_duplicates` 會比對 Entity identity、Record canonical ref／title，並
偵測 Experience `work_title` 出現在 Catalog `categories` 的跨 schema 重疊；它只回報
refs、理由與 confidence，不會自動產生或核准 Candidate。所有 relation／merge 內容
都納入 immutable review digest。

## Search Projection

- Entity search 必須涵蓋 `name`、`canonical_name`、`payload.aliases`。
- Record search 必須涵蓋 title、summary、body、payload 中的 canonical reference。
- Search 結果回傳 stable ref、score、matched fields/terms、strategy 與 normalized
  query；查無結果先做 bounded fallback，不直接推論資料不存在。
- Archived 與 superseded item 不出現在一般搜尋；既有 stable ref 仍可透過 `fetch`
  讀回並驗證 `state`、`lifecycle_status` 與 `deleted_at`。
