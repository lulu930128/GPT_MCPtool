# Workspace v4 離線驗收（2026-11-11）

新增 `omi_open_tw_workspace_v4` → `ui://omi/tw-workspace/v4.html`，兩種 UI metadata 均指向此 URI。v1/v2/v3 保持原名、metadata、selection schema 與讀取行為；所有 Workspace URI 共用同一 production bundle。未修改 UI source、交易邏輯或正式 Runtime。

本次修改：`server.py`；`tests/` 下的 `test_workspace_v2_sdk.py`、`test_workspace_transport_core.py`、`workspace_transport_fixture.py`、`test_server.py`、`test_http_server.py`、`test_runtime_control.py`、`test_runtime_control_sdk.py`、`test_workspace.py`、`test_workspace_g2b_sdk.py`、`check_workspace_contract.py`。其他既有 WIP 保留。

既有 WIP 已有 62 個工具；新增後為 63 個工具、5 個 resources。舊 pre-v3 tools hash 已早於這些 WIP，改由修改前擷取的完整 pre-v4 catalog hash 驗證保留性；原 pre-v3 resources hash 繼續保留。

驗證均為 PASS：8 個 unittest suites 合計 87 tests、static contract check（包含 generated snapshot byte parity）、isolated production build、`git diff --check`。SDK 使用 `2026-07-28` 與精確 legacy `2025-06-18`，驗證 list/read/call、空及指定 initial selection、拒絕非 selection 參數、缺 bundle fail closed。v4 resource 實際回應確認含「當日未完成／待核對委託」「歷史委託」（支援 bundle Unicode escape）。

重現命令（從 `C:\GPT_MCPtool\OMI_search`）：

```powershell
node ui/tw-market-dashboard/scripts/build.mjs --output-dir C:\GPT_MCPtool\OMI_search\.tmp\workspace-v4-widget
$env:OMI_TEST_WIDGET_PATH='C:\GPT_MCPtool\OMI_search\.tmp\workspace-v4-widget\index.html'
foreach ($suite in @('test_workspace_v2_sdk.py','test_workspace_transport_core.py','test_server.py','test_http_server.py','test_runtime_control_sdk.py','test_workspace_g2b_sdk.py','test_workspace.py','test_runtime_control.py')) {
  ./.venv/Scripts/python.exe -B -m unittest discover -s tests -p $suite
  if ($LASTEXITCODE -ne 0) { throw "Failed: $suite" }
}
./.venv/Scripts/python.exe -B tests/check_workspace_contract.py
```

Isolated bundle SHA-256：`5ba9ae2619029d18200a243213b8d53c49f0c9a6a7d819ea2ff30f629af7f2e8`。
Workspace resource UTF-8 SHA-256：`53a41a0768d225546096b2edd6756d37f67233a05d245b1e9076ff14b265abc6`。

Source Update 已有從 source snapshot 建置、以 widget hash pin 發布 `dist/index.html` 的流程，本次未更動。測試只輸出 isolated bundle，未覆寫正式 dist。

Reviewer 後續透過 Control Center Source Build/Stage/Update，再核對 runtimeBuild、v4 tool metadata、v4 resource 內容與 hash，最後用 v4 opener 查驗 Host。正式 loaded runtime 與 Host adoption 均為 UNVERIFIED；舊 URI 快取只是待驗證假設，不宣稱已解決。
