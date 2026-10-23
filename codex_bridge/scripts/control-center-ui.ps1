param(
    [ValidateSet("copy_mcp_url", "copy_health_url", "copy_tunnel_id", "open_mcp_health", "open_tunnel_ui", "open_runtime_logs", "open_jobs_folder")]
    [string]$Action,
    [switch]$SelfTest
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$menuContract = "component-menu-v1"
$supportedActions = @("copy_mcp_url", "copy_health_url", "copy_tunnel_id", "open_mcp_health", "open_tunnel_ui", "open_runtime_logs", "open_jobs_folder")
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$installedModule=Import-Module (Join-Path $PSScriptRoot 'codex-bridge-runtime.psm1') -PassThru
$installed=& $installedModule {Test-CbInstalledLayout}
if ($installed) {
    $installedContext=New-CodexBridgeRuntimeContext -ProjectRoot $projectRoot
    & $installedModule {param($c) Assert-CbInstalledMutationBlocked $c} $installedContext
}
if ($SelfTest) {
    [pscustomobject]@{ ok = $true; menuContract = $menuContract; actions = $supportedActions; managerDomainDataAccess = "none"; managerSecretAccess = "none" } | ConvertTo-Json -Depth 4
    exit 0
}
$mcpUrl = "http://127.0.0.1:18828/mcp"
$healthUrl = "http://127.0.0.1:18828/health"
$tunnelUiUrl = "http://127.0.0.1:18829/ui"
if ($installed) {
    $runtimeDir=$installedContext.runtimeDir;$dataDir=$installedContext.dataDir
    $tunnelId=$installedContext.tunnelIdentity.resolvedTunnelId
} else {
$runtimeDir = Join-Path $projectRoot ".tmp"
$dataDir = Join-Path $projectRoot '.local\runtime'
$tunnelId = [string]$env:CODEX_BRIDGE_TUNNEL_ID
$localSettingsPath = Join-Path $projectRoot ".local\tray-settings.json"
if (Test-Path -LiteralPath $localSettingsPath -PathType Leaf) {
    $localSettings = Get-Content -LiteralPath $localSettingsPath -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($null -ne $localSettings.PSObject.Properties["dataDir"] -and -not [string]::IsNullOrWhiteSpace([string]$localSettings.dataDir)) { $dataDir = [string]$localSettings.dataDir }
    if ([string]::IsNullOrWhiteSpace($tunnelId) -and $null -ne $localSettings.PSObject.Properties["tunnelId"]) { $tunnelId = [string]$localSettings.tunnelId }
}
$tunnelProfilePath = Join-Path $projectRoot ".tunnel-client\codex-bridge.yaml"
if ([string]::IsNullOrWhiteSpace($tunnelId) -and (Test-Path -LiteralPath $tunnelProfilePath -PathType Leaf)) {
    foreach ($line in (Get-Content -LiteralPath $tunnelProfilePath -Encoding UTF8)) {
        if ($line -match '^\s*tunnel_id\s*:\s*"?([^"#\s]+)') { $tunnelId = $matches[1]; break }
    }
}
}
$jobsDir = Join-Path $dataDir "jobs"
$explorer=if($installed){'C:\Windows\explorer.exe'}else{'explorer.exe'}

if ([string]::IsNullOrWhiteSpace($Action)) { throw "Specify -Action or -SelfTest." }

Add-Type -AssemblyName System.Windows.Forms
function Show-Message([string]$Message, [Windows.Forms.MessageBoxIcon]$Icon) {
    [Windows.Forms.MessageBox]::Show($Message, "Codex Bridge MCP", 'OK', $Icon) | Out-Null
}
function Copy-ComponentText([string]$Text, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Text)) { throw "$Label is not configured." }
    [Windows.Forms.Clipboard]::SetText($Text)
}

try {
    switch ($Action) {
        "copy_mcp_url" { Copy-ComponentText $mcpUrl "MCP URL" }
        "copy_health_url" { Copy-ComponentText $healthUrl "Health URL" }
        "copy_tunnel_id" { Copy-ComponentText $tunnelId "Tunnel ID" }
        "open_mcp_health" { Start-Process $healthUrl | Out-Null }
        "open_tunnel_ui" { Start-Process $tunnelUiUrl | Out-Null }
        "open_runtime_logs" {
            New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
            Start-Process $explorer -ArgumentList "`"$runtimeDir`"" | Out-Null
        }
        "open_jobs_folder" {
            New-Item -ItemType Directory -Force -Path $jobsDir | Out-Null
            Start-Process $explorer -ArgumentList "`"$jobsDir`"" | Out-Null
        }
    }
    [pscustomobject]@{ ok = $true; action = $Action; errorCode = $null; message = "Component-owned UI action completed." } | ConvertTo-Json -Compress
}
catch {
    Show-Message "The requested action could not be completed. Check the Codex Bridge runtime settings." ([Windows.Forms.MessageBoxIcon]::Warning)
    [pscustomobject]@{ ok = $false; action = $Action; errorCode = "UI_ACTION_FAILED"; message = "Component-owned UI action failed." } | ConvertTo-Json -Compress
    exit 1
}
