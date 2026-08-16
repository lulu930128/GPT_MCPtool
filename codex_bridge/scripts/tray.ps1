param(
  [string]$ProjectRoot,
  [string]$HostName = "127.0.0.1",
  [int]$Port = 18828,
  [string]$ProjectsFile,
  [string]$DataDir = "C:\CodexBridge",
  [string]$Token = $env:CODEX_BRIDGE_HTTP_TOKEN,
  [string]$CodexCommand = "",
  [string]$CodexArgs = "",
  [string]$TunnelClientPath,
  [string]$TunnelProfileDir,
  [string]$TunnelProfile = "codex-bridge",
  [string]$TunnelId,
  [string]$TunnelHealthUrl = "http://127.0.0.1:18829",
  [string]$SecretPath,
  [switch]$NoAutoStart,
  [switch]$AutoStartTunnel,
  [switch]$DiagnosticOnly,
  [switch]$ReplaceExisting,
  [switch]$SelfTest
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$TrayDisplayName = $(if($DiagnosticOnly){"Codex Bridge MCP Diagnostics"}else{"Codex Bridge MCP"})

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
$explicitTunnelId = if ($PSBoundParameters.ContainsKey('TunnelId')) { $TunnelId } else { $null }
$settingsTunnelId = $null
$ComponentDescriptorPath = Join-Path $ProjectRoot "control-center\component.json"
$V3ControllerActive = $false
if (Test-Path -LiteralPath $ComponentDescriptorPath -PathType Leaf) {
  try {
    $ComponentDescriptor = [IO.File]::ReadAllText($ComponentDescriptorPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $V3ControllerActive = [string]$ComponentDescriptor.runtimeMode -eq "component-controller"
  }
  catch { throw "Invalid Codex Bridge control-center descriptor." }
}
if (-not $SelfTest -and -not $DiagnosticOnly -and $V3ControllerActive) {
  throw "LEGACY_TRAY_DISABLED: Use MCP Control Center or the diagnostic launcher. Restore a legacy-tray descriptor only for rollback."
}
if ([string]::IsNullOrWhiteSpace($ProjectsFile)) {
  $ProjectsFile = Join-Path $ProjectRoot ".local\projects.json"
}

function Get-SettingValue($Settings, [string]$Name) {
  $property = $Settings.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

$localSettingsPath = Join-Path $ProjectRoot ".local\tray-settings.json"
if (Test-Path -LiteralPath $localSettingsPath) {
  try { $localSettings = Get-Content -LiteralPath $localSettingsPath -Encoding UTF8 -Raw | ConvertFrom-Json }
  catch { throw "Invalid local tray settings at $localSettingsPath. $($_.Exception.Message)" }
  foreach ($binding in @(
    @{ Parameter = "ProjectsFile"; Name = "projectsFile" },
    @{ Parameter = "DataDir"; Name = "dataDir" },
    @{ Parameter = "CodexCommand"; Name = "codexCommand" },
    @{ Parameter = "CodexArgs"; Name = "codexArgs" }
  )) {
    $value = Get-SettingValue $localSettings $binding.Name
    if (-not $PSBoundParameters.ContainsKey($binding.Parameter) -and -not [string]::IsNullOrWhiteSpace([string]$value)) {
      Set-Variable -Name $binding.Parameter -Value ([string]$value)
    }
  }
  $settingsValue = Get-SettingValue $localSettings 'tunnelId'
  if (-not [string]::IsNullOrWhiteSpace([string]$settingsValue)) { $settingsTunnelId = [string]$settingsValue }
}

$HttpEntry = Join-Path $ProjectRoot "dist\src\http-main.js"
$McpUrl = "http://${HostName}:${Port}/mcp"
$HealthUrl = "http://${HostName}:${Port}/health"
$NodePath = (Get-Command node -ErrorAction Stop).Source
$JobsDir = Join-Path $DataDir "jobs"
$SharedProjectReadingRoot = (Resolve-Path -LiteralPath (Join-Path $ProjectRoot "..\project_reading")).Path
if ([string]::IsNullOrWhiteSpace($TunnelClientPath)) {
  $TunnelClientPath = Join-Path $SharedProjectReadingRoot "vendor\tunnel-client\tunnel-client.exe"
}
if ([string]::IsNullOrWhiteSpace($TunnelProfileDir)) {
  $TunnelProfileDir = Join-Path $ProjectRoot ".tunnel-client"
}
if ([string]::IsNullOrWhiteSpace($SecretPath)) {
  $SecretPath = Join-Path $SharedProjectReadingRoot ".secrets\control-plane-api-key.dpapi"
}
. (Join-Path $SharedProjectReadingRoot "scripts\key-store.ps1")
$ResolvedSecretPath = Get-ControlPlaneSecretPath -ProjectRoot $ProjectRoot -SecretPath $SecretPath
$TunnelProfilePath = Join-Path $TunnelProfileDir "$TunnelProfile.yaml"
Import-Module (Join-Path $PSScriptRoot 'component-runtime.psm1') -Force
$TunnelIdentity = Resolve-CbTunnelIdentity -ExplicitTunnelId $explicitTunnelId -SettingsTunnelId $settingsTunnelId -EnvironmentTunnelId $env:CODEX_BRIDGE_TUNNEL_ID -ProfilePath $TunnelProfilePath
$TunnelId = if ($TunnelIdentity.status -eq 'Ready') { [string]$TunnelIdentity.resolvedTunnelId } else { $null }
$TunnelUiUrl = "$($TunnelHealthUrl.TrimEnd('/'))/ui"
$TmpDir = Join-Path $ProjectRoot ".tmp"
$TunnelLogFile = Join-Path $TmpDir "tunnel-client.log"
$TunnelPidFile = Join-Path $TmpDir "tunnel-client.pid"
$ControllerPath = Join-Path $PSScriptRoot "runtime-control.ps1"

function Test-BuildCurrent {
  if (-not (Test-Path -LiteralPath $HttpEntry)) { return $false }
  $entryTime = (Get-Item -LiteralPath $HttpEntry).LastWriteTimeUtc
  $sourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "src") -Recurse -File -ErrorAction SilentlyContinue)
  $sourceFiles += @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "web") -Recurse -File -ErrorAction SilentlyContinue)
  $sourceFiles += @(Get-Item -LiteralPath (Join-Path $ProjectRoot "package.json") -ErrorAction SilentlyContinue)
  return -not @($sourceFiles | Where-Object { $_.LastWriteTimeUtc -gt $entryTime }).Count
}

if ($SelfTest) {
  $localCodexLauncher = Join-Path $ProjectRoot "node_modules\@openai\codex\bin\codex.js"
  $effectiveCodexCommand = if ([string]::IsNullOrWhiteSpace($CodexCommand) -and (Test-Path -LiteralPath $localCodexLauncher)) { $NodePath } elseif ([string]::IsNullOrWhiteSpace($CodexCommand)) { "codex" } else { $CodexCommand }
  $effectiveCodexArgs = if ([string]::IsNullOrWhiteSpace($CodexArgs) -and (Test-Path -LiteralPath $localCodexLauncher)) { "[`"$localCodexLauncher`",`"app-server`"]" } elseif ([string]::IsNullOrWhiteSpace($CodexArgs)) { '["app-server"]' } else { $CodexArgs }
  $codexResolved = Get-Command $effectiveCodexCommand -ErrorAction SilentlyContinue
  [pscustomobject]@{
    trayDisplayName = $TrayDisplayName
    projectRoot = $ProjectRoot
    nodePath = $NodePath
    httpEntry = $HttpEntry
    httpEntryExists = Test-Path -LiteralPath $HttpEntry
    buildCurrent = Test-BuildCurrent
    projectsFile = $ProjectsFile
    projectsFileExists = Test-Path -LiteralPath $ProjectsFile
    dataDir = $DataDir
    jobsDir = $JobsDir
    codexCommand = $effectiveCodexCommand
    codexCommandResolved = if ($null -ne $codexResolved) { $codexResolved.Source } else { $null }
    codexArgs = $effectiveCodexArgs
    mcpUrl = $McpUrl
    healthUrl = $HealthUrl
    tunnelClientPath = $TunnelClientPath
    tunnelClientExists = Test-Path -LiteralPath $TunnelClientPath
    tunnelProfilePath = $TunnelProfilePath
    tunnelProfileExists = Test-Path -LiteralPath $TunnelProfilePath
    secretPath = $ResolvedSecretPath
    secretExists = Test-Path -LiteralPath $ResolvedSecretPath
    tunnelIdConfigured = $TunnelIdentity.status -eq 'Ready'
    tunnelIdentity = Get-CbTunnelIdentitySummary -Identity $TunnelIdentity
    tunnelHealthUrl = $TunnelHealthUrl
    replaceExistingSupported = $true
    trayMenuContract = "unified-always-on-v2"
    lifecycleDelegated = [bool]$DiagnosticOnly
    ownsRuntimeProcesses = -not [bool]$DiagnosticOnly
    diagnosticOnlySupported = $true
    diagnosticOnly = [bool]$DiagnosticOnly
    exitUiStopsRuntime = -not [bool]$DiagnosticOnly
    legacyRuntimeTrayBlocked = $V3ControllerActive
    controllerPath = $ControllerPath
    controllerExists = Test-Path -LiteralPath $ControllerPath -PathType Leaf
    autoStartServer = $true
    autoStartTunnel = $true
  } | ConvertTo-Json -Depth 4
  exit 0
}

function Stop-ExistingCodexBridgeRuntime {
  param([switch]$TrayOnly)
  $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -ne $PID -and -not [string]::IsNullOrWhiteSpace($_.CommandLine) })
  $targets = @()
  foreach ($process in $processes) {
    $commandLine = [string]$process.CommandLine
    $executablePath = [string]$process.ExecutablePath
    $role = $null
    $priority = 99
    if (-not $TrayOnly -and $commandLine.IndexOf($HttpEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $executablePath.IndexOf("node", [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $role = "MCP"; $priority = 10
    }
    elseif (-not $TrayOnly -and ($executablePath.Equals($TunnelClientPath, [StringComparison]::OrdinalIgnoreCase) -or $commandLine.IndexOf($TunnelClientPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) -and $commandLine.IndexOf($TunnelProfileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $commandLine.IndexOf("--profile `"$TunnelProfile`"", [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $role = "Tunnel"; $priority = 20
    }
    elseif ($process.Name -in @("powershell.exe", "pwsh.exe") -and $commandLine -match ('(?i)(?:^|\s)-File\s+"?' + [Regex]::Escape($PSCommandPath) + '"?(?:\s|$)')) {
      $role = "Tray"; $priority = 30
    }
    if ($null -ne $role) { $targets += [pscustomobject]@{ ProcessId = [int]$process.ProcessId; Role = $role; Priority = $priority } }
  }
  foreach ($target in @($targets | Sort-Object Priority, ProcessId)) {
    try { Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop; Wait-Process -Id $target.ProcessId -Timeout 3 -ErrorAction SilentlyContinue }
    catch { if (Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue) { throw "Could not replace Codex Bridge $($target.Role) PID $($target.ProcessId): $($_.Exception.Message)" } }
  }
  if ($targets.Count -gt 0) { Start-Sleep -Milliseconds 600 }
}

if ($ReplaceExisting) { Stop-ExistingCodexBridgeRuntime -TrayOnly:$DiagnosticOnly }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\CodexBridgeMcpTray", [ref]$createdNew)
if (-not $createdNew) {
  [System.Windows.Forms.MessageBox]::Show("Codex Bridge MCP is already running in the system tray.", $TrayDisplayName, "OK", "Information") | Out-Null
  $mutex.Dispose()
  exit 0
}

$script:ServerProcess = $null
$script:TunnelProcess = $null

function Test-ServerHealth {
  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri $HealthUrl -TimeoutSec 2
    return ($health.ok -eq $true -and $health.service -eq "codex-handoff-bridge")
  }
  catch { return $false }
}
function Test-TunnelReady {
  try { Invoke-RestMethod -UseBasicParsing -Uri "$($TunnelHealthUrl.TrimEnd('/'))/readyz" -TimeoutSec 2 | Out-Null; return $true }
  catch { return $false }
}
function Test-OwnedServerRunning { return ($script:ServerProcess -ne $null -and -not $script:ServerProcess.HasExited) }
function Test-OwnedTunnelRunning { return ($script:TunnelProcess -ne $null -and -not $script:TunnelProcess.HasExited) }
function Set-NotifyText([string]$Text) { if ($Text.Length -gt 63) { $Text = $Text.Substring(0, 63) }; $notifyIcon.Text = $Text }
function Show-Warning([string]$Message) { [System.Windows.Forms.MessageBox]::Show($Message, $TrayDisplayName, "OK", "Warning") | Out-Null }
function Show-Error([string]$Message) { [System.Windows.Forms.MessageBox]::Show($Message, $TrayDisplayName, "OK", "Error") | Out-Null }

function Start-CodexBridgeServer {
  if ((Test-OwnedServerRunning) -or (Test-ServerHealth)) { return }
  if (-not (Test-BuildCurrent)) { Show-Warning "Build is missing or stale.`nRun npm install and npm run build in $ProjectRoot first."; return }
  if (-not (Test-Path -LiteralPath $ProjectsFile)) { Show-Warning "Missing project allowlist at $ProjectsFile"; return }
  $env:CODEX_BRIDGE_PROJECT_ROOT = $ProjectRoot
  $env:CODEX_BRIDGE_PROJECTS_FILE = $ProjectsFile
  $env:CODEX_BRIDGE_DATA_DIR = $DataDir
  $env:CODEX_BRIDGE_HTTP_HOST = $HostName
  $env:CODEX_BRIDGE_HTTP_PORT = [string]$Port
  if ([string]::IsNullOrWhiteSpace($CodexCommand)) { Remove-Item Env:\CODEX_BRIDGE_CODEX_COMMAND -ErrorAction SilentlyContinue }
  else { $env:CODEX_BRIDGE_CODEX_COMMAND = $CodexCommand }
  if ([string]::IsNullOrWhiteSpace($CodexArgs)) { Remove-Item Env:\CODEX_BRIDGE_CODEX_ARGS -ErrorAction SilentlyContinue }
  else { $env:CODEX_BRIDGE_CODEX_ARGS = $CodexArgs }
  if ([string]::IsNullOrWhiteSpace($Token)) { Remove-Item Env:\CODEX_BRIDGE_HTTP_TOKEN -ErrorAction SilentlyContinue }
  else { $env:CODEX_BRIDGE_HTTP_TOKEN = $Token }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $NodePath
  $startInfo.Arguments = "`"$HttpEntry`""
  $startInfo.WorkingDirectory = $ProjectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  try {
    $script:ServerProcess = [System.Diagnostics.Process]::Start($startInfo)
    $notifyIcon.ShowBalloonTip(1200, $TrayDisplayName, "Server starting on $McpUrl", "Info")
  }
  catch { Show-Error "Could not start MCP server.`n$($_.Exception.Message)" }
}

function Stop-CodexBridgeServer {
  if (-not (Test-OwnedServerRunning)) { return }
  try { $script:ServerProcess.Kill(); $script:ServerProcess.WaitForExit(3000) | Out-Null }
  catch { }
  finally { $script:ServerProcess = $null }
}
function Restart-CodexBridgeServer { Stop-CodexBridgeServer; Start-Sleep -Milliseconds 300; Start-CodexBridgeServer }

function Start-TunnelClient {
  if ((Test-OwnedTunnelRunning) -or (Test-TunnelReady)) { return }
  try { Assert-CbTunnelIdentityReady -Context ([pscustomobject]@{ tunnelIdentity = $TunnelIdentity }) }
  catch { Show-Warning "Tunnel identity configuration is missing, invalid, or inconsistent. Run tunnel SelfTest before starting."; return }
  if (-not (Test-Path -LiteralPath $TunnelClientPath)) { Show-Warning "Missing tunnel-client.exe at $TunnelClientPath"; return }
  if (-not (Test-Path -LiteralPath $TunnelProfilePath)) { Show-Warning "Missing tunnel profile at $TunnelProfilePath`nRun npm run tunnel:init first."; return }
  Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $ProjectRoot -SecretPath $ResolvedSecretPath | Out-Null
  if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) { Show-Warning "Save CONTROL_PLANE_API_KEY before starting the tunnel."; return }
  if (-not (Test-ServerHealth)) { Start-CodexBridgeServer; Start-Sleep -Milliseconds 800 }
  New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $TunnelClientPath
  $startInfo.Arguments = "run --profile-dir `"$TunnelProfileDir`" --profile `"$TunnelProfile`" --control-plane.tunnel-id `"$TunnelId`" --log.file `"$TunnelLogFile`" --pid.file `"$TunnelPidFile`""
  $startInfo.WorkingDirectory = $ProjectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  try { $script:TunnelProcess = [System.Diagnostics.Process]::Start($startInfo); $notifyIcon.ShowBalloonTip(1200, $TrayDisplayName, "Tunnel starting", "Info") }
  catch { Show-Error "Could not start tunnel-client.`n$($_.Exception.Message)" }
}
function Stop-TunnelClient {
  if (-not (Test-OwnedTunnelRunning)) { return }
  try { $script:TunnelProcess.Kill(); $script:TunnelProcess.WaitForExit(3000) | Out-Null }
  catch { }
  finally { $script:TunnelProcess = $null }
}
function Copy-TextToClipboard([string]$Text) { [System.Windows.Forms.Clipboard]::SetText($Text); $notifyIcon.ShowBalloonTip(900, $TrayDisplayName, "Copied: $Text", "Info") }
function Open-RuntimeLogs { New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null; Start-Process explorer.exe -ArgumentList "`"$TmpDir`"" }

function Invoke-ControllerReload {
  if(-not(Test-Path -LiteralPath $ControllerPath -PathType Leaf)){Show-Error "Runtime controller is missing.";return $false}
  try{$output=@(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ControllerPath -Action ReloadRuntime -ProjectRoot $ProjectRoot 2>&1);$exitCode=$LASTEXITCODE;$result=($output-join[Environment]::NewLine)|ConvertFrom-Json;if($exitCode-ne 0-or$result.ok-ne$true){Show-Error "Runtime reload failed.`n$($result.errorCode): $($result.message)";return $false};return $true}catch{Show-Error "Runtime reload failed. Open runtime logs for details.";return $false}
}

function Update-TrayStatus {
  $ownedRunning = Test-OwnedServerRunning; $healthOk = Test-ServerHealth
  $tunnelOwned = Test-OwnedTunnelRunning; $tunnelReady = Test-TunnelReady
  if ($ownedRunning -and $healthOk) { $serverStatus = "Running" }
  elseif ($ownedRunning) { $serverStatus = "Starting" }
  elseif ($healthOk) { $serverStatus = "Running external" }
  else { $serverStatus = "Stopped" }
  if ($tunnelOwned -and $tunnelReady) { $tunnelStatus = "Ready" }
  elseif ($tunnelOwned) { $tunnelStatus = "Starting" }
  elseif ($tunnelReady) { $tunnelStatus = "Ready external" }
  else { $tunnelStatus = "Stopped" }
  if ($healthOk -and $tunnelReady) { $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information }
  elseif ($ownedRunning -or $tunnelOwned) { $notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning }
  else { $notifyIcon.Icon = [System.Drawing.SystemIcons]::Error }
  $openTunnelUiItem.Enabled = ($tunnelReady -or $tunnelOwned)
  $statusItem.Text = "$TrayDisplayName | Server: $serverStatus | Tunnel: $tunnelStatus"
  Set-NotifyText "$TrayDisplayName | $serverStatus / $tunnelStatus"
}

$contextMenu = New-Object System.Windows.Forms.ContextMenu
$statusItem = New-Object System.Windows.Forms.MenuItem "$TrayDisplayName | Server: Checking | Tunnel: Checking"; $statusItem.Enabled = $false
$restartItem = New-Object System.Windows.Forms.MenuItem $(if($DiagnosticOnly){"Reload managed runtime"}else{"Restart MCP server"})
$openTunnelUiItem = New-Object System.Windows.Forms.MenuItem "Open tunnel UI"
$copyMcpItem = New-Object System.Windows.Forms.MenuItem "Copy MCP URL"
$copyTunnelIdItem = New-Object System.Windows.Forms.MenuItem "Copy tunnel ID"; $copyTunnelIdItem.Enabled = -not [string]::IsNullOrWhiteSpace($TunnelId)
$copyHealthItem = New-Object System.Windows.Forms.MenuItem "Copy health URL"
$openHealthItem = New-Object System.Windows.Forms.MenuItem "Open MCP health"
$openRuntimeItem = New-Object System.Windows.Forms.MenuItem "Open runtime logs"
$openJobsItem = New-Object System.Windows.Forms.MenuItem "Open jobs folder"
$exitItem = New-Object System.Windows.Forms.MenuItem $(if($DiagnosticOnly){"Exit diagnostic tray only"}else{"Exit"})
$restartItem.add_Click({if($DiagnosticOnly){Invoke-ControllerReload|Out-Null}else{Restart-CodexBridgeServer};Update-TrayStatus})
$openTunnelUiItem.add_Click({ Start-Process $TunnelUiUrl })
$copyMcpItem.add_Click({ Copy-TextToClipboard $McpUrl })
$copyTunnelIdItem.add_Click({ Copy-TextToClipboard $TunnelId })
$copyHealthItem.add_Click({ Copy-TextToClipboard $HealthUrl })
$openHealthItem.add_Click({ Start-Process $HealthUrl })
$openRuntimeItem.add_Click({ Open-RuntimeLogs })
$openJobsItem.add_Click({ New-Item -ItemType Directory -Force -Path $JobsDir | Out-Null; Start-Process explorer.exe -ArgumentList "`"$JobsDir`"" })
$exitItem.add_Click({
  if($DiagnosticOnly){$timer.Stop();$notifyIcon.Visible=$false;$notifyIcon.Dispose();$mutex.ReleaseMutex();$mutex.Dispose();[System.Windows.Forms.Application]::Exit();return}
  $choice = [System.Windows.Forms.MessageBox]::Show("Exit will stop the MCP server, tunnel, and tray. Continue?", $TrayDisplayName, "YesNo", "Warning")
  if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) { return }
  $timer.Stop()
  try { Stop-TunnelClient; Stop-CodexBridgeServer; Stop-ExistingCodexBridgeRuntime }
  catch { $timer.Start(); Show-Error "Exit could not stop the full Codex Bridge runtime.`n$($_.Exception.Message)"; return }
  $notifyIcon.Visible = $false; $notifyIcon.Dispose()
  $mutex.ReleaseMutex(); $mutex.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
foreach ($item in @($statusItem, "-", $restartItem, "-", $copyMcpItem, $copyHealthItem, $copyTunnelIdItem, "-", $openHealthItem, $openTunnelUiItem, $openRuntimeItem, "-", $openJobsItem, "-", $exitItem)) { $contextMenu.MenuItems.Add($item) | Out-Null }

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.ContextMenu = $contextMenu
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
$notifyIcon.Text = "$TrayDisplayName | Starting"
$notifyIcon.Visible = $true
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2500
$timer.add_Tick({ Update-TrayStatus })
$timer.Start()
if (-not $DiagnosticOnly -and -not $NoAutoStart) { Start-CodexBridgeServer; Start-TunnelClient }
Update-TrayStatus
[System.Windows.Forms.Application]::Run()
