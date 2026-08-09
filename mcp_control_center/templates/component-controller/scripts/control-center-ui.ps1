param(
    [ValidateSet("copy_mcp_url", "copy_health_url", "open_mcp_health", "open_runtime_logs")]
    [string]$Action,
    [switch]$SelfTest
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$menuContract = "component-menu-v1"
$supportedActions = @("copy_mcp_url", "copy_health_url", "open_mcp_health", "open_runtime_logs")
$componentRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$mcpUrl = "http://127.0.0.1:__CORE_PORT__/mcp"
$healthUrl = "http://127.0.0.1:__CORE_PORT__/health"
$runtimeDir = Join-Path $componentRoot ".tmp"

if ($SelfTest) {
    [pscustomobject]@{
        ok = $true
        menuContract = $menuContract
        actions = $supportedActions
        managerDomainDataAccess = "none"
        managerSecretAccess = "none"
    } | ConvertTo-Json -Depth 4
    exit 0
}
if ([string]::IsNullOrWhiteSpace($Action)) { throw "Specify -Action or -SelfTest." }

Add-Type -AssemblyName System.Windows.Forms

try {
    switch ($Action) {
        "copy_mcp_url" {
            [Windows.Forms.Clipboard]::SetText($mcpUrl)
        }
        "copy_health_url" {
            [Windows.Forms.Clipboard]::SetText($healthUrl)
        }
        "open_mcp_health" { Start-Process $healthUrl | Out-Null }
        "open_runtime_logs" {
            New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
            Start-Process explorer.exe -ArgumentList "`"$runtimeDir`"" | Out-Null
        }
    }
    [pscustomobject]@{ ok = $true; action = $Action; errorCode = $null; message = "Component-owned UI action completed." } | ConvertTo-Json -Compress
}
catch {
    [Windows.Forms.MessageBox]::Show("The component action failed. Check the component runtime logs.", '__DISPLAY_NAME_PS_SINGLE__', 'OK', 'Error') | Out-Null
    [pscustomobject]@{ ok = $false; action = $Action; errorCode = "UI_ACTION_FAILED"; message = "Component-owned UI action failed." } | ConvertTo-Json -Compress
    exit 1
}
