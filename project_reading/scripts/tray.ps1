param(
  [string]$ProjectRoot,
  [string]$WorkspaceRoot = "C:\project",
  [string]$WorkspaceRoots = $env:WORKSPACE_MCP_ROOTS,
  [string]$DefaultWorkspaceRoot = $env:WORKSPACE_MCP_DEFAULT_ROOT,
  [string]$WorkspaceRootDenyDirs = $env:WORKSPACE_MCP_ROOT_DENY_DIRS,
  [string]$AssetScopes = $env:WORKSPACE_MCP_ASSET_SCOPES,
  [string]$HostName = "127.0.0.1",
  [int]$Port = 8787,
  [string]$Token = $env:WORKSPACE_MCP_HTTP_TOKEN,
  [string]$TunnelClientPath,
  [string]$TunnelProfileDir,
  [string]$TunnelProfile = "project-workspace",
  [string]$TunnelId = $env:WORKSPACE_MCP_TUNNEL_ID,
  [string]$TunnelHealthUrl = "http://127.0.0.1:8788",
  [string]$SecretPath,
  [switch]$NoAutoStart,
  [switch]$AutoStartTunnel,
  [switch]$DiagnosticOnly,
  [switch]$ReplaceExisting,
  [switch]$SelfTest
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$TrayDisplayName = "Project Reading MCP"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
$ComponentDescriptorPath = Join-Path $ProjectRoot "control-center\component.json"
$V3ControllerActive = $false
if (Test-Path -LiteralPath $ComponentDescriptorPath -PathType Leaf) {
  try {
    $ComponentDescriptor = [IO.File]::ReadAllText($ComponentDescriptorPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $V3ControllerActive = [string]$ComponentDescriptor.runtimeMode -eq "component-controller"
  }
  catch { throw "Invalid Project Reading control-center descriptor." }
}
if (-not $SelfTest -and -not $DiagnosticOnly -and $V3ControllerActive) {
  throw "LEGACY_TRAY_DISABLED: Use MCP Control Center or the diagnostic launcher. Restore a legacy-tray descriptor only for rollback."
}
$ControllerPath = Join-Path $PSScriptRoot "runtime-control.ps1"
$McpUrl = "http://${HostName}:${Port}/mcp"
$HealthUrl = "http://${HostName}:${Port}/health"
$TunnelUiUrl = "$($TunnelHealthUrl.TrimEnd('/'))/ui"
$RuntimeDir = Join-Path $ProjectRoot ".tmp"
$TrayPidFile = Join-Path $RuntimeDir "project-reading-tray.pid"
$TunnelProfilePath = if ([string]::IsNullOrWhiteSpace($TunnelProfileDir)) {
  Join-Path $ProjectRoot ".tunnel-client\$TunnelProfile.yaml"
}
else { Join-Path $TunnelProfileDir "$TunnelProfile.yaml" }

if ([string]::IsNullOrWhiteSpace($TunnelId) -and (Test-Path -LiteralPath $TunnelProfilePath -PathType Leaf)) {
  foreach ($line in (Get-Content -LiteralPath $TunnelProfilePath -Encoding UTF8)) {
    if ($line -match '^\s*tunnel_id\s*:\s*"?([^"#\s]+)') { $TunnelId = $matches[1]; break }
  }
}

if ($SelfTest) {
  [pscustomobject]@{
    trayDisplayName = $TrayDisplayName
    projectRoot = $ProjectRoot
    controllerPath = $ControllerPath
    controllerExists = Test-Path -LiteralPath $ControllerPath -PathType Leaf
    mcpUrl = $McpUrl
    healthUrl = $HealthUrl
    tunnelHealthUrl = $TunnelHealthUrl
    tunnelUiUrl = $TunnelUiUrl
    trayMenuContract = "unified-always-on-v2"
    lifecycleDelegated = $true
    ownsRuntimeProcesses = $false
    diagnosticOnlySupported = $true
    legacyRuntimeTrayBlocked = $V3ControllerActive
    replaceExistingSupported = $true
    autoStartServer = $true
    autoStartTunnel = $true
  } | ConvertTo-Json -Depth 4
  exit 0
}

function Test-ServerHealth {
  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri $HealthUrl -TimeoutSec 2
    return ($health.ok -eq $true)
  }
  catch { return $false }
}

function Test-TunnelReady {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$($TunnelHealthUrl.TrimEnd('/'))/readyz" -TimeoutSec 2
    return ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300)
  }
  catch { return $false }
}

function Quote-ProcessArgument([string]$Value) {
  if ($null -eq $Value) { return '""' }
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Show-Warning([string]$Message) {
  [Windows.Forms.MessageBox]::Show(
    $Message,
    $TrayDisplayName,
    [Windows.Forms.MessageBoxButtons]::OK,
    [Windows.Forms.MessageBoxIcon]::Warning
  ) | Out-Null
}

function Read-TrayPid {
  if (-not (Test-Path -LiteralPath $TrayPidFile -PathType Leaf)) { return $null }
  try {
    $text = (Get-Content -LiteralPath $TrayPidFile -Encoding UTF8 -Raw).Trim()
    $parsed = 0
    if ([int]::TryParse($text, [ref]$parsed) -and $parsed -gt 0) { return $parsed }
  }
  catch { }
  return $null
}

function Test-ExactTrayProcess([int]$ProcessId) {
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    return (
      [string]$process.Name -in @("powershell.exe", "pwsh.exe") -and
      -not [string]::IsNullOrWhiteSpace([string]$process.CommandLine) -and
      [string]$process.CommandLine -match ('(?i)(?:^|\s)-File\s+"?' + [Regex]::Escape($PSCommandPath) + '"?(?:\s|$)')
    )
  }
  catch { return $false }
}

function Stop-ExistingTrayForReplacement {
  $targets = @()
  $pidFromFile = Read-TrayPid
  if ($null -ne $pidFromFile -and $pidFromFile -ne $PID -and (Test-ExactTrayProcess -ProcessId $pidFromFile)) {
    $targets += $pidFromFile
  }
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
    if ($process.ProcessId -eq $PID -or [string]$process.Name -notin @("powershell.exe", "pwsh.exe")) { continue }
    if ([string]::IsNullOrWhiteSpace([string]$process.CommandLine)) { continue }
    if ([string]$process.CommandLine -match ('(?i)(?:^|\s)-File\s+"?' + [Regex]::Escape($PSCommandPath) + '"?(?:\s|$)')) {
      $targets += [int]$process.ProcessId
    }
  }
  foreach ($targetPid in @($targets | Sort-Object -Unique)) {
    Stop-Process -Id $targetPid -Force -ErrorAction Stop
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ((Get-Process -Id $targetPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 100
    }
    if (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) {
      throw "Previous exact Project Reading tray PID $targetPid did not exit."
    }
  }
}

if ($ReplaceExisting) { Stop-ExistingTrayForReplacement }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$createdNew = $false
$mutex = New-Object Threading.Mutex($true, "Local\ProjectReadingMcpTray", [ref]$createdNew)
if (-not $createdNew) {
  [Windows.Forms.MessageBox]::Show(
    "Project Reading MCP is already running in the system tray.",
    $TrayDisplayName,
    [Windows.Forms.MessageBoxButtons]::OK,
    [Windows.Forms.MessageBoxIcon]::Information
  ) | Out-Null
  $mutex.Dispose()
  exit 0
}
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
[IO.File]::WriteAllText($TrayPidFile, [string]$PID, (New-Object Text.UTF8Encoding($false)))

$script:ControllerProcess = $null
$script:PendingAction = $null
$script:CloseAfterAction = $false

function Set-NotifyText([string]$Text) {
  if ($Text.Length -gt 63) { $Text = $Text.Substring(0, 63) }
  $notifyIcon.Text = $Text
}

function Set-ActionButtonsEnabled([bool]$Enabled) {
  foreach ($item in @($ensureItem, $repairItem, $restartCoreItem, $reloadItem, $shutdownItem)) {
    $item.Enabled = $Enabled
  }
}

function Start-LifecycleAction {
  param([ValidateSet("EnsureRunning", "RepairConnectivity", "RestartCore", "ReloadRuntime", "ShutdownRuntime")][string]$Action)
  if ($null -ne $script:ControllerProcess -and -not $script:ControllerProcess.HasExited) {
    Show-Warning "Wait for $($script:PendingAction) to finish."
    return
  }
  if (-not (Test-Path -LiteralPath $ControllerPath -PathType Leaf)) {
    Show-Warning "Missing lifecycle controller: $ControllerPath"
    return
  }
  if ([string]::IsNullOrWhiteSpace($WorkspaceRoots)) {
    $env:WORKSPACE_MCP_ROOT = $WorkspaceRoot
    Remove-Item Env:\WORKSPACE_MCP_ROOTS -ErrorAction SilentlyContinue
    Remove-Item Env:\WORKSPACE_MCP_DEFAULT_ROOT -ErrorAction SilentlyContinue
    Remove-Item Env:\WORKSPACE_MCP_ROOT_DENY_DIRS -ErrorAction SilentlyContinue
  }
  else {
    $env:WORKSPACE_MCP_ROOTS = $WorkspaceRoots
    $env:WORKSPACE_MCP_DEFAULT_ROOT = $DefaultWorkspaceRoot
    $env:WORKSPACE_MCP_ROOT_DENY_DIRS = $WorkspaceRootDenyDirs
    Remove-Item Env:\WORKSPACE_MCP_ROOT -ErrorAction SilentlyContinue
  }
  if ([string]::IsNullOrWhiteSpace($AssetScopes)) { Remove-Item Env:\WORKSPACE_MCP_ASSET_SCOPES -ErrorAction SilentlyContinue }
  else { $env:WORKSPACE_MCP_ASSET_SCOPES = $AssetScopes }
  if ([string]::IsNullOrWhiteSpace($Token)) { Remove-Item Env:\WORKSPACE_MCP_HTTP_TOKEN -ErrorAction SilentlyContinue }
  else { $env:WORKSPACE_MCP_HTTP_TOKEN = $Token }

  $arguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ControllerPath,
    "-Action", $Action, "-ProjectRoot", $ProjectRoot,
    "-HostName", $HostName, "-Port", [string]$Port,
    "-TunnelProfile", $TunnelProfile, "-TunnelHealthUrl", $TunnelHealthUrl
  )
  if (-not [string]::IsNullOrWhiteSpace($TunnelClientPath)) { $arguments += @("-TunnelClientPath", $TunnelClientPath) }
  if (-not [string]::IsNullOrWhiteSpace($TunnelProfileDir)) { $arguments += @("-TunnelProfileDir", $TunnelProfileDir) }
  if (-not [string]::IsNullOrWhiteSpace($SecretPath)) { $arguments += @("-SecretPath", $SecretPath) }
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = Join-Path $PSHOME "powershell.exe"
  $startInfo.Arguments = ($arguments | ForEach-Object { Quote-ProcessArgument ([string]$_) }) -join " "
  $startInfo.WorkingDirectory = $ProjectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $script:ControllerProcess = [Diagnostics.Process]::Start($startInfo)
  $script:PendingAction = $Action
  Set-ActionButtonsEnabled $false
  $statusItem.Text = "$TrayDisplayName | Running: $Action"
  Set-NotifyText "$TrayDisplayName | $Action"
}

function Update-TrayStatus {
  $serverHealthy = Test-ServerHealth
  $tunnelReady = Test-TunnelReady
  $serverStatus = if ($serverHealthy) { "Running" } else { "Stopped" }
  $tunnelStatus = if ($tunnelReady) { "Ready" } else { "Stopped" }
  if ($serverHealthy -and $tunnelReady) { $notifyIcon.Icon = [Drawing.SystemIcons]::Information }
  elseif ($serverHealthy -or $tunnelReady) { $notifyIcon.Icon = [Drawing.SystemIcons]::Warning }
  else { $notifyIcon.Icon = [Drawing.SystemIcons]::Error }
  $statusItem.Text = "$TrayDisplayName | Server: $serverStatus | Tunnel: $tunnelStatus"
  Set-NotifyText "$TrayDisplayName | $serverStatus / $tunnelStatus"
  $openTunnelUiItem.Enabled = $tunnelReady
}

function Close-TrayUi {
  $timer.Stop()
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  [Windows.Forms.Application]::Exit()
}

$contextMenu = New-Object Windows.Forms.ContextMenu
$statusItem = New-Object Windows.Forms.MenuItem "$TrayDisplayName | Checking"
$statusItem.Enabled = $false
$ensureItem = New-Object Windows.Forms.MenuItem "Ensure runtime running"
$repairItem = New-Object Windows.Forms.MenuItem "Repair connectivity"
$restartCoreItem = New-Object Windows.Forms.MenuItem "Restart MCP server"
$reloadItem = New-Object Windows.Forms.MenuItem "Reload full runtime"
$shutdownItem = New-Object Windows.Forms.MenuItem "Stop full runtime"
$copyMcpItem = New-Object Windows.Forms.MenuItem "Copy MCP URL"
$copyHealthItem = New-Object Windows.Forms.MenuItem "Copy health URL"
$copyTunnelIdItem = New-Object Windows.Forms.MenuItem "Copy tunnel ID"
$copyTunnelIdItem.Enabled = -not [string]::IsNullOrWhiteSpace($TunnelId)
$openHealthItem = New-Object Windows.Forms.MenuItem "Open MCP health"
$openTunnelUiItem = New-Object Windows.Forms.MenuItem "Open tunnel UI"
$openRuntimeItem = New-Object Windows.Forms.MenuItem "Open runtime logs"
$exitItem = New-Object Windows.Forms.MenuItem $(if ($DiagnosticOnly) { "Exit diagnostic tray only" } else { "Exit and stop full runtime" })

$ensureItem.add_Click({ Start-LifecycleAction -Action EnsureRunning })
$repairItem.add_Click({ Start-LifecycleAction -Action RepairConnectivity })
$restartCoreItem.add_Click({ Start-LifecycleAction -Action RestartCore })
$reloadItem.add_Click({
  $choice = [Windows.Forms.MessageBox]::Show("Reload the Project Reading server and tunnel?", $TrayDisplayName, [Windows.Forms.MessageBoxButtons]::YesNo, [Windows.Forms.MessageBoxIcon]::Warning)
  if ($choice -eq [Windows.Forms.DialogResult]::Yes) { Start-LifecycleAction -Action ReloadRuntime }
})
$shutdownItem.add_Click({
  $choice = [Windows.Forms.MessageBox]::Show("Stop the complete Project Reading runtime?", $TrayDisplayName, [Windows.Forms.MessageBoxButtons]::YesNo, [Windows.Forms.MessageBoxIcon]::Warning)
  if ($choice -eq [Windows.Forms.DialogResult]::Yes) { Start-LifecycleAction -Action ShutdownRuntime }
})
$copyMcpItem.add_Click({ [Windows.Forms.Clipboard]::SetText($McpUrl) })
$copyHealthItem.add_Click({ [Windows.Forms.Clipboard]::SetText($HealthUrl) })
$copyTunnelIdItem.add_Click({ [Windows.Forms.Clipboard]::SetText($TunnelId) })
$openHealthItem.add_Click({ Start-Process $HealthUrl })
$openTunnelUiItem.add_Click({ Start-Process $TunnelUiUrl })
$openRuntimeItem.add_Click({ New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null; Start-Process explorer.exe -ArgumentList "`"$RuntimeDir`"" })
$exitItem.add_Click({
  if ($null -ne $script:ControllerProcess -and -not $script:ControllerProcess.HasExited) {
    Show-Warning "Wait for $($script:PendingAction) to finish before closing the tray."
    return
  }
  if ($DiagnosticOnly) { Close-TrayUi; return }
  $choice = [Windows.Forms.MessageBox]::Show("Exit will stop the MCP server, tunnel, and tray. Continue?", $TrayDisplayName, [Windows.Forms.MessageBoxButtons]::YesNo, [Windows.Forms.MessageBoxIcon]::Warning)
  if ($choice -eq [Windows.Forms.DialogResult]::Yes) {
    $script:CloseAfterAction = $true
    Start-LifecycleAction -Action ShutdownRuntime
  }
})

$contextMenu.MenuItems.Add($statusItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
foreach ($item in @($ensureItem, $repairItem, $restartCoreItem, $reloadItem, $shutdownItem)) { $contextMenu.MenuItems.Add($item) | Out-Null }
$contextMenu.MenuItems.Add("-") | Out-Null
foreach ($item in @($copyMcpItem, $copyHealthItem, $copyTunnelIdItem, "-", $openHealthItem, $openTunnelUiItem, $openRuntimeItem, "-", $exitItem)) { $contextMenu.MenuItems.Add($item) | Out-Null }

$notifyIcon = New-Object Windows.Forms.NotifyIcon
$notifyIcon.ContextMenu = $contextMenu
$notifyIcon.Icon = [Drawing.SystemIcons]::Warning
$notifyIcon.Text = "$TrayDisplayName | Starting"
$notifyIcon.Visible = $true

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({
  if ($null -ne $script:ControllerProcess -and $script:ControllerProcess.HasExited) {
    $exitCode = $script:ControllerProcess.ExitCode
    $completedAction = $script:PendingAction
    $script:ControllerProcess.Dispose()
    $script:ControllerProcess = $null
    $script:PendingAction = $null
    Set-ActionButtonsEnabled $true
    Update-TrayStatus
    if ($exitCode -ne 0) {
      $script:CloseAfterAction = $false
      $notifyIcon.ShowBalloonTip(2000, $TrayDisplayName, "$completedAction failed. Open runtime logs for details.", [Windows.Forms.ToolTipIcon]::Warning)
    }
    elseif ($script:CloseAfterAction) { Close-TrayUi }
  }
  elseif ($null -eq $script:ControllerProcess) { Update-TrayStatus }
})
$timer.Start()

try {
  Update-TrayStatus
  if (-not $DiagnosticOnly -and -not $NoAutoStart) {
    Start-LifecycleAction -Action $(if ($ReplaceExisting) { "ReloadRuntime" } else { "EnsureRunning" })
  }
  [Windows.Forms.Application]::Run()
}
finally {
  $timer.Stop()
  $timer.Dispose()
  if ($null -ne $script:ControllerProcess) { $script:ControllerProcess.Dispose() }
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  if ((Read-TrayPid) -eq $PID) { Remove-Item -LiteralPath $TrayPidFile -Force -ErrorAction SilentlyContinue }
  if ($createdNew) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
