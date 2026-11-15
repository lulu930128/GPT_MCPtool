# 分段傳輸 source 驗收紀錄

日期：2026-11-08。Source application `1.9.0`，contract `2026-11-08.2`。
本次 source 工作已完成；沒有 commit、push、部署、runtime restart 或 ChatGPT 上傳。

## 最終驗證

| 表面 | 指令或證據 | 結果 |
| --- | --- | --- |
| Source Build | `npm run build` | PASS |
| Focused | `node --test dist/tests/segmented-transfer.test.js` | **16/16 PASS**，0 failed/skipped，126,649 ms |
| Full regression | `npm test`（含 build） | **195/195 PASS**，0 failed/skipped，167,138 ms |
| 格式 | `git diff --check -- .` | PASS |
| 隔離 MCP | SDK InMemoryTransport，四個 tools 與 resource read、SDK send failure/retry | PASS；不代表 ChatGPT 附件 |
| ZIP64 獨立 reader | Python `zipfile` CRC 與檔案 SHA-256 | PASS，包含 64 MiB input 與 65,536 entries |
| 既有大型 ZIP | 65,536-entry ZIP 以 `kind=zip` 串流驗證並保留原 bytes/hash | PASS；分段 reader 上限 100,000，舊 reader 仍 2,048 |

覆蓋：單檔 51 MiB、64 MiB aggregate input、超過 12 MiB output、不同 chunk size、
1 MiB/12 MiB 邊界、分頁與空檔、每片及全檔 hash、壓縮比、來源 identity/bytes 未變、
deny/hardlink/skipped、CRC/traversal、來源 capture 中變動、cancel/expiry/cleanup failure、
ready restart recovery、interrupted job、損壞 state、暫時 owner lock 失敗後同 instance 重試、
持久傳送額度與 torn unused ledger slot、PowerShell 可用的 manifest-dir 重組、混頁/缺頁/重複拒絕。
100 GB 邊界是精確 numeric counter 模擬，未配置 100 GB memory/disk。

中間失敗保留在 ignored evidence：曾修正 cleanup single-flight 等待競態，以及舊工具數量/annotation
斷言未計入新增 tools 的兩個 full-suite failures。上表為修正後最終成功結果，未將早期失敗刪除。

## ASR 隔離檢查

使用現役查得的 `projects → C:\project`、asset/file-return scopes 與既有 deny policy；
隔離 source instance 無 listener，先做 128 MiB / 10,000 entries 上限的預檢。
沒有呼叫 fresh ChatGPT upload，沒有改寫 ASR。

| 項目 | 結果 |
| --- | --- |
| 納入檔案 | 32 |
| 來源 bytes | **30,869,203** |
| ZIP64 bytes | **30,122,927** |
| 分片 | **4**：3 × 8,388,608 + 4,957,103 bytes |
| SHA-256 | `58c159973abacc9ef88d714cee87db2572e09eee1e60e1a52a65a7c263e84400` |
| 每片及全檔驗證 | PASS |
| Python ZIP CRC、解壓後各檔 hash | PASS |
| 來源擷取前/後 bytes、identity | unchanged |
| complete | **false**，既有 deny policy 排除兩筆 |
| 清理 | server-owned staging 與本次驗證 ZIP 已清理 |
| Node process peak RSS | 132,423,680 bytes；此觀測不能外推 100 GB 規模 |

排除項為 `build-cache/python-3.13.17-embed-amd64.zip`（denied `.zip`）與 `dist/`
（denied directory，整個 subtree）。因此此產物是 allowed subset，不能稱完整 ASR 備份。

## 精確 diff 與 WIP

基線包含 **130** 個既有 dirty files 的 SHA-256。最終 **123** 個 bytes 完全一致；
其餘 **7** 個在既有 WIP 上加入本次增量：README、Asset-Readers、package/package-lock、
server.ts、component-recovery.test.ts、write-tools.test.ts。
比對復原後的 baseline bytes，未使用 HEAD 覆寫這些 dirty files。
HEAD 與 `git ls-files --stage` logical index 完全一致；沒有意外 drift。

下列指定 WIP 保持原 bytes：scripts/node-source-update.ps1、tests/test-node-source-update.ps1、
docs/ReadOnlyG2Evidence.md、docs/RemoteMcpComponentRecoveryEvidence.md，及原先 1.8.0 的
archives.ts、archive-transfer.ts、archive-server.ts、archives.test.ts、path-guard.ts、file-transfer.ts。

本次修改的既有檔案：`.env.example`、`README.md`、`docs/Asset-Readers.md`、
`package.json`、`package-lock.json`、`src/server.ts`、`src/http-main.ts`、`src/index.ts`、
`tests/component-recovery.test.ts`、`tests/write-tools.test.ts`。

新增：`src/segmented-transfer.ts`、`src/segmented-transfer-server.ts`、`src/transfer-streams.ts`、
`src/transfer-zip-validation.ts`、`src/transfer-budget.ts`、`tests/segmented-transfer.test.ts`、
`scripts/reassemble-transfer.py`、`docs/Segmented-Transfer.md`、本紀錄。
任務追蹤文件位於 ignored `docs/agent-runs/segmented-transfer/`。

已檢閱相對 task baseline 的精確增量 diff，包含 route/schema、來源/暫存路徑邊界、串流和計數器、
恢復與 cleanup、測試與文件。使用者 reviewer 指出的 fanout/time、PowerShell glob、初始化 Promise
與大型既有 ZIP entry ceiling 均已處理並回歸。沒有新增 dependency、MCP shell 工具或政策放寬。

完整可檢查資料留在 ignored `.local/segmented-transfer-evidence/`：
`baseline-files.json`、`baseline-head.txt`、`baseline-index.txt`、`incremental-source.diff`、
`wip-final.json`、`build-final.log`、`focused-final.log`、`full-final.log`、`asr-result.json`。
其中 `wip-final.json` 列出本次各檔案 SHA-256，原始較早失敗 logs 也保留。

## 未驗證的界線

- 正式 runtime 仍為 **1.8.0 / 2026-11-08.1**，當次 active MCP `workspace_info` 回報
  buildId `2c22d44f11028fd8cb69`。新 tools 的正式 runtime adoption/discovery 尚未進行。
- ChatGPT 是否把 octet-stream 分片顯示為可下載附件、MIME/檔名處理、預讀行為皆 **UNVERIFIED**。
- 真實 100 GB input/output/transfer、>4 GiB 單一實體 entry、長時間滿額磁碟與實體斷電恢復皆 **UNVERIFIED**。
  不以小型/計數器測試宣稱 100 GB production-capable。
- 恢復已完成分片；未完成 capture 會失敗並清理，沒有跨重啟續壓縮。
  Payload 記憶體 O(chunk)，名稱碰撞 metadata 另有 100,000-entry 上限。
- 實務 timeout/TTL、四工作、一封裝與磁碟空間限制仍有效；詳見 API 文件。

後續 runtime source-update 與 ChatGPT 附件驗收需要另一個明確授權的任務。
