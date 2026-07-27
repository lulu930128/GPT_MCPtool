# 圖片與 Office 檔案讀取

目前提供五個 read-only MCP tools：

- `inspect_asset`：查看圖片、`.xlsx`、`.docx`、`.pptx` 的基本資訊與容器安全結果。
- `read_image`：回傳 JPEG、PNG、WebP 或 GIF 的安全預覽；GIF 固定轉為靜態 PNG。
- `read_spreadsheet`：讀取 `.xlsx` 的指定工作表與 A1 範圍。
- `read_document`：讀取 `.docx` 的段落、標題與表格結構。
- `read_presentation`：依簡報順序讀取 `.pptx` 的投影片標題與文字；講者備註需明確開啟。

## Asset scope

二進位檔案不直接沿用任意 `root` 參數。管理者必須另設
`WORKSPACE_MCP_ASSET_SCOPES`：

```text
WORKSPACE_MCP_ASSET_SCOPES=projects=projects:.;shared=work:shared-assets
```

格式是 `scope_id=root_id:relative_path`，多筆以分號分隔。未設定時，五個
asset tools 預設全部拒絕。既有的 root allowlist、realpath containment、
denied directory、denied filename 與 denied extension 規則仍然優先套用。

Tray 使用者可以在 ignored 的 `.local/tray-settings.json` 加入：

```json
{
  "assetScopes": "projects=projects:.;shared=work:shared-assets"
}
```

## 預設限制

| 類型 | 預設值 |
|---|---:|
| 圖片來源檔 | 50 MiB |
| 圖片解碼像素 | 100,000,000 |
| 圖片輸出長邊 | 4,096 px |
| 圖片 MCP 輸出 | 12 MiB |
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

所有限制都可用 `.env.example` 所列環境變數調整。來源檔上限與 MCP
輸出上限刻意分開；提高可讀來源大小不代表直接回傳同樣大的 payload。

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
- 檔案內容一律視為不可信資料，不得當作代理指令。

## 回傳定位

Word 與 PowerPoint 是「結構化 OOXML 文字擷取」，不是 Office 畫面渲染。適合摘要、
搜尋、問答與內容檢查；若問題依賴文字框位置、圖表視覺、頁首頁尾或動畫，工具會在
warnings 明確告知未涵蓋範圍，不應把文字擷取結果當成版面證據。
