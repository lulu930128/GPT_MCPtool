# MCP Control Center

本目錄是六個本機 MCP runtime 的 Windows orchestration 與 observability layer，不是 MCP server，也不擁有任何 domain data。

## 安全邊界

- 只允許 loopback health／readyz probe。
- 不讀取或記錄 MCP tool payload、response body、token、secret、DPAPI ciphertext、個人記憶內容、學習內容或財務資料。
- runtime state、event log、diagnostic 與 Startup adoption receipt 只能放在 `%LOCALAPPDATA%\McpControlCenter` 或明確的 repo-external override。
- component action path 必須解析在該 component root 內；不得接受任意 shell command string。
- `component-controller` mode 只能使用 manager 內建的固定 semantic action 與參數映射；manifest 不得自訂 PowerShell arguments。
- controller action 必須在 bounded timeout 內回傳完整 JSON contract；manager capture 必須限制大小、清除暫存輸出，且不得把 stderr 或未驗證 output 寫入 event。
- 自動 reconciliation 只能執行既有非破壞性 Start。Restart 必須由使用者明確觸發並委派給元件既有 exact-path script。
- 不提供 Stop All、kill-by-name、任意 command、任意 URL 或 domain write action。
- 六個元件都採 `autoStart=true`，server、已配置的外部 API 能力與 tunnel 視為同一條
  production startup chain。中樞只能啟動既有 runtime，不得因此背景呼叫外部 API、
  傳送 tool payload／財務資料或消耗模型 quota。

## Windows lifecycle

- `scripts\start-tray.vbs` 是一般隱藏啟動入口；正常 Start 不取代既有中樞 instance。
- `scripts\Restart-Tray.cmd` 只可 exact-path replacement 中樞 tray，不停止六個 component。
- Startup adoption 預設只能產生 plan。只有明確 `-Apply` 才能移動已驗證 target 的既有 shortcut，且必須保存可回復 receipt。

## 驗證

- `powershell -NoProfile -ExecutionPolicy Bypass -File tests\run-tests.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\control-center.ps1 -Action SelfTest`
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tray.ps1 -SelfTest`
- Live read-only: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\control-center.ps1 -Action Status`
- Side-effect-free plan: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\control-center.ps1 -Action Reconcile -PlanOnly`
