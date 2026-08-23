param(
    [ValidateSet("copy_mcp_url", "copy_health_url", "copy_tunnel_id", "open_mcp_health", "open_tunnel_ui", "open_runtime_logs", "open_study_browser", "open_hub_health", "save_tunnel_key", "show_key_status")]
    [string]$Action,
    [switch]$SelfTest
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$menuContract = "component-menu-v1"
$supportedActions = @("copy_mcp_url", "copy_health_url", "copy_tunnel_id", "open_mcp_health", "open_tunnel_ui", "open_runtime_logs", "open_study_browser", "open_hub_health", "save_tunnel_key", "show_key_status")
$desktopApiBaseUrl = "http://127.0.0.1:18791"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$keyStorePath = Join-Path $PSScriptRoot "key-store.ps1"
$desktopLauncher = Join-Path $PSScriptRoot "start-japanese-study-desktop.vbs"
if ($SelfTest) {
    $dependenciesReady = (Test-Path -LiteralPath $keyStorePath -PathType Leaf) -and (Test-Path -LiteralPath $desktopLauncher -PathType Leaf)
    [pscustomobject]@{ ok = $dependenciesReady; menuContract = $menuContract; actions = $supportedActions; desktopApiBaseUrl = $desktopApiBaseUrl; managerDomainDataAccess = "none"; managerSecretAccess = "none" } | ConvertTo-Json -Depth 4
    exit $(if ($dependenciesReady) { 0 } else { 1 })
}
$mcpUrl = "http://127.0.0.1:18790/mcp"
$healthUrl = "http://127.0.0.1:18790/health"
$hubHealthUrl = "http://127.0.0.1:18791/health"
$tunnelUiUrl = "http://127.0.0.1:18792/ui"
$runtimeDir = Join-Path $projectRoot ".tmp"
$tunnelProfileDir = Join-Path $projectRoot ".tunnel-client"
$tunnelId = [string]$env:JSTUDY_TUNNEL_ID
$localSettingsPath = Join-Path $tunnelProfileDir "local-settings.psd1"
if ([string]::IsNullOrWhiteSpace($tunnelId) -and (Test-Path -LiteralPath $localSettingsPath -PathType Leaf)) {
    $localSettings = Import-PowerShellDataFile -LiteralPath $localSettingsPath
    $tunnelId = [string]$localSettings.TunnelId
}
$tunnelProfilePath = Join-Path $tunnelProfileDir "japanese-study.yaml"
if ([string]::IsNullOrWhiteSpace($tunnelId) -and (Test-Path -LiteralPath $tunnelProfilePath -PathType Leaf)) {
    $match = Select-String -LiteralPath $tunnelProfilePath -Pattern 'tunnel_[A-Za-z0-9]+' | Select-Object -First 1
    if ($null -ne $match) { $tunnelId = $match.Matches[0].Value }
}
. $keyStorePath
$resolvedSecretPath = Get-ControlPlaneSecretPath -ProjectRoot $projectRoot

if ([string]::IsNullOrWhiteSpace($Action)) { throw "Specify -Action or -SelfTest." }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Show-Message([string]$Message, [Windows.Forms.MessageBoxIcon]$Icon) {
    [Windows.Forms.MessageBox]::Show($Message, "Japanese Study MCP", 'OK', $Icon) | Out-Null
}
function Copy-ComponentText([string]$Text, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Text)) { throw "$Label is not configured." }
    [Windows.Forms.Clipboard]::SetText($Text)
}
function Save-TunnelKey {
    $form = New-Object Windows.Forms.Form
    $form.Text = "Japanese Study Tunnel Key"
    $form.StartPosition = "CenterScreen"; $form.FormBorderStyle = "FixedDialog"; $form.MaximizeBox = $false; $form.MinimizeBox = $false
    $form.ClientSize = New-Object Drawing.Size(520, 150)
    $label = New-Object Windows.Forms.Label
    $label.Text = "Paste the CONTROL_PLANE_API_KEY. It will be stored with Windows DPAPI."; $label.AutoSize = $true; $label.Location = New-Object Drawing.Point(16, 18)
    $textBox = New-Object Windows.Forms.TextBox
    $textBox.Location = New-Object Drawing.Point(18, 52); $textBox.Size = New-Object Drawing.Size(484, 24); $textBox.UseSystemPasswordChar = $true
    $saveButton = New-Object Windows.Forms.Button
    $saveButton.Text = "Save"; $saveButton.DialogResult = [Windows.Forms.DialogResult]::OK; $saveButton.Location = New-Object Drawing.Point(342, 100)
    $cancelButton = New-Object Windows.Forms.Button
    $cancelButton.Text = "Cancel"; $cancelButton.DialogResult = [Windows.Forms.DialogResult]::Cancel; $cancelButton.Location = New-Object Drawing.Point(427, 100)
    $form.Controls.AddRange(@($label, $textBox, $saveButton, $cancelButton)); $form.AcceptButton = $saveButton; $form.CancelButton = $cancelButton
    if ($form.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { $textBox.Clear(); $form.Dispose(); return "cancelled" }
    $secure = New-Object Security.SecureString
    foreach ($character in $textBox.Text.ToCharArray()) { $secure.AppendChar($character) }
    $secure.MakeReadOnly(); $textBox.Clear(); $form.Dispose()
    try {
        Save-ControlPlaneApiKeySecret -ProjectRoot $projectRoot -Secret $secure -SecretPath $resolvedSecretPath | Out-Null
        Show-Message "Tunnel runtime key saved with Windows DPAPI for the current user." ([Windows.Forms.MessageBoxIcon]::Information)
        return "saved"
    }
    finally { $secure.Dispose() }
}

try {
    switch ($Action) {
        "copy_mcp_url" { Copy-ComponentText $mcpUrl "MCP URL" }
        "copy_health_url" { Copy-ComponentText $healthUrl "Health URL" }
        "copy_tunnel_id" { Copy-ComponentText $tunnelId "Tunnel ID" }
        "open_mcp_health" { Start-Process $healthUrl | Out-Null }
        "open_tunnel_ui" { Start-Process $tunnelUiUrl | Out-Null }
        "open_runtime_logs" { New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null; Start-Process explorer.exe -ArgumentList "`"$runtimeDir`"" | Out-Null }
        "open_study_browser" {
            $hubRoot = if ([string]::IsNullOrWhiteSpace([string]$env:JSTUDY_HUB_ROOT)) { "C:\project\japanese-study-hub" } else { [string]$env:JSTUDY_HUB_ROOT }
            $pythonwPath = Join-Path $hubRoot ".venv\Scripts\pythonw.exe"
            if (-not (Test-Path -LiteralPath $pythonwPath -PathType Leaf)) { throw "Japanese Study Hub desktop runtime is not installed." }
            $previousApiBaseUrl = [Environment]::GetEnvironmentVariable("JSTUDY_API_BASE_URL", "Process")
            try {
                [Environment]::SetEnvironmentVariable("JSTUDY_API_BASE_URL", $desktopApiBaseUrl, "Process")
                Start-Process -FilePath $pythonwPath -ArgumentList "-m japanese_study_hub.cli desktop" -WorkingDirectory $hubRoot | Out-Null
            }
            finally {
                [Environment]::SetEnvironmentVariable("JSTUDY_API_BASE_URL", $previousApiBaseUrl, "Process")
            }
        }
        "open_hub_health" { Start-Process $hubHealthUrl | Out-Null }
        "save_tunnel_key" { $null = Save-TunnelKey }
        "show_key_status" {
            $status = Test-ControlPlaneApiKeySecret -ProjectRoot $projectRoot -SecretPath $resolvedSecretPath
            Show-Message "Saved: $($status.exists)`nDecryptable: $($status.decryptable)`nUsable: $($status.usable)`nPath: $($status.path)" ([Windows.Forms.MessageBoxIcon]::Information)
        }
    }
    [pscustomobject]@{ ok = $true; action = $Action; errorCode = $null; message = "Component-owned UI action completed." } | ConvertTo-Json -Compress
}
catch {
    Show-Message "The requested action could not be completed. Check the Japanese Study runtime settings." ([Windows.Forms.MessageBoxIcon]::Warning)
    [pscustomobject]@{ ok = $false; action = $Action; errorCode = "UI_ACTION_FAILED"; message = "Component-owned UI action failed." } | ConvertTo-Json -Compress
    exit 1
}
