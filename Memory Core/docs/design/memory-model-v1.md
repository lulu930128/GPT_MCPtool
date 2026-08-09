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

## Temporal Contract

- `occurred_start`／`occurred_end` 非 null 時必須是含 `Z` 或數字 UTC offset 的
  RFC 3339 datetime；schema 邊界會正規化為 UTC。
- `timezone_name` 可省略；提供時必須是 IANA timezone。它保存事件顯示脈絡，不會替
  naive timestamp 補 offset。
- 有 `occurred_start` 時 `date_precision` 不得為 `unknown`；沒有 `occurred_start`
  時必須為 `unknown`，而且 `occurred_end` 不可單獨存在。
- 新 Record 在 schema 邊界驗證完整 temporal state。Record update Candidate 則先以
  exact target/version 合併 patch 與現值，通過完整驗證後才可建立 pending row。
- 儲存層只保存 UTC 與 `timezone_name`；MCP fetch projection 依有效 IANA timezone
  動態產生 `occurred_start_local`／`occurred_end_local`，不新增重複 DB 欄位。
- Temporal input error 使用穩定錯誤碼與欄位資訊，不以 HTTP 500 表示可預期輸入錯誤。

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

## Legacy Completion Catalog

2026-07-29 起，V3 以逐 Item Record 與 Collection membership 作為 canonical truth；
`media_experience_catalog` 降級為 legacy import snapshot：

- 不再直接更新大型 Catalog Record。
- 每款作品建立獨立 Work Entity／Experience Record。
- 「Galgame 完食清單」使用 Collection membership，不複製 Item payload。
- 舊 Catalog 在新 Item／Collection 驗證完成前保留作來源；之後可 archive。
- 統計與搜尋不得同時計入 Catalog snapshot 與 canonical Item。
- 版本名稱有歧義時建立 blocked Batch Item，由使用者明確 resolution，不自行猜測。

完整 Batch／Item／Collection contract 見
[`memory-model-v3.md`](memory-model-v3.md)。

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

## Cocktail Record Schemas

第一版以通用 Record／Revision 儲存，不新增 domain table：

- `cocktail_recipe@1`：`kind=fact`，保存可重複使用的配方。小幅調整沿用同一 Record
  並產生新 revision；真正不同的飲品建立新 Record，以 `parent_recipe_ref` 指向來源
  Recipe。`status=retired` 代表不再採用，不等於 archive。
- `cocktail_tasting@1`：`kind=event`，每次實際調製或飲用建立一筆。必須有帶 offset 的
  `occurred_start` 與 IANA `timezone_name`。引用正式配方時，`recipe_ref` 與
  `recipe_version` 必須成對存在，並在 propose 階段確認該 revision 可解析；即興品飲則
  必須保存 `ingredients_snapshot`。
- `cocktail_preference@1`：`kind=state`，保存使用者明確確認的長期口味偏好。single-user
  v1 只允許一筆 active Preference；一次 Tasting 不會自動改寫 Preference。

三者固定使用 `domain=lifestyle.cocktail`、`schema_version=1`，payload
`extra=forbid`。Direct API、Candidate propose 與 approve defense-in-depth 共用同一組
validator。已註冊 Schema 的 identity 不可透過一般 Record update 加入、移除或改成其他
Schema；generic Cocktail 筆記若要轉換，必須另建可審核的 migration workflow。

Recipe 的 `taste_profile` 是預期風味，Tasting 的 `observed_taste_profile` 是單次實際
感受。`rating`、`verdict` 與 `repeat_intent` 屬於 Tasting；Recipe 僅保留較穩定的
`evaluation`，避免把某次體驗誤寫成配方本體。第一版不把酒櫃庫存納入長期記憶。

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
- `lifestyle.cocktail`

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
- `schema_name` 是 Record-only exact filter；指定時 Entity search 必須停用。
- Search 結果回傳 stable ref、score、matched fields/terms、strategy 與 normalized
  query；查無結果先做 bounded fallback，不直接推論資料不存在。
- Archived 與 superseded item 不出現在一般搜尋；既有 stable ref 仍可透過 `fetch`
  讀回並驗證 `state`、`lifecycle_status` 與 `deleted_at`。
- `cocktail_tasting@1` 的 `fetch` 以 `recipe_ref + recipe_version` 解析 revision，
  回傳 `recipe_title`、`recipe_version_available` 與 resolution status；Recipe 或
  revision 缺失不得讓 Tasting 本身讀取失敗。
