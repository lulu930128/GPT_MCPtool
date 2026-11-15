# 大檔分段傳輸

Source **1.9.0 / contract 2026-11-08.2**。這是既有 archive 模組的 in-process extension，
共新增四個 tools 與一種 resource URI，沒有新服務、listener、approval gate 或 workspace 寫入工具。
1.8.0 的 `package_folder_zip`、`fetch_zip`、`inspect_zip`、`list_zip_entries`、`read_zip_entry`
及其限制、schema、single-use 暫存行為維持不變。

## API 與操作順序

| 工具 | 參數 | 用途 |
| --- | --- | --- |
| `start_segmented_transfer` | `scope`, `path`, `kind: folder/file/zip`, `chunkBytes?` | 回傳 `taskId` 與 `running`，背景開始擷取；不等待整包壓縮 |
| `get_segmented_transfer` | `taskId` | 工作狀態、輸入/輸出/傳送 bytes、chunk/entry/skipped 數量、到期、hash、錯誤與 cleanup 狀態 |
| `list_segmented_transfer` | `taskId`, `collection: parts/entries`（預設 parts）, `offset?`, `limit?` | ready 後取分頁 manifest；parts 同時回 MCP resource_links；entries 宣告 included/skipped |
| `finish_segmented_transfer` | `taskId`, `action: cancel/complete/cleanup`, `archiveSha256?` | 只清理此工作的 server-owned staging；complete 須帶重組後驗證的全檔 SHA-256 |

例如目前已設定的 `projects` scope，傳入：

```json
{"scope":"projects","path":"asr","kind":"folder"}
```

1. 保存 start 回傳的 `taskId`，輪詢 status 至 `ready`、`failed`、`canceled` 或 `expired`。
2. `ready` 表示擷取完成；另看 `complete`。`skippedEntries>0` 時必為 `complete=false`，不是完整備份。
3. 以 `collection=parts,offset=0,limit=20` 取得第一頁，沿 `nextOffset` 至 null。
   每頁保留完整 `structuredContent` JSON。下載每個 link，保留 manifest 所指定的檔名。
4. 若要知道排除項，另取 `collection=entries`；每筆 skipped 有 path、reason、subtree。
   `subtree=true` 表示整個目錄排除，未進入計算其內部檔數。
5. 離線驗證每片與全檔後才 complete；沒有瀏覽器或 ChatGPT 的完成 ACK。
   需要中止時 cancel；不再需要下載時 cleanup。清理非同步，回 `cleanupPending=true` 時繼續查狀態。
   `cleaned=true` 或其後 `Unknown transfer` 表示工作資料已清理、墓碑已回收。

狀態為 `running → ready → completed`，或 `failed/canceled/expired`。
失敗時不發布部分 archive。`archiveSha256=null` 代表尚無完成的整包 hash。
`sourceBytes` 是實際納入的來源 bytes；`archiveBytes` 是原檔或 ZIP（含所有 headers）；
`expandedBytes` 只在既有 ZIP 額外列出驗證過的解壓總量。
`createdAt`、`expiresAt` 是 UTC Unix milliseconds。
entries 的 included file 帶完整 source SHA-256；directory hash 為 null。
parts 的 index 從 0 起、offset 是重組檔案中的 byte offset、length 是該片 bytes。
`integrity=captured_bytes_sha256_verified` 指擷取當時完整 byte stream hash；每次下載另驗證該片磁碟 bytes。
這不是原始目錄的原子 filesystem snapshot，也不是主機收到附件的證據。

## Bytes 硬限制與實務限制

| 限制 | 契約 |
| --- | --- |
| 每工作累計下載 payload | **100,000,000,000 bytes（decimal 100 GB）**，包括 retry、host prefetch 與 SDK 傳送失敗但已保留的讀取 |
| 來源輸入 | 另有 **100 GB** 上限；folder 計入 allowed file bytes，file/ZIP 計原檔 bytes |
| 既有 ZIP 展開量 | 另有 **100 GB** 上限，實際 streaming inflation 與宣告值都驗證 |
| 每工作 archive output | **100 GB**，ZIP headers 與壓縮後擴張也計入；超過則失敗 |
| 所有保留工作 staged payload | 合計 **100 GB**；metadata 另受檔數、名稱與固定記錄長度限制 |
| chunk | 預設 8 MiB，範圍 1 MiB 至 `min(maxFetchFileBytes,12 MiB)`；不改既有 fetch cap |
| 頁面 | 預設 20、最大 100 筆，parts 與 entries 各自分頁 |
| 工作 | 一次一個封裝；最多四個保留工作（含等待清理與未到期孤兒） |
| folder entries | 最多 100,000，包含目錄與 skips；沒有額外 4,096 單目錄門檻 |
| 既有 ZIP entries | 分段 reader 為 100,000，與 folder writer 一致；原本 inspect_zip/fetch_zip 仍為 2,048 |
| 名稱 | 沿用 32 層、512 UTF-8 bytes 與 portable name 檢查 |
| 封裝時間 | 預設 3 天；`WORKSPACE_MCP_TRANSFER_WORK_MS` 可設定 1 分鐘至 14 天 |
| 保留時間 | 從 start 起預設 7 天；`WORKSPACE_MCP_TRANSFER_TTL_MS` 可設定 1 分鐘至 14 天 |

時間限制是可設定的資源保護，不是 100 GB 邏輯上限。需讓 TTL 留出壓縮後的下載時間；
兩者先到者停止工作。工作到期不因讀取自動延長。正常程序每 30 秒清理；大量碎片或 OS 刪除失敗可能更久，
會保持 cleanupPending、保留容量並記錄 stderr，下一輪重試。沒有宣稱真實 100 GB 長時間運轉已驗收。

`transmittedBytes` 計 **decoded chunk payload bytes**。Base64 約增加三分之一，JSON/TLS/manifest
不屬於此 payload 計數；不得將 100 GB 描述成同額網路 wire bytes 或 ChatGPT 附件配額。
已接近 100 GB 的工作，重讀會壓縮剩餘額度；額度耗盡後即使缺片也不能繞過原工作重讀。
任何無法確認傳送結果的保留額度不退回，以免程序崩潰後重複傳送超過 cap。
額度使用固定兩個 slot 的 checksum ledger，先寫入並 fsync 才交給 SDK；JSON 狀態快照回退
不會退還已保留額度，ledger 不會因重讀次數增加而無限成長。

檔案用 64 KiB 讀取與 zlib streaming DEFLATE level 6，背壓直接寫進 staged parts；
ZIP64 local/central headers、64-bit descriptors/end records 自動完整產生，即使小 ZIP 也採 ZIP64。
central directory、parts index、entries、來源 identity ledger 都 spooled 到磁碟，不累積 archive Buffer。
payload 記憶體為 O(chunk)，另有受全域 100,000 entries 限制的名稱碰撞 metadata；
既有 ZIP 的名稱碰撞 metadata 同樣受 100,000 entries 上限約束。磁碟為 staged parts 加 bounded metadata，沒有另一份整包 ZIP。
小於 1 MiB 的 configured fetch cap 會使新功能無可用 chunk 範圍，不提高 cap。

## 政策、恢復與清理

沿用 WORKSPACE_MCP_ROOTS、assetScopes、fileReturnScopes、shared path guard、root-specific deny。
來源每檔讀前/後及整個擷取結束再查 identity；變動、消失或 OS 失敗會使工作失敗。
資料夾中的 deny、symlink/junction、hardlink、特殊檔排除且列入 manifest；直接指定的這類來源拒絕。
既有 ZIP 僅 final `.zip` 使用既有窄例外；全部 entries 需通過 deny、CRC、size、local/central header 檢查。
拒絕 encrypted、特殊 entries、重疊/prefixed/reordered local records、alternate Unicode path fields、不支援 compression。
這些是明確的 reader 相容性限制，不能以 file 模式繞過 ZIP deny。

`workspace-transfer:///{taskId}/{index}?sha256=...` 沿既有 SDK `resource_link → resources/read` 回傳 base64 blob。
片段使用 `application/octet-stream` 與 `.part-000001` 等名稱，並非單片可開啟 ZIP。
連結產生和預讀都不刪檔；讀取可重試，直到 expiry/cleanup 或總傳送額度不足。
Host 對 MIME、檔名、附件下載 UI 的行為仍須真實 E2E，不能從 MCP schema 推定。
start response 遺失會留下有限期工作，不自動重送；若未保存 taskId，等待 TTL 回收。

staging 位於 OS temp 的 `project-workspace-transfer-v1`，採 exclusive-create、private mode、
固定檔名、path guard、非 symlink/hardlink 檢查與程序 owner lock。只刪自己的精確普通檔，從不遞迴刪目錄。
同一 OS 使用者仍是既有信任邊界，這不是對同身分惡意程序的硬隔離。
啟動先恢復 staging；ready jobs、hash 與 durable read budget 可續用，running jobs 標記 INTERRUPTED 並清理。
不自動接續未完成壓縮，以免混合兩次來源狀態。損壞 state 不提供下載、不重置額度；待 timestamp 到期清理。
活 owner 的 lock 拒絕使用；初始化失敗會釋放本次 lock 與 partial state，後續真實呼叫可於條件解除後重新初始化，
不重啟程序、不改權限、不替換入口。無法辨識的 owner lock 必須保留並報錯，不能推測無 owner 而刪除。
政策/roots/scopes fingerprint 改變後拒絕下載，不會把舊 scope 的 snapshot 移交新 scope。

## Windows 離線重組

把所有 **parts collection 的 structuredContent JSON** 放進單一 manifest 目錄，下載的 parts 放另一個目錄。
只掃描該層 `.json`，不遞迴；混入另一工作、重複 index 或缺頁都拒絕。命令不依賴 PowerShell glob 展開：

```powershell
python .\scripts\reassemble-transfer.py --manifest-dir 'C:\downloads\manifests' --parts 'C:\downloads\parts' --output 'C:\downloads\asr.zip'
```

仍支援明確檔案模式：

```powershell
python .\scripts\reassemble-transfer.py --parts 'C:\downloads\parts' --output 'C:\downloads\asr.zip' 'C:\downloads\manifests\page-0.json' 'C:\downloads\manifests\page-20.json'
```

script 串流驗證每片 length/offset/SHA-256 與全檔 length/SHA-256，不覆寫既有 output，不執行 extract。
失敗只移除本次 exclusive-create 的不完整 output，保留下載片段。若 host 改名，先依 manifest 恢復片段名稱。
Python 只用標準庫；source regression 的獨立 ZIP64 驗證也使用 Python `zipfile`。
執行完整 `npm test` 時，測試環境須有 `python` 在 PATH。

ZIP64 格式依 [PKWARE APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)，
existing ZIP streaming reader 沿用已安裝的 [yauzl](https://github.com/thejoshwolfe/yauzl)，無新增依賴。
Build、隔離 source、正式 runtime、active MCP discovery 與 ChatGPT attachments 是分開的驗收層。
本次逐層結果見 [Segmented-Transfer-Evidence.md](Segmented-Transfer-Evidence.md)。
