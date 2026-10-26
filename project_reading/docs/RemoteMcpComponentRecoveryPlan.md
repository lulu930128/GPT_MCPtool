> 歷史證據／設計：2026-10-13 使用者已修訂身分與人工維護需求；現行路徑見 [本機管理](LocalComponentManagement.md)。以下原文與先前驗證結果保留，不是目前 adoption 前提。

# 跨 MCP 元件復原介面：G0 / G1

本切片僅交付 Project Workspace 的唯讀 source、測試與文件。工具契約
`2026-10-13.1`，回應契約 `mcp-component-recovery-g1-v1`。不宣稱已載入正式
runtime 或通過 ChatGPT E2E。G2+ request、approval、execution 均未實作、未註冊。

## G0：已核對的邊界

2026-10-13 唯讀核對 `../mcp_control_center/config/registry.json`（schema v3）、
七個元件的 `control-center/component.json`、Control Center 的 AGENTS、README、
`docs/RepairPolicy.md` 及 Workspace AGENTS。registry 有八個 ID；排除自身
`project_reading` 後為以下七個。`mcp_control_center` 不是 MCP target，同樣拒絕。

Control Center 是遠端 lifecycle 委派的唯一 Owner；各元件既有 controller 仍擁有
exact-path process lifecycle。本 adapter 無此權限，也不查 PID 判斷 ownership。
中樞既有 Status CLI 會寫入 state/event，因此此切片不呼叫 CLI。既有 Codex Bridge
R1 固定 pipeline 不作為跨元件正式通道；NORMAL/ADMIN PowerShell 核准設計不變。

## G1：工具與封閉輸入

| 工具 | 輸入 | 結果 |
| --- | --- | --- |
| `mcp_component_status` | `componentId?`，省略查七個 | `LOCAL_OBSERVATION_ONLY`；每列固定 TCP 觀察 |
| `mcp_component_preview` | `componentId`, `action` | `AUTHORITY_NOT_DEPLOYED`、`NOT_CONNECTED`、`allowed=false` |
| `mcp_component_receipt` | `requestId`，UUID | `AUTHORITY_NOT_DEPLOYED`、`NOT_CONNECTED`、`receipt=null` |

componentId 僅允許以下七值；schema 與 handler 都驗證。額外欄位全部拒絕。
action 僅允許 `ensure_running`、`repair_connectivity`、`restart_core`、
`reload_runtime`、`shutdown_runtime`，這些是提案名稱，不是已授權操作。
無 caller command、path、URL、executable、env、flags 或 raw args。

| ID | 固定觀察 port |
| --- | --- |
| `codex_bridge` | 18828 |
| `omi_search` | 18797 |
| `japanese_study` | 18790 |
| `memory_core` | 18818 |
| `personal_asset_os` | 18876 |
| `english_study` | 18886 |
| `listening_audio` | 18810 |

port 來自上述已審閱 descriptor 的主要 MCP endpoint（PAOS 為 app endpoint），
host 固定 `127.0.0.1`。映射版本 `2026-10-13.1`；不在 runtime 載入 registry 或
descriptor，不接受環境變數覆寫。映射變動必須另行 source review；舊映射可能
觀察到不同 listener，因此永遠不據此確認 service identity 或 ownership。

status 沿用既有 `checkTcpPort` Node API，不送 application payload、不讀 response、
不探測其他 core、dependency 或 tunnel。每個 probe 最多 750ms，每次最多七個，
依序執行；跨 session 同時最多兩個 status call，忙碌立即回 `OBSERVATION_BUSY`。
沒有重試、排隊、子程序或 timer 排程任務。七個 probe 的設定總預算 5250ms
（event loop 延遲不構成硬即時保證）。輸出只含封閉欄位、安全錯誤碼與時間戳。

`TCP_CONNECTED` 只表示當時有人接受 TCP；`TCP_NOT_CONNECTED` 不等於 Stopped。
probe 例外或 malformed 結果為 `OBSERVATION_FAILED`，保留其他列。每列 health、
serviceIdentity、ownership、ChatGPT E2E 都為 `UNVERIFIED`，不回 raw error 或 PID。
status 的 `ok=true` 表示成功回傳觀察集合，不代表 component healthy。

Owner authority 永遠 `deployment=NOT_DEPLOYED`、`connection=NOT_CONNECTED`，
表示此跨元件權威通道未部署，不是宣稱 Control Center 本機程序未啟動。
preview 的 `ok=false`、`executable=false`、`approvalAvailable=false`、
`requestCreated=false`；無核准 token、request 建立或執行計畫。receipt 的
`found=null`、`completed=null` 表示無法查證，不是假造 NOT_FOUND 或完成收據。
全部 readOnlyHint=true、destructiveHint=false；只有 status 的 openWorldHint=true。

## 後續 gate（本切片禁止啟用）

- G2：獨立保護的 Control Center Owner、安全審查、經驗證的狀態及收據通道。
- G3：exact-action 核准契約，綁定 target、action、期限、nonce、owner identity、
  active-work 與 fresh preflight，抗重放；由 Owner 委派既有 controller。
- G4：在另行授權後驗證 lifecycle 與故障恢復，再驗證 host discovery／ChatGPT E2E。

`mcp_component_request`、`mcp_component_approve` 僅保留未來名稱，不註冊。
未來 RepairConnectivity 仍須遵守 RepairPolicy：core healthy、明確 ownership、
allowlisted local transient tunnel failure；remote、credential、configuration、
active work、ownership unknown 均不允許由 Workspace 推導 repair。
Workspace 自我管理與 Control Center 自身重啟持續排除。

## 驗證與回退

先 build，再執行 `node --test dist/tests/component-recovery.test.js`；schema 變更依
Workspace AGENTS 執行 `npm test`。契約 smoke 使用隔離的本機測試 transport，
不重啟正式 server、不讀 token。既有工具僅調整總數斷言 31→34、37→40，
不修改 file reader、writer、diagnostic 邏輯與安全邊界。

保留起始 HEAD、index SHA-256、所有可讀取且非 ignored 的 tracked/untracked 檔案
SHA-256 與 Workspace 原始 dirty diff；denied 路徑不讀。驗證後比較本次 allowlist
以外的所有 bytes，並保存本次增量 patch 與命令 exit evidence。任何寫入 denial
即停止該動作，不改 ACL、不換寫入路徑繞過。

回退僅反向套用本次增量 patch，先檢查 patch 與目前 WIP；移除本次新建 source/test/doc
檔案須另行確認精確清單，不能 reset 或還原到 HEAD。重新 build 與 runtime adoption
各自需要對應步驟；本次不做 runtime 回退，因為沒有部署或重啟。build 會更新 ignored
`dist`，不代表 live adoption。證據見同目錄 `RemoteMcpComponentRecoveryEvidence.md`。
