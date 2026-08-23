param(
    [ValidateSet("copy_mcp_url", "copy_health_url", "copy_tunnel_id", "open_mcp_health", "open_tunnel_ui", "open_runtime_logs", "open_dashboard", "create_verified_backup", "copy_app_url", "open_data_folder", "open_backup_folder")]
    [string]$Action,
    [switch]$SelfTest
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$menuContract = "component-menu-v1"
$supportedActions = @("copy_mcp_url", "copy_health_url", "copy_tunnel_id", "open_mcp_health", "open_tunnel_ui", "open_runtime_logs", "open_dashboard", "create_verified_backup", "copy_app_url", "open_data_folder", "open_backup_folder")
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ($SelfTest) {
    [pscustomobject]@{ ok = $true; menuContract = $menuContract; actions = $supportedActions; managerDomainDataAccess = "none"; managerSecretAccess = "none"; formalDataPathExposed = $false } | ConvertTo-Json -Depth 4
    exit 0
}
. (Join-Path $PSScriptRoot "local-env.ps1")
$appUrl = "http://127.0.0.1:18876/"
$mcpUrl = "http://127.0.0.1:18876/mcp/"
$healthUrl = "http://127.0.0.1:18876/api/health"
$tunnelUiUrl = "http://127.0.0.1:18877/ui"
$runtimeDir = Join-Path $projectRoot ".tmp"
$tunnelId = [string]$env:PAOS_TUNNEL_ID
if ([string]::IsNullOrWhiteSpace($tunnelId)) { $tunnelId = Get-LocalEnvValue -ProjectRoot $projectRoot -Name "PAOS_TUNNEL_ID" }
$dataDir = [string]$env:PAOS_DATA_DIR
if ([string]::IsNullOrWhiteSpace($dataDir)) { $dataDir = Join-Path $env:LOCALAPPDATA "PersonalAssetOS" }
$backupDir = Join-Path $dataDir "backups"

if ([string]::IsNullOrWhiteSpace($Action)) { throw "Specify -Action or -SelfTest." }

Add-Type -AssemblyName System.Windows.Forms

function Show-Message([string]$Message, [Windows.Forms.MessageBoxIcon]$Icon) {
    [Windows.Forms.MessageBox]::Show($Message, "Personal Asset OS MCP", 'OK', $Icon) | Out-Null
}
function Copy-ComponentText([string]$Text, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Text)) { throw "$Label is not configured." }
    [Windows.Forms.Clipboard]::SetText($Text)
}
function Open-Folder([string]$Path) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    Start-Process explorer.exe -ArgumentList "`"$Path`"" | Out-Null
}

try {
    switch ($Action) {
        "copy_mcp_url" { Copy-ComponentText $mcpUrl "MCP URL" }
        "copy_health_url" { Copy-ComponentText $healthUrl "Health URL" }
        "copy_tunnel_id" { Copy-ComponentText $tunnelId "Tunnel ID" }
        "open_mcp_health" { Start-Process $healthUrl | Out-Null }
        "open_tunnel_ui" { Start-Process $tunnelUiUrl | Out-Null }
        "open_runtime_logs" { Open-Folder $runtimeDir }
        "open_dashboard" { Start-Process $appUrl | Out-Null }
        "create_verified_backup" {
            $result = Invoke-RestMethod -UseBasicParsing -Method Post -Uri "${appUrl}api/backups" -ContentType "application/json" -Body "{}" -TimeoutSec 30
            Show-Message "Verified backup created: $([IO.Path]::GetFileName([string]$result.backup_path))" ([Windows.Forms.MessageBoxIcon]::Information)
        }
        "copy_app_url" { Copy-ComponentText $appUrl "App URL" }
        "open_data_folder" { Open-Folder $dataDir }
        "open_backup_folder" { Open-Folder $backupDir }
    }
    [pscustomobject]@{ ok = $true; action = $Action; errorCode = $null; message = "Component-owned UI action completed." } | ConvertTo-Json -Compress
}
catch {
    Show-Message "The requested action could not be completed. Check the Personal Asset OS runtime settings." ([Windows.Forms.MessageBoxIcon]::Warning)
    [pscustomobject]@{ ok = $false; action = $Action; errorCode = "UI_ACTION_FAILED"; message = "Component-owned UI action failed." } | ConvertTo-Json -Compress
    exit 1
}
