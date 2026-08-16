param(
    [ValidateSet("copy_mcp_url", "copy_health_url", "copy_tunnel_id", "open_mcp_health", "open_tunnel_ui", "open_runtime_logs", "save_control_plane_key", "show_key_status")]
    [string]$Action,
    [switch]$SelfTest
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$menuContract = "component-menu-v1"
$supportedActions = @("copy_mcp_url", "copy_health_url", "copy_tunnel_id", "open_mcp_health", "open_tunnel_ui", "open_runtime_logs", "save_control_plane_key", "show_key_status")
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$workspaceRoot = Split-Path -Parent $projectRoot
$keyStorePath = Join-Path $workspaceRoot "project_reading\scripts\key-store.ps1"
if ($SelfTest) {
    [pscustomobject]@{ ok = (Test-Path -LiteralPath $keyStorePath -PathType Leaf); menuContract = $menuContract; actions = $supportedActions; managerDomainDataAccess = "none"; managerSecretAccess = "none" } | ConvertTo-Json -Depth 4
    exit $(if (Test-Path -LiteralPath $keyStorePath -PathType Leaf) { 0 } else { 1 })
}
$mcpUrl = "http://127.0.0.1:18797/mcp"
$healthUrl = "http://127.0.0.1:18797/health"
$tunnelUiUrl = "http://127.0.0.1:18799/ui"
$runtimeDir = Join-Path $projectRoot ".tmp"
$tunnelId = [string]$env:OMI_SEARCH_TUNNEL_ID
$tunnelProfilePath = Join-Path $projectRoot ".tunnel-client\omi-search.yaml"
if ([string]::IsNullOrWhiteSpace($tunnelId) -and (Test-Path -LiteralPath $tunnelProfilePath -PathType Leaf)) {
    foreach ($line in (Get-Content -LiteralPath $tunnelProfilePath -Encoding UTF8)) {
        if ($line -match '^\s*tunnel_id\s*:\s*"?([^"#\s]+)') { $tunnelId = $matches[1]; break }
    }
}
. $keyStorePath
$resolvedSecretPath = Get-ControlPlaneSecretPath -ProjectRoot $projectRoot

if ([string]::IsNullOrWhiteSpace($Action)) { throw "Specify -Action or -SelfTest." }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Show-Message([string]$Message, [Windows.Forms.MessageBoxIcon]$Icon) {
    [Windows.Forms.MessageBox]::Show($Message, "OMI Search MCP", 'OK', $Icon) | Out-Null
}
function Copy-ComponentText([string]$Text, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Text)) { throw "$Label is not configured." }
    [Windows.Forms.Clipboard]::SetText($Text)
}
function Save-ControlPlaneKey {
    $form = New-Object Windows.Forms.Form
    $form.Text = "Save CONTROL_PLANE_API_KEY"
    $form.Width = 540
    $form.Height = 180
    $form.FormBorderStyle = [Windows.Forms.FormBorderStyle]::FixedDialog
    $form.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.TopMost = $true
    $label = New-Object Windows.Forms.Label
    $label.Left = 12; $label.Top = 14; $label.Width = 500; $label.Height = 32
    $label.Text = "Paste CONTROL_PLANE_API_KEY. It will be stored encrypted with Windows DPAPI for this user."
    $textBox = New-Object Windows.Forms.TextBox
    $textBox.Left = 12; $textBox.Top = 52; $textBox.Width = 500; $textBox.UseSystemPasswordChar = $true
    $saveButton = New-Object Windows.Forms.Button
    $saveButton.Text = "Save"; $saveButton.Left = 340; $saveButton.Top = 92; $saveButton.Width = 82; $saveButton.DialogResult = [Windows.Forms.DialogResult]::OK
    $cancelButton = New-Object Windows.Forms.Button
    $cancelButton.Text = "Cancel"; $cancelButton.Left = 430; $cancelButton.Top = 92; $cancelButton.Width = 82; $cancelButton.DialogResult = [Windows.Forms.DialogResult]::Cancel
    $form.Controls.AddRange(@($label, $textBox, $saveButton, $cancelButton))
    $form.AcceptButton = $saveButton; $form.CancelButton = $cancelButton
    if ($form.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { $textBox.Clear(); $form.Dispose(); return "cancelled" }
    $plainText = $textBox.Text.Trim()
    $textBox.Clear(); $form.Dispose()
    if ([string]::IsNullOrWhiteSpace($plainText)) { throw "CONTROL_PLANE_API_KEY is empty." }
    if (-not $plainText.StartsWith("sk-")) {
        $choice = [Windows.Forms.MessageBox]::Show("The value does not start with sk-. Save it anyway?", "OMI Search MCP", 'YesNo', 'Warning')
        if ($choice -ne [Windows.Forms.DialogResult]::Yes) { return "cancelled" }
    }
    $secure = New-Object Security.SecureString
    foreach ($character in $plainText.ToCharArray()) { $secure.AppendChar($character) }
    $secure.MakeReadOnly(); $plainText = $null
    try {
        Save-ControlPlaneApiKeySecret -ProjectRoot $projectRoot -Secret $secure -SecretPath $resolvedSecretPath | Out-Null
        Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $projectRoot -SecretPath $resolvedSecretPath | Out-Null
        Show-Message "CONTROL_PLANE_API_KEY saved for this Windows user." ([Windows.Forms.MessageBoxIcon]::Information)
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
        "save_control_plane_key" { $null = Save-ControlPlaneKey }
        "show_key_status" {
            $status = Test-ControlPlaneApiKeySecret -ProjectRoot $projectRoot -SecretPath $resolvedSecretPath
            Show-Message "Path: $($status.path)`nExists: $($status.exists)`nDecryptable: $($status.decryptable)`nUsable: $($status.usable)" ([Windows.Forms.MessageBoxIcon]::Information)
        }
    }
    [pscustomobject]@{ ok = $true; action = $Action; errorCode = $null; message = "Component-owned UI action completed." } | ConvertTo-Json -Compress
}
catch {
    Show-Message "The requested action could not be completed. Check the OMI Search runtime settings." ([Windows.Forms.MessageBoxIcon]::Warning)
    [pscustomobject]@{ ok = $false; action = $Action; errorCode = "UI_ACTION_FAILED"; message = "Component-owned UI action failed." } | ConvertTo-Json -Compress
    exit 1
}
