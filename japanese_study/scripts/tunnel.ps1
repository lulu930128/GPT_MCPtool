param(
  [ValidateSet("SelfTest", "Version", "Init", "Doctor", "Health", "Run", "SaveKey", "SaveKeyPrompt", "KeyStatus")]
  [string]$Action = "Doctor",
  [string]$ProjectRoot,
  [string]$TunnelClientPath,
  [string]$ProfileDir,
  [string]$SecretPath,
  [string]$Profile = "japanese-study",
  [string]$TunnelId = $env:JSTUDY_TUNNEL_ID,
  [string]$McpUrl = "http://127.0.0.1:18790/mcp",
  [string]$HealthListenAddr = "127.0.0.1:18792",
  [string]$ControlPlaneApiKeyRef = "env:CONTROL_PLANE_API_KEY",
  [switch]$Explain
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($TunnelClientPath)) {
  $TunnelClientPath = Join-Path $ProjectRoot "vendor\tunnel-client\tunnel-client.exe"
}
if ([string]::IsNullOrWhiteSpace($ProfileDir)) {
  $ProfileDir = Join-Path $ProjectRoot ".tunnel-client"
}

$LocalSettingsPath = Join-Path $ProfileDir "local-settings.psd1"
$TunnelIdSource = if (-not [string]::IsNullOrWhiteSpace($TunnelId)) { "parameter-or-environment" } else { "missing" }
if ([string]::IsNullOrWhiteSpace($TunnelId) -and (Test-Path -LiteralPath $LocalSettingsPath)) {
  $localSettings = Import-PowerShellDataFile -LiteralPath $LocalSettingsPath
  $TunnelId = [string]$localSettings.TunnelId
  $TunnelIdSource = "ignored-local-settings"
}
if ([string]::IsNullOrWhiteSpace($TunnelId)) {
  $existingProfilePath = Join-Path $ProfileDir "$Profile.yaml"
  if (Test-Path -LiteralPath $existingProfilePath) {
    foreach ($line in (Get-Content -LiteralPath $existingProfilePath -Encoding UTF8)) {
      if ($line -match '^\s*tunnel_id\s*:\s*"?([^"#\s]+)') {
        $TunnelId = $matches[1]
        $TunnelIdSource = "ignored-generated-profile"
        break
      }
    }
  }
}

. (Join-Path $PSScriptRoot "key-store.ps1")
$ResolvedSecretPath = Get-ControlPlaneSecretPath -ProjectRoot $ProjectRoot -SecretPath $SecretPath

function Get-AdminBaseUrl {
  if ($HealthListenAddr -match "^https?://") {
    return $HealthListenAddr.TrimEnd("/")
  }
  return "http://$HealthListenAddr"
}

function Assert-TunnelClient {
  if (-not (Test-Path -LiteralPath $TunnelClientPath)) {
    throw "Missing tunnel-client.exe at $TunnelClientPath. Run npm run tunnel:install first."
  }
}

function Assert-TunnelId {
  if ($TunnelId -notmatch '^tunnel_[A-Za-z0-9]+$') {
    throw "No valid tunnel id is configured. Set JSTUDY_TUNNEL_ID or create .tunnel-client\local-settings.psd1."
  }
}

function Assert-StoredKey {
  if (-not (Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $ProjectRoot -SecretPath $ResolvedSecretPath)) {
    throw "No usable DPAPI-protected runtime key. Run npm run tunnel:key:save first."
  }
}

function Invoke-TunnelClient([string[]]$Arguments) {
  Assert-TunnelClient
  & $TunnelClientPath @Arguments
  exit $LASTEXITCODE
}

function Save-KeyFromSecureString([securestring]$Secret) {
  $path = Save-ControlPlaneApiKeySecret -ProjectRoot $ProjectRoot -Secret $Secret -SecretPath $ResolvedSecretPath
  [pscustomobject]@{
    saved = $true
    path = $path
    storage = "Windows DPAPI current-user encrypted"
  } | ConvertTo-Json -Depth 4
}

function Show-SecureKeyPrompt {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()

  $form = New-Object System.Windows.Forms.Form
  $form.Text = "Japanese Study Tunnel Key"
  $form.StartPosition = "CenterScreen"
  $form.FormBorderStyle = "FixedDialog"
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.ClientSize = New-Object System.Drawing.Size(520, 150)

  $label = New-Object System.Windows.Forms.Label
  $label.Text = "Paste the CONTROL_PLANE_API_KEY. It will be stored with Windows DPAPI."
  $label.AutoSize = $true
  $label.Location = New-Object System.Drawing.Point(16, 18)
  $form.Controls.Add($label)

  $textBox = New-Object System.Windows.Forms.TextBox
  $textBox.Location = New-Object System.Drawing.Point(18, 52)
  $textBox.Size = New-Object System.Drawing.Size(484, 24)
  $textBox.UseSystemPasswordChar = $true
  $form.Controls.Add($textBox)

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = "Save"
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.Location = New-Object System.Drawing.Point(342, 100)
  $form.Controls.Add($ok)

  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = "Cancel"
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $cancel.Location = New-Object System.Drawing.Point(427, 100)
  $form.Controls.Add($cancel)

  $form.AcceptButton = $ok
  $form.CancelButton = $cancel
  $form.Add_Shown({ $textBox.Focus() })
  $result = $form.ShowDialog()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
    $textBox.Clear()
    $form.Dispose()
    return $null
  }

  $secure = New-Object System.Security.SecureString
  foreach ($character in $textBox.Text.ToCharArray()) {
    $secure.AppendChar($character)
  }
  $secure.MakeReadOnly()
  $textBox.Clear()
  $form.Dispose()
  return $secure
}

switch ($Action) {
  "SelfTest" {
    $profilePath = Join-Path $ProfileDir "$Profile.yaml"
    [pscustomobject]@{
      projectRoot = $ProjectRoot
      tunnelClientPath = $TunnelClientPath
      tunnelClientExists = Test-Path -LiteralPath $TunnelClientPath
      profileDir = $ProfileDir
      profile = $Profile
      profilePath = $profilePath
      profileExists = Test-Path -LiteralPath $profilePath
      secretPath = $ResolvedSecretPath
      secretStatus = Test-ControlPlaneApiKeySecret -ProjectRoot $ProjectRoot -SecretPath $ResolvedSecretPath
      tunnelIdConfigured = ($TunnelId -match '^tunnel_[A-Za-z0-9]+$')
      tunnelIdSource = $TunnelIdSource
      mcpUrl = $McpUrl
      adminBaseUrl = Get-AdminBaseUrl
      apiKeyReference = $ControlPlaneApiKeyRef
    } | ConvertTo-Json -Depth 5
    exit 0
  }
  "Version" {
    Invoke-TunnelClient @("--version")
  }
  "SaveKey" {
    $secret = Read-Host -Prompt "CONTROL_PLANE_API_KEY" -AsSecureString
    Save-KeyFromSecureString -Secret $secret
    exit 0
  }
  "SaveKeyPrompt" {
    $secret = Show-SecureKeyPrompt
    if ($null -eq $secret) {
      [pscustomobject]@{ saved = $false; cancelled = $true } | ConvertTo-Json
      exit 2
    }
    Save-KeyFromSecureString -Secret $secret
    exit 0
  }
  "KeyStatus" {
    Test-ControlPlaneApiKeySecret -ProjectRoot $ProjectRoot -SecretPath $ResolvedSecretPath | ConvertTo-Json -Depth 4
    exit 0
  }
  "Init" {
    Assert-TunnelId
    Invoke-TunnelClient @(
      "init",
      "--profile-dir", $ProfileDir,
      "--profile", $Profile,
      "--sample", "sample_mcp_remote_no_auth",
      "--tunnel-id", $TunnelId,
      "--mcp-server-url", $McpUrl,
      "--control-plane-api-key-ref", $ControlPlaneApiKeyRef,
      "--health-listen-addr", $HealthListenAddr,
      "--force"
    )
  }
  "Doctor" {
    Assert-StoredKey
    $args = @("doctor", "--profile-dir", $ProfileDir, "--profile", $Profile)
    if ($Explain) {
      $args += "--explain"
    }
    Invoke-TunnelClient $args
  }
  "Health" {
    Invoke-TunnelClient @("health", "--url", (Get-AdminBaseUrl), "--json")
  }
  "Run" {
    Assert-StoredKey
    $tmpDir = Join-Path $ProjectRoot ".tmp"
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
    Invoke-TunnelClient @(
      "run",
      "--profile-dir", $ProfileDir,
      "--profile", $Profile,
      "--log.file", (Join-Path $tmpDir "tunnel-client.log"),
      "--pid.file", (Join-Path $tmpDir "tunnel-client.pid")
    )
  }
}
