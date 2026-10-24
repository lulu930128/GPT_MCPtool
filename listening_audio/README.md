# Listening Audio MCP

本機日文與英文聽力 MCP Adapter。沿用 Listening Trainer 的 schema、GPT-SoVITS profile
與合成流程；Trainer 預設呼叫共用 Voice Runtime。不複製模型、不直接讀寫 Trainer 資料，也不保存長期學習紀錄。

目前版本 `0.2.0`，MCP contract `listening-audio-v2`，Trainer contract
`listening-trainer-v1`。支援日文 schema 1.2 與英文 schema 2.0。提供六個資料工具、一個下載測試 render tool 與唯讀 WAV resource。

## 啟動

需要 Node.js 20+、已安裝 listening API 擴充的 JLPT Listening Trainer，以及原有
Voice Runtime。套件版本固定為 workspace 已使用的版本；請使用 lockfile 安裝。

```powershell
cd C:\GPT_MCPtool\listening_audio
npm ci
npm run build
npm start
```

預設 MCP：`http://127.0.0.1:18810/mcp`，本機 liveness：`/health`。
Trainer 預設：`http://127.0.0.1:8765`。`npm run start:stdio` 提供 STDIO。
設定由 process environment 載入；不自動讀 `.env`。可用選項見 `.env.example`。
HTTP 只允許 `127.0.0.1`，拒絕 browser Origin。設定 bearer token 後，health 與 MCP
都需驗證。工具輸入不接受 host、port、path、模型或任意 URL。

透過 Control Center 啟動時，元件 controller 會依序啟動 Trainer（`18811`）、MCP（`18810`）、tunnel（admin `18812`）。
手動獨立使用時，Trainer 才使用原預設 `8765`；MCP tool 本身不啟動 Trainer，只能要求 Trainer 準備音訊。
新 API 原始碼更新後，必須重新啟動 Trainer 才會採用。啟動前確認 port owner：

```powershell
cd C:\project\jlpt-listening-trainer
# 中央模式只設定共用服務，不管理模型或 TTS 子程序。
$env:JLPT_TTS_MODE = 'central'
$env:JLPT_VOICE_RUNTIME_URL = 'http://127.0.0.1:18890'
.\scripts\run.ps1
```

同一 data directory 只執行一個 Trainer。MCP `/health` 提供 buildId，不會探測 Trainer；
`listening_health` 才是跨服務唯讀探測。TTS listenerRunning 不能當成生成成功或音質證據。

## 使用流程

1. `listening_create_exam` 匯入完整 schema 1.2 題組，使用穩定 set ID。
2. `listening_prepare_audio` 準備一題，可能啟動 Trainer 設定的 TTS profile。
3. `listening_get_question` 取得允許呈現的選項與音訊狀態。
4. 透過 `resources/read` 讀取回傳的 `listening-audio://sets/{setId}/{questionId}.wav`。
5. `listening_submit_answer` 提交使用者實際答案，重試沿用 attemptId/submissionId。

範例題組見 `examples/exam.json`。完整契約見 [ToolContract.md](docs/ToolContract.md)，
責任與資料位置見 [Architecture.md](docs/Architecture.md)。
本機驗收結果見 [Verification.md](docs/Verification.md)。

工具回應不提供 localhost 音檔 URL 假裝雲端可用，也不在一般 JSON 放 base64。
只有 MCP resource 的標準 `blob` 欄位承載 WAV，最大 12 MiB。

## 驗證

```powershell
npm test
npm run smoke:http
```

真實 Trainer smoke 會自行啟動臨時 Trainer，資料全部放本元件 `.tmp/live-*/`；不使用正式題庫。
不設定 `LISTENING_LIVE_TTS=1` 時只測真實 API、匯入、投影及作答，不啟動 GPU。

```powershell
$env:LISTENING_ALLOW_TEST_WRITE = '1'
$env:LISTENING_TRAINER_ROOT = 'C:\project\jlpt-listening-trainer'
$env:LISTENING_TRAINER_PYTHON = 'C:\project\jlpt-listening-trainer\.venv\Scripts\python.exe'
# 隔離 Trainer 使用已啟動的中央服務：
$env:JLPT_TTS_MODE = 'central'
npm run smoke:live
# 實際男聲、女聲、雙角色合成（需現有模型與 GPU）：
$env:LISTENING_LIVE_TTS = '1'
npm run smoke:live
```

結束時只透過保留的 Popen handle 關閉本次建立的 TTS 程序，既有服務不被停止。
測試輸出含 WAV、隔離 DB 與 evidence.json，全部 Git ignored。

## 已知邊界

- 已加入 Control Center 的 enabled／autoStart chain；Windows cold boot 與 ChatGPT 內播放仍需另外驗收。
- 同一對話的 AI 若負責出題，已知道答案；安全投影只能避免工具額外洩漏，不能清除模型上下文。
- `text_options` 顯示日文選項；`audio_only` 隱藏選項文字，出題者必須將選項放入 audio_script。
- 考試資料由 Trainer 的獨立 `listening-v1.sqlite3` 保存，不會自動出現在舊 Trainer UI 題庫。
- 目前答後回傳正誤、正解、逐字稿與重點解析；英文 completed result 可由 caller 經 English Study 正式 preview/record 寫回；日文 Study 寫回尚未加入。
- 一次準備一題。若客戶端 TIMEOUT，後端可能仍在合成；先查題目狀態，BUSY 時稍後重試。
- 音質、口音與題目教學品質仍需人工聽感檢查；英文透過 schema 2.0 明確指定。

## Tunnel 與 Control Center

操作入口是 Control Center 的 `Listening Audio`。設定方法、固定埠、ownership 與啟停語義見 [ControlCenterIntegration.md](docs/ControlCenterIntegration.md)。
目前主機透過忽略的 `.local/runtime.psd1` 重用 `project_reading` 的 tunnel client 與 DPAPI key 路徑，自己的 tunnel ID/profile 放 `.tunnel-client/`，不進 Git。
納管 runtime 以 secure tunnel 控制遠端連線，loopback upstream 無 bearer；獨立 `npm start` 仍支援環境變數 bearer。
Controller 不下載 binary，不複製模型／金鑰，Control Center 不讀取學習內容。

```powershell
npm run runtime:status
npm run test:runtime
```

## 中央語音服務與 health

最小下載 Widget 使用 `listening_render_question`，操作與驗證方式見 [DownloadWidgetTest.md](docs/DownloadWidgetTest.md)。
目前是 host 相容性測試，尚未宣稱 ChatGPT 真實下載成功；不支援的 Client 會明確顯示狀態。

Trainer 預設 `JLPT_TTS_MODE=central`、`JLPT_VOICE_RUNTIME_URL=http://127.0.0.1:18890`。
female → yuki，male／narrator → kuro；一般專案只設定 URL 與 voice_id。
模型、registry、Python、引擎及跨 consumer 推論鎖由 Voice Package 管理。

```powershell
powershell -NoProfile -File "C:\project\voice package\GPT-SoVITS\scripts\start-service.ps1" -Background
```

共用服務不屬於 Listening Audio controller 的程序；Restart MCP 不會重啟它。
舊 TTS port override 只適用明確選用 legacy 的安裝，central 模式忽略它們。
本次不安裝 Voice Runtime 開機自動啟動，重開機後需使用其自有入口啟動。

MCP `/health` 是 adapter liveness；`listening_health` 回報 Trainer 與 TTS 狀態。
中央服務離線時，Trainer 在短限時探測後仍回 `ok=true`，TTS 回報
`mode=central`、`serviceStatus=unavailable`、`listenerRunning=false`；這不阻擋 MCP／tunnel 啟動。
`available`／`busy` 也不表示已合成或人工聽感通過。prepare 離線回 `TTS_NOT_READY`，
共用服務忙碌回 `BUSY`；不自動重試、不回退舊引擎。

## 英文聽力與學習紀錄

完整 schema、finalize、raw score、重試與單一路徑寫回見 [EnglishListeningV2.md](docs/EnglishListeningV2.md)。Hub 擁有 assessment 與長期進度，Trainer 保存題目／attempt／音訊；MCP 不直接開啟任何資料庫。
