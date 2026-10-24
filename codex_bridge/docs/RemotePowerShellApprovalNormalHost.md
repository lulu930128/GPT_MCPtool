# NORMAL protected host 實作追蹤（歷史證據）

> **2026-10-15 現行規則：** 這是過去 G1 的狀態／驗收證據，所有「本輪不修改／不可部署／只做 fixture／等待平台授權」僅描述當時工作，不限制後續合法程式開發。現已授權補齊受保護 Host、密碼驗證、Grant、NORMAL／ADMIN Runner 與 Receipt；開發期 PowerShell 真實操作僅做唯讀，正式可寫／管理員測試由使用者逐筆發起與批准。實際平台拒絕不可藉替代路徑繞過。優先適用 [2026-10-15 現行工程決策](RemotePowerShellApprovalPlan.md)。

> **2026-10-14 最新雙入口定案（優先）：** [RemotePowerShellApprovalPlan.md 第 0、3、4、6、9、10 節](RemotePowerShellApprovalPlan.md) 是唯一現行規格。**`CODEX_DERIVED` 為主要使用情境**：Codex 工程工作出現有證據的 Sandbox／Job Object／Windows 權限不足，由 Bridge 回報問題與建議的確切外部操作，**由使用者選擇是否放行**，其 Request 必須真實綁定 Job／Turn，完成後 Receipt 必須回查原工作。**`DIRECT` 為另一路必要入口**：使用者直接指定 PowerShell 操作，不要求 Codex Job。兩者共用 Bridge 的 App-only 逐筆核准、唯一 Journal、Control Center 可信 Operator；**特殊操作本身的核准與派送不經 Codex App Server**。下方 `fixed marker only`、舊 native reviewer、G1 實驗圖都是歷史 Source 快照，不能取代雙入口正式 E2E；舊 PASS 不重跑。本段為當時快照；其時 Source contract 尚未支援無 Job 的 Direct，NORMAL／ADMIN 仍 OFF。較新契約進度請以實際 Source 與 Runtime 為準。

**2026-10-13 正式決策更新：已停止以 isolated G1／真人 Native Pipe／manifest preview 作為後續待跑 Gate。** 這些證據均已通過且保留；不能再要求重跑，也不能藉此宣告正式功能可用。

**現行唯一接線／交付計畫請見 [RemotePowerShellApprovalPlan.md 第 6、9、10 節](RemotePowerShellApprovalPlan.md)。** 實際使用中的 Control Center 為 Source Schema v3 單例 Tray；Bridge 仍為既有正式 Runtime。未部署的 v4 InstalledRelease 不是正在運作的 Owner；不新增平行 Tray/Manager。

本文件以下為原 G1 執行證據及歷史設計，**不是重新啟動一輪隔離測試的操作指令**。目前 NORMAL OFF、ADMIN `BLOCKED_AWAITING_LOCAL_UAC`；正式 Broker Factory、受保護本機核准、single-use Grant、跨程序 Host Runner 和回傳仍屬 Source Pending。不能以移除 `BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED` 或放寬 Tray 啟動檢查直接啟用。

## 唯一 canonical data flow 與 owner

```text
genuine Codex failure (Controller/JobStore event owner)
  -> Bridge bounded proposal (exact project/job/turn/event, fixed marker only)
  -> protected local review / verifier (Bridge-owned native UI, no HTTP password)
  -> G0 PowerShellApprovalBroker / ApprovalStore (only Grant + Journal owner)
  -> APPROVED exact id/digest/mode/job/turn/SID/expiry/nonce
  -> same Journal fsync single consume BEFORE dispatch
  -> existing CC singleton Tray / protected child (process + IPC owner only)
  -> pinned NORMAL marker (nonadmin, outside all jobs, 5 seconds, bounded output)
  -> bounded OS-bound Result Receipt -> same canonical Journal
  -> Bridge read-only job/turn projection (no JobStore write or automatic resume)
```

secret owner：Bridge protected native reviewer，唯一 DPAPI/KDF enrollment。
CC 不保存密碼、verifier、Grant 或第二份 Journal。IPC 的 OS token/retained handles
只證明 peer，不能代替真人核准；本機 UI 確認也不能代替 OS 身分。

## 工作順序與驗收

1. 實作 native pipe transport：明確 DACL、first instance、remote reject、exact retained
   process identities、bounded framing／deadline。隔離編譯、正常 exchange 與身份負例；不執行 marker。
2. Bridge native local enrollment/reviewer：DPAPI CurrentUser + private ACL，固定 KDF，
   無密碼參數／回傳／紀錄，TTL／digest 與三次上限。先驗證 source，真人 enrollment 留人工。
3. 將 production contract、durable consume 接入既有 Broker/Store；不是另一份授權紀錄。
4. 完成 CC protected-child composition、signed closure／ancestor gate、fixed runner、Bridge
   genuine failure adapter 與最小唯讀 projection，再做定點 integration。
5. Source 完整後才公布可執行的人工作業：protected install／ACL／password enrollment／
   out-of-job Tray／真人 E2E；任何 source 缺口都明示 Pending，不包裝成人工部署問題。

## 尚未接線的基線

- failure capture：`OFFLINE_FIXTURE` only。
- Broker factory／Grant：`OFFLINE_ONLY` only。
- Tray gate：`BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED`，沒有 listener。
- `operator-ipc.ts` 的 TCP keys／Map：僅隔離 fixture，不能升格為正式 authority。
- 本輪不修改 R1、live dist、JobStore、ACL、Startup、service/task 或其他 MCP。

## 停止規則與保留

Permission denial：保留 operation、errorCode/HResult/nativeErrorCode、實際 Windows identity／
process context、policy/environment/source 分類；停止該路徑，不換工具、不提權、不重試。
既知 `.env.*` 禁讀不再探測。前輪 protected checkout owner rejection 不重跑。

本輪既有 WIP 雜湊基線：ignored `.tmp/g1-normal-host-20261013/baseline.json`，82 個
元件 source 候選；明確排除 `.env.*` 與 private state，不能宣稱被排除檔案已有 hash 證明。
主分支 `main`，開始時 staged 為空。完整驗證、變更 SHA 及回滾 checkpoint 在本文件結尾更新。

## Reviewer 修正與本輪已完成內容

新增 `mcp_control_center/src/NormalOperator.Pipe.cs`；只提供 transport，不是 Grant service。
`Listener.Exchange(Func<byte[],byte[]> verifiedHandler)` 的順序固定為：

1. native connect / 固定 hello。
2. retained OS client PID、token SID、session、image、start time 核對。
3. bounded request read，再核對同一 OS peer。
4. 執行 verified handler，由它解析／綁定原請求並完成 canonical durable consume（若該操作有 consume）。
5. handler 產生 response 後、送出前再次核對 peer；write 後再核對。
6. handler 拒絕／exception／期限用盡，關閉 handle；沒有預先準備的 Grant response、重連或重送。

16 KiB frame／5.5 秒絕對 exchange deadline、first-instance／maxInstances=1／remote reject、
non-inheritable handles、明確 pipe DACL、client identification-level SQOS。host composition
仍須使用 `requireIndependent=true`；測試用 false 只表示觀察同一受限程序，不是 out-of-job 授權。
新增 `AssertServerIdentity` 保留原 `AssertServer` 的獨立性檢查，沒有放寬原 host API。

Reviewer 要求後的 source inspection 另修正：client 的 CreateFile handle 已連線，
`NamedPipeClientStream` 必須標 `isConnected=true`。Server duplex handle 需要 read/write
及 create-instance rights（owner mask `0x0012019f`）；不同 client SID 僅給 data read/write
與 synchronize（`0x00100003`）。同 SID 不能靠 DACL 區分程序，仍必須 retained exact peer。
這兩项 source 修正**尚無 native exchange 成功證據**，不把它們當成 denial 已修復的證明。
Win32 CreateNamedPipe/CreateFile 的錯誤現在附 native operation，保留原 nativeErrorCode。

API 依據：[Microsoft named-pipe rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)。
正式 secret 隔離另須注意 [DPAPI 的同使用者解密範圍](https://learn.microsoft.com/en-us/windows/win32/seccrypto/example-c-program-using-cryptprotectdata)，不是只加 DPAPI 就能隔離其他同 SID 程序。

## 精確驗證與已停止操作

2026-10-13 語法證據更正：**先前 PASS 證據失效，真人確認 syntax failure，修補後 v5.1 PASS**。
真人非管理員執行在 line 65 回報 `UnexpectedToken ']'`，尚未進入 pipe exchange；
下表舊 Parser PASS 不再作為 Windows PowerShell 5.1 相容性證據。
Project Workspace 已將複合陣列泛型 literal 改為 reflection 型別比較；本次讀回後未再修改腳本。
首次驗證工具雖指定 v5.1 shell，實際 engine 為 `7.6.5 Core`，版本防護以
`EXPECTED_WINDOWS_POWERSHELL_5_1` 中止，真實 exit 1，未呼叫 Parser。
隨後直接呼叫 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
（`-NoLogo -NoProfile -NonInteractive`），實際 engine `5.1.26100.9444 Desktop`：
`Parser::ParseFile` 解析本表 SHA 的腳本，`ParseErrorCount=0`；同次程序以
``Type.GetType('System.Func`2').MakeGenericType(...)`` 建立純記憶體型別，執行與 source
相同的 generic definition、argument count 與兩個 `[byte[]]` 比較，輸出
`REFLECTION_TYPE_COMPARISON_PASS`，真實 exit 0，無 parser／reflection 錯誤。
此 reflection 檢查沒有載入專案 C# 或驗證實際 Exchange method；型別表達式不做 IO。
輸出另有 PowerShell module 初始化 progress CLIXML，不是錯誤。
本次沒有執行整份測試、Add-Type、Pipe exchange、Runner、ACL 或服務操作。
**IPC 仍未驗收；既有 WinError 5 路徑保持 Blocked/Unverified，留待真人非管理員驗證。**

| 驗證 | 結果 |
| --- | --- |
| `Add-Type` Native.cs + Pipe.cs；反射檢查 callback signature | exit 0 |
| 隔離 fixed handler 的 native exchange | exit 1；Win32Exception `存取被拒。`，nativeErrorCode=5，HResult=-2147467259 |
| denial 後 source compile、callback signature、source guard order | exit 0；沒有開 pipe、沒有重試 exchange |
| 人工 `.ps1` Parser + 三個 C# 檔案 Add-Type | exit 0；沒有呼叫 Run／Listener／Exchange 或 OS probe |
| Reviewer 首次 output parent 修正後的 PowerShell Parser | exit 0；只解析，沒有執行腳本或 IPC |
| volume-root 明確 break／祖先未前進防護後 Parser + source proof | exit 0；沒有執行腳本或 IPC |
| `git check-ignore mcp_control_center/.tmp/normal-pipe-handler/receipt.json` | exit 0；receipt 目錄 ignored |

拒絕發生在 `isolated native pipe verified-handler exchange`，Windows identity
`lulu\CodexSandboxOffline`、PID `52120`，繼承 Codex 執行環境。當次輸出沒有保留最內層
Win32 operation，不能確定是哪一個 native call；也不能把來源 DACL 問題排除。
分類為 **PERMISSION_SOURCE_OR_ENVIRONMENT_UNRESOLVED**。已停止該操作，沒有替代
工具／IPC／提權／breakaway；原測試沒有取得 PASS。後續只做 source 編譯、parser、文件與 hash。

沒有重跑 G0 16、G1 10、legacy tests、host checkout preflight 或 R1 tests。
沒有正式 listener／marker execution、密碼設定、ACL／Startup／service／task mutation。

## 人工隔離 Native Pipe 測試：已完成（保留歷史指令，請勿重跑）

**2026-10-13 人工驗收 PASS**：使用者從普通 Windows PowerShell 執行固定測試，回傳 `status=PASS_ISOLATED_HANDLER_ONLY`、`operation=completed isolated checks`、`elevated=false`、`inAnyJob=false`、`nativeErrorCode=null`、`errorCode=null`。以下三項實際 PASS：`request determines verified response`、`handler called once`、`handler rejection closes without response`。測試收據已在使用者本機 `mcp_control_center/.tmp/normal-pipe-handler/` 保存；不另讀取私人 SID、Windows 帳號或被 Workspace 拒絕的 `.tmp` 目錄。

這項證據取代之前的「等待普通 Windows 人工測試」：本機非管理員、outside-job 的**隔離 Native Pipe Handler** 已驗證可運作，CodexSandboxOffline 的 WinError 5 不能直接推定為 Pipe 程式缺陷。但同程序測試**不證明跨程序雙向 OS Peer、受保護 Host、正式 Grant/密碼審核或 Production Runner**，`productionEnabled=false`、`protectedHost=UNVERIFIED`，均維持未驗收。

以下只保留已執行的歷史測試命令供追溯，**沒有要求使用者再次執行**：

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -File C:\GPT_MCPtool\mcp_control_center\tests\test-normal-pipe-handler.ps1
```

只授權這個隔離測試：兩個短效本機 named pipes、固定 `read-this-request`／
`reject-this-request` 合成資料、同程序 retained OS peer。它在建立 pipe 時設定該暫時
kernel object 的 DACL；**不修改任何既有 filesystem／process ACL**。不讀 secrets、
不開 review UI、不設定密碼、不啟動 Tray／Node／Bridge／Runner／正式服務。
若執行政策拒絕，保留拒絕並停止，不加 `ExecutionPolicy Bypass`、不提權。

正常 exit 0，receipt `status=PASS_ISOLATED_HANDLER_ONLY`；必須同時有三個 checks。
任一失敗 exit 1，立刻停止，不自動重試。結果寫入
`mcp_control_center/.tmp/normal-pipe-handler/<UTC時間-GUID>/receipt.json`，含 source SHA、
identity/PID、operation、nativeOperation（若有）、errorCode、HResult／WinError。
腳本嚴格限定 output 在這份 CC root 的 `.tmp/normal-pipe-handler`；先檢查祖先與既有
output 目錄沒有 reparse point，再逐一建立缺少的 `.tmp` 和 `normal-pipe-handler`，
最後建立 timestamp/GUID 唯一 case，不依賴父目錄事先存在。不使用 `-Force` 覆寫 case。
祖先檢查在處理 volume root 後明確 `break`；若其他層的父路徑沒有前進，拒絕為
`TEST_OUTPUT_ANCESTRY_STALLED`，避免 Windows 根目錄造成無限迴圈。
若 receipt write 本身被拒，stdout 回報原結果與寫入錯誤，不改寫其他位置。
receipt 包含本機 identity，保持 ignored；不需要在對話提供任何密碼。

請回報 receipt 中的 **`status`、`operation`、`nativeOperation`、`nativeErrorCode`**，
若 FAIL 再附 `errorType`／`errorCode`／`hresult`；identity、SID 與完整私人 path 不必貼入對話。

| 真人結果 | 下一步（另輪執行） |
| --- | --- |
| exit 0、`PASS_ISOLATED_HANDLER_ONLY`，三個 checks 完整 | 回報上述欄位；agent 接續下表 canonical Host／Grant／reviewer 等 source，保留正式 OFF，不能直接部署 |
| exit 1、nativeErrorCode=5 | 保留 receipt，停止；回報 nativeOperation／operation 區分受拒步驟，先分析 source／環境，不重試、換權限或工具 |
| exit 1、其他 code／parser／compile／output 路徑錯誤 | 保留 receipt 或 stdout，回報同組欄位；agent 定點修復，不擴大為 installer 或服務操作 |
| PowerShell execution policy 在進入腳本前拒絕，沒有 receipt | 保留原始拒絕文字並回報；不加 Bypass、不提權、不換執行入口 |

人工驗收結果已返回，G1 隔離 Native Pipe 的人為測試 Gate 已關閉；正式 canonical Host/Grant source 尚有下列 Pending。當時後續一筆跨 Sandbox 特權派送委派曾遭平台安全檢查拒絕，本次未改寫請求或繞過；此為該次操作的歷史紀錄，不代表未來全部正常 Source 修改被禁止。Production 當時保持 OFF，正式測試仍要遵守當下 OS／平台限制與逐筆核准。

即使此命令 PASS，最多證明 **同程序、短效 native transport 與 handler ordering**。
不是跨程序 peer 否定驗收、protected install、out-of-job Tray、production Grant 或正式 E2E。

## 尚未完成的 source blocker（不是人工部署問題）

| Gate | 現況／下一個 source 動作 |
| --- | --- |
| Canonical production Grant | Pending：G0 仍只接受 OFFLINE_ONLY；需在同一 Broker/Store 接入正式 evidence／nonce／local native reviewer 與 durable consume，不能新增 journal owner |
| Protected local password UI | Pending：沒有正式 Enrollment／DPAPI + protected ACL verifier／獨立 WinForms review composition；現有 HTTP review 仍 fixture only |
| CC Host composition | Pending：尚未將 signed dependency closure、actual ancestor checks、唯一 Tray 的 protected child 與正式 pipe listener 接入；原 gate 仍永遠 BLOCKED |
| Genuine failure + projection | **唯讀 source PARTIAL**：Bridge `JobStore.snapshot` 新增 `commandFailureDiagnostics`，且 Bridge MCP 已新增 `codex_powershell_job_preview` 唯讀工作預覽，從既有 JobStore 僅投影符合可讀資格的 personal/public 工作。原因與權限歸因仍 UNKNOWN／UNVERIFIED、兩種 PowerShell 入口均 OFF、不產生 Request 或執行能力；診斷與預覽各自 isolated compile exit 0、targeted tests 7/7 PASS。**live runtime 未載入新版**。正式 failure→Grant proposal、通知／核准、執行回報及 JobStore 寫入仍未接線；不以診斷結果授權。 |
| Production runner / receipt | Pending：現有 runner 仍繼承 fixture 程序；正式 pinned NORMAL runner、OS child token/PID／5 秒／receipt 綁定未接線 |
| Native IPC | **PASS：非管理員、out-of-job 的單程序隔離 Handler 人工測試**；正式跨程序 OS peer / protected Host IPC 仍 **UNVERIFIED**，不可當作 Production PASS |

因此**本輪沒有完成原要求的可部署 NORMAL 正式鏈路**。人工命令的 PASS 不會自動解鎖
以上 source blockers，也不授權部署／改 ACL／Enrollment。完成 source composition 與
cross-process peer negatives 後，才可給 protected install／password／真人 E2E 的啟用步驟。
目前不提供會造成誤啟用的 installer、service/task 或 Startup 命令。

## 精確 source SHA-256、Diff 與回滾

| 檔案（相對 `mcp_control_center`） | SHA-256 |
| --- | --- |
| `src/NormalOperator.Native.cs` | `fed2778ac3e8fd55aacf2d74a54b1f439026b5257483f8f1e0ca475286b2a97d` |
| `src/NormalOperator.Pipe.cs` | `b354ac065109351b6f98c806d171c3d4c831f5a2ec1e65b1c47a53cd58d2d600` |
| `tests/NormalPipeHandler.Check.cs` | `e2c4463ba1aa9e11468e97910ade55a74836537e6fe53a82b7cd134a5e94605c` |
| `tests/test-normal-pipe-handler.ps1` | `0a6346d63091388849708c80d9325c2c37a17325bbbf64e899b4dd95f2741d73` |

歷史 Reviewer SHA 複核（不是目前腳本的驗證）：當時以 `Get-FileHash -Algorithm SHA256` 讀取四檔 raw bytes，
當時四項與舊表及 checkpoint 一致；當時腳本為 root-loop 修正後的 `5adccd44…481e70d`，
不是先前 `cfa454…`。本次不改 source；只重做 Parser 與唯讀 path/root-break 檢查，
並刷新 ignored `final-sha-recheck.json`、checkpoint 與精確 rollback patch。沒有執行 IPC。

目前腳本 SHA 已由本次 v5.1 程序重新讀取並更新上表；本次未重驗其他三個 C# SHA，
也未更新舊 ignored checkpoint／rollback artifact；它們不能代表目前 reflection 修補版本。

本輪只修改原 Native.cs 的 server identity API，新增 transport、人工測試及本文，並在
原 G1／CC handoff 追加本次連結。G0、Tray、R1、live dist/build、JobStore 未修改。
精確本輪 patch 與 preservation 在 Bridge ignored `.tmp/g1-normal-host-20261013/`。
回滾只撤回該 patch；原有 Native.cs 與兩份 handoff 的 before bytes 已留存，不 reset
整個 WIP、不中止 live process、不刪 journal／receipts／其他 ignored 資料。

本輪最終保留核對：82 個既有候選中 79 個 SHA 位元組一致，只有允許的 Native.cs、
G1 Operator doc、CC handoff doc 三檔不同；staged 仍為空。新的四份 source/doc 不在舊基線。
唯讀 `http://127.0.0.1:18828/health`：exit 0、`ok=true`、controller `ready`、
buildId `05e99d459acc9ca8`，與使用者提供基線一致。沒有在開始時另存 live PID／dist
逐檔 hash，因此不聲稱完成 PID／live dist 位元組差分證明；本輪未寫 live dist、未重啟。
