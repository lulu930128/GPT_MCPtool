# 本機驗收紀錄

日期：2026-09-09。版本：listening-audio 0.1.0 / listening-trainer-v1。

## 原始碼與自動測試

- `npm test`：TypeScript build 成功，11 項測試通過。
- `npm run smoke:http`：authenticated HTTP initialize、五工具、health、resource template、
  build identity 與 Origin rejection 通過。
- Trainer `python -B -m unittest discover -s tests`：25 項測試通過，包含原有 8 項。
- Trainer 新增測試涵蓋 immutable create、並行重試、submission 衝突、整批 rollback、
  部分題目解鎖、輸入 bounds、corrupt cache、生成時間預算與背景 stdin 隔離。

## 真實 Trainer 與 GPU

使用既有 Trainer 原始碼與 GPT-SoVITS 環境，測試 DB、cache、log 都位於 Adapter 的
Git-ignored `.tmp/live-*/`。沒有匯入正式題庫或寫入日／英 Study 紀錄。
預設男聲 9983 被 VPN 占用，因此只在測試 child environment 使用已確認空閒的 9984。

| 樣本 | WAV bytes | 時長 | 驗證 |
| --- | ---: | ---: | --- |
| 男聲 Q001 | 290604 | 4.54 秒 | 生成、MCP resources/read、重試快取通過 |
| 女聲 Q002 | 231724 | 3.62 秒 | 生成、MCP resources/read、重試快取通過 |
| narrator + female Q003 | 455724 | 7.12 秒 | 多段合併、MCP resources/read、重試快取通過 |

三段都是 mono、32000 Hz，Python wave parser 完整讀出所有 frames。
瀏覽器對取回的 WAV 執行靜音播放，三段皆 `readyState=4`、`ended=true`、`error=null`，
currentTime 到達各自 duration。這證明格式與播放流程，不代表人工聽感、口音或教學品質驗收。

實機測試發現並修正 Trainer 背景子程序繼承 stdin pipe 的啟動阻塞；TTS launcher 現在
使用 DEVNULL stdin、即時 log，並明確關閉父程序 log handle。沒有修改 GPT-SoVITS 核心。

## Tunnel 與正式 runtime 納管

- 使用者指定的 tunnel 已寫入 Git-ignored profile；沿用現有 DPAPI key 路徑，未複製金鑰。
- `listening_audio` 已加入 registry，`enabled=true`、`autoStart=true`、startupOrder `80`。
- 固定納管埠為 Trainer `18811`、MCP `18810`、tunnel admin `18812`；獨立模式保留原 Trainer 預設 `8765`。
- 隔離 lifecycle 測試通過：外來 PID、同執行檔不同 start time、缺失 owner metadata、foreign listener、venv descendant、重複 EnsureRunning 與 ShutdownRuntime。
- 正式 controller `EnsureRunning`、`ShutdownRuntime`、`ReloadRuntime` 通過；所有程序皆為 owned。
- Control Center regression：534 assertions 通過；SelfTest：8 registered、8 enabled。
- `node scripts/smoke-managed.mjs` 通過：正式 MCP build 與磁碟一致、五工具、Trainer contract、WAV template、tunnel readyz。
- tunnel 已取得遠端登錄 metadata 並完成本機 MCP initialize；這不等於 ChatGPT connector 實際呼叫成功。
- 長駐 tunnel stdout/stderr 分別寫入元件本機 log，避免繼承 controller 回傳管道。
- Control Center 最終 Status：8/8 Ready；托盤已以新的 registry 重新載入。
- 官方 Doctor 在運行中回報 admin port 已使用、no-auth upstream OAuth metadata 404；未將 Doctor 計為通過。獨立 Health／readyz 與 MCP 協定 smoke 已通過。

## 尚未驗收

- ChatGPT connector 的實際呼叫與 host 音訊呈現。
- Windows 冷開機後的自動啟動驗收。
- 英文生成、英文音質、Study learning-state 寫回。
- 人工發音／聽感與出題品質評估。

隔離測試建立的 Trainer/TTS 程序會在 smoke 結束時關閉。正式 Trainer／MCP／tunnel 則由 Control Center 保持運作。
