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
  [switch]$ReplaceExisting,
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
$McpServerEntry = Join-Path $ProjectRoot "dist\src\server.js"
$McpBuildArtifacts = @(
  (Join-Path $ProjectRoot "dist\src\api-client.js"),
  (Join-Path $ProjectRoot "dist\src\config.js"),
  (Join-Path $ProjectRoot "dist\src\http-server.js"),
  $McpServerEntry
)
$ExpectedMcpVersion = "0.3.1"
$ExpectedMcpContractVersion = "practice-resolution-v4.1"
$ExpectedMcpToolCount = 14
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

function Get-ExpectedMcpBuildId {
  $artifactHashes = @()
  foreach ($artifact in $McpBuildArtifacts) {
    if (-not (Test-Path -LiteralPath $artifact)) {
      return ""
    }
    $artifactHashes += (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($artifactHashes -join ""))
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha256.ComputeHash($bytes)
    return (-join ($hash | ForEach-Object { $_.ToString("x2") })).Substring(0, 16)
  }
  finally {
    $sha256.Dispose()
  }
}

function Test-McpBuildFresh {
  if (-not (Test-Path -LiteralPath $McpEntry) -or -not (Test-Path -LiteralPath $McpServerEntry)) {
    return $false
  }
  $sourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "src") -Filter "*.ts" -File -Recurse)
  if ($sourceFiles.Count -eq 0) {
    return $false
  }
  $latestSource = $sourceFiles | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  $entryArtifact = Get-Item -LiteralPath $McpEntry
  return $entryArtifact.LastWriteTimeUtc -ge $latestSource.LastWriteTimeUtc
}

if ($SelfTest) {
  [pscustomobject]@{
    trayDisplayName = $TrayDisplayName
    projectRoot = $ProjectRoot
    hubRoot = $HubRoot
    nodePath = $NodePath
    uvPath = $UvPath
    mcpEntry = $McpEntry
    mcpEntryExists = Test-Path -LiteralPath $McpEntry
    mcpBuildFresh = Test-McpBuildFresh
    expectedMcpVersion = $ExpectedMcpVersion
    expectedMcpContractVersion = $ExpectedMcpContractVersion
    expectedMcpToolCount = $ExpectedMcpToolCount
    expectedMcpBuildId = Get-ExpectedMcpBuildId
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
    replaceExistingSupported = $true
    trayMenuContract = "unified-always-on-v2"
    autoStartServer = $true
    autoStartTunnel = $true
  } | ConvertTo-Json -Depth 5
  exit 0
}

function Stop-ExistingJapaneseStudyRuntime {
  $processes = @(
    Get-CimInstance Win32_Process -ErrorAction Stop |
      Where-Object { $_.ProcessId -ne $PID -and -not [string]::IsNullOrWhiteSpace($_.CommandLine) }
  )
  $targets = @()
  foreach ($process in $processes) {
    $commandLine = [string]$process.CommandLine
    $executablePath = [string]$process.ExecutablePath
    $role = $null
    $priority = 99
    if (
      $commandLine.IndexOf("-m japanese_study_hub.cli serve", [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $commandLine.IndexOf($HubRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
    ) {
      $role = "Hub"
      $priority = 10
    }
    elseif (
      $commandLine.IndexOf($McpEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $executablePath.IndexOf("node", [StringComparison]::OrdinalIgnoreCase) -ge 0
    ) {
      $role = "MCP"
      $priority = 20
    }
    elseif (
      (
        $executablePath.Equals($TunnelClientPath, [StringComparison]::OrdinalIgnoreCase) -or
        $commandLine.IndexOf($TunnelClientPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
      ) -and
      $commandLine.IndexOf($TunnelProfileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $commandLine.IndexOf("--profile `"$TunnelProfile`"", [StringComparison]::OrdinalIgnoreCase) -ge 0
    ) {
      $role = "Tunnel"
      $priority = 30
    }
    elseif (
      $process.Name -in @("powershell.exe", "pwsh.exe") -and
      $commandLine -match (
        '(?i)(?:^|\s)-File\s+"?' +
        [Regex]::Escape($PSCommandPath) +
        '"?(?:\s|$)'
      )
    ) {
      $role = "Tray"
      $priority = 40
    }
    if ($role) {
      $targets += [pscustomobject]@{
        ProcessId = [int]$process.ProcessId
        Role = $role
        Priority = $priority
      }
    }
  }
  foreach ($target in @($targets | Sort-Object Priority, ProcessId)) {
    try {
      Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
      Wait-Process -Id $target.ProcessId -Timeout 3 -ErrorAction SilentlyContinue
    }
    catch {
      if (Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue) {
        throw "Could not replace Japanese Study $($target.Role) PID $($target.ProcessId): $($_.Exception.Message)"
      }
    }
  }
  if ($targets.Count -gt 0) {
    Start-Sleep -Milliseconds 600
  }
}

if ($ReplaceExisting) {
  Stop-ExistingJapaneseStudyRuntime
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
  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri $McpHealthUrl -TimeoutSec 2
    return (
      $health.ok -eq $true -and
      $health.service -eq "japanese-study-mcp" -and
      $health.version -eq $ExpectedMcpVersion -and
      $health.contractVersion -eq $ExpectedMcpContractVersion -and
      [int]$health.toolCount -eq $ExpectedMcpToolCount -and
      $health.buildId -eq (Get-ExpectedMcpBuildId)
    )
  }
  catch {
    return $false
  }
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
  if (-not (Test-McpBuildFresh)) {
    Show-Warning "MCP source is newer than dist, or the build artifact is missing.`nRun npm run build before starting the runtime."
    return
  }
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

function Start-McpServer {
  Start-Hub
  Wait-ForHealth { Test-HubHealth } | Out-Null
  Start-Mcp
  Wait-ForHealth { Test-McpHealth } | Out-Null
}

function Stop-McpServer {
  Stop-OwnedProcess ([ref]$script:McpProcess)
  Stop-OwnedProcess ([ref]$script:HubProcess)
}

function Restart-McpServer {
  Stop-McpServer
  Start-Sleep -Milliseconds 400
  Start-McpServer
}

function Stop-All {
  Stop-OwnedProcess ([ref]$script:TunnelProcess)
  Stop-McpServer
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

function Open-RuntimeLogs {
  New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
  Start-Process explorer.exe -ArgumentList "`"$TmpDir`""
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
  $serverHealthy = $hubHealthy -and $mcpHealthy
  $serverOwned = $hubOwned -or $mcpOwned
  $serverStatus = if ($serverHealthy) {
    if ($serverOwned) { "Running" } else { "Running external" }
  }
  elseif ($hubHealthy -or $mcpHealthy) {
    "Partial"
  }
  elseif ($serverOwned) {
    "Starting"
  }
  else {
    "Stopped"
  }

  $statusItem.Text = "$TrayDisplayName | Server: $serverStatus | Tunnel: $tunnelStatus"
  Set-NotifyText "$TrayDisplayName | $serverStatus / $tunnelStatus"
  if ($hubHealthy -and $mcpHealthy -and $tunnelReady) {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
  }
  elseif ($hubOwned -or $mcpOwned -or $tunnelOwned) {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
  }
  else {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Error
  }

  $restartItem.Enabled = $true
  $openTunnelUiItem.Enabled = ($tunnelReady -or $tunnelOwned)
}

$contextMenu = New-Object System.Windows.Forms.ContextMenu
$statusItem = New-Object System.Windows.Forms.MenuItem "$TrayDisplayName | Server: Checking | Tunnel: Checking"
$statusItem.Enabled = $false
$restartItem = New-Object System.Windows.Forms.MenuItem "Restart MCP server"
$saveKeyItem = New-Object System.Windows.Forms.MenuItem "Save tunnel key..."
$keyStatusItem = New-Object System.Windows.Forms.MenuItem "Show key status"
$copyMcpItem = New-Object System.Windows.Forms.MenuItem "Copy MCP URL"
$copyTunnelIdItem = New-Object System.Windows.Forms.MenuItem "Copy tunnel ID"
$copyHealthItem = New-Object System.Windows.Forms.MenuItem "Copy health URL"
$openHealthItem = New-Object System.Windows.Forms.MenuItem "Open MCP health"
$openHubHealthItem = New-Object System.Windows.Forms.MenuItem "Open Hub health"
$openTunnelUiItem = New-Object System.Windows.Forms.MenuItem "Open tunnel UI"
$openRuntimeItem = New-Object System.Windows.Forms.MenuItem "Open runtime logs"
$exitItem = New-Object System.Windows.Forms.MenuItem "Exit"

$restartItem.add_Click({ Restart-McpServer; Update-TrayStatus })
$saveKeyItem.add_Click({ Save-KeyWithPrompt; Update-TrayStatus })
$keyStatusItem.add_Click({ Show-KeyStatus })
$copyMcpItem.add_Click({ Copy-TextToClipboard $McpUrl })
$copyTunnelIdItem.add_Click({
  if ($TunnelId -match '^tunnel_[A-Za-z0-9]+$') {
    Copy-TextToClipboard $TunnelId
  }
  else {
    Show-Warning "No tunnel id is configured in ignored local settings."
  }
})
$copyHealthItem.add_Click({ Copy-TextToClipboard $McpHealthUrl })
$openHealthItem.add_Click({ Start-Process $McpHealthUrl })
$openHubHealthItem.add_Click({ Start-Process $HubHealthUrl })
$openTunnelUiItem.add_Click({ Start-Process $TunnelUiUrl })
$openRuntimeItem.add_Click({ Open-RuntimeLogs })
$exitItem.add_Click({
  $choice = [System.Windows.Forms.MessageBox]::Show(
    "Exit will stop the MCP server, tunnel, and tray. Continue?",
    $TrayDisplayName,
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  )
  if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) { return }
  $timer.Stop()
  try {
    Stop-All
    Stop-ExistingJapaneseStudyRuntime
  }
  catch {
    $timer.Start()
    Show-Error "Exit could not stop the full Japanese Study runtime.`n$($_.Exception.Message)"
    return
  }
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  $mutex.ReleaseMutex()
  $mutex.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$contextMenu.MenuItems.Add($statusItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($restartItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($copyMcpItem) | Out-Null
$contextMenu.MenuItems.Add($copyHealthItem) | Out-Null
$contextMenu.MenuItems.Add($copyTunnelIdItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($openHealthItem) | Out-Null
$contextMenu.MenuItems.Add($openTunnelUiItem) | Out-Null
$contextMenu.MenuItems.Add($openRuntimeItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($openHubHealthItem) | Out-Null
$contextMenu.MenuItems.Add($saveKeyItem) | Out-Null
$contextMenu.MenuItems.Add($keyStatusItem) | Out-Null
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
  Start-McpServer
  Start-Tunnel
}

Update-TrayStatus
[System.Windows.Forms.Application]::Run()
