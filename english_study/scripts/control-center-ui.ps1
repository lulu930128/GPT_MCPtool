param(
    [ValidateSet("copy_mcp_url", "copy_health_url", "copy_tunnel_id", "open_mcp_health", "open_tunnel_ui", "open_runtime_logs", "open_study_browser", "open_hub_health", "save_tunnel_key", "show_key_status")]
    [string]$Action,
    [switch]$SelfTest
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$menuContract = "component-menu-v1"
$supportedActions = @("copy_mcp_url", "copy_health_url", "copy_tunnel_id", "open_mcp_health", "open_tunnel_ui", "open_runtime_logs", "open_study_browser", "open_hub_health", "save_tunnel_key", "show_key_status")
$desktopApiBaseUrl = "http://127.0.0.1:18887"
$componentRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$mcpUrl = "http://127.0.0.1:18886/mcp"
$healthUrl = "http://127.0.0.1:18886/health"
$hubHealthUrl = "http://127.0.0.1:18887/health"
$tunnelUrl = "http://127.0.0.1:18888"
$hubRoot = if ([string]::IsNullOrWhiteSpace([string]$env:ESTUDY_HUB_ROOT)) { "C:\project\english-study-hub" } else { [string]$env:ESTUDY_HUB_ROOT }
$desktopPythonw = Join-Path $hubRoot ".venv\Scripts\pythonw.exe"
$desktopLauncher = Join-Path $PSScriptRoot "start-english-study-desktop.vbs"
$runtimeDir = Join-Path $componentRoot ".tmp"
$profileDir = Join-Path $componentRoot ".tunnel-client"
$localSettingsPath = Join-Path $profileDir "local-settings.psd1"
$tunnelScript = Join-Path $componentRoot "scripts\tunnel.ps1"

function Get-EnglishStudyTunnelId {
    if (-not [string]::IsNullOrWhiteSpace($env:ESTUDY_TUNNEL_ID)) { return [string]$env:ESTUDY_TUNNEL_ID }
    if (Test-Path -LiteralPath $localSettingsPath -PathType Leaf) {
        $settings = Import-PowerShellDataFile -LiteralPath $localSettingsPath
        if ([string]$settings.TunnelId -match '^tunnel_[A-Za-z0-9]+$') { return [string]$settings.TunnelId }
    }
    $profilePath = Join-Path $profileDir "english-study.yaml"
    if (Test-Path -LiteralPath $profilePath -PathType Leaf) {
        foreach ($line in Get-Content -LiteralPath $profilePath -Encoding UTF8) {
            if ($line -match '^\s*tunnel_id\s*:\s*"?([^"#\s]+)') { return $matches[1] }
        }
    }
    throw "Tunnel id is not configured."
}

if ($SelfTest) {
    $dependenciesReady = (Test-Path -LiteralPath $desktopLauncher -PathType Leaf) -and (Test-Path -LiteralPath $desktopPythonw -PathType Leaf)
    [pscustomobject]@{
        ok = $dependenciesReady
        menuContract = $menuContract
        actions = $supportedActions
        desktopApiBaseUrl = $desktopApiBaseUrl
        managerDomainDataAccess = "none"
        managerSecretAccess = "none"
    } | ConvertTo-Json -Depth 4
    exit $(if ($dependenciesReady) { 0 } else { 1 })
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
        "copy_tunnel_id" { [Windows.Forms.Clipboard]::SetText((Get-EnglishStudyTunnelId)) }
        "open_mcp_health" { Start-Process $healthUrl | Out-Null }
        "open_tunnel_ui" { Start-Process $tunnelUrl | Out-Null }
        "open_runtime_logs" {
            New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
            Start-Process explorer.exe -ArgumentList "`"$runtimeDir`"" | Out-Null
        }
        "open_study_browser" {
            if (-not (Test-Path -LiteralPath $desktopPythonw -PathType Leaf)) { throw "English Study Hub desktop runtime is not installed." }
            $previousApiBaseUrl = [Environment]::GetEnvironmentVariable("ESTUDY_API_BASE_URL", "Process")
            try {
                [Environment]::SetEnvironmentVariable("ESTUDY_API_BASE_URL", $desktopApiBaseUrl, "Process")
                Start-Process -FilePath $desktopPythonw -ArgumentList "-m english_study_hub desktop" -WorkingDirectory $hubRoot | Out-Null
            }
            finally {
                [Environment]::SetEnvironmentVariable("ESTUDY_API_BASE_URL", $previousApiBaseUrl, "Process")
            }
        }
        "open_hub_health" { Start-Process $hubHealthUrl | Out-Null }
        "save_tunnel_key" {
            $result = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tunnelScript -Action SaveKeyPrompt
            if ($LASTEXITCODE -ne 0) { throw "Tunnel key prompt was cancelled or failed." }
            [Windows.Forms.MessageBox]::Show("Tunnel key saved with Windows DPAPI. Reload the English Study runtime to apply it.", "English Study", "OK", "Information") | Out-Null
        }
        "show_key_status" {
            $status = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tunnelScript -Action KeyStatus) | ConvertFrom-Json
            $message = "Exists: $([bool]$status.exists)`r`nDecryptable: $([bool]$status.decryptable)`r`nUsable: $([bool]$status.usable)`r`nStorage: $($status.storage)"
            [Windows.Forms.MessageBox]::Show($message, "English Study Tunnel Key", "OK", "Information") | Out-Null
        }
    }
    [pscustomobject]@{ ok = $true; action = $Action; errorCode = $null; message = "Component-owned UI action completed." } | ConvertTo-Json -Compress
}
catch {
    [Windows.Forms.MessageBox]::Show("The component action failed. Check the component runtime logs.", 'English Study', 'OK', 'Error') | Out-Null
    [pscustomobject]@{ ok = $false; action = $Action; errorCode = "UI_ACTION_FAILED"; message = "Component-owned UI action failed." } | ConvertTo-Json -Compress
    exit 1
}
