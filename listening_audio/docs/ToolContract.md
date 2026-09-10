# Listening Audio v1

所有工具 envelope 都是 strict；未知參數拒絕。完整 Trainer set 可保留 schema 擴充欄位，
由 Trainer 原有 validator 作完整驗證，Adapter 只限制識別碼、題數與文字／payload 大小。

| 工具 | 輸入 | 副作用 |
| --- | --- | --- |
| listening_health | `{}` | 唯讀；契約、ja capability、TTS listener 狀態 |
| listening_create_exam | `{set, language?:"ja", presentation?:"text_options"或"audio_only"}` | 保存 immutable exam，不生成 |
| listening_get_question | `{setId, questionId}` | 唯讀安全題目與 missing/stale/ready |
| listening_prepare_audio | `{setId, questionId}` | 準備一題，可啟動既有配置的 TTS |
| listening_submit_answer | `{setId, attemptId, submissionId, answers:{Q001:1}}` | 冪等提交、已答題解析 |

setId 遵循 Trainer 3–81 字元格式；question/attempt/submission ID 只接受字母、數字、
底線與連字號，最多 80 字元，首字必須字母或數字。最多 20 題，每題最多 40 段、
總 script 最多 5000 字，完整題組最多 256 KiB。答案必須整數 1–4，不接受 bool 或字串。

## 未作答投影

只回 setId、questionId、位置、題數、ja、presentation、option key、可選日文選項文字及
audio 狀態。沒有 question_ja、question_zh_tw、audio_script、正解、解析或原始 set echo。
不要把工具輸入中的出題稿展示給考生。text_options 不代表提供中文翻譯。

## 作答

attemptId 代表一次練習；submissionId 代表一次送出。網路失敗重試兩者都不變。
相同 submission 與答案回傳已保存結果；改 payload 回 SUBMISSION_CONFLICT。
已提交題改答案回 ANSWER_CONFLICT，重新練習必須使用新的 attemptId。
回應 score 是此次提交的分數，answeredCount 是此次題數，questionCount 是整組題數。
只解鎖本次提交題目的 transcript、correctOption 與 summary/evidence/translation。
不把「提交一題」當成「整組所有題可解鎖」。不自動寫入 Study learning records。

## Resource

`listening-audio://sets/{setId}/{questionId}.wav` 只接受精確 ID，不能使用 file URI、
Windows 路徑、query 或任意 URL。讀取只回 `audio/wav` 與標準 MCP blob，最多 12 MiB。
檔案 missing/stale 時回錯誤，必須明確 prepare，read 不會偷偷生成。
host 的原生播放能力需另驗證，沒有 tunnel 時不宣稱 ChatGPT 雲端可用。

## 錯誤與時間

工具失敗設定 `isError: true`，內容包含 `{ok:false,error:{code,message,retryable,status?}}`。
常見 code：INVALID_REQUEST、INVALID_SET、INVALID_QUESTION、INVALID_ANSWER、SET_CONFLICT、
SUBMISSION_CONFLICT、ANSWER_CONFLICT、TRAINER_UNREACHABLE、TRAINER_INVALID_RESPONSE、
TRAINER_HTTP_ERROR、TIMEOUT、BUSY、TTS_NOT_READY、TTS_GENERATION_FAILED、AUDIO_NOT_FOUND、
AUDIO_STALE、AUDIO_INVALID、AUDIO_TOO_LARGE、RESPONSE_TOO_LARGE。

Health timeout 5 秒，一般操作 10 秒，prepare 預設 300 秒。Trainer 冷啟動最多等待 120 秒，
其餘時間供整題合成使用。client timeout 不代表後端取消。
遇到 TIMEOUT 先用 get_question 查狀態，仍未 ready 時稍後以同 ID 重試；不建立另一份題組。
服務不自動重試寫入，也不接受 force、cache delete、reset 或變更模型設定。
