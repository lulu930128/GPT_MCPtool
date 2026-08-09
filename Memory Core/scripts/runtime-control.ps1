param(
    [ValidateSet('SelfTest', 'Status', 'EnsureRunning', 'RepairConnectivity', 'RestartCore', 'ReloadRuntime', 'ShutdownRuntime')][string]$Action = 'Status',
    [string]$ProjectRoot, [string]$StackScript, [int]$BackendPort = 18765,
    [string]$PowershellPath, [int]$ActionTimeoutSeconds = 170
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path }

Import-Module (Join-Path $PSScriptRoot 'component-runtime.psm1') -Force
$context = New-MemoryCoreRuntimeContext -ProjectRoot $ProjectRoot -StackScript $StackScript `
    -BackendPort $BackendPort -PowershellPath $PowershellPath -ActionTimeoutSeconds $ActionTimeoutSeconds

if ($Action -eq 'SelfTest') {
    [pscustomobject]@{
        runtimeContract = 'unified-lifecycle-v3'; lifecycleModel = 'stateless-controller'; supportsDiagnosticTray = $true
        controllerEntryExists = (Test-Path -LiteralPath $PSCommandPath -PathType Leaf); autoStartCore = $true; autoStartTunnel = $true
        exitUiStopsRuntime = $false; exactOwnershipEnforced = $true; orderedCoreRoles = @('backend', 'mcp')
        managerDomainDataAccess = 'none'; managerSecretAccess = 'none'; credentialValuesExposed = $false; formalDataPathExposed = $false
        componentDifferences = @('multi-core', 'data-sensitive', 'primary-ui', 'component-stack-facade')
        capabilities = @('ensure_running', 'repair_connectivity', 'restart_core', 'reload_runtime', 'shutdown_runtime', 'show_diagnostic_tray')
        resultFields = @('ok', 'action', 'before', 'after', 'ownedPids', 'elapsedMs', 'errorCode', 'message')
    } | ConvertTo-Json -Depth 5
    exit 0
}

$mutex = New-Object Threading.Mutex($false, 'Local\MemoryCoreRuntimeControl')
$acquired = $false
$clock = [Diagnostics.Stopwatch]::StartNew()
$before = $null; $after = $null
try {
    try { $acquired = $mutex.WaitOne(0, $false) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw 'ACTION_BUSY: Another Memory Core lifecycle action is running.' }
    $before = Get-MemoryCoreRuntimeStatus -Context $context
    if ($Action -ne 'Status') { Invoke-MemoryCoreLifecycleAction -Context $context -Action $Action }
    $after = Get-MemoryCoreRuntimeStatus -Context $context
    $clock.Stop()
    $result = [pscustomobject]@{
        ok = $true; action = $Action; before = $before; after = $after; ownedPids = @($after.ownedPids)
        elapsedMs = [int]$clock.ElapsedMilliseconds; errorCode = $null
        message = $(if ($Action -eq 'Status') { 'Status checked.' } else { 'Lifecycle action completed.' })
    }
    Write-MemoryCoreLifecycleEvent -Context $context -Action $Action -Ok $true -BeforeStatus $before.status -AfterStatus $after.status -OwnedPids @($after.ownedPids) -ElapsedMs $result.elapsedMs -Message $result.message
    $result | ConvertTo-Json -Depth 9
    exit 0
}
catch {
    $clock.Stop()
    $raw = ([string]$_.Exception.Message -replace '[\r\n]+', ' ').Trim()
    if ($raw -match '^([A-Z][A-Z0-9_]+):\s*(.*)$') { $errorCode = $matches[1]; $message = $matches[2] }
    else { $errorCode = 'ACTION_FAILED'; $message = 'Lifecycle action failed; inspect the component runtime log.' }
    try { $after = Get-MemoryCoreRuntimeStatus -Context $context } catch { $after = $null }
    $owned = if ($null -eq $after) { @() } else { @($after.ownedPids) }
    try {
        Write-MemoryCoreLifecycleEvent -Context $context -Action $Action -Ok $false `
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
