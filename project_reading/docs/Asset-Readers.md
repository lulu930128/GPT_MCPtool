# 圖片、Office、PDF 與 ZIP 檔案讀取

專用 reader 提供下列格式解析、原始檔案與音訊回傳工具：

- `inspect_asset`：查看圖片、`.xlsx`、`.docx`、`.pptx` 的基本資訊與容器安全結果。
- `read_image`：回傳 JPEG、PNG、WebP 或 GIF 的安全預覽；GIF 固定轉為靜態 PNG。
- `read_spreadsheet`：讀取 `.xlsx` 的指定工作表與 A1 範圍。
- `read_document`：讀取 `.docx` 的段落、標題與表格結構。
- `read_presentation`：依簡報順序讀取 `.pptx` 的投影片標題與文字；講者備註需明確開啟。
- `fetch_asset`：原封不動回傳通過相同 asset scope、path guard、deny policy 與大小限制的檔案 bytes。
- `read_audio`：以 MCP AudioContent 回傳允許的原始音檔。
- `inspect_pdf`：檢查 `.pdf` 頁數、metadata 與主動內容安全狀態。
- `read_pdf_text`：擷取 bounded page window 的文字。
- `read_pdf_page`：將單頁 bounded render 成 metadata-stripped PNG。

## ZIP 壓縮傳輸與受限讀取

`start_segmented_transfer` 自 1.9.0 提供，沿用 asset/file-return scope。V2 的 `read_file`、`read_files` 使用 workspace root，可讀 `.git` 與 raw DB/binary，並透過同一 Owner 分段。下表的格式與限制適用於專用 Asset/ZIP 工具。舊 8–12 MiB part 的同 taskId range、原 URI 相容性、SHA-256 與接收端驗證見 [分段傳輸](Segmented-Transfer.md)。
以下 1.8.0 小 ZIP 工具、限制、single-use URI 與 return contract 均保持不變。

Source `1.8.0` / contract `2026-11-08.1` 新增下列工具，所有 input/output 都有宣告 schema：

| 工具 | 輸入 | 結果 |
| --- | --- | --- |
| `package_folder_zip` | `scope`, `path`（既有資料夾） | DEFLATE level 6 ZIP 的 `resource_link`、檔名、size、SHA-256、resource URI、到期時間、included/skipped 與原因 |
| `fetch_zip` | `scope`, `path`（既有 `.zip`） | 驗證所有 entries 後回傳原始 ZIP 的 `resource_link`；來源不刪除 |
| `inspect_zip` | `scope`, `path` | 大小、SHA-256、entry 數量、展開總量、denied 數量與完整性範圍 |
| `list_zip_entries` | `scope`, `path`, `offset?`, `limit?` | 最多 200 筆 metadata、allowed/reason、CRC 狀態及 `nextOffset` |
| `read_zip_entry` | `scope`, `path`, `entry`, `offset?`, `maxBytes?`, `encoding?` | entry SHA-256／CRC32、bounded byte window、`eof` 與 `nextOffset`；預設 `base64`，可指定 `utf8` |

例如既有 `projects` asset scope 指向 `projects:.` 且已列入 file-return scopes 時：

```json
{"scope":"projects","path":"asr"}
```

將此參數交給 `package_folder_zip` 即可壓縮 `projects/asr`；使用者不指定輸出檔案路徑。
`fetch_zip` 的 path 則例如 `asr/export.zip`。這些工具沿用目前的
`WORKSPACE_MCP_ROOTS`、`assetScopes`、`fileReturnScopeIds`，沒有新增授權層或修改設定。
ZIP inspect/list/read-entry 需要 asset scope；兩種整包回傳另需既有 file-return scope。

只有專用 ZIP reader 對最終 `.zip` 副檔名有窄例外；一般 `fetch_asset`、文字 reader 與
全域 deny list 不變。來源資料夾及每一檔案均通過 shared path guard、scope containment、
祖先檢查及讀前／讀後 identity 檢查。來源不寫入、不刪除。禁止目錄／檔名／副檔名與
資料夾內 symlink/junction 會列入 `skipped`；目錄以 `subtree=true` 表示整個子樹排除，
不進入該子樹計算檔數。只要有排除就回 `complete=false`，不能描述成完整備份。
直接指定 symlink/junction、hardlink、特殊檔、無法安全命名或變動中的來源會失敗。

既有 ZIP 的安全 metadata 可列出 denied entry 及原因，但不讀其 payload；整包 `fetch_zip`
若有任何 denied entry 會拒絕。entry 套用 ZIP 所在目錄的 root-specific deny policy。
不提供解壓、任意寫入、刪除或外部命令工具。檔案內容保持 untrusted data。

| ZIP 限制 | 值 |
| --- | --- |
| 輸出 ZIP／既有 ZIP 檔大小 | 既有 `maxFetchFileBytes`，預設 **12 MiB**，未提高 |
| 單一展開 entry／來源檔 | 16 MiB |
| 展開總量／來源總量 | 48 MiB |
| 掃描／ZIP entries | 2,048，含目錄與被排除項目 |
| entry 路徑 | 32 層、512 UTF-8 bytes |
| 單次 entry 回傳 | 預設 64 KiB；最高 `min(256 KiB, floor(maxReturnedBytes/4)*3)` |
| 掃描／壓縮、ZIP 檢查期限 | 各 15 秒 |
| 同時進行的 archive operations | 每程序 2 個 |
| 尚未領取的 temporary ZIP | 每程序最多 8 個、10 分鐘 TTL，30 秒清理週期 |

展開量與傳輸量分開限制：13 MiB 的可壓縮單檔可產生小於 12 MiB 的有效 ZIP。
壓縮後 ZIP（包含 headers）超過既有 cap 仍失敗，不回傳部分 ZIP。
高壓縮比本身不視為錯誤；bomb 防護依 metadata 與實際 inflation bytes、單檔／總量、
entry count 及期限檢查。驗證 local/central headers、宣告長度與 CRC32，拒絕 traversal、
絕對路徑、Windows ADS／device names、名稱碰撞、重疊 entries、symlinks、加密、ZIP64、
多磁碟及不支援的 compression。支援 STORE／DEFLATE 讀取、UTF-8／CP437 名稱與 Windows
分隔符；產生 ZIP 使用 UTF-8 與 `/`。entry 不會再遞迴解壓；nested `.zip` 仍受 deny policy。
`utf8` byte window 必須切在有效 UTF-8 邊界，否則明確報錯，可改用 `base64`。

### 暫存資源清理的精確保證

沿用 SDK `resource_link → resources/read` 與 base64 blob。Temporary ZIP 使用
`workspace-zip-temp:` URI；現存 ZIP 使用 SHA-256 綁定的 `workspace-zip:` URI。

- 發出 link 時保留 ZIP；第一次 resource read 先原子 claim，再驗證當下 scope／deny policy、
  完整 bytes、SHA-256 與 CRC，移除 server-owned 檔案後將 bytes 交給 SDK。
- resource read／完整性／政策失敗也會清理。成功緩衝後即使 SDK 傳送失敗，暫存檔已清除。
  重複／併發／過期／未知 URI 拒絕，需重新封裝；現存 ZIP link 可重讀，每次驗證內容未變。
- 未領取或工具回應遺失的 ZIP 在 TTL 後由週期清理，正常運作時最多再等一個 30 秒週期。
  OS 阻擋刪除時資源保持鎖定、stderr 報告並重試，不回傳成功或任意刪除其他檔案。
- 暫存檔位於 OS temp 的專屬 `project-workspace-zip-v1` 目錄，採 exclusive-create 與亂數檔名。
  程序崩潰／強制終止時無法承諾即時清除；下次封裝初始化與週期掃描只回收此專屬目錄內
  符合 owned filename 格式的過期普通檔，不跟隨 symlink、不遞迴刪除。

SDK 沒有瀏覽器下載完成 ACK。這裡保證的是 **resource callback 完整緩衝後、SDK 傳送前清理**，
不是 ChatGPT／瀏覽器已儲存檔案；host 若先預讀一次，後續再要求讀取會得到 single-use 錯誤。
這個 host 行為及實際 ChatGPT 下載需獨立 E2E 驗收。
參考 [MCP resources 規格](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)。

### 安裝與後續採用

全新 checkout 在 `project_reading` 執行 `npm ci`、`npm run build`、`npm test`。
1.8.0 的 ZIP 工具將既有 `jszip@3.10.1` 列為 runtime dependency。

正式更新須另行確認允許中斷目前 runtime 請求，再沿
[既有 CC source-update owner](LocalComponentManagement.md#2026-10-28-phase-2source-update-v2)：
以 `componentId=project_reading`、`action=update_from_source`、`idlePolicy=wait_for_idle`
及新 immutable `versionId` 呼叫 `mcp_component_update_preview`；保留 preview 的
`expectedSourceDigest` 與同一 UUID `requestId` 提交 update，使用必要的
`confirmation=interrupt_current_requests`，並查原 receipt。
核對該次 Owner 收據的 prepared/observed buildId、Ready、正式 MCP 的 applicationVersion、toolContractVersion 與 `tools/list`。ZIP 工具最初在 1.8.0 驗收；Host 的下載與 single-use 行為須在對應版本另行實測。

## Asset scope

二進位檔案不直接沿用任意 `root` 參數。管理者必須另設
`WORKSPACE_MCP_ASSET_SCOPES`：

```text
WORKSPACE_MCP_ASSET_SCOPES=projects=projects:.;shared=work:shared-assets
```

格式是 `scope_id=root_id:relative_path`，多筆以分號分隔。未設定時，所有
asset tools 預設全部拒絕。既有的 root allowlist、realpath containment、
denied directory、denied filename 與 denied extension 規則仍然優先套用。

Tray 使用者可以在 ignored 的 `.local/tray-settings.json` 加入：

```json
{
  "assetScopes": "projects=projects:.;shared=work:shared-assets",
  "fileReturnScopes": "projects"
}
```

## 預設限制

| 類型 | 預設值 |
|---|---:|
| 圖片來源檔 | 50 MiB |
| 圖片解碼像素 | 100,000,000 |
| 圖片輸出長邊 | 4,096 px |
| 圖片 MCP 輸出 | 12 MiB |
| 原始檔案回傳 | 12 MiB |
| XLSX 來源檔 | 25 MiB |
| XLSX 解壓後總量 | 100 MiB |
| XLSX ZIP entries | 2,048 |
| 單次儲存格 | 5,000 |
| 單次列／欄 | 500／100 |
| DOCX／PPTX 來源檔 | 100 MiB |
| DOCX／PPTX 解壓後總量 | 500 MiB |
| DOCX／PPTX ZIP entries | 4,096 |
| 單一 Office XML part | 10 MiB |
| 單次 Office XML 擷取總量 | 50 MiB |
| 單次 Office 回傳文字 | 100,000 字元 |
| 單次 Word blocks／表格 cells | 300／5,000 |
| 單次 PowerPoint slides | 50 |
| PDF 來源檔 | 50 MiB |
| PDF 頁數 | 500 |
| 單次 PDF 文字頁數 | 10 |
| 單次 PDF 回傳文字 | 100,000 字元 |
| PDF render 長邊 | 4,096 px |
| PDF render 像素 | 16,777,216 |
| PDF PNG 輸出 | 12 MiB |
| PDF operation timeout | 15 秒 |

所有限制都可用 `.env.example` 所列環境變數調整。來源檔上限與 MCP
輸出上限刻意分開；提高可讀來源大小不代表直接回傳同樣大的 payload。

## 原始檔案回傳

原始檔回傳比 normalized reader 多暴露完整檔案，因此除 `WORKSPACE_MCP_ASSET_SCOPES`
外，還必須明確列出可回傳原檔的 scope id；未設定時 `fetch_asset` 預設拒絕：

```text
WORKSPACE_MCP_FILE_RETURN_SCOPES=projects,shared
```

`fetch_asset(scope, path)` 重用 `resolveAssetFile()`，不接受 absolute path，也不另建公開
中繼目錄。它先以檔案 stat 檢查 `WORKSPACE_MCP_MAX_FETCH_FILE_BYTES`，再讀取固定大小的
原始 bytes，回傳 MIME、basename、SHA-256 與 `workspace-asset:///...` resource link。
URI 不含本機 absolute path，並以 SHA-256 綁定當次內容；若檔案在 link 產生後改變，
`resources/read` 會拒絕回傳舊 identity 下的新內容。

Tool result 只攜帶 `resource_link` 與 metadata；MCP host 呼叫 `resources/read` 時才取得
base64 blob，因此 payload 約比原始檔大三分之一。這個 contract 能證明 MCP host 可讀回
原始 bytes，但不保證每個 host 都會顯示附件或下載按鈕。ChatGPT 的使用者端呈現必須另外
實測；若 UI 不顯示，MCP transport 可視為完成，產品功能仍不得宣稱完成。

目前 OpenAI plugin UI 的檔案下載介面是
`window.openai.getFileDownloadUrl({ fileId })`，它需要 ChatGPT file id。不得假設 embedded
blob 或 resource link 會自動變成 file id，也不得引用不存在的 `downloadFile()`。若 Phase 2 需要 UI，必須先
證明 host 產生 tool file reference，否則另行設計經驗證的受控下載橋接。

## 原始音訊 MVP

`read_audio(scope, path)` 重用 `fetchAsset()` 的 original-file-return 授權、shared path
guard、deny policy 與 bounded read，不新增 scope 或中繼檔。`codex` 維持文字 root，
不得加入 asset/file-return scopes。支援 WAV (`audio/wav`)、MP3 (`audio/mpeg`)、
OGG (`audio/ogg`)、FLAC (`audio/flac`)，不轉檔、不解碼；MIME 依副檔名推定，
SHA-256 只識別回傳 bytes，不代表音訊有效或可播放。

沿用原始檔大小限制。`content` 回傳 MCP AudioContent，metadata 使用 `transport=audio_content`。
自訂播放器、診斷卡與 UI resource 已撤回；host 原生播放能力尚未確認。

## 安全行為

- 圖片只接受可成功解碼的 JPEG、PNG、WebP、GIF，回傳前一律重新編碼且不保留 EXIF。
- GIF 只取第一幀並轉為靜態 PNG；回傳 metadata 會標示來源幀數及是否捨棄動畫。
- XLSX 先檢查 ZIP entry 數、解壓總量、路徑與加密旗標。
- DOCX／PPTX 會先檢查 ZIP entry、解壓總量、XML part 大小與安全路徑。
- 含 macro、ActiveX、OLE、embedded object 或加密旗標的 Office 檔會拒絕。
- Office XML 禁止 DTD 與 entity 宣告；外部 relationship target 不會被抓取或回傳。
- Word 的 tracked insertion 會納入，tracked deletion 會排除；header、footer、comment、
  footnote、endnote、圖片及版面不會回傳。
- PowerPoint 依 presentation manifest 決定投影片順序；media、chart、SmartArt 幾何、
  animation、comment 與版面不會回傳。`includeNotes` 預設為 `false`。
- PDF bytes 只會在 lazy、序列化的隔離 worker 內交給 PDF.js；worker 有記憶體上限，
  每次 operation 有 timeout，超時只終止並重建該 worker。
- 加密／密碼保護、JavaScript action、自動 open action、embedded file 的 PDF 會 fail closed。
  外部 target 不會被抓取；頁面只會回傳 bounded PNG 或 bounded text。
- 檔案內容一律視為不可信資料，不得當作代理指令。

## 回傳定位

Word 與 PowerPoint 是「結構化 OOXML 文字擷取」，不是 Office 畫面渲染。適合摘要、
搜尋、問答與內容檢查；若問題依賴文字框位置、圖表視覺、頁首頁尾或動畫，工具會在
warnings 明確告知未涵蓋範圍，不應把文字擷取結果當成版面證據。PDF 文字擷取同樣不是
版面證據；需要圖表、欄位、幾何或掃描頁判讀時，應使用 `read_pdf_page`。
