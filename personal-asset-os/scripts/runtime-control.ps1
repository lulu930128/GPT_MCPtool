param(
  [ValidateSet('SelfTest', 'Status', 'EnsureRunning', 'RepairConnectivity', 'RestartCore', 'ReloadRuntime', 'ShutdownRuntime')][string]$Action = 'Status',
  [string]$ProjectRoot, [string]$HostName = '127.0.0.1', [int]$Port = 18876, [string]$DataDir,
  [string]$PythonPath, [string]$ServerArguments, [string]$ServerIdentity = 'personal_asset_os.cli serve',
  [string]$TunnelClientPath, [string]$TunnelProfileDir, [string]$TunnelProfile = 'personal-asset-os',
  [string]$TunnelHealthUrl = 'http://127.0.0.1:18877', [string]$TunnelArguments, [string]$TunnelIdentity,
  [string]$LocalEnvScript, [string]$ExpectedBuildId,
  [int]$CoreReadyTimeoutSeconds = 30, [int[]]$TunnelRecoveryDelaysSeconds = @(15, 30, 60),
  [switch]$AdoptLegacyExactListeners
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path }

Import-Module (Join-Path $PSScriptRoot 'component-runtime.psm1') -Force
$context = New-PersonalAssetOsRuntimeContext `
  -ProjectRoot $ProjectRoot -HostName $HostName -Port $Port -DataDir $DataDir `
  -PythonPath $PythonPath -ServerArguments $ServerArguments -ServerIdentity $ServerIdentity `
  -TunnelClientPath $TunnelClientPath -TunnelProfileDir $TunnelProfileDir -TunnelProfile $TunnelProfile `
  -TunnelHealthUrl $TunnelHealthUrl -TunnelArguments $TunnelArguments -TunnelIdentity $TunnelIdentity `
  -LocalEnvScript $LocalEnvScript -ExpectedBuildId $ExpectedBuildId `
  -CoreReadyTimeoutSeconds $CoreReadyTimeoutSeconds -TunnelRecoveryDelaysSeconds $TunnelRecoveryDelaysSeconds

if ($Action -eq 'SelfTest') {
  [pscustomobject]@{
    runtimeContract = 'unified-lifecycle-v3'; lifecycleModel = 'stateless-controller'; supportsDiagnosticTray = $true
    controllerEntryExists = (Test-Path -LiteralPath $PSCommandPath -PathType Leaf); autoStartCore = $true; autoStartTunnel = $true
    exitUiStopsRuntime = $false; exactOwnershipEnforced = $true; orderedCoreRoles = @('server'); managerDomainDataAccess = 'none'
    credentialValuesExposed = $false; formalDataPathExposed = $false
    componentDifferences = @('data-sensitive', 'primary-ui', 'descendant-server-listener')
    capabilities = @('ensure_running', 'repair_connectivity', 'restart_core', 'reload_runtime', 'shutdown_runtime', 'show_diagnostic_tray')
    resultFields = @('ok', 'action', 'before', 'after', 'ownedPids', 'elapsedMs', 'errorCode', 'message')
  } | ConvertTo-Json -Depth 5
  exit 0
}

$mutex = New-Object Threading.Mutex($false, 'Local\PersonalAssetOsRuntimeControl')
$acquired = $false
$clock = [Diagnostics.Stopwatch]::StartNew()
$before = $null; $after = $null
try {
  try { $acquired = $mutex.WaitOne(0, $false) } catch [Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { throw 'ACTION_BUSY: Another Personal Asset OS lifecycle action is running.' }
  $before = Get-PersonalAssetOsRuntimeStatus -Context $context -AdoptLegacyExactListeners:$AdoptLegacyExactListeners
  if ($Action -ne 'Status') { Invoke-PersonalAssetOsLifecycleAction -Context $context -Action $Action }
  $after = Get-PersonalAssetOsRuntimeStatus -Context $context
  $clock.Stop()
  $result = [pscustomobject]@{
    ok = $true; action = $Action; before = $before; after = $after; ownedPids = @($after.ownedPids)
    elapsedMs = [int]$clock.ElapsedMilliseconds; errorCode = $null
    message = $(if ($Action -eq 'Status') { 'Status checked.' } else { 'Lifecycle action completed.' })
  }
  Write-PersonalAssetOsLifecycleEvent -Context $context -Action $Action -Ok $true -BeforeStatus $before.status -AfterStatus $after.status -OwnedPids @($after.ownedPids) -ElapsedMs $result.elapsedMs -Message $result.message
  $result | ConvertTo-Json -Depth 9
  exit 0
}
catch {
  $clock.Stop()
  $raw = ([string]$_.Exception.Message -replace '[\r\n]+', ' ').Trim()
  if ($raw -match '^([A-Z][A-Z0-9_]+):\s*(.*)$') { $errorCode = $matches[1]; $message = $matches[2] }
  else { $errorCode = 'ACTION_FAILED'; $message = 'Lifecycle action failed; inspect the component runtime log.' }
  try { $after = Get-PersonalAssetOsRuntimeStatus -Context $context } catch { $after = $null }
  $owned = if ($null -eq $after) { @() } else { @($after.ownedPids) }
  try {
    Write-PersonalAssetOsLifecycleEvent -Context $context -Action $Action -Ok $false `
      -BeforeStatus $(if ($null -eq $before) { $null } else { $before.status }) `
      -AfterStatus $(if ($null -eq $after) { $null } else { $after.status }) `
      -OwnedPids $owned -ElapsedMs ([int]$clock.ElapsedMilliseconds) -ErrorCode $errorCode -Message $message
  }
  catch { }
  [pscustomobject]@{
    ok = $false; action = $Action; before = $before; after = $after; ownedPids = $owned
    elapsedMs = [int]$clock.ElapsedMilliseconds; errorCode = $errorCode; message = $message
  } | ConvertTo-Json -Depth 9
  exit 1
}
finally {
  if ($acquired) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
