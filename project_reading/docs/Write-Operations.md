# 受限寫入與修改

Project Workspace 提供通用檔案操作，適用於 operator 明確授權的筆記、報告、文字資料、JSON 或原始碼目錄。工具不包含特定專案的業務邏輯，也不判定修改後其他應用程式是否已採用資料。

## 模式與啟用

預設維持 `read-only` 與既有 25 個唯讀工具。只有有效且 `enabled=true` 的獨立 policy 才註冊五個寫入工具與 `get_write_operation`。讀取 root 或 asset scope 不會自動取得寫入權。

1. 將 [policy 範例](../examples/write-policy.example.json) 複製至 operator 管理、Agent 無法寫入的位置，例如本元件 ignored 的 `.local/write-policy.json`。
2. 把範例路徑改成已審查的實際 root id 與相對路徑，明確列出 operations／extensions，再設定 `enabled=true`。
3. 設定 `WORKSPACE_MCP_WRITE_POLICY` 為 policy 的絕對路徑。未設定、缺檔或無效 policy 都停用寫入，不擴大權限。
4. 可設定 `WORKSPACE_MCP_WRITE_STATE_DIR`。預設為 `%LOCALAPPDATA%\ProjectWorkspace\write-state`；此資料夾必須位於所有 workspace roots 之外，不得透過另一個 root alias 開放。
5. HTTP operate mode 必須綁定 loopback，且 `WORKSPACE_MCP_HTTP_TOKEN` 至少 32 字元。請使用隨機 token，透過 operator 的本機秘密設定交付 server 與受信任 client，不可寫進 policy 或 Git。所有持有此 token 的 client 共享這份 write policy，沒有隱含的 per-user 權限隔離。
6. 啟動 operator 核准的 runtime 後，檢查 `workspace_info`、`/health`、`tools/list` 與指定測試目錄的一次完整讀取／寫入流程。

STDIO 的 trust boundary 是 operator 授權的本機程序啟動。HTTP 拒絕帶有 `Origin` 的 browser 直連請求；遠端使用仍需受控、已驗證身分的 transport，不能直接公開 loopback writer。

既有 controller 支援在 ignored 的 `.local/tray-settings.json` 保存 `writePolicyPath`、`writeStateDirectory`、`httpTokenFile` 三個絕對路徑。token 檔案只含隨機 token，放在 operator 保護的 `.secrets`，不得進 Git。明確參數／既有環境變數優先於本機設定；HTTP token 參數或環境變數未設定時才讀 token 檔。controller 會把同一 token 傳給 server 與 tunnel 的 MCP／discovery headers；程序參數只含環境變數參照，不包含 token 本文。正式採用前應核對有效設定。

policy 在每次寫入準備與提交前重新驗證 digest。修改、撤銷、刪除 policy 後，舊 runtime 拒絕寫入，`workspace_info`／`health` 顯示停用原因；新 policy 需由 operator reload 後採用。工具清單在 session 建立時註冊，撤權後舊 session 可能仍列出工具，但執行一定重新檢查 policy。

## Policy 契約

### 已設定路徑預設讀寫

若 operator 希望所有明確加入 `WORKSPACE_MCP_ROOTS` 的路徑自動可讀寫，可使用：

```json
{
  "version": 1,
  "enabled": true,
  "defaultRootAccess": "read-write",
  "rules": [],
  "deny": []
}
```

這個設定在每次啟動時為已設定 roots 產生五個操作的預設規則，涵蓋所有未被既有安全規則阻擋的 UTF-8 文字檔，包括無副檔名與原始碼。之後加入的 root 會在 reload 後自動套用。一般安裝未設定 policy 時仍唯讀；`defaultRootAccess` 省略時是 `read-only`。

defaults 不覆蓋 deny 或精確 JSON 欄位限制，也不開放 binary、資料庫、secrets、hidden 路徑、`.codex`、`.agents` 或 Project Workspace 自身。位於受保護目錄內的整個 root 不產生預設 grant；包含受保護子目錄的 root，其餘正常路徑仍可操作。既有讀取 root-specific 排除繼續生效。

### 個別規則

- `version=1`，未知欄位／未知 root／無效路徑／超過 hard caps 均無效。
- 路徑支援精確檔案／目錄、尾端 `/**` 子樹，或 `**` 表示整個已設定 root；不支援其他 glob。例：`notes/**` 包含 `notes` 本身與其後代，不包含 `notes-other`。
- `deny` 優先；既有 global／selected-root deny 不可由 allow 覆蓋。write policy 的 deny 與 JSON 欄位限制依實際路徑比對所有重疊 roots，不能藉另一個 root id 繞過。
- 個別檔案規則必須明列副檔名，或使用 `extensions: ["*"]` 允許所有通過安全檢查的文字檔；`.ts`、`.py` 等 source 可以授權，工具不執行它們。
- `make_directory(parents=true)` 需要每一個待建立父目錄均具有 directory permission；建立檔案不會偷偷建立父目錄。
- `jsonFields` 是可選的額外約束，只用於精確 JSON 檔案。定義後該檔只能經 `update_json_value` 修改，即使其他 broad rule 允許 patch／append 也不可繞過。
- 欄位限制支援 exact JSON Pointer、type、enum、數值 minimum／maximum 與字串 maxLength；這不是完整 JSON Schema，也不取代應用程式 domain 驗證。沒有欄位限制的 JSON，可修改任一安全且已存在的 pointer。
- `.git`、秘密／憑證、資料庫、模型權重、hidden 路徑、`AGENTS.md`／`SKILL.md`、policy 目錄，以及 Project Workspace 自身 source/runtime 均不可寫。保護依 physical path 實施，不能藉改 root id 繞過。

## 工具與讀取流程

所有 mutation 都必須提供 `root`、相對 `path`、新 `operation_id` UUID。root 沒有預設值。

| 工具 | 必要資料與行為 |
| --- | --- |
| `create_text_file` | `content`；只建立新檔，不接受 overwrite；父目錄須存在 |
| `append_text_file` | `content`；`create_if_missing=true`；可額外指定 expected_sha256 |
| `patch_text_file` | 必填 `expected_sha256`；1–20 個 exact find／replace；expected_count 預設 1，任一不符全部拒絕 |
| `update_json_value` | 必填 `expected_sha256`、非 root 的 JSON Pointer 與 value；只修改已存在欄位／array index |
| `make_directory` | `parents=true`；已存在目錄回傳 changed=false |
| `get_write_operation` | 只讀指定 operation_id 的持久化結果，不讀原始 audit 檔案 |

修改前呼叫：

```json
{"root":"projects","path":"Example Project/notes/report.md","includeSha256":true}
```

`read_file` 會在既有 source size cap 內，讀取一份有效 UTF-8 的完整原始 bytes 快照，再從該快照產生 bounded 文字視窗及 SHA-256。hash 包含 BOM、CRLF 與未回傳的行，不能改為對回傳文字自行計算。其他讀取工具維持原有行為；`read_files` 不提供 hash。

首次修改示例（UUID 每次新操作重新產生）：

```json
{
  "root": "projects",
  "path": "Example Project/notes/report.md",
  "operation_id": "11111111-1111-4111-8111-111111111111",
  "expected_sha256": "<read_file 回傳的完整 SHA-256>",
  "operations": [{"find":"原文字","replace":"新文字","expected_count":1}]
}
```

patch 回傳 bounded context diff，不保證完整 unified diff。需要完整審查時重新讀檔或使用既有 Git diff；ignored 檔案通常不會出現在 Git diff，須直接讀回。

## 資料保留與格式

- 第一版只寫 UTF-8，拒絕 NUL、非法 UTF-8 與會被替換的未配對 surrogate。
- append 保留原始 bytes prefix，在檔案大小上限內，使用完整新快照 atomic replace；不是無限增長的串流 log。
- JSON／JSONL 不論由哪個 tool 建立或修改，結果都必須可解析。JSONL 每筆獨立一行、以換行結束，不接受空白紀錄或半行紀錄。
- JSON update 保留可辨識的縮排／換行／BOM，但會重新序列化 JSON。重複 object key、超過安全整數範圍、過深 nesting 與 prototype-related pointers 會拒絕，避免靜默改變資料。無語意變更時保留原 bytes。
- YAML／TOML 可在明確授權副檔名後以文字方式建立／patch，但不提供 parser/schema 或 comment-preserving 結構化更新。

## 並行、原子提交與不確定結果

同一 config 的 MCP session 共享 writer queue。所有使用相同 state directory 的 writer 另以 exclusive `writer.lock` 序列化；其他 process 忙碌時回傳 `WRITE_BUSY`，不接管已有 lock。

檔案先寫同目錄唯一 temp、flush／fsync，提交前重新驗證 policy、父目錄 identity、target identity 與原始 hash。新檔使用 hard-link publication 避免 overwrite race；既有檔案使用 rename/replace。temp 不供讀取工具回傳。檔案系統必須支援所需操作，失敗時不退回直接 truncate/write。

每次操作先保存 pending receipt 與開始 audit，再提交資料，再寫完成 audit／receipt：

- 回應遺失：使用**相同 UUID 與相同參數**重試，或查 `get_write_operation`。已完成操作回傳收據，不再修改。
- UUID 配上不同參數：`OPERATION_ID_CONFLICT`。
- pending 或提交後無法確認 audit／receipt：`OPERATION_OUTCOME_UNKNOWN`、`applied="unknown"`，禁止用新 UUID 盲目重做。
- 建立多層目錄中途 I/O 失敗可能已建立部分父目錄，回報 unknown，不自動刪除已建立目錄。
- 拒絕／提交前失敗：`applied=false`。結果同時透過 MCP `isError` 與 structuredContent 回傳。

操作收據是去重依據，不能因為成功收到回應就刪除。這提供程序中斷後的恢復線索，不是跨多個檔案的 transaction，也不宣稱斷電後的完整 filesystem durability。

## Audit、容量與 operator 恢復

state directory 保存 `operations/<uuid>.json`、`write-audit.jsonl` 與 lock。Audit 只包含操作／路徑／digest／結果 metadata，不保存輸入全文；收據可能包含 bounded diff 或 JSON old/new value，所以必須與私人資料同等保護，不得進 Git 或公開 root。

### Windows AppData 重導

部分 Windows 封裝環境會把 AppData 重新導向套件的 `LocalCache`，即使 `lstat` 不是 symlink，`realpath` 也可能不同。這與 [Microsoft 說明的 AppData virtualization](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-prepare) 相符。

1.6.1 對 operator state anchor 先檢查完整實體 ancestry，並以 volume/file identity 確認原路徑與 canonical 路徑是同一個目錄；只有這項檢查通過才綁定實體位置。若目錄原先不存在，首次建立空 state 目錄後會重新檢查，通過後才建立 lock／audit／receipt。原設定與實體位置都必須在所有 workspace roots 之外。

這個例外不套用到 workspace 寫入目標，也不放行實際 symlink／junction 或 state 內部的路徑跳轉。無法確認身分、實體位置與原物件不同或落入可讀 root 時仍拒絕。`SYMLINK_DENIED` 的 public code 保持相容，內部錯誤訊息區分 symlink node 與 canonical path mismatch。

若使用多種 launcher 或切換封裝環境，operator 應把已確認的實體 state 位置保存在本機 `writeStateDirectory`，讓不同 launcher 使用同一份收據。不得透過改成空資料夾來繞過原 state 的故障；本修正不搬移、不刪除既有 state。

成功、no-op 與進入 writer 後的拒絕都有 audit。未啟用 writer、MCP schema／transport 拒絕、payload 超限、lock 或 journal 容量拒絕可能尚未建立收據；caller 仍取得明確錯誤。state/audit 無法保存時不會開始新的檔案提交，提交後失敗則回報 unknown。

預設上限：256 KiB request、2 MiB target file、2,048 個 receipts、64 MiB 累計接受的 request bytes、32 MiB state。容量包含失敗與 pending 操作的收據預算；到達上限會停止寫入，無自動刪檔／輪替。這些限制控制 writer 的增長，不是整個 workspace 的磁碟配額。

發生 stale lock、pending receipt 或損壞 audit 尾端時：

1. 停用／停止經 ownership 驗證的 writer。
2. 由 operator 檢查 lock 的 PID、程序身分與啟動時間，確認沒有活躍 writer；不能只憑 PID 不存在就自動清鎖。
3. 備份受保護的 state，對照 audit／receipt 與實際目標 hash，人工判定操作結果；保留原 operation ID 的去重紀錄。
4. 只清理已確認失去 owner 的 lock／本工具 temp，修復 journal 後再 reload。

不要刪除整個 state directory 來修復 quota 或 pending；這會失去去重依據。第一版沒有 MCP journal 維修、已提交修改的自動回滾或任意檔案刪除工具。

## 適用邊界與驗證

這層限制 MCP caller 的能力，不是對惡意本機同帳號程序的 OS sandbox。Node 的 pathname API 無法提供對所有外部 editor 的原子 compare-and-swap：最後 hash 檢查到 replace 之間仍有極短 race。因此，寫入 scope 應是 operator 控制、無非合作 writer 的本機目錄；共用資料應由唯一服務 owner 協調更新。

Windows 僅開放一般本機路徑；拒絕 UNC、ADS、junction/symlink、hard-linked target、保留裝置名與歧義尾端。替換檔案的 POSIX mode 會保留；Windows temp 繼承父目錄 ACL，不複製 target 的自訂 ACL。正式 scope 應採一致、已審查的父目錄權限；需要保留特殊 ACL 的檔案交由其專用 owner。

驗證命令：

```powershell
npm run test:write
npm test
```

`test:write` 在獨立暫存 roots／policy／state 與隨機 loopback port 測試真實 filesystem、Windows junction/hardlink、原始 hash、重試、並行、故障注入與 authenticated HTTP MCP，結束後清理自己建立的 fixture。它不會寫任何既有專案、接觸正式 policy 或重啟服務。

Source／隔離 transport 通過，與正式 runtime reload、實際 write scopes 與 host 端採用是分開的驗收。
