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
  [switch]$SelfTest
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$TrayDisplayName = "Project Reading MCP"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$localSettingsPath = Join-Path $ProjectRoot ".local\tray-settings.json"
if (Test-Path -LiteralPath $localSettingsPath) {
  try {
    $localSettings = Get-Content -LiteralPath $localSettingsPath -Encoding UTF8 -Raw | ConvertFrom-Json
  }
  catch {
    throw "Invalid local tray settings at $localSettingsPath. $($_.Exception.Message)"
  }

  if (-not $PSBoundParameters.ContainsKey("WorkspaceRoot") -and
      -not [string]::IsNullOrWhiteSpace([string]$localSettings.workspaceRoot)) {
    $WorkspaceRoot = [string]$localSettings.workspaceRoot
  }
  if (-not $PSBoundParameters.ContainsKey("WorkspaceRoots") -and
      [string]::IsNullOrWhiteSpace($WorkspaceRoots) -and
      -not [string]::IsNullOrWhiteSpace([string]$localSettings.workspaceRoots)) {
    $WorkspaceRoots = [string]$localSettings.workspaceRoots
  }
  if (-not $PSBoundParameters.ContainsKey("DefaultWorkspaceRoot") -and
      [string]::IsNullOrWhiteSpace($DefaultWorkspaceRoot) -and
      -not [string]::IsNullOrWhiteSpace([string]$localSettings.defaultWorkspaceRoot)) {
    $DefaultWorkspaceRoot = [string]$localSettings.defaultWorkspaceRoot
  }
  if (-not $PSBoundParameters.ContainsKey("WorkspaceRootDenyDirs") -and
      [string]::IsNullOrWhiteSpace($WorkspaceRootDenyDirs) -and
      -not [string]::IsNullOrWhiteSpace([string]$localSettings.workspaceRootDenyDirs)) {
    $WorkspaceRootDenyDirs = [string]$localSettings.workspaceRootDenyDirs
  }
  if (-not $PSBoundParameters.ContainsKey("AssetScopes") -and
      [string]::IsNullOrWhiteSpace($AssetScopes) -and
      -not [string]::IsNullOrWhiteSpace([string]$localSettings.assetScopes)) {
    $AssetScopes = [string]$localSettings.assetScopes
  }
}

if ([string]::IsNullOrWhiteSpace($DefaultWorkspaceRoot)) {
  $DefaultWorkspaceRoot = "projects"
}

$HttpEntry = Join-Path $ProjectRoot "dist\src\http-main.js"
$McpUrl = "http://${HostName}:${Port}/mcp"
$HealthUrl = "http://${HostName}:${Port}/health"
$NodeCommand = Get-Command node -ErrorAction Stop
$NodePath = $NodeCommand.Source

if ([string]::IsNullOrWhiteSpace($TunnelClientPath)) {
  $TunnelClientPath = Join-Path $ProjectRoot "vendor\tunnel-client\tunnel-client.exe"
}

if ([string]::IsNullOrWhiteSpace($TunnelProfileDir)) {
  $TunnelProfileDir = Join-Path $ProjectRoot ".tunnel-client"
}

. (Join-Path $PSScriptRoot "key-store.ps1")
$ResolvedSecretPath = Get-ControlPlaneSecretPath -ProjectRoot $ProjectRoot -SecretPath $SecretPath

$TunnelProfilePath = Join-Path $TunnelProfileDir "$TunnelProfile.yaml"
if ([string]::IsNullOrWhiteSpace($TunnelId) -and (Test-Path -LiteralPath $TunnelProfilePath)) {
  foreach ($line in (Get-Content -LiteralPath $TunnelProfilePath -Encoding UTF8)) {
    if ($line -match '^\s*tunnel_id\s*:\s*"?([^"#\s]+)') {
      $TunnelId = $matches[1]
      break
    }
  }
}
$TunnelUiUrl = "$($TunnelHealthUrl.TrimEnd('/'))/ui"
$TmpDir = Join-Path $ProjectRoot ".tmp"
$TunnelLogFile = Join-Path $TmpDir "tunnel-client.log"
$TunnelPidFile = Join-Path $TmpDir "tunnel-client.pid"

if ($SelfTest) {
  $result = [pscustomobject]@{
    trayDisplayName = $TrayDisplayName
    projectRoot = $ProjectRoot
    workspaceRoot = $WorkspaceRoot
    workspaceRoots = $WorkspaceRoots
    defaultWorkspaceRoot = $DefaultWorkspaceRoot
    workspaceRootDenyDirs = $WorkspaceRootDenyDirs
    assetScopes = $AssetScopes
    nodePath = $NodePath
    httpEntry = $HttpEntry
    httpEntryExists = Test-Path -LiteralPath $HttpEntry
    mcpUrl = $McpUrl
    healthUrl = $HealthUrl
    tunnelClientPath = $TunnelClientPath
    tunnelClientExists = Test-Path -LiteralPath $TunnelClientPath
    tunnelProfilePath = $TunnelProfilePath
    tunnelProfileExists = Test-Path -LiteralPath $TunnelProfilePath
    secretPath = $ResolvedSecretPath
    secretExists = Test-Path -LiteralPath $ResolvedSecretPath
    tunnelId = $TunnelId
    tunnelHealthUrl = $TunnelHealthUrl
    tunnelUiUrl = $TunnelUiUrl
  }
  $result | ConvertTo-Json -Depth 4
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:ServerProcess = $null
$script:TunnelProcess = $null

function Test-ServerHealth {
  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri $HealthUrl -TimeoutSec 2
    return ($health.ok -eq $true)
  }
  catch {
    return $false
  }
}

function Test-TunnelReady {
  try {
    Invoke-RestMethod -UseBasicParsing -Uri "$($TunnelHealthUrl.TrimEnd('/'))/readyz" -TimeoutSec 2 | Out-Null
    return $true
  }
  catch {
    return $false
  }
}

function Test-OwnedServerRunning {
  return ($script:ServerProcess -ne $null -and -not $script:ServerProcess.HasExited)
}

function Test-OwnedTunnelRunning {
  return ($script:TunnelProcess -ne $null -and -not $script:TunnelProcess.HasExited)
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

function Show-Error([string]$Message) {
  [System.Windows.Forms.MessageBox]::Show(
    $Message,
    $TrayDisplayName,
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
}

function Start-WorkspaceServer {
  if ((Test-OwnedServerRunning) -or (Test-ServerHealth)) {
    return
  }
  if (-not (Test-Path -LiteralPath $HttpEntry)) {
    Show-Warning "Missing $HttpEntry`nRun npm install and npm run build in $ProjectRoot first."
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
  if ([string]::IsNullOrWhiteSpace($AssetScopes)) {
    Remove-Item Env:\WORKSPACE_MCP_ASSET_SCOPES -ErrorAction SilentlyContinue
  }
  else {
    $env:WORKSPACE_MCP_ASSET_SCOPES = $AssetScopes
  }
  $env:WORKSPACE_MCP_HTTP_HOST = $HostName
  $env:WORKSPACE_MCP_HTTP_PORT = [string]$Port
  if ([string]::IsNullOrWhiteSpace($Token)) {
    Remove-Item Env:\WORKSPACE_MCP_HTTP_TOKEN -ErrorAction SilentlyContinue
  }
  else {
    $env:WORKSPACE_MCP_HTTP_TOKEN = $Token
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $NodePath
  $startInfo.Arguments = "`"$HttpEntry`""
  $startInfo.WorkingDirectory = $ProjectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true

  try {
    $script:ServerProcess = [System.Diagnostics.Process]::Start($startInfo)
    $notifyIcon.ShowBalloonTip(1200, $TrayDisplayName, "Server starting on $McpUrl", [System.Windows.Forms.ToolTipIcon]::Info)
  }
  catch {
    Show-Error "Could not start MCP server.`n$($_.Exception.Message)"
  }
}

function Stop-WorkspaceServer {
  if (-not (Test-OwnedServerRunning)) {
    return
  }
  try {
    $script:ServerProcess.Kill()
    $script:ServerProcess.WaitForExit(3000) | Out-Null
  }
  catch {
    # Process may have already exited.
  }
  finally {
    $script:ServerProcess = $null
  }
}

function Restart-WorkspaceServer {
  Stop-WorkspaceServer
  Start-Sleep -Milliseconds 300
  Start-WorkspaceServer
}

function Start-TunnelClient {
  if ((Test-OwnedTunnelRunning) -or (Test-TunnelReady)) {
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
  Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $ProjectRoot -SecretPath $ResolvedSecretPath | Out-Null
  if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
    Show-Warning "Save CONTROL_PLANE_API_KEY before starting the tunnel.`nRun npm run tunnel:key:save, or set CONTROL_PLANE_API_KEY and run npm run tunnel:key:save-from-env."
    return
  }

  if (-not (Test-ServerHealth)) {
    Start-WorkspaceServer
    Start-Sleep -Milliseconds 800
  }

  New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $TunnelClientPath
  $startInfo.Arguments = "run --profile-dir `"$TunnelProfileDir`" --profile `"$TunnelProfile`" --log.file `"$TunnelLogFile`" --pid.file `"$TunnelPidFile`""
  $startInfo.WorkingDirectory = $ProjectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true

  try {
    $script:TunnelProcess = [System.Diagnostics.Process]::Start($startInfo)
    $tunnelMessage = if ([string]::IsNullOrWhiteSpace($TunnelId)) {
      "Tunnel starting"
    }
    else {
      "Tunnel starting for $TunnelId"
    }
    $notifyIcon.ShowBalloonTip(1200, $TrayDisplayName, $tunnelMessage, [System.Windows.Forms.ToolTipIcon]::Info)
  }
  catch {
    Show-Error "Could not start tunnel-client.`n$($_.Exception.Message)"
  }
}

function Stop-TunnelClient {
  if (-not (Test-OwnedTunnelRunning)) {
    return
  }
  try {
    $script:TunnelProcess.Kill()
    $script:TunnelProcess.WaitForExit(3000) | Out-Null
  }
  catch {
    # Process may have already exited.
  }
  finally {
    $script:TunnelProcess = $null
  }
}

function Copy-TextToClipboard([string]$Text) {
  [System.Windows.Forms.Clipboard]::SetText($Text)
  $notifyIcon.ShowBalloonTip(900, $TrayDisplayName, "Copied: $Text", [System.Windows.Forms.ToolTipIcon]::Info)
}

function Update-TrayStatus {
  $ownedRunning = Test-OwnedServerRunning
  $healthOk = Test-ServerHealth
  $tunnelOwned = Test-OwnedTunnelRunning
  $tunnelReady = Test-TunnelReady

  if ($ownedRunning -and $healthOk) {
    $serverStatus = "Running"
    $startItem.Enabled = $false
    $stopItem.Enabled = $true
  }
  elseif ($ownedRunning) {
    $serverStatus = "Starting"
    $startItem.Enabled = $false
    $stopItem.Enabled = $true
  }
  elseif ($healthOk) {
    $serverStatus = "Running external"
    $startItem.Enabled = $false
    $stopItem.Enabled = $false
  }
  else {
    $serverStatus = "Stopped"
    $startItem.Enabled = $true
    $stopItem.Enabled = $false
  }

  if ($tunnelOwned -and $tunnelReady) {
    $tunnelStatus = "Ready"
    $startTunnelItem.Enabled = $false
    $stopTunnelItem.Enabled = $true
  }
  elseif ($tunnelOwned) {
    $tunnelStatus = "Starting"
    $startTunnelItem.Enabled = $false
    $stopTunnelItem.Enabled = $true
  }
  elseif ($tunnelReady) {
    $tunnelStatus = "Ready external"
    $startTunnelItem.Enabled = $false
    $stopTunnelItem.Enabled = $false
  }
  else {
    $tunnelStatus = "Stopped"
    $startTunnelItem.Enabled = $true
    $stopTunnelItem.Enabled = $false
  }

  if ($healthOk -and $tunnelReady) {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
  }
  elseif ($ownedRunning -or $tunnelOwned) {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
  }
  else {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Error
  }

  $openTunnelUiItem.Enabled = ($tunnelReady -or $tunnelOwned)
  $statusItem.Text = "$TrayDisplayName | Server: $serverStatus | Tunnel: $tunnelStatus"
  Set-NotifyText "$TrayDisplayName | $serverStatus / $tunnelStatus"
}

$contextMenu = New-Object System.Windows.Forms.ContextMenu
$statusItem = New-Object System.Windows.Forms.MenuItem "$TrayDisplayName | Server: Checking | Tunnel: Checking"
$statusItem.Enabled = $false
$startItem = New-Object System.Windows.Forms.MenuItem "Start MCP server"
$stopItem = New-Object System.Windows.Forms.MenuItem "Stop MCP server"
$restartItem = New-Object System.Windows.Forms.MenuItem "Restart MCP server"
$startTunnelItem = New-Object System.Windows.Forms.MenuItem "Start tunnel"
$stopTunnelItem = New-Object System.Windows.Forms.MenuItem "Stop tunnel"
$copyMcpItem = New-Object System.Windows.Forms.MenuItem "Copy MCP URL"
$copyTunnelIdItem = New-Object System.Windows.Forms.MenuItem "Copy tunnel ID"
$copyTunnelIdItem.Enabled = -not [string]::IsNullOrWhiteSpace($TunnelId)
$copyHealthItem = New-Object System.Windows.Forms.MenuItem "Copy health URL"
$openHealthItem = New-Object System.Windows.Forms.MenuItem "Open health check"
$openTunnelUiItem = New-Object System.Windows.Forms.MenuItem "Open tunnel UI"
$exitItem = New-Object System.Windows.Forms.MenuItem "Exit"

$startItem.add_Click({ Start-WorkspaceServer; Update-TrayStatus })
$stopItem.add_Click({ Stop-WorkspaceServer; Update-TrayStatus })
$restartItem.add_Click({ Restart-WorkspaceServer; Update-TrayStatus })
$startTunnelItem.add_Click({ Start-TunnelClient; Update-TrayStatus })
$stopTunnelItem.add_Click({ Stop-TunnelClient; Update-TrayStatus })
$copyMcpItem.add_Click({ Copy-TextToClipboard $McpUrl })
$copyTunnelIdItem.add_Click({ Copy-TextToClipboard $TunnelId })
$copyHealthItem.add_Click({ Copy-TextToClipboard $HealthUrl })
$openHealthItem.add_Click({ Start-Process $HealthUrl })
$openTunnelUiItem.add_Click({ Start-Process $TunnelUiUrl })
$exitItem.add_Click({
  $timer.Stop()
  Stop-TunnelClient
  Stop-WorkspaceServer
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$contextMenu.MenuItems.Add($statusItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($startItem) | Out-Null
$contextMenu.MenuItems.Add($stopItem) | Out-Null
$contextMenu.MenuItems.Add($restartItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($startTunnelItem) | Out-Null
$contextMenu.MenuItems.Add($stopTunnelItem) | Out-Null
$contextMenu.MenuItems.Add($openTunnelUiItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($copyMcpItem) | Out-Null
$contextMenu.MenuItems.Add($copyTunnelIdItem) | Out-Null
$contextMenu.MenuItems.Add($copyHealthItem) | Out-Null
$contextMenu.MenuItems.Add($openHealthItem) | Out-Null
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
  Start-WorkspaceServer
}

if ($AutoStartTunnel) {
  Start-TunnelClient
}

Update-TrayStatus
[System.Windows.Forms.Application]::Run()
