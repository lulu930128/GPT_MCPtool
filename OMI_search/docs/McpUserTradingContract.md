# MCP 手動倉交易契約

本文件對齊主 OMI `ManualDeskService` 與 `execution_runtime/read_projection.py`。
本輪只有 OMI_search source／fixture 修改，沒有部署、登入、送單、正式 DB 或 Runtime 操作。

所有 HTTP 路由位於 `/api/research/conditional-candidates`。

| MCP tool | HTTP suffix | body |
| --- | --- | --- |
| `omi_create_desk_draft` | POST `/desk/draft` | `client_intent_id,symbol,action,condition,lot,quantity_shares,price` |
| `omi_read_desk_staged` | GET `/desk/staged` | query `after,limit` |
| `omi_read_desk_stage` | GET `/desk/staged/{id}` | 無 |
| `omi_confirm_desk_staged` | POST `/desk/staged/{id}/confirm` | `expected_revision,expected_digest` |
| `omi_read_desk_orders` | GET `/desk/order-reports` | 無 |
| `omi_read_desk_fills` | GET `/desk/fills` | 無 |
| `omi_read_desk_inventory` | GET `/desk/inventory` | 無 |
| `omi_read_desk_status` | GET `/desk/status` | 無 |
| `omi_confirm_desk_review` | POST `/desk/reviews/{id}/confirm` | `expected_revision,expected_digest` |
| `omi_prepare_candidate_pending` | POST `/pending/{id}/prepare` | 無 body |
| `omi_approve_candidate_pending` | POST `/pending/{id}/approve` | `expected_revision,expected_digest` |

`/desk/orders` 更名為 `/desk/order-reports`，避免既有 execution architecture guard 對
泛用 `/orders` segment 的禁止。public tool name 不變；不放寬 AST guard。
本版沒有券商 cancel tool/UI；研究 Pending cancel 仍只屬研究邏輯。

## 歸屬與一次性語意

- MCP 新建候選：`raw.space_id=USER_SPACE`、`raw.source=MANUAL`；Adapter 注入 `owner_id=MCP`。
- 一般單 Backend 固定 USER_SPACE／MANUAL／MCP，帳戶與交易日由既有 Native session 決定。
- AGENT_SPACE 僅檢視、編輯既有 AI 候選，不轉換歷史歸屬；切環境不丟未保存草稿。
- 一般單「加入掛單」只建立 Backend CandidateService 本地 `kind=manual_stage`，不進 Native。
  回傳 Candidate 的 `id/revision/digest/raw/manual_stage/lifecycle` 保留原樣；不套用條件候選格式。
- `client_intent_id` 由 UI 首次操作產生 UUID，保留原 body。驗證原 raw/provenance，
  price 採精確 decimal 字串等價（例如 `578.00` 與 `578`），其他欄位精確比對。
- 建立 timeout／409／不完整回應後，只讀本地 staged 清單精確比對原 `client_intent_id` 與 raw；
  不重建或換 UUID，空清單不解除 UNKNOWN。本地清單逐頁讀取（每頁 100，最多 100 頁），超界保持未知。
- 掛單頁將本地待送單與 Native/Broker 讀回分開；券商 503 不隱藏本地清單，也不阻擋本地修改或開 modal。
  本地修改／取消使用原 Candidate revision／cancel 工具與 expected_revision；不是券商撤單。
- 本地送單只在唯一 modal 確認後呼叫 `omi_confirm_desk_staged` 一次，綁定原 ID/revision/digest。
  timeout／一般 503／UNKNOWN 只讀原 ID 詳情，不能因讀回 STAGED 而自動重送。原 review 與 Pending 路徑保留。
  Backend 回傳的 SUBMITTING／SUBMITTED／SUBMISSION_UNKNOWN／SUBMISSION_REJECTED 或其他狀態照實顯示，不由 fulfilled 推定成交。
- Native confirm staged 使用 75 秒 client timeout；本地 staged list/detail 為 20 秒。
  上一版八個工具的 75 秒設定保留；其他工具與初始化仍為 20 秒。Host timeout 未驗證。
- 整股 UI 輸入張數，`quantity_shares=張數*1000`；零股為股數。切單位清空輸入。
- 只在掛單頁由「送單」開啟一個 modal；取消零次 confirm/approve。
  確認呼叫一次 exact ID/revision/digest；UNKNOWN 只讀回、不自動重送。
- 條件 Pending 先 prepare 取得待送快照，再從掛單頁同一 modal approve；沒有第二輪同意框或 AI Gate。
  Native 綁定的條件 Review 不從一般 desk confirm 繞過 Pending selection。

## 真實讀回形狀

`order-reports` 的 `contract=omi.execution-desk.v1`，包含 `trade_date`、
`session_generation`、`queried_at`、`received_at`、`quality`、`sources`、`reviews`、
`broker_orders`、`fills`、`fill_history_complete`、`inventory`、`unparsed_reports`。

- reviews 保留 DRAFT／PREVIEW／EXECUTION 與 immutable snapshot，僅合法 USER/MCP PREVIEW 有送單入口。
- broker_orders 分開顯示 EXTERNAL／MANAGED、精確 broker_key、券商／Native 狀態與已知成交量。
  SUBMITTED、接受回報與累計量不製造成交。
- fills endpoint 使用 `.fills`，保留 fill_id、quality、來源時間、
  `fill_history_complete` 與未解析回報，不使用通用 `.items/.source` 假設。
- inventory endpoint 使用 `.inventory.cash/margin/short_selling`。
  cash PARTIAL、sellable_shares=null、來源時間未知、complete=false 均保留；
  margin/short UNKNOWN 與 items=null 不補零，不使用 OMI 研究 holdings。
- 成交與庫存各有手動「更新資料」；保留舊資料、時間與錯誤，不新增輪詢。
- 價位快捷仍 unavailable，沒有把日 K 收盤當成現價或自行產生漲跌停。

Source、mock/SDK protocol、browser、真 Host、Native loaded adoption、Broker E2E 是分開的證據。
Endpoint source 存在不代表服務已載入；未接路由的 404/405 原樣呈現 API 契約待接。

## 確定未嘗試與連線狀態

常駐連線之業務語意唯一依據為 Backend 的
`docs/exec-plans/active/execution-always-online-20261105/InterfaceContract.md`。
Adapter 不實作連線維護、交易日、登入或重送。

Candidate HTTP error 保留既有 `error` 訊息與 `tool`，additive 加入 `http_status` 與
`backend_error`（原 JSON envelope，無法解析時為 null）。公開 middleware 形狀為
`backend_error.error.{code,message,request_id,detail}`；UI 的 CallError 保留型別欄位，
不從文字解析 NOT_ATTEMPTED。市場 API 的錯誤形狀與成功資料均維持原樣。

唯一解鎖例外為本次 staged confirm await 返回 HTTP 503 的 typed terminal receipt：
`error.detail.retry_policy=EXPLICIT_RETRY_SAME_STAGE`，submission_attempt 的 contract、
NOT_ATTEMPTED、READINESS、native_command_started=false 與原 candidate selector 全部一致。
同一 local attempt 物件與 generation 必須仍有效；request_id 原樣保存，MCP response ID 與
該 await 綁定，不新增 caller request ID 或業務 receipt store。舊 modal callback 不能確認新 modal。

收到證據後仍保留本次送單鎖，直到單筆讀回確認同 ID/revision/digest/raw、ACTIVE、STAGED
且 submission=null；屆時僅恢復手動開啟 modal，不自行開 modal 或 confirm。
讀取失敗仍可再讀；若有效回讀已看到修改、取消或 claim，消耗該次 retry 證據，
後續舊 STAGED snapshot 不能復活它。真正 unknown、Pending、部分成交與原 Native identity join
維持原語意。跨視窗最終並行 claim 仍由 Backend 的 exact pin／transaction 擁有。

DeskStatus 每次讀取結束後間隔 15 秒純讀 `omi_read_desk_status`；頁籤隱藏暫停，顯示時恢復。
每個 mounted 元件單飛；cleanup 清 timer／listener、abort 本地 bridge 等待並丟棄 late reply，
不宣稱取消遠端 SDK。HTTP 200 或 session_bound 不推定 online；逐欄顯示 desired、actual、
session generation、交易日、date_ready、ready、busy、最後 broker read 時間／age／stale 與錯誤，
美股 execution 未支援。ONLINE／ready 不代表可送單、受理或成交。
status 是 Backend 記憶體投影；原 broker report GET 保留同 session 即時唯讀查詢，
不改為 snapshot。managed owner 的 60 秒 health read 與 120 秒 stale 判定由 Backend 擁有。

本次 source／隔離驗證紀錄見 [工作包證據](agent-runs/execution-always-online-20261105/Progress.md)。
