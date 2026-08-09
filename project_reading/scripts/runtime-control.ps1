param(
  [ValidateSet("SelfTest", "Status", "EnsureRunning", "RepairConnectivity", "RestartCore", "ReloadRuntime", "ShutdownRuntime")]
  [string]$Action = "Status",
  [string]$ProjectRoot,
  [string]$WorkspaceRoot = "C:\project",
  [string]$WorkspaceRoots = $env:WORKSPACE_MCP_ROOTS,
  [string]$DefaultWorkspaceRoot = $env:WORKSPACE_MCP_DEFAULT_ROOT,
  [string]$WorkspaceRootDenyDirs = $env:WORKSPACE_MCP_ROOT_DENY_DIRS,
  [string]$AssetScopes = $env:WORKSPACE_MCP_ASSET_SCOPES,
  [string]$HostName = "127.0.0.1",
  [int]$Port = 8787,
  [string]$Token = $env:WORKSPACE_MCP_HTTP_TOKEN,
  [string]$NodePath,
  [string]$TunnelClientPath,
  [string]$TunnelProfileDir,
  [string]$TunnelProfile = "project-workspace",
  [string]$TunnelHealthUrl = "http://127.0.0.1:8788",
  [string]$SecretPath,
  [int]$ServerReadyTimeoutSeconds = 20,
  [int[]]$TunnelRecoveryDelaysSeconds = @(15, 30, 60)
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$localSettingsPath = Join-Path $ProjectRoot ".local\tray-settings.json"
if (Test-Path -LiteralPath $localSettingsPath -PathType Leaf) {
  try { $localSettings = Get-Content -LiteralPath $localSettingsPath -Encoding UTF8 -Raw | ConvertFrom-Json }
  catch { throw "Invalid local tray settings." }
  if (-not $PSBoundParameters.ContainsKey("WorkspaceRoot") -and -not [string]::IsNullOrWhiteSpace([string]$localSettings.workspaceRoot)) { $WorkspaceRoot = [string]$localSettings.workspaceRoot }
  if (-not $PSBoundParameters.ContainsKey("WorkspaceRoots") -and [string]::IsNullOrWhiteSpace($WorkspaceRoots) -and -not [string]::IsNullOrWhiteSpace([string]$localSettings.workspaceRoots)) { $WorkspaceRoots = [string]$localSettings.workspaceRoots }
  if (-not $PSBoundParameters.ContainsKey("DefaultWorkspaceRoot") -and [string]::IsNullOrWhiteSpace($DefaultWorkspaceRoot) -and -not [string]::IsNullOrWhiteSpace([string]$localSettings.defaultWorkspaceRoot)) { $DefaultWorkspaceRoot = [string]$localSettings.defaultWorkspaceRoot }
  if (-not $PSBoundParameters.ContainsKey("WorkspaceRootDenyDirs") -and [string]::IsNullOrWhiteSpace($WorkspaceRootDenyDirs) -and -not [string]::IsNullOrWhiteSpace([string]$localSettings.workspaceRootDenyDirs)) { $WorkspaceRootDenyDirs = [string]$localSettings.workspaceRootDenyDirs }
  if (-not $PSBoundParameters.ContainsKey("AssetScopes") -and [string]::IsNullOrWhiteSpace($AssetScopes) -and -not [string]::IsNullOrWhiteSpace([string]$localSettings.assetScopes)) { $AssetScopes = [string]$localSettings.assetScopes }
}
if ([string]::IsNullOrWhiteSpace($DefaultWorkspaceRoot)) { $DefaultWorkspaceRoot = "projects" }

$modulePath = Join-Path $PSScriptRoot "project-reading-runtime.psm1"
Import-Module $modulePath -Force
$context = New-PrRuntimeContext `
  -ProjectRoot $ProjectRoot `
  -WorkspaceRoot $WorkspaceRoot `
  -WorkspaceRoots $WorkspaceRoots `
  -DefaultWorkspaceRoot $DefaultWorkspaceRoot `
  -WorkspaceRootDenyDirs $WorkspaceRootDenyDirs `
  -AssetScopes $AssetScopes `
  -HostName $HostName `
  -Port $Port `
  -Token $Token `
  -NodePath $NodePath `
  -TunnelClientPath $TunnelClientPath `
  -TunnelProfileDir $TunnelProfileDir `
  -TunnelProfile $TunnelProfile `
  -TunnelHealthUrl $TunnelHealthUrl `
  -SecretPath $SecretPath `
  -ServerReadyTimeoutSeconds $ServerReadyTimeoutSeconds `
  -TunnelRecoveryDelaysSeconds $TunnelRecoveryDelaysSeconds

if ($Action -eq "SelfTest") {
  [pscustomobject]@{
    runtimeContract = "unified-lifecycle-v3"
    lifecycleModel = "stateless-controller"
    supportsDiagnosticTray = $true
    controllerEntryExists = (Test-Path -LiteralPath $PSCommandPath -PathType Leaf)
    autoStartCore = $true
    autoStartTunnel = $true
    exitUiStopsRuntime = $false
    exactOwnershipEnforced = $true
    capabilities = @("ensure_running", "repair_connectivity", "restart_core", "reload_runtime", "shutdown_runtime", "show_diagnostic_tray")
    serverReadyTimeoutSeconds = $context.serverReadyTimeoutSeconds
    tunnelRecoveryDelaysSeconds = @($context.tunnelRecoveryDelaysSeconds)
    resultFields = @("ok", "action", "before", "after", "ownedPids", "elapsedMs", "errorCode", "message")
  } | ConvertTo-Json -Depth 5
  exit 0
}

$mutex = New-Object Threading.Mutex($false, "Local\ProjectReadingMcpRuntimeControl")
$acquired = $false
$started = [Diagnostics.Stopwatch]::StartNew()
$before = $null
$after = $null
$errorCode = $null
$message = $null
try {
  try { $acquired = $mutex.WaitOne(0, $false) }
  catch [Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { throw "ACTION_BUSY: Another Project Reading lifecycle action is already running." }
  $before = Get-PrRuntimeStatus -Context $context -AdoptExactListeners
  if ($Action -ne "Status") { Invoke-PrLifecycleAction -Context $context -Action $Action }
  $after = Get-PrRuntimeStatus -Context $context -AdoptExactListeners
  $started.Stop()
  $result = [pscustomobject]@{
    ok = $true
    action = $Action
    before = $before
    after = $after
    ownedPids = @($after.ownedPids)
    elapsedMs = [int]$started.ElapsedMilliseconds
    errorCode = $null
    message = $(if ($Action -eq "Status") { "Status checked." } else { "Lifecycle action completed." })
  }
  Write-PrLifecycleEvent -Context $context -Action $Action -Ok $true -BeforeStatus $before.status -AfterStatus $after.status -OwnedPids @($after.ownedPids) -ElapsedMs $result.elapsedMs -Message $result.message
  $result | ConvertTo-Json -Depth 8
  exit 0
}
catch {
  $started.Stop()
  $rawMessage = ([string]$_.Exception.Message -replace '[\r\n]+', ' ').Trim()
  if ($rawMessage -match '^([A-Z][A-Z0-9_]+):\s*(.*)$') {
    $errorCode = $matches[1]
    $message = $matches[2]
  }
  else {
    $errorCode = "ACTION_FAILED"
    $message = "Lifecycle action failed; inspect the component runtime log."
  }
  try { $after = Get-PrRuntimeStatus -Context $context }
  catch { $after = $null }
  $ownedPids = if ($null -eq $after) { @() } else { @($after.ownedPids) }
  try {
    Write-PrLifecycleEvent -Context $context -Action $Action -Ok $false -BeforeStatus $(if ($null -eq $before) { $null } else { $before.status }) -AfterStatus $(if ($null -eq $after) { $null } else { $after.status }) -OwnedPids $ownedPids -ElapsedMs ([int]$started.ElapsedMilliseconds) -ErrorCode $errorCode -Message $message
  }
  catch { }
  [pscustomobject]@{
    ok = $false
    action = $Action
    before = $before
    after = $after
    ownedPids = $ownedPids
    elapsedMs = [int]$started.ElapsedMilliseconds
    errorCode = $errorCode
    message = $message
  } | ConvertTo-Json -Depth 8
  exit 1
}
finally {
  if ($acquired) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
