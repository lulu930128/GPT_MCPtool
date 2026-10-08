# KGI 最後有效持倉保底

`BrokerBridgeClient` 是 guard 的唯一正式 runtime owner。REST、MCP 與既有每日估值服務
共用同一 client／read lock，不各自維護持倉真相或增加確認計數。
`broker-last-good-v1.json` 是本機私人 external evidence，不是 Ledger 或可匯入的交易檔案。

## 每市場狀態轉換

| 本次 live 結果 | 有 last-good | 無 last-good | 空倉計數 |
| --- | --- | --- | --- |
| complete | 更新該市場有效持倉 | 建立該市場有效持倉 | 歸零 |
| explicit_empty，未達門檻 | stale fallback，保留持倉與時間 | 回實際 empty、附未確認警告 | 同 opaque account 連續加一 |
| explicit_empty，達門檻 | 原子清除該市場 last-good | 接受 empty | 保留已確認計數，後續 empty 不溢位 |
| unavailable／timeout／HTTP／contract error | stale fallback | unavailable，不補零 | 歸零 |
| RAM cache 命中 | 回傳已 guard 的結果 | 回傳已 guard 的結果 | 不變 |

TW／US 各自判斷。已知帳戶切換時停用舊帳戶證據。v1 bridge 的 TW response 仍經過相同
guard；v2 envelope 可驗證時，單一 scope 格式錯誤不影響另一個有效 live scope。

持久化檔必須有 `schema_version=paos.broker-last-good.v1`、唯一 TW／US state、合法非零
持倉數量、有限數值、時區時間、正確市場／幣別／valuation 配對。上游 warning、masked
account 尾碼與 raw payload hash 不保存。損壞或未知版本整檔忽略並警告，不拋出持倉讀取錯誤。
同目錄暫存檔經 flush／fsync 後 atomic replace；寫入失敗不接受未成功保存的空倉清除。

## 對外契約

- 只要任一市場使用 last-good，整體 broker `status=stale`、`read_mode=persistent_fallback`。
- `broker.markets[].read_mode` 與 `.stale` 描述各市場的實際來源；scope `status=complete`
  表示該證據包含完整持倉，不代表 live。警告列出回退市場。
- `source_as_of`、原 `price_as_of` 保留；fallback 市場 row 為 `broker_stale`，有效 live 市場不被
  整體 stale 誤標。匯率缺失或過舊仍依既有獨立規則處理。
- `PAOS_BROKER_EMPTY_CONFIRMATION_COUNT` 預設 3，範圍 1–20。舊
  `PAOS_BROKER_MEMORY_FALLBACK_SECONDS` 保留設定相容性，但不再限制持倉保底期限。
- snapshot 為單一正式 PAOS process 擁有的 runtime state；不支援兩個獨立 server 共寫同一路徑。

## 驗證與採用

從 `personal-asset-os` 執行既有環境：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_broker_read.py tests/test_broker_snapshot_guard.py tests/test_broker_overlay.py tests/test_mcp.py -q
.\.venv\Scripts\python.exe -m ruff check src tests migrations scripts/smoke-kgi-overlay.py
.\.venv\Scripts\python.exe -m mypy src
```

frontend 需通過 `npm run lint` 與 `npm run build`。完整 backend suite 仍為 `pytest`。
測試只用 synthetic HTTP transport 與隔離 data directory；包含 restart、新 client、兩市場混合、
空倉序列、壞檔／缺版本、atomic replace 失敗、REST／MCP 序列化及 Ledger 表無寫入。

正式採用前由 Control Center Status 驗證 owner；只有可確認 ownership 才以官方
`control-center.ps1 -Action RestartCore -Component personal_asset_os` 重啟。
`scripts/smoke-kgi-overlay.py` 與 `scripts/smoke-kgi-mcp.ps1` 可驗證 read model／非 live 標記
及讀取前後 DB row counts、檔案 hash、含 WAL 已提交內容 hash 不變；只輸出 sanitized 摘要。
未實際觀察到 live failure 時，不能把 mock fallback 測試報成正式 KGI failure 驗收。