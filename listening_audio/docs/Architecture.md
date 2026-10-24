# 架構與責任

```text
MCP client → listening_audio → Listening Trainer /api/listening/v1
                                      → Voice Runtime HTTP → GPT-SoVITS
```

- Adapter：strict MCP envelopes、總量限制、固定 loopback upstream、錯誤分類、response allowlist。
- Trainer：沿用 schema 1.2 validator、immutable exam、attempt/submission 交易、評分與安全投影。
- TtsManager：voice slot → voice_id、中央服務請求、WAV 合併及快取；共享非阻塞 operation lock。
- Voice Runtime：集中解析 platform／manifest，擁有 Python、模型、引擎與跨 consumer 推論鎖。
- Japanese/English Study：各自長期 learning state；本元件不直寫兩者 DB。
- Control Center：協調 Trainer／MCP／tunnel lifecycle，不取得題目、模型設定或共用引擎 ownership。

## 保存位置

Adapter 不保存 exam/session/audio。Trainer 使用 `data/listening-v1.sqlite3` 保存不可變
normalized exam 與提交結果，使用 `data/audio/listening-v1/` 保存可重建音檔。
SQLite transaction 與唯一鍵保護跨請求的 create/submit 重試，不使用 Adapter 記憶體當權威。
legacy `data/sets`、`data/sessions`、`data/results` 與舊 UI 契約不搬移、不合併。

相同 set ID 的內容與 presentation 不可變。相同 attempt 中已提交的題目不可改答案；
retake 使用新 attempt ID。同 submission ID 不同 payload 回 409，整批提交同一交易。
SQLite 的提交結果與 answer rows 一起提交，因此 timeout/retry 不會產生半份紀錄。

## 音訊

取題與 resource read 不啟動、不合成、不建立 DB。state 由 Trainer 的 voice signature
與 WAV 檢查決定。中央快取 signature 包括台詞、slot、voice_id、服務回報的 package digest、
endpoint、speed 與 segment silence。服務不可達時既有音檔保守標 stale；不偷偷生成。
合成前驗證 Voice Runtime protocol 與 voice identity，不只檢查 TCP port。
registry 變更須由服務 owner 重新載入；磁碟更新不等於 runtime 已採用。SDK resource bytes 不等於 host 會播放。

一個 Trainer process 同時只允許一項 TTS operation，涵蓋舊 UI 與新 API。
不支援多個 Trainer 共用同一 data/profile 啟動管理；不使用 kill-by-name。

## 傳輸與安全

HTTP 使用 stateless Streamable HTTP，無需建立永久 MCP session。每請求最多 300000 bytes，
JSON upstream 最多 524288 bytes、WAV 最多 12 MiB、最多 16 個 in-flight HTTP requests。
固定 upstream origin、拒絕 redirect、無 user-controlled path/URL、HTTP Origin 預設拒絕。
Health/error 不返回檔案路徑、traceback 或 profile 內部設定。STDIO 日誌不寫 stdout。

Tunnel 後續只能通到具驗證的 MCP 邊界，不直接暴露 Trainer、模型服務或資料目錄。
