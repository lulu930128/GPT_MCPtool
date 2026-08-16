param(
  [ValidateSet("SelfTest", "Status", "EnsureRunning", "RepairConnectivity", "RestartCore", "ReloadRuntime", "ShutdownRuntime")]
  [string]$Action = "Status",
  [string]$ProjectRoot,
  [string]$HostName = "127.0.0.1",
  [int]$Port = 18797,
  [string]$OmiApiBaseUrl = "http://127.0.0.1:8400",
  [switch]$StrictOmiApiBaseUrl,
  [string]$Token = $env:OMI_SEARCH_MCP_HTTP_TOKEN,
  [string]$PythonPath,
  [string]$TunnelClientPath = "C:\GPT_MCPtool\project_reading\vendor\tunnel-client\tunnel-client.exe",
  [string]$TunnelProfileDir,
  [string]$TunnelProfile = "omi-search",
  [string]$TunnelHealthUrl = "http://127.0.0.1:18799",
  [string]$KeyStorePath = "C:\GPT_MCPtool\project_reading\scripts\key-store.ps1",
  [string]$SecretPath,
  [int]$ServerReadyTimeoutSeconds = 20,
  [int[]]$TunnelRecoveryDelaysSeconds = @(15, 30, 60),
  [switch]$AdoptLegacyExactListeners
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path }

$modulePath = Join-Path $PSScriptRoot "component-runtime.psm1"
Import-Module $modulePath -Force
$context = New-OmiSearchRuntimeContext `
  -ProjectRoot $ProjectRoot `
  -HostName $HostName `
  -Port $Port `
  -OmiApiBaseUrl $OmiApiBaseUrl `
  -StrictOmiApiBaseUrl:$StrictOmiApiBaseUrl `
  -Token $Token `
  -PythonPath $PythonPath `
  -TunnelClientPath $TunnelClientPath `
  -TunnelProfileDir $TunnelProfileDir `
  -TunnelProfile $TunnelProfile `
  -TunnelHealthUrl $TunnelHealthUrl `
  -KeyStorePath $KeyStorePath `
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
    externalDependencyOwned = $false
    capabilities = @("ensure_running", "repair_connectivity", "restart_core", "reload_runtime", "shutdown_runtime", "show_diagnostic_tray")
    resultFields = @("ok", "action", "before", "after", "ownedPids", "elapsedMs", "errorCode", "message")
  } | ConvertTo-Json -Depth 5
  exit 0
}

$mutex = New-Object Threading.Mutex($false, "Local\OmiSearchMcpRuntimeControl")
$acquired = $false
$started = [Diagnostics.Stopwatch]::StartNew()
$before = $null
$after = $null
try {
  try { $acquired = $mutex.WaitOne(0, $false) }
  catch [Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { throw "ACTION_BUSY: Another OMI Search lifecycle action is running." }
  $before = Get-OmiSearchRuntimeStatus -Context $context -AdoptLegacyExactListeners:$AdoptLegacyExactListeners
  if ($Action -ne "Status") { Invoke-OmiSearchLifecycleAction -Context $context -Action $Action }
  $after = Get-OmiSearchRuntimeStatus -Context $context
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
  Write-OmiSearchLifecycleEvent -Context $context -Action $Action -Ok $true -BeforeStatus $before.status -AfterStatus $after.status -OwnedPids @($after.ownedPids) -ElapsedMs $result.elapsedMs -Message $result.message
  $result | ConvertTo-Json -Depth 9
  exit 0
}
catch {
  $started.Stop()
  $raw = ([string]$_.Exception.Message -replace '[\r\n]+', ' ').Trim()
  if ($raw -match '^([A-Z][A-Z0-9_]+):\s*(.*)$') { $errorCode = $matches[1]; $message = $matches[2] }
  else { $errorCode = "ACTION_FAILED"; $message = "Lifecycle action failed; inspect the component runtime log." }
  try { $after = Get-OmiSearchRuntimeStatus -Context $context } catch { $after = $null }
  $ownedPids = if ($null -eq $after) { @() } else { @($after.ownedPids) }
  try {
    Write-OmiSearchLifecycleEvent -Context $context -Action $Action -Ok $false -BeforeStatus $(if($null-eq$before){$null}else{$before.status}) -AfterStatus $(if($null-eq$after){$null}else{$after.status}) -OwnedPids $ownedPids -ElapsedMs ([int]$started.ElapsedMilliseconds) -ErrorCode $errorCode -Message $message
  } catch { }
  [pscustomobject]@{ ok=$false; action=$Action; before=$before; after=$after; ownedPids=$ownedPids; elapsedMs=[int]$started.ElapsedMilliseconds; errorCode=$errorCode; message=$message } | ConvertTo-Json -Depth 9
  exit 1
}
finally {
  if ($acquired) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
