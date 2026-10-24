目前 G2 實作與操作以 [R1G2Operator.md](R1G2Operator.md) 為準（2026-10-13）。release contract v3 已有條件式正向 lifecycle；下列 v1/v2 阻擋與 G1 測試是前一里程碑紀錄。G1 仍未宣告 SOURCE_COMPLETE；G0 HOST_NOT_VERIFIED、G2 NOT_DEPLOYED。

# R1 正式安裝候選：G1 PARTIAL

2026-10-12 source-only 修復。**不可部署／不可切換正式 Runtime。**
這一版提供 v4 映射、v2 installed manifest、ACL／完整程式樹 digest、實際 controller context 的來源選擇，
以及全入口阻擋。隔離 fixture 可通過 **source binding**；尚未提供可啟用的完整 lifecycle binding。
`activationReady=false` 是診斷值，改 JSON 或改成 `true` 都不能解鎖。

## 已實作的契約

現行 `config/registry.json` 與 v3 行為不變。v4 僅存在於另行建立的候選樹：

```text
<protected-installation-parent>/<releaseId>/
  mcp_control_center/
    config/registry.json                  # schemaVersion 4
    config/installed-release.json         # mcpcc-installed-release-v1
    src/ scripts/                        # 既有唯一 manager
  codex_bridge/                          # 第五個固定元件的 installed root
    scripts/ dist/ web/ node_modules/ control-center/
    package.json package-lock.json
  dependencies/
    node/node.exe                        # Node 完整 distribution，包括 DLL
    tunnel-client/tunnel-client.exe
    key-store/key-store.ps1               # 程式副本，不是 credential 副本
```

v4 registry 的 fields 仍是 `schemaVersion, settings, components`；settings 沿用 v3。
必須恰有下列八個唯一 ID，entry 的 `root` **必須等於 ID token**，不接受 caller path：

| ID | 實際目錄 |
|---|---|
| project_reading | legacyWorkspaceRoot/project_reading |
| omi_search | legacyWorkspaceRoot/OMI_search |
| japanese_study | legacyWorkspaceRoot/japanese_study |
| memory_core | legacyWorkspaceRoot/Memory Core |
| codex_bridge | releaseId/codex_bridge |
| personal_asset_os | legacyWorkspaceRoot/personal-asset-os |
| english_study | legacyWorkspaceRoot/english_study |
| listening_audio | legacyWorkspaceRoot/listening_audio |

`descriptor` 固定 `control-center\component.json`。Bridge 必須 enabled、autoStart，且
`contractScript` 與 controller 都固定 `scripts\runtime-control.ps1`。manifest 不能提供 arguments、shell、env。
在此主機，未來 operator 核對的 legacyWorkspaceRoot 是既有 `C:\GPT_MCPtool`；本輪未產生正式 manifest。

舊 `mcpcc-installed-release-v1` 保留 mapping／negative fixture 相容；不能建立 installed runtime context。
它只接受以下 fields；示例占位值刻意不能通過 parser：

```json
{
  "contract": "mcpcc-installed-release-v1",
  "schemaVersion": 1,
  "releaseId": "<operator-reviewed-version>",
  "legacyWorkspaceRoot": "<existing-workspace-absolute-path>",
  "dependencies": {
    "node": "<64-lowercase-hex-SHA256>",
    "tunnelClient": "<64-lowercase-hex-SHA256>",
    "keyStore": "<64-lowercase-hex-SHA256>"
  }
}
```

版本須等於 release 目錄名稱；registry 必須由該目錄自己的 manager 載入。CC／Bridge 保持 sibling，
因此 IPC helper 的固定相對 native source／tray 路徑仍指向同一 release，未建立第二個 owner。
其他七個元件維持原位；不安裝 service、task 或替代 broker，tray mutex 名稱保持不變。

## 拒絕規則與成本

`McpControlCenter.InstalledRelease.psm1` 拒絕 unknown fields/IDs、root token 混用、UNC、ADS、
dot segment、trailing dot/space、workspace overlap、reparse、missing code/dependency、hash mismatch。
ACL predicate 接受 SYSTEM／Administrators，以及 Windows TrustedInstaller 的**固定 service SID** 作為 code owner，
不以帳號顯示名稱判斷，不把一般 operator 加入 code writers。拒絕 null DACL 以及其他 principal 的 write、delete、
delete-child、ChangePermissions、TakeOwnership ACE，包含 inherit-only；不因 deny ACE 推定 allow 無害。
每個 code tree 的所有 ancestors（含磁碟 root）也須通過，未知／讀取失敗直接拒絕。

每輪祖先檢查一次；每個子項檢查後才能向下走，不使用可能先跨 reparse 的 `-Recurse`。
每樹最多 100,000 entries，超出回 `INSTALLED_TREE_LIMIT`。沒有跨 gate 的信任快取。
1,000 檔 fixture 每輪 1,008 ACL reads；此數據使用注入 ACL，**不代表正式 NTFS ACL 掃描 latency**。
正式 node_modules 樹仍需 operator 量測；超過既有啟動預算時停止，不拉長 timeout 掩蓋問題。

v1 closure 僅證明宣告樹、固定必要檔案、固定三個 dependency hashes。v2 另外綁定 Codex JS／Windows x64 native binary，
以及三棵程式樹的全部檔案 bytes／目錄名稱。仍不能把「來源選擇通過」當作「正式 runtime 已載入」。

v4 的 Core action、UI action、controller audit、component SelfTest、tray、CLI 都拒絕執行。
CLI `Status`、`Doctor`、`-PlanOnly` 只輸出靜態 `ok=false`／阻擋原因與映射，無 probe、controller、event/state write。
Reconcile plan 八筆都為 `ManualAttention`，不產生 Start／Repair。其他七個元件也不能由此候選 mutate。
v3 日常 lifecycle 不受這些 v4 guard 影響。

## v2 source binding 與 code/state 分離

`mcpcc-installed-release-v2`／`schemaVersion=2` 只接受 v1 的五個 fields 加上 `state`、`treeHashes`。
`dependencies` 固定五個 lowercase SHA256：`node, tunnelClient, keyStore, codexLauncher, codexNative`。
前面三個相對路徑不變，Codex 路徑固定為：

```text
codex_bridge/node_modules/@openai/codex/bin/codex.js
codex_bridge/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe
```

`state` 恰有 `operatorSid, userProfile, localAppData, dataDir, projectsFile, codexHome`。
它們是 operator 在受保護 manifest 中釘住的既有身份／設定位置，不接受 caller 新增選項。
`dataDir` 應保存既有 JobStore 路徑（預設 `C:\CodexBridge`）；不會搬移資料或複製 credential。
`operatorSid` 必須等於目前非管理員 Windows token SID，兩個 profile folder 必須等於 Windows folder API 結果。
測試使用合成 operator；本輪 sandbox SID／profile 不構成原 operator 證據。

`treeHashes` 恰有 `mcp_control_center, codex_bridge, dependencies`。每個 digest 是以下 UTF-8 bytes 的 SHA256：
以 ordinal 排序的每行 `D <relative/path>` 或 `F <relative/path> <lowercase-file-SHA256>`，每行以 LF 結尾。
只排除 CC 的 `config/installed-release.json`，避免 self-reference；registry、Node DLL、scripts、dist、web、
node_modules 及其他檔案全納入。ACL 與 reparse checks 先執行，再做獨立 bytes inventory；沒有跨呼叫 trust cache。
建置／stage 完成後才算 digest，不能在 manifest 建立後繼續改 release bytes。

| 用途 | 來源／位置 |
|---|---|
| immutable code／canonical Build ID | physically loaded release 的 `codex_bridge` |
| 設定根目錄 | manifest 的 `legacyWorkspaceRoot/codex_bridge` |
| PID／owner／events／tunnel log | `state.localAppData/McpControlCenter/installed-bridge/<releaseId>` |
| JobStore／allowlist／Codex home | protected manifest 的 `state.dataDir/projectsFile/codexHome` |
| text handoff | 舊 `codex_bridge/.tmp/codex-inbox` |
| tunnel profile | 舊 `codex_bridge/.tunnel-client` |
| DPAPI secret | 原 `project_reading/.secrets/control-plane-api-key.dpapi`，只檢查 metadata／ACL |

private verifier 要求 targets 與 ancestors 抵抗 foreign write/replacement，target 也拒絕 foreign read、null DACL／reparse。
不建立 private directories、不讀 secret bytes、不設定 ACL。預期寫入位置必須由 operator 先準備好；不存在直接拒絕。
`C:\Program Files\McpCcReleases\<releaseId>` 是可供 operator 評估的 layout 示例，**不是本機 ACL 已通過的聲明**。
TrustedInstaller ancestor 可以通過，其他 ancestor 的可寫 ACE 仍會阻擋；不可為了通過 predicate 放寬 ACL。

`runtime-control.ps1 -Action InstalledBinding` 只從實際載入 script 的 sibling CC verifier 取得 binding。
import 前檢查該 verifier／ancestors；不從 caller ProjectRoot、舊 sibling、`.local`、owner sidecar 或 PATH 尋找 code。
`New-CodexBridgeRuntimeContext` 的 installed 分支只接受同一個 code root；Node/Codex/tunnel/key-store、自訂 state／build
參數一律拒絕。所有非空 `NODE_*`／`OPENSSL_*` 與 executable/test override env 都拒絕；PATH 不參與 binary selection。
v4 registry 即使少了 installed manifest 也不會降級成 v3。

TypeScript config 透過固定 controller 的唯讀 binding action 取得 code/state 路徑，要求目前 `process.execPath`
等於 pinned Node。候選僅支援已核對的 Windows x64／`C:\Windows` system PowerShell 路徑；不由 env 選 helper executable。
Codex launch projection 固定 `[pinned codex.js, app-server, 固定 permission profiles]`，沒有 caller command/args 或 PATH fallback。
兩個 profiles 都 deny release、CC owner/private runtime、舊 secrets/settings；handoff 維持 read。
Codex child env 使用封閉 allowlist，不繼承 Bridge token、Node loader 或外部 PATH。這只是 **Codex profile source 證據**，
不表示 Project Workspace plugin 或 Windows ACL 的 effective permission 已驗收。

`createBridgeRuntime` 在任何 JobStore 初始化之前阻擋 installed candidate；Bridge CLI、direct lifecycle／native stop 入口、
event writer 與 pipe helper 也保持阻擋。Node/Codex/tunnel 正式 installed child 尚未啟動；key-store 沒有被 dot-source/decrypt。
原 native handle 的身份驗證／終止邏輯保留，新增 guard 不以 numeric PID termination 取代它。

## G1 尚未完成：下一輪必須修改的 source

1. context 路徑與 dependency selection 已完成 source fixture，但 installed `Start-CbServer/Start-CbTunnelOnce` 仍無條件阻擋。
   必須補齊安全 child spawn、完整 Windows loader/PowerShell module closure、HTTP authentication settings、tunnel profile identity、
   private 寫入 target 每次 reparse／ACL recheck，並排除原 key-store 的 ambient `CONTROL_PLANE_API_KEY` shortcut。
   舊 v3 的 settings／env 行為不能直接拿來啟用 v4，也不能在完成前移除 guard。
2. TypeScript 已固定來源與 permission projection；仍需完整正向 **Node → fixed controller binding → pinned Codex native**
   執行 fixture，以及驗證 Codex launcher 的 platform package resolution 不會落到 release 外的 ancestor package。
   目前 fake binary fixture 不證明真實 loader、Node distribution 完整性或 app-server 啟動成功。
3. `McpControlCenter.SelfReload.Owner.psm1`：在**實際 controller context 與 loaded runtime** 上重新核對 dependency closure，包含
   Node distribution／DLL、CC code/core/tray/native IPC、Bridge scripts/dist/web/node_modules、key-store script
   與 tunnel-client。現行共享 Project Reading 程式若可寫必須拒絕；root protected 不足以放行。
   每次 dispatch 前重新檢查，不把一次 source manifest 檢查當成載入中的身份。
4. `McpControlCenter.Core.psm1`、`scripts/control-center.ps1`、`scripts/tray.ps1`：只有上述完整 lifecycle closure 與
   lifecycle binding 有正反回歸後，才將目前無條件阻擋替換成可達成的嚴格 gate。
   同時驗證原 v3 owner 已退出；不得同時跑 dev 與 installed manager／Bridge。
5. Project Workspace 的正式 mode／roots／write policy、Codex sandbox 對 protected authority 的負向權限測試
   仍需獨立驗證。這次不改 Project Reading／OMI，也不假定 Codex deny 自動保護另一個工具。

`Get-R1Deployment` 在 legacy protected-path 檢查後仍回 `R1_DEPENDENCY_BINDINGS_UNVERIFIED`；
v4 即使宣告 closure 通過，仍回 `INSTALLED_LIFECYCLE_BINDINGS_REQUIRED`。這是刻意保留的 G1 阻擋。

本輪唯讀 Startup target 仍是 `C:\GPT_MCPtool\mcp_control_center\scripts\start-tray.vbs`，沒有安裝候選 owner。
live Bridge CIM owner 查詢遭拒；沒有提權重試。現有 job 執行中 health 曾回 `scope=all, active=1`，不可當成 cutover idle 證據。

## 本輪隔離驗證（2026-10-12）

命令：`powershell -NoProfile -ExecutionPolicy Bypass -File codex_bridge/tests/test-r1-isolated.ps1`。
最終 evidence：`C:\project\r1-isolated-ada19967ae4b4cd184c5db49f0069735\result.json`，十個 steps 全部 exit 0。
這是 source／synthetic 驗證，G1 仍為 **PARTIAL**，不是 protected installed lifecycle 或 live acceptance。

| 驗證 | 結果 |
|---|---|
| Bridge npm tests／TypeScript build | 180/180 |
| HTTP smoke／widget | PASS；僅隔離 loopback／fixture |
| single native handle／PID reuse fixture | 23 assertions |
| v3 runtime controller | 73 assertions |
| canonical Build ID／reparse／loader fixture | 58 assertions |
| CC R1 owner／IPC／receipt fixture | 17 assertions |
| v3/v4 mapping／CC Core／CLI／tray autoReconcile gates | 67 assertions；72 次 Core mutation call 被拒絕 |
| v2 installed binding | 75 assertions；source binding 正向，activation BLOCKED，無 installed runtime write／launch |
| 同 process loader env 暫存／還原 | PASS；只輸出 name，沒有 value |

binding 的 480 ms 是小型 fixture＋合成 ACL 的一次結果，不是正式 NTFS／完整 node_modules performance。
真實 ACL／100k entries 上限／完整依賴樹與既有 timeout 的成本仍需 operator 量測。

保留的失敗及修復證據：

- `r1-isolated-5b2ca43881a3412585142f3993df4888/installed-binding.log`：fixture 使用 PowerShell `$args` 自動變數，
  以及 assertion helper 的 `$Action` 遮蔽 loop 變數。修成 `$overrides`／`$AssertionBody`；保持原產品 override deny。
- `r1-isolated-29395ee8c9df443481e410e19ceecb0f/controller.log`：`SERVER_NOT_READY` 的實際原因是 synthetic copy
  漏掉 `config.js` 新 import 的 `installed-runtime.js`。另以 Node 直接重現 `ERR_MODULE_NOT_FOUND`；補入該檔後載入成功。
  該模組的 transitive imports 全是 Node built-ins；兩套 fixture 精確補檔，未增加 timeout，未刪除 security import。
- 同一目錄的 `test-installed-binding.ps1.verified.log`：廣義 `NODE_*` deny 正確拒絕既有工具環境的
  `NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S`。只在 synthetic fixture 的 process 中暫時清除／還原 loader env，
  不改產品規則或 Windows 環境設定。`C:\GPT_MCPtool\codex_bridge\.tmp\history\r1-evidence-ec241798df664eff9676e6e9d031e643/fixture-environment.json`
  證明 75 assertions 通過且 `sameProcessEnvironmentRestored=true`。

source/security 自查仍將 installed 啟用 gate 判為 BLOCKED；未載入／未核准 private policy，G0 仍是
`HOST_NOT_VERIFIED`，G2／G3 均未驗收。v3 registry／八個 component mapping、原 native stop handle、正式 dist/web/package
不因以上 fixture 更新；live canonical before/after 都是 `ab00434f51c86ef8`。

## G2 operator cutover（尚不可執行）

前置條件是以上 G1 bindings 全部完成，且真實 host 已證明 RP／origin／topOrigin、get/create policy 與 ceremony。
目前 UI candidate 固定 `HOST_NOT_VERIFIED`，沒有文字 boolean 或 localStorage grant；需要後續可信 host-evidence
設計和人工驗證，不能刪除檢查後直接採用。

完成前置條件後，另開明確授權的部署工作：

1. 在獨立 operator session 保存 live release identity、registry exact bytes、兩個元件 owner/StartTime/PID、
   全部 jobs／approvals terminal 證據和原 Startup target。備份不含公開可讀的 secret；不得把本次 WIP 當 loaded release。
2. 在 versioned candidate 內建置，promotion UI source 到 candidate web；核對 package-lock、native helpers、
   dependency hashes、完整 ACL/ancestors 與反向寫入測試。ACL 安裝是 operator 另行授權工作，不能遞迴改開發 workspace。
3. 核對既有 data／allowlist／tunnel profile／DPAPI 路徑仍由原帳號使用。任何 credential identity 不確定即停。
4. 透過既有單一 Control Center／component lifecycle 進行一次受控移交。先證明原 owner 停止、無第二 tray／Bridge／tunnel，
   才採用 installed owner；不從 Codex job 啟動 replacement、不建立排程／第二服務、不重送 UNKNOWN。
5. 採用後依 G3 驗收；前置任一項失敗，保留既有 v3 正式運作，不切換 active registry。

## G3 live acceptance 與 rollback（待另行授權）

保存 owner out-of-job、exact executable/entrypoint/start time、相同非管理員 SID、pipe 雙向 OS PID/SID、
permissions deny 與真實 host ceremony 證據。確認 canonical／health build 一致，全部 jobs scope=all，
新 MCP session discovery 六個 tools，其中 challenge/approve 為 app-only。
真人核准只允許一筆固定 `reload_runtime`；核對 old/new native instance、tunnel ready、收據歷程，
local completion 與 remote host/schema acceptance 分開報告。

發生 dispatching/running/unknown 時保留 receipts，先查 exact owners、listener、build，不自動重試／rollback。
安全回滾須無 active jobs、無不確定 lifecycle；由 operator 依原 v3 的 exact registry／Startup／loaded release
identity 透過原 lifecycle 還原。只回復 source 不是 runtime rollback；不得 reset 本機 WIP。

同 SID 仍不是對抗任意惡意本機程序的強隔離；本版本不升級此威脅模型。
