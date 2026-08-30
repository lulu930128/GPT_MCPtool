# Codex Bridge Conversation Model

## 目標

Codex Bridge 的對話介面要能回答三件事：目前在哪個專案、做到哪個 turn、Codex 正在做什麼。它必須在
Widget reload、MCP reconnect 或 Bridge process restart 後恢復相同的 user-visible history，同時不把
raw reasoning、任意本機路徑或未授權資料暴露給 client。

## 真相來源

1. Codex App Server thread／turn／item 是 conversation history 的 authoritative source。
2. `conversation.json` 是 Bridge 的 durable、bounded、redacted UI projection；它不是新的 agent runtime。
3. `conversation-events.jsonl` 是 monotonic revision patch log，讓 Widget 不必每 900 ms 重抓整段 history。
4. `messages.jsonl` 保留使用者輸入 metadata、附件摘要與舊版相容，不再獨自代表完整 transcript。
5. `events.jsonl` 是 Bridge 操作／稽核事件；它與 user-visible conversation projection 分開。

## Checkpoint 與 journal recovery

- Revision 先 append 到 `conversation-events.jsonl` 並完成 file sync，才允許更新 process memory；checkpoint
  promotion 失敗時該 revision 仍可重播，且後續 revision 會先修復 pending checkpoint。
- `conversation.json` 只由已完整寫入並驗證的同目錄 temp promotion；Windows `EPERM`／`EEXIST` fallback
  先保留一份已驗證 `conversation.json.bak`，再用 bounded swap 取代 primary，不會 copy 覆寫 active file。
- 啟動時先驗證 primary／backup schema 與 revision，再讀取 journal。Checkpoint 落後時只重播連續缺少
  revisions；identical duplicate 只套用一次，conflicting duplicate、gap 與 middle corruption fail closed。
- 未換行且無法解析的 final JSONL tail 可截回最後完整 byte boundary；已換行的 malformed record 視為
  committed corruption，不會靜默跳過。
- Valid legacy checkpoint 即使沒有 journal 仍可讀取，並 lazy seed 一份 bounded backup。只有 primary、backup
  與 journal 都完全沒有既有證據時，才建立新的空 projection。
- Recovery diagnostics 只包含固定 code、時間與 revision metadata，不包含 transcript、path、secret 或 payload。

Journal compaction／rotation 必須等 verified checkpoint 已涵蓋被移除 revisions，並在 crash 中保留至少一份
可恢復狀態。目前尚未實作，列為 P2 storage/performance debt。

## Prompt-neutral input

沒有額外資料時，使用者輸入會原樣送入 App Server，例如：

```text
hello
```

```text
please continue
```

若使用者明確提供 context、acceptance criteria、constraints 或文字附件，Bridge 只增加有名稱的資料區段：

```text
[USER_CONTEXT]
...
[/USER_CONTEXT]
```

文字附件以 `[ATTACHED_TEXT_ARTIFACT]` 保存 filename、MIME、chars、bytes、SHA-256、server-generated
read-only path 與 verified content。這些標記描述資料來源，不加入「必須如何作答」等 Bridge-generated
behavior prompt。`request.md` 是獨立 audit artifact，不作為 `turn/start` input。

## Hydration 與 live reduce

```mermaid
flowchart LR
    A[選取 focus visibility 或定期核對] --> B[thread/read metadata]
    B -->|legacy| C1[thread/read includeTurns=true]
    B -->|paginated| C2[thread/turns/list full until complete]
    C1 --> C[normalize user-visible turns/items]
    C2 --> C
    C --> D[conversation.json]
    E[App Server notifications] --> F[per-job serialized reducer]
    F --> D
    F --> G[conversation-events.jsonl]
    D --> H[codex_job_get snapshot]
    G --> H
    H --> I[Widget keyed timeline]
```

- Reader 不以 exception 猜 protocol；先依 metadata 的 `historyMode` 分流。Paginated history 必須取得全部
  cursor pages，並固定要求 `itemsView="full"`；任何頁失敗、cursor loop、重複 turn 或安全上限超出都不覆蓋
  最後一次已驗證 projection。
- Paginated full read 前後會各取一次 metadata/head fingerprint。中途新增或變更 turn 時完整重試一次；第二次仍不一致
  以 `HistoryChangedDuringRead` fail closed。到達 `maxTurns` 且仍有 cursor 時直接回 `HistoryLimitExceeded`，不送出 `limit=0`。
- Fingerprint 變更或週期 full-read 到期才抓完整 history；成功 hydration 是 authoritative replacement，來源已移除
  的 turn/item 會透過 `replaceAll` revision patch 從 Widget 刪除。
- App Server user message text 永遠是內容權威。`messages.jsonl` 只有在 App Server `clientId` 與 Bridge
  `clientMessageId` 完全一致時才附加 context／input artifact metadata；不使用 positional fallback，也不重建已由來源刪除的訊息。
- Live delta 以 stable item id 更新原項目；`item/completed` 取代同 item 的暫態內容。
- Interrupted／failed turn 會停止 streaming indicator，但保留 partial assistant／command output。
- 同一個 job 的 notification、approval 與 synthetic lifecycle event 依序處理，避免 race 造成 revision 倒退。

## User-visible item allowlist

| App Server / Bridge item | Widget 呈現 | 保存原則 |
| --- | --- | --- |
| user message | 使用者 bubble | 文字、context、附件 metadata |
| agent message | Codex bubble、streaming cursor | bounded text；completed authoritative |
| plan | 可展開活動卡 | user-visible plan text |
| reasoning summary | 可展開活動卡 | 只限 summary；raw reasoning 排除 |
| command execution | command、cwd、status、bounded output | redacted、bounded |
| file change | path、status、bounded diff preview | redacted、bounded |
| MCP tool call | server/tool、status、bounded progress/result | redacted、bounded |
| turn diff | diff 活動卡 | bounded preview |
| approval | inline exact approval | 僅目前 pending request 可決定 |
| error | error 活動卡 | sanitized message |

未知 item 不會把任意 payload 直接序列化進 UI；只保留安全的 generic activity metadata。

## Cursor 與 reconnect

`codex_job_get` 的 event cursor 與 conversation revision cursor 分開：

- `nextEventSeq`：client 實際收到的最後 event seq。
- `serverLastEventSeq`：server 已保存的最新 event seq。
- `nextConversationRevision`：client 實際收到的最後 conversation revision。
- `serverConversationRevision`：server 已保存的最新 projection revision。
- `hasMore`／`conversationHasMore`：client 是否仍需補頁。

Active Bridge job 正常狀態每 900 ms poll；落後時每 25 ms 補 bounded page。Terminal thread 每 20 秒核對，
active automation target 每 4 秒核對，focus／visibility 回復時立即 refresh；後兩者先比對 metadata fingerprint，
未變更時沿用 process 內最後一份已驗證 native snapshot，不重讀完整 history。Patch 第一個 revision 若不是預期下一筆，
或 client cursor 與 server state 無法連續，server 回傳完整 projection 重新對齊，避免靜默漏訊息。

## 專案與對話範圍

Server-side unified registry 以 App Server `thread/list` 為 native inventory，依 `threadId` 合併 Bridge JobStore
與 automation overlay；同一 thread 永遠只回一筆 summary，native title／recency 是顯示基準，Bridge job 保留
執行狀態與成品，automation 只加入名稱、狀態、schedule、target id 與時間。Widget 不再自行決定兩份清單的
precedence。Bridge 不掃描 `.codex` database 或 rollout；automation adapter 只讀 `%CODEX_HOME%\\automations\\*\\automation.toml`
的 allowlisted keys，限制 path、檔案大小與 parse failure，絕不讀取或回傳 prompt。

Native inventory 與 automation adapter 使用獨立 failure boundary；其中一方失敗時仍回傳另一方與 durable Bridge jobs，
並附上 bounded diagnostics。Conversation `updatedAt` 不混入 automation 設定時間，automation 時間另放
`automationUpdatedAt`。Inventory 會沿 App Server cursor chain 讀取，顯式安全上限為 10,000；超過時標示 incomplete。
Widget 只有在 server 回傳 `reset=true` 的第一頁才重建 registry，後續頁一律累加。

本機 history project 若與 `.local/projects.json` 的 exact path 相符，會與 Bridge job 合併並以 `threadId`
去重。其他 App Server 發現的 cwd 會先經 `realpath`、目錄存在性與敏感路徑 deny rules 檢查；安全的實際
project 只以 opaque `local:<digest>` id 暴露給 Widget，可新增對話，也可在使用者明確送出時把既有 thread
採用為 durable Bridge job 後由 `thread/resume` 續作。單純 list／read 不會採用或修改 thread。

磁碟根目錄、使用者家目錄、Windows／Program Files／ProgramData／AppData、`.codex`、`.ssh`、`.aws`、
`.azure`、Downloads、Bridge runtime state 與 dependency／virtual environment 目錄保持受保護唯讀。
Client 不能提供 raw cwd；每次 dispatch／resume 前會由 server 重新解析 exact project。公開 MCP tools 仍只接受
設定檔 allowlist，完整歷史與 discovered project 操作只存在 app-only Widget 邊界。

`thread/list`／`thread/read` shape 對齊 repo 鎖定的 `@openai/codex` 版本；升級 Codex dependency 時必須重新產生
App Server schema 並跑 controller tests，不把 ChatKit Threads API 視為同一份 contract。

## Transport 邊界

本版採 MCP tool polling，目標是 reliable reconnect 與 durable progress，而不是複製 Codex Desktop 的私有
render cadence。未來可在相同 revision contract 上加入 authenticated SSE；SSE 只改 delivery transport，
不改 Job Store、allowlist、sandbox、approval 或 prompt-neutral input 邊界。
