param(
  [string]$ProjectRoot,
  [string]$HubRoot = "C:\project\japanese-study-hub",
  [string]$HostName = "127.0.0.1",
  [int]$McpPort = 8790,
  [int]$HubPort = 8791,
  [string]$TunnelClientPath,
  [string]$TunnelProfileDir,
  [string]$TunnelProfile = "japanese-study",
  [string]$TunnelId = $env:JSTUDY_TUNNEL_ID,
  [string]$TunnelHealthUrl = "http://127.0.0.1:8792",
  [string]$SecretPath,
  [switch]$NoAutoStart,
  [switch]$AutoStartTunnel,
  [switch]$SelfTest
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$TrayDisplayName = "Japanese Study MCP"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($TunnelClientPath)) {
  $TunnelClientPath = Join-Path $ProjectRoot "vendor\tunnel-client\tunnel-client.exe"
}
if ([string]::IsNullOrWhiteSpace($TunnelProfileDir)) {
  $TunnelProfileDir = Join-Path $ProjectRoot ".tunnel-client"
}

$LocalSettingsPath = Join-Path $TunnelProfileDir "local-settings.psd1"
$TunnelIdSource = if (-not [string]::IsNullOrWhiteSpace($TunnelId)) { "parameter-or-environment" } else { "missing" }
if ([string]::IsNullOrWhiteSpace($TunnelId) -and (Test-Path -LiteralPath $LocalSettingsPath)) {
  $localSettings = Import-PowerShellDataFile -LiteralPath $LocalSettingsPath
  $TunnelId = [string]$localSettings.TunnelId
  $TunnelIdSource = "ignored-local-settings"
}
if ([string]::IsNullOrWhiteSpace($TunnelId)) {
  $existingProfilePath = Join-Path $TunnelProfileDir "$TunnelProfile.yaml"
  if (Test-Path -LiteralPath $existingProfilePath) {
    $profileMatch = Select-String -LiteralPath $existingProfilePath -Pattern 'tunnel_[A-Za-z0-9]+' | Select-Object -First 1
    if ($profileMatch) {
      $TunnelId = $profileMatch.Matches[0].Value
      $TunnelIdSource = "ignored-generated-profile"
    }
  }
}

. (Join-Path $PSScriptRoot "key-store.ps1")
$ResolvedSecretPath = Get-ControlPlaneSecretPath -ProjectRoot $ProjectRoot -SecretPath $SecretPath
$McpEntry = Join-Path $ProjectRoot "dist\src\http-main.js"
$HubPyproject = Join-Path $HubRoot "pyproject.toml"
$McpUrl = "http://${HostName}:${McpPort}/mcp"
$McpHealthUrl = "http://${HostName}:${McpPort}/health"
$HubBaseUrl = "http://${HostName}:${HubPort}"
$HubHealthUrl = "$HubBaseUrl/health"
$TunnelProfilePath = Join-Path $TunnelProfileDir "$TunnelProfile.yaml"
$TunnelUiUrl = "$($TunnelHealthUrl.TrimEnd('/'))/ui"
$TmpDir = Join-Path $ProjectRoot ".tmp"
$TunnelLogFile = Join-Path $TmpDir "tunnel-client.log"
$TunnelPidFile = Join-Path $TmpDir "tunnel-client.pid"
$NodePath = (Get-Command node -ErrorAction Stop).Source
$UvPath = (Get-Command uv -ErrorAction Stop).Source

if ($SelfTest) {
  [pscustomobject]@{
    trayDisplayName = $TrayDisplayName
    projectRoot = $ProjectRoot
    hubRoot = $HubRoot
    nodePath = $NodePath
    uvPath = $UvPath
    mcpEntry = $McpEntry
    mcpEntryExists = Test-Path -LiteralPath $McpEntry
    hubPyproject = $HubPyproject
    hubExists = Test-Path -LiteralPath $HubPyproject
    mcpUrl = $McpUrl
    hubBaseUrl = $HubBaseUrl
    tunnelClientPath = $TunnelClientPath
    tunnelClientExists = Test-Path -LiteralPath $TunnelClientPath
    tunnelProfilePath = $TunnelProfilePath
    tunnelProfileExists = Test-Path -LiteralPath $TunnelProfilePath
    secretStatus = Test-ControlPlaneApiKeySecret -ProjectRoot $ProjectRoot -SecretPath $ResolvedSecretPath
    tunnelIdConfigured = ($TunnelId -match '^tunnel_[A-Za-z0-9]+$')
    tunnelIdSource = $TunnelIdSource
    tunnelHealthUrl = $TunnelHealthUrl
  } | ConvertTo-Json -Depth 5
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\JapaneseStudyHubTray", [ref]$createdNew)
if (-not $createdNew) {
  [System.Windows.Forms.MessageBox]::Show(
    "Japanese Study Hub is already running in the system tray.",
    $TrayDisplayName,
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  ) | Out-Null
  $mutex.Dispose()
  exit 0
}

$script:HubProcess = $null
$script:McpProcess = $null
$script:TunnelProcess = $null

function Test-JsonHealth([string]$Url, [string]$ExpectedService = "") {
  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri $Url -TimeoutSec 2
    if ($health.ok -ne $true) {
      return $false
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedService) -and $health.service -ne $ExpectedService) {
      return $false
    }
    return $true
  }
  catch {
    return $false
  }
}

function Test-HubHealth {
  return Test-JsonHealth -Url $HubHealthUrl -ExpectedService "japanese-study-hub"
}

function Test-McpHealth {
  return Test-JsonHealth -Url $McpHealthUrl
}

function Test-TunnelReady {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$($TunnelHealthUrl.TrimEnd('/'))/readyz" -TimeoutSec 2
    $content = [string]$response.Content
    if ($content.Trim().ToLowerInvariant() -in @("ready", "ok")) {
      return $true
    }
    try {
      $json = $content | ConvertFrom-Json
      return ($json.ready -eq $true -or $json.ok -eq $true -or $json.status -in @("ready", "ok"))
    }
    catch {
      return $false
    }
  }
  catch {
    return $false
  }
}

function Test-OwnedProcess([System.Diagnostics.Process]$Process) {
  return ($null -ne $Process -and -not $Process.HasExited)
}

function Wait-ForHealth([scriptblock]$Probe, [int]$Attempts = 50) {
  for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
    if (& $Probe) {
      return $true
    }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

function Set-NotifyText([string]$Text) {
  if ($Text.Length -gt 63) {
    $Text = $Text.Substring(0, 63)
  }
  $notifyIcon.Text = $Text
}

function Show-Warning([string]$Message) {
  [System.Windows.Forms.MessageBox]::Show(
    $Message,
    $TrayDisplayName,
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  ) | Out-Null
}

function Show-Info([string]$Message) {
  [System.Windows.Forms.MessageBox]::Show(
    $Message,
    $TrayDisplayName,
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  ) | Out-Null
}

function Show-Error([string]$Message) {
  [System.Windows.Forms.MessageBox]::Show(
    $Message,
    $TrayDisplayName,
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
}

function Start-Hub {
  if ((Test-OwnedProcess $script:HubProcess) -or (Test-HubHealth)) {
    return
  }
  if (-not (Test-Path -LiteralPath $HubPyproject)) {
    Show-Warning "Missing Japanese Study Hub at $HubRoot"
    return
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $UvPath
  $startInfo.Arguments = "run python -m japanese_study_hub.cli serve"
  $startInfo.WorkingDirectory = $HubRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.EnvironmentVariables["PYTHONUTF8"] = "1"
  $startInfo.EnvironmentVariables["JSTUDY_API_HOST"] = $HostName
  $startInfo.EnvironmentVariables["JSTUDY_API_PORT"] = [string]$HubPort

  try {
    $script:HubProcess = [System.Diagnostics.Process]::Start($startInfo)
  }
  catch {
    Show-Error "Could not start Japanese Study Hub.`n$($_.Exception.Message)"
  }
}

function Start-Mcp {
  if ((Test-OwnedProcess $script:McpProcess) -or (Test-McpHealth)) {
    return
  }
  if (-not (Test-Path -LiteralPath $McpEntry)) {
    Show-Warning "Missing $McpEntry`nRun npm install and npm run build first."
    return
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $NodePath
  $startInfo.Arguments = "`"$McpEntry`""
  $startInfo.WorkingDirectory = $ProjectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.EnvironmentVariables["JSTUDY_HUB_BASE_URL"] = $HubBaseUrl
  $startInfo.EnvironmentVariables["JSTUDY_MCP_HOST"] = $HostName
  $startInfo.EnvironmentVariables["JSTUDY_MCP_PORT"] = [string]$McpPort

  try {
    $script:McpProcess = [System.Diagnostics.Process]::Start($startInfo)
  }
  catch {
    Show-Error "Could not start Japanese Study MCP.`n$($_.Exception.Message)"
  }
}

function Start-Tunnel {
  if ((Test-OwnedProcess $script:TunnelProcess) -or (Test-TunnelReady)) {
    return
  }
  if (-not (Test-Path -LiteralPath $TunnelClientPath)) {
    Show-Warning "Missing tunnel-client.exe at $TunnelClientPath"
    return
  }
  if (-not (Test-Path -LiteralPath $TunnelProfilePath)) {
    Show-Warning "Missing tunnel profile at $TunnelProfilePath`nRun npm run tunnel:init first."
    return
  }
  if (-not (Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $ProjectRoot -SecretPath $ResolvedSecretPath)) {
    Show-Warning "No usable saved tunnel runtime key. Use Save tunnel key from the tray menu."
    return
  }

  if (-not (Test-HubHealth)) {
    Start-Hub
    Wait-ForHealth { Test-HubHealth } | Out-Null
  }
  if (-not (Test-McpHealth)) {
    Start-Mcp
    Wait-ForHealth { Test-McpHealth } | Out-Null
  }
  if (-not (Test-McpHealth)) {
    Remove-Item Env:\CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    Show-Warning "MCP health check failed; tunnel was not started."
    return
  }

  New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $TunnelClientPath
  $startInfo.Arguments = "run --profile-dir `"$TunnelProfileDir`" --profile `"$TunnelProfile`" --log.file `"$TunnelLogFile`" --pid.file `"$TunnelPidFile`""
  $startInfo.WorkingDirectory = $ProjectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.EnvironmentVariables["CONTROL_PLANE_API_KEY"] = $env:CONTROL_PLANE_API_KEY

  try {
    $script:TunnelProcess = [System.Diagnostics.Process]::Start($startInfo)
  }
  catch {
    Show-Error "Could not start Secure MCP Tunnel.`n$($_.Exception.Message)"
  }
  finally {
    Remove-Item Env:\CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
  }
}

function Stop-OwnedProcess([ref]$ProcessReference) {
  $process = $ProcessReference.Value
  if (-not (Test-OwnedProcess $process)) {
    $ProcessReference.Value = $null
    return
  }
  try {
    $process.Kill()
    $process.WaitForExit(3000) | Out-Null
  }
  catch {
    # The process may have already exited.
  }
  finally {
    $ProcessReference.Value = $null
  }
}

function Start-All {
  Start-Hub
  Wait-ForHealth { Test-HubHealth } | Out-Null
  Start-Mcp
  Wait-ForHealth { Test-McpHealth } | Out-Null
  if ($AutoStartTunnel) {
    Start-Tunnel
  }
}

function Stop-All {
  Stop-OwnedProcess ([ref]$script:TunnelProcess)
  Stop-OwnedProcess ([ref]$script:McpProcess)
  Stop-OwnedProcess ([ref]$script:HubProcess)
}

function Restart-All {
  Stop-All
  Start-Sleep -Milliseconds 400
  Start-All
}

function Copy-TextToClipboard([string]$Text) {
  [System.Windows.Forms.Clipboard]::SetText($Text)
  $notifyIcon.ShowBalloonTip(900, "Japanese Study Hub", "Copied.", [System.Windows.Forms.ToolTipIcon]::Info)
}

function Save-KeyWithPrompt {
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
  if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    $textBox.Clear()
    $form.Dispose()
    return
  }

  $secure = New-Object System.Security.SecureString
  foreach ($character in $textBox.Text.ToCharArray()) {
    $secure.AppendChar($character)
  }
  $secure.MakeReadOnly()
  $textBox.Clear()
  $form.Dispose()
  try {
    Save-ControlPlaneApiKeySecret -ProjectRoot $ProjectRoot -Secret $secure -SecretPath $ResolvedSecretPath | Out-Null
    Show-Info "Tunnel runtime key saved with Windows DPAPI for the current user."
  }
  catch {
    Show-Error $_.Exception.Message
  }
}

function Show-KeyStatus {
  $status = Test-ControlPlaneApiKeySecret -ProjectRoot $ProjectRoot -SecretPath $ResolvedSecretPath
  Show-Info "Saved: $($status.exists)`nDecryptable: $($status.decryptable)`nUsable: $($status.usable)`nPath: $($status.path)"
}

function Update-TrayStatus {
  $hubHealthy = Test-HubHealth
  $mcpHealthy = Test-McpHealth
  $tunnelReady = Test-TunnelReady
  $hubOwned = Test-OwnedProcess $script:HubProcess
  $mcpOwned = Test-OwnedProcess $script:McpProcess
  $tunnelOwned = Test-OwnedProcess $script:TunnelProcess

  $hubStatus = if ($hubHealthy) { if ($hubOwned) { "Ready" } else { "Ready external" } } elseif ($hubOwned) { "Starting" } else { "Stopped" }
  $mcpStatus = if ($mcpHealthy) { if ($mcpOwned) { "Ready" } else { "Ready external" } } elseif ($mcpOwned) { "Starting" } else { "Stopped" }
  $tunnelStatus = if ($tunnelReady) { if ($tunnelOwned) { "Ready" } else { "Ready external" } } elseif ($tunnelOwned) { "Starting" } else { "Stopped" }

  $statusItem.Text = "$TrayDisplayName | Hub: $hubStatus | MCP: $mcpStatus | Tunnel: $tunnelStatus"
  Set-NotifyText "$TrayDisplayName | $hubStatus / $mcpStatus / $tunnelStatus"
  if ($hubHealthy -and $mcpHealthy -and $tunnelReady) {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
  }
  elseif ($hubOwned -or $mcpOwned -or $tunnelOwned) {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
  }
  else {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Error
  }

  $startAllItem.Enabled = -not ($hubHealthy -and $mcpHealthy -and $tunnelReady)
  $stopAllItem.Enabled = ($hubOwned -or $mcpOwned -or $tunnelOwned)
  $startTunnelItem.Enabled = (-not $tunnelReady -and -not $tunnelOwned)
  $stopTunnelItem.Enabled = $tunnelOwned
  $openTunnelUiItem.Enabled = ($tunnelReady -or $tunnelOwned)
}

$contextMenu = New-Object System.Windows.Forms.ContextMenu
$statusItem = New-Object System.Windows.Forms.MenuItem "$TrayDisplayName | Hub: Checking | MCP: Checking | Tunnel: Checking"
$statusItem.Enabled = $false
$startAllItem = New-Object System.Windows.Forms.MenuItem "Start all"
$stopAllItem = New-Object System.Windows.Forms.MenuItem "Stop all"
$restartAllItem = New-Object System.Windows.Forms.MenuItem "Restart all"
$startTunnelItem = New-Object System.Windows.Forms.MenuItem "Start tunnel"
$stopTunnelItem = New-Object System.Windows.Forms.MenuItem "Stop tunnel"
$saveKeyItem = New-Object System.Windows.Forms.MenuItem "Save tunnel key..."
$keyStatusItem = New-Object System.Windows.Forms.MenuItem "Show key status"
$copyTunnelIdItem = New-Object System.Windows.Forms.MenuItem "Copy tunnel ID"
$openHubHealthItem = New-Object System.Windows.Forms.MenuItem "Open Hub health"
$openMcpHealthItem = New-Object System.Windows.Forms.MenuItem "Open MCP health"
$openTunnelUiItem = New-Object System.Windows.Forms.MenuItem "Open tunnel UI"
$exitItem = New-Object System.Windows.Forms.MenuItem "Exit"

$startAllItem.add_Click({ Start-All; Start-Tunnel; Update-TrayStatus })
$stopAllItem.add_Click({ Stop-All; Update-TrayStatus })
$restartAllItem.add_Click({ Restart-All; Start-Tunnel; Update-TrayStatus })
$startTunnelItem.add_Click({ Start-Tunnel; Update-TrayStatus })
$stopTunnelItem.add_Click({ Stop-OwnedProcess ([ref]$script:TunnelProcess); Update-TrayStatus })
$saveKeyItem.add_Click({ Save-KeyWithPrompt; Update-TrayStatus })
$keyStatusItem.add_Click({ Show-KeyStatus })
$copyTunnelIdItem.add_Click({
  if ($TunnelId -match '^tunnel_[A-Za-z0-9]+$') {
    Copy-TextToClipboard $TunnelId
  }
  else {
    Show-Warning "No tunnel id is configured in ignored local settings."
  }
})
$openHubHealthItem.add_Click({ Start-Process $HubHealthUrl })
$openMcpHealthItem.add_Click({ Start-Process $McpHealthUrl })
$openTunnelUiItem.add_Click({ Start-Process $TunnelUiUrl })
$exitItem.add_Click({
  $timer.Stop()
  Stop-All
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  $mutex.ReleaseMutex()
  $mutex.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$contextMenu.MenuItems.Add($statusItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($startAllItem) | Out-Null
$contextMenu.MenuItems.Add($stopAllItem) | Out-Null
$contextMenu.MenuItems.Add($restartAllItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($startTunnelItem) | Out-Null
$contextMenu.MenuItems.Add($stopTunnelItem) | Out-Null
$contextMenu.MenuItems.Add($openTunnelUiItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($saveKeyItem) | Out-Null
$contextMenu.MenuItems.Add($keyStatusItem) | Out-Null
$contextMenu.MenuItems.Add($copyTunnelIdItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($openHubHealthItem) | Out-Null
$contextMenu.MenuItems.Add($openMcpHealthItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($exitItem) | Out-Null

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.ContextMenu = $contextMenu
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
$notifyIcon.Text = "$TrayDisplayName | Starting"
$notifyIcon.Visible = $true

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2500
$timer.add_Tick({ Update-TrayStatus })
$timer.Start()

if (-not $NoAutoStart) {
  Start-All
}
if ($AutoStartTunnel) {
  Start-Tunnel
}

Update-TrayStatus
[System.Windows.Forms.Application]::Run()
