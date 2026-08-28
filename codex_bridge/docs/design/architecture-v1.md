# Codex Handoff Bridge v1 Architecture

## 產品決策

第一版採 `interactive-decoupled`：read、action 與 render tools 分離，MCP Apps widget 透過標準 bridge
呼叫 UI-only action。Widget 以 project 為父層、conversation/job 為子層；Job store 是 durable state，
ChatGPT tool result 只是投影，不是 system of record。

## Trust boundaries

1. ChatGPT 只傳 `projectId` 與工作包，不傳本機絕對專案路徑；公開 tools 只接受設定檔 project id。
2. Bridge 由本機 ignored allowlist 將 id 映射為 realpath；app-only Widget 也可使用 App Server
   thread metadata 發現的 opaque project id，但 server 必須先以 realpath、存在性與敏感路徑 deny rules 驗證。
3. Job UUID、目錄與 artifact 路徑全部由 server 建立。
4. Codex App Server 只透過 child-process stdio 存取，不直接暴露網路 listener。
5. Bridge 啟動 App Server 時建立兩個狹窄的 inline permission profiles。`codex-bridge-read-only`
   繼承 `:read-only`，`codex-bridge-workspace` 繼承 `:workspace`；兩者只額外允許唯讀存取固定的
   `.local/codex-inbox`，永遠不選擇 `:danger-full-access`，runtime workspace roots 只有目前再次驗證的 exact project。
6. `turn/start`／`turn/steer` 的文字只由使用者明確輸入與標記為資料的 context、criteria、constraints、
   text artifact 區段組成。Bridge 不把 audit 模板或自訂行為提示注入模型；durable `request.md` 只供
   Bridge 稽核，job folder 不授權給 Codex。
7. 不核准額外 network permission，approval policy 固定 `on-request`。
8. command 與 file change request 只允許 `accept`、`decline`、`cancel`，不提供 `acceptForSession`。
9. 文字文件只能經 app-only begin／append／finalize contract 進入 server-owned staging。檔名只作 metadata，
   實際路徑永遠使用 Bridge UUID；每段與整體 SHA-256、character count、UTF-8 byte count 均需吻合。
10. finalized bundle 綁定 project id 與 data classification；Job Store 把通過綁定的內容複製到 job
    `inbox/` 與 `.local/codex-inbox/<job_id>/`。Controller 重新驗證 hash 後，把 server-generated
    唯讀路徑與 verified inline fallback 一起放入 turn。`C:\CodexBridge` 與 `codex-inbox` 都不加入
    Codex runtime roots。
11. Widget 的大型成品讀取使用 app-only `codex_artifact_read_chunk`，內容只放 tool result `_meta`；
    `structuredContent` 只含檔名、大小、hash、cursor 等 metadata。
12. 本機 thread 的 list／read 無副作用；安全 discovered thread 只有在使用者從 Widget 明確送出時才建立
    durable Bridge job，沿用原 `threadId` 由 `thread/resume` 續作。Root、home、system 與 sensitive path 保持受保護。

## State model

`queued -> preparing -> running -> awaiting_approval -> running -> completed|failed|cancelled`

每個 job 對應一個 Codex thread。App Server thread／turn／item 是 authoritative history；Bridge 以
`conversation.json` 保存 durable UI projection，並用 append-only `conversation-events.jsonl` 保存 revision
patch。舊 `messages.jsonl` 繼續保存 Bridge-authored user metadata 與相容訊息，但不再是完整 transcript
的唯一來源。

首次開啟既有 thread 時，Controller 以 `thread/read(includeTurns=true)` hydrate 全部已保存 turns；live
notification 之後透過同一個 per-job lock 依序 reduce。Agent、plan、reasoning summary delta 先更新
stable item id，`item/completed` 再 authoritative reconcile 同一 item。Command、file change、MCP tool、
diff、approval 與 error 都保留 turn／item 關聯；interrupt／failure 不清掉已收到的 partial output。

`codex_job_get` 同時提供兩組 monotonic cursor：event `nextEventSeq`／`serverLastEventSeq`，以及 conversation
`nextConversationRevision`／`serverConversationRevision`。回傳 cursor 只前進到實際交付的最後一筆；若
client 落後或 patch gap 無法連續，server fail safe 回傳完整 projection。Widget 補完 bounded pages 後
才回到一般 polling。

執行中的訊息以 `turn/steer` 送入目前 turn；terminal job 的下一則訊息先呼叫 `thread/resume`，再用
`turn/start` 建立同一 thread 的下一個 turn。`model/list` 是模型與 reasoning effort 選項的 runtime
source，UI 不硬編碼可用模型。

任何 active state 在 controller restart 後轉成 `interrupted`。Pending approvals 同時轉成 `expired`，避免 UI
對已不存在的 JSON-RPC request 做出核准。

每次 mutation 先 append event，再寫入 atomic manifest，並增加 monotonic `stateVersion` 與 event `seq`。

Conversation patch 則先建立新的 monotonic revision，再原子寫入 `conversation.json`，並 append
`conversation-events.jsonl`。Widget 使用 keyed timeline 更新實際變動的 item，保留展開狀態；使用者離開
底部閱讀時不強制捲回，而顯示「有新內容」提示。

## Non-goals

- 任意檔案上傳、二進位附件或雙向檔案瀏覽器。
- 對企業 DLP、proxy、workspace admin 或網路封鎖的繞過。
- 自動 commit、push、發布、資料庫 migration 或 destructive action。
- 公開 Codex App Server port。
- 保存或顯示 raw reasoning chain-of-thought，或宣稱與 Codex Desktop 私有 UI 100% parity。
- 自動掃描所有磁碟專案；完整本機 history 只來自 App Server thread metadata。Allowlist 以外的
  discovered workspace 必須通過 protected-path gate，且只在使用者明確送出續作時才採用。
- 在本輪把 MCP cursor polling 改成 SSE／WebSocket；projection contract 與 transport 保持解耦。
- 保證 `:workspace` 內每個檔案修改都先逐檔核准；嚴格 diff-before-apply 留給 staged patch workflow。

## Text Artifact Shuttle v1

- 輸入允許最多 8 份純文字工件，限定文字副檔名、MIME、單份 500,000 字元／2 MB，總量 2 MB。
- `codex_text_bundle_begin` 提供宣告與重送 idempotency；`append` 驗證 chunk hash；`finalize` 驗證完整
  hash／大小並拒絕明顯 API key、bearer token 與 assigned secret。
- Job 建立與多輪 follow-up 都能附帶 finalized bundle；對話只保存 metadata，文件內容留在 job inbox。
- 輸出只公開 request、final response 與 aggregated diff，不掃描或輸出任意專案檔案。

## 後續候選

- staging retention policy。
- local notification、approval expiry timer 與 audit export。
- diff 分檔檢視、test summary 結構化、重新執行 failed validation。
- 對每個 project 設定可用 mode、額外 read roots、validation profile 與最大執行時間。
- 若量測顯示 900 ms polling 不足，再以相同 conversation revision contract 加入 authenticated SSE；
  transport migration 不改變 Job Store system-of-record 或 approval boundary。
