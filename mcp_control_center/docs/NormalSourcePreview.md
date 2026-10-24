# NORMAL source manifest 唯讀預覽（已完成的歷史證據）

> **2026-10-15：** 此文的 Source Preview、不能啟用 Marker 等規定，僅禁止把一份 manifest／fixture 冒充正式 Grant 或繞過 Host；**不禁止繼續實作**正式 Windows Host、Operator／Runner、App-only 核准、Grant／Receipt。開發中 PowerShell 操作唯讀，正式執行由使用者逐筆核准；目前功能能否執行仍依實際部署、OS 權限與平台政策。詳見 [現行工程決策](../../codex_bridge/docs/RemotePowerShellApprovalPlan.md)。

**已被 2026-10-13 PRODUCTION-FIRST 決策取代為歷史驗證：** 本文件的「最短操作／來源驗收」指令均已通過，不再執行，亦非正式 Host 的啟用步驟。下一輪請直接依 [Bridge 正式 Runtime 接線計畫](../../codex_bridge/docs/RemotePowerShellApprovalPlan.md) 第 6、9、10 節完成正式 Source 並進行真人 E2E。

本次交付只提供 `config/normal-operator-source.json` 的候選內容；不建立、覆寫或安裝該檔。
既有正式 preflight 的 11-file closure 是唯一清單來源，正式 Host 仍維持
`BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED`。人為 install 尚未完成，本輪沒有新增其證據。

## 最短操作

在 repository 根目錄，用 Windows PowerShell 5.1 執行：

```powershell
& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -NonInteractive -File mcp_control_center\scripts\preview-normal-operator-source.ps1
```

預期 stdout 只有一份 compact JSON：`contract=normal-operator-source-v1`，
`files` 恰為正式 preflight 既有 11 個相對路徑及各自小寫 SHA256。
不輸出 source 內容、SID、PID、私人絕對路徑或環境資料；總輸出上限 8192 UTF-8 bytes。
沒有參數、GUI、MCP 或 IPC 入口；不接受 caller-supplied path/hash/flag。
不必點 Tray，不必重啟，不要將此輸出當作安裝或授權指令。

每個固定檔案及其父目錄都須存在且沒有 reparse point；單檔上限 1 MiB。
11 個檔案以唯讀 handle 保持開啟，完成來源清單的 AST 比對與 SHA256 計算後才一次輸出。
只解析正式 gate 的文字，不 import 或執行其中程式。發生錯誤不輸出部分 manifest。

## 停止條件

| 分類 | 意義與處置 |
| --- | --- |
| `SOURCE_PREVIEW_ARGUMENTS_REJECTED` | 傳入了額外參數；預覽器不提供設定或套用模式。 |
| `SOURCE_PREVIEW_PATH_REJECTED`／`SOURCE_PREVIEW_REPARSE_REJECTED` | 路徑或祖先不合要求；停止，不改 ACL、不換路徑繞過。 |
| `SOURCE_PREVIEW_FILE_REJECTED` | 不是預期檔案或大小超限；停止，人工檢查來源。 |
| `SOURCE_PREVIEW_CLOSURE_MISMATCH` | 正式 gate 解析失敗，或 11-file 清單不一致；停止並 review source。 |
| `SOURCE_PREVIEW_OUTPUT_LIMIT` | 輸出超限；停止，不截斷後使用。 |
| `SOURCE_PREVIEW_READ_FAILED` | 缺檔、讀取／鎖定／權限或其他檢查失敗；停止，不自動重試。 |

這是可寫 checkout 在讀取時的 source snapshot，**不是可信 immutable artifact identity**。
檔案鎖、no-reparse 與 hash 比對都不證明 protected ancestor ACL、installed closure 或
人為授權；同帳號可寫來源的信任問題仍存在。不得用此 manifest 開啟 marker 派送、
Grant、Password、Runner、ADMIN 或遠端執行，也不能推論 Tray／子程序 out-of-job。
未觸碰 protected install、ACL、Startup、service、R1、WorkspaceLocal、Bridge 或正式 config。

## 來源驗收與回滾

```powershell
& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -NonInteractive -File mcp_control_center\tests\test-normal-source-preview.ps1
```

2026-10-13：回傳 `PASS_SOURCE_ONLY`、`files=11`、`configWritten=false`、
`childDispatched=false`、`formalHost=BLOCKED`。定點驗收包括原生 5.1 Parser、
5.1 不支援語法的否定案例、固定 hashes／JSON shape／大小、額外參數拒絕及來源執行邊界檢查。
未執行 G0、Native Pipe G1、Tray、marker、runtime smoke 或任何部署；沒有 commit/push/restart。

本 turn 曾加入的 LocalMarker module、測試及四個 Tray 區塊已全部撤回。
Tray 與 turn 開始快照的 SHA256 完全一致：
`ECCF91EABDBA461E5D466163E57F50C0D9E0458F85F66A9EB21DCD1CEF888C75`。
既有 WorkspaceLocal／R1／NORMAL WIP 保留，原 preflight 未變更。

本次最終新增僅三個檔案：此文件、`scripts/preview-normal-operator-source.ps1`、
`tests/test-normal-source-preview.ps1`。要回滾本次交付，只移除這三個新增檔案；
不要對 Tray、README、其他既有 WIP 使用整檔 checkout/reset。
