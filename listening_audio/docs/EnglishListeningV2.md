# 英文 Listening schema 2.0

MCP 0.2.0／`listening-audio-v2` 支援七個工具。Trainer 保留
`/api/listening/v1` 和日文 1.2 契約，新英文結果使用 `listening-result-v2`。
舊日文答案、資料、快取識別與按次提交分數保留。

## 題組

`listening_create_exam` 傳 `language=en`、`set.schema_version=2.0`。
完整範例見 `examples/english-exam.json`。必要欄位：set_id、title、scope、
source_ref、question_count、questions。每題有 id、prompt、section、answer_type、
expected_answers、audio_script、explanation。圖形題與外部素材載入尚未開放。

- single_choice：`{type: "single_choice", value: "A"}`。
- multiple_choice：`{type: "multiple_choice", value: ["A", "C"]}`，指定 selection_count。
- text：`{type: "text", value: "environment"}`。
- number：`{type: "number", value: "7:30"}`；以字串保留數字／時間格式，僅接受明列的替代答案。
- matching：`{type: "matching", value: {one: "A", two: "B"}}`，指定 matching_keys。
- `null` 表示空白。字串不做 fuzzy spelling correction。

choice/matching 題提供 `{key,text}` 選項。多選不接受重複或超過指定數量；
每個命中的 selection 或 matching pair 各計一分，部分正確保留部分分數。
text/number 每题一分，NFKC、casefold、空白正規化後比對明列的完整替代答案。
不任意移除標點或修正拼字。`word_limit={max_words,max_numbers}` 限制文字與數字 token；
數字含 7:30、7.30 格式，帶連字號的文字視為一個空白分隔 token。

最多 40 個 question object、總分最多 40；一個多選／matching object 可代表多個計分單位。
scope=skill 要求四個 section 與 40 分；scope=section 必須只含一個 section。
題組上限 256 KiB，每題 script 上限 5000 字與 40 段。日文仍最多 20 題。

## 作答、完成與寫回

使用固定 attemptId；每次新提交用新的 submissionId，重試保持原 payload。
英文結果累計整個 attempt，只有已提交題目可看到答案與解析。
最後一次提交加 `finalize=true`，未提交題目記為空白，attempt 變成不可變 completed。
MCP 每次需至少一筆答案；若全部已送出，可重送一筆相同答案並使用新的 submissionId 完成。
Trainer HTTP 也允許 finalize 加空 answers。

`listening_get_attempt_result` 用 setId/attemptId 取得可恢復結果。
完成後，caller 將整份結果作為 `listeningResult` 傳給 English Study 的既有
preview/record 工具。未完成結果不得寫回。重試不新增另一筆學習紀錄。
caller 需已有保存授權；Listening 不自行呼叫 Study 或管理 SRS。

結果包含 raw score、分母、起訖時間、各題 evidence 和來源 ID。
startedAt 是第一次提交的時間，不當成實際聆聽起始時間或作答耗時。
generated_practice 未經試卷校準，因此 Hub 不自動將 raw score 換成 band。

## 音訊與相容性

英文語言一路傳入 TTS；cache signature 包含英文 language，防止錯用日文音檔。
仍使用既有中央 Voice Runtime，不啟停模型或安裝新 voice。
API／schema 通過不代表英文口音或教學品質已驗收；真正合成、MCP WAV readback、
ChatGPT host 播放與人工聽感各自驗證。

Trainer 在同一 `listening-v1.sqlite3` 增加 attempts_v2/answers_v2 表，日文表不改寫。
沒有建立第二套學習資料庫；長期 assessment 與 progress 仍由 English Study Hub 擁有。
