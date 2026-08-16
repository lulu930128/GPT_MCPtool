param(
    [ValidateSet("copy_mcp_url", "copy_health_url", "copy_tunnel_id", "open_mcp_health", "open_tunnel_ui", "open_runtime_logs", "open_control_center", "open_backend_api_docs", "replace_runtime_tunnel_key", "show_key_status")]
    [string]$Action,
    [switch]$SelfTest,
    [ValidateRange(1, 65535)][int]$BackendPort = 18765
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$menuContract = "component-menu-v1"
$supportedActions = @("copy_mcp_url", "copy_health_url", "copy_tunnel_id", "open_mcp_health", "open_tunnel_ui", "open_runtime_logs", "open_control_center", "open_backend_api_docs", "replace_runtime_tunnel_key", "show_key_status")
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$viewerScript = Join-Path $PSScriptRoot "start_memory_core_viewer.ps1"
$stackScript = Join-Path $PSScriptRoot "memory_core_stack.ps1"
$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if ($SelfTest) {
    $dependenciesReady = (Test-Path -LiteralPath $viewerScript -PathType Leaf) -and (Test-Path -LiteralPath $stackScript -PathType Leaf) -and (Test-Path -LiteralPath $powershellPath -PathType Leaf)
    [pscustomobject]@{ ok = $dependenciesReady; menuContract = $menuContract; actions = $supportedActions; managerDomainDataAccess = "none"; managerSecretAccess = "none" } | ConvertTo-Json -Depth 4
    exit $(if ($dependenciesReady) { 0 } else { 1 })
}
$mcpUrl = "http://127.0.0.1:18818/mcp"
$healthUrl = "http://127.0.0.1:18818/health"
$tunnelUiUrl = "http://127.0.0.1:18800/ui"
$backendHealthUrl = "http://127.0.0.1:$BackendPort/health"
$backendDocsUrl = "http://127.0.0.1:$BackendPort/docs"
$runtimeDir = Join-Path $projectRoot ".tmp"
$tunnelId = ""
$tunnelProfilePath = Join-Path $projectRoot "data\tunnel-client\memory-core.yaml"
if (Test-Path -LiteralPath $tunnelProfilePath -PathType Leaf) {
    $match = Select-String -LiteralPath $tunnelProfilePath -Pattern 'tunnel_[A-Za-z0-9]+' | Select-Object -First 1
    if ($null -ne $match) { $tunnelId = $match.Matches[0].Value }
}

if ([string]::IsNullOrWhiteSpace($Action)) { throw "Specify -Action or -SelfTest." }

Add-Type -AssemblyName System.Windows.Forms

function Show-Message([string]$Message, [Windows.Forms.MessageBoxIcon]$Icon) {
    [Windows.Forms.MessageBox]::Show($Message, "Memory Core MCP", 'OK', $Icon) | Out-Null
}
function Copy-ComponentText([string]$Text, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Text)) { throw "$Label is not configured." }
    [Windows.Forms.Clipboard]::SetText($Text)
}
function Test-Endpoint([string]$Url) {
    try { return (Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2).StatusCode -eq 200 }
    catch { return $false }
}

try {
    switch ($Action) {
        "copy_mcp_url" { Copy-ComponentText $mcpUrl "MCP URL" }
        "copy_health_url" { Copy-ComponentText $healthUrl "Health URL" }
        "copy_tunnel_id" { Copy-ComponentText $tunnelId "Tunnel ID" }
        "open_mcp_health" { Start-Process $healthUrl | Out-Null }
        "open_tunnel_ui" { Start-Process $tunnelUiUrl | Out-Null }
        "open_runtime_logs" { New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null; Start-Process explorer.exe -ArgumentList "`"$runtimeDir`"" | Out-Null }
        "open_control_center" {
            if (-not (Test-Endpoint $backendHealthUrl)) { throw "Memory Core backend is not ready." }
            $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$viewerScript`" -BackendPort $BackendPort"
            Start-Process -FilePath $powershellPath -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null
        }
        "open_backend_api_docs" { Start-Process $backendDocsUrl | Out-Null }
        "replace_runtime_tunnel_key" {
            $arguments = "-NoProfile -ExecutionPolicy Bypass -Sta -File `"$stackScript`" -Action SaveRuntimeKey -BackendPort $BackendPort"
            Start-Process -FilePath $powershellPath -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Normal | Out-Null
        }
        "show_key_status" {
            $rawStatus = & $powershellPath -NoProfile -ExecutionPolicy Bypass -File $stackScript -Action KeyStatus -BackendPort $BackendPort 2>$null | Out-String
            if ($LASTEXITCODE -ne 0) { throw "KeyStatus exited with code $LASTEXITCODE." }
            $status = $rawStatus | ConvertFrom-Json
            $mcpStatus = if ($status.mcpClientTokenConfigured) { "Configured" } else { "Missing" }
            $reviewStatus = if ($status.mcpReviewTokenConfigured) { "Configured" } else { "Missing" }
            $viewerStatus = if ($status.viewerTokenConfigured) { "Configured" } else { "Missing" }
            $controlCenterStatus = if ($status.controlCenterTokenConfigured) { "Configured" } else { "Missing" }
            $tunnelStatus = if ($status.tunnelRuntimeKeyConfigured) { "Configured" } else { "Missing" }
            Show-Message "MCP client token: $mcpStatus`nMCP review token: $reviewStatus`nLegacy viewer token: $viewerStatus`nControl center token: $controlCenterStatus`nTunnel runtime key: $tunnelStatus`nStorage: $($status.storage)" ([Windows.Forms.MessageBoxIcon]::Information)
        }
    }
    [pscustomobject]@{ ok = $true; action = $Action; errorCode = $null; message = "Component-owned UI action completed." } | ConvertTo-Json -Compress
}
catch {
    Show-Message "The requested action could not be completed. Check the Memory Core runtime settings." ([Windows.Forms.MessageBoxIcon]::Warning)
    [pscustomobject]@{ ok = $false; action = $Action; errorCode = "UI_ACTION_FAILED"; message = "Component-owned UI action failed." } | ConvertTo-Json -Compress
    exit 1
}
