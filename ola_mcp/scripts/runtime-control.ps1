param(
    [ValidateSet("SelfTest", "EnsureRunning", "RepairConnectivity", "RestartCore", "ReloadRuntime", "ShutdownRuntime")]
    [string]$Action = "SelfTest"
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$script:ComponentId = "ola_mcp"
$script:DisplayName = 'Open Intel Atlas MCP'
$script:Capabilities = @(
    "ensure_running"
    "repair_connectivity"
    "reload_runtime"
    "shutdown_runtime"
    
)
$script:SupportsDiagnosticTray = [bool]::Parse("False")
$modulePath = Join-Path $PSScriptRoot "component-runtime.psm1"

if ($Action -eq "SelfTest") {
    [pscustomobject]@{
        runtimeContract = "unified-lifecycle-v3"
        lifecycleModel = "stateless-controller"
        supportsDiagnosticTray = $script:SupportsDiagnosticTray
        controllerEntryExists = (Test-Path -LiteralPath $PSCommandPath -PathType Leaf)
        autoStartCore = $true
        autoStartTunnel = $true
        exitUiStopsRuntime = $false
        exactOwnershipEnforced = $true
        capabilities = $script:Capabilities
    } | ConvertTo-Json -Depth 5
    exit 0
}

$mutex = New-Object Threading.Mutex($false, "Local\McpComponent.$($script:ComponentId).Lifecycle")
$acquired = $false
$started = [Diagnostics.Stopwatch]::StartNew()
try {
    try { $acquired = $mutex.WaitOne(0, $false) }
    catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw "Another lifecycle action is already running." }
    if (-not (Test-Path -LiteralPath $modulePath -PathType Leaf)) { throw "Component runtime module is missing." }
    Import-Module $modulePath -Force
    $result = Invoke-ComponentRuntimeAction -Action $Action
    $result | ConvertTo-Json -Depth 8
    exit $(if ([bool]$result.ok) { 0 } else { 1 })
}
catch {
    $started.Stop()
    [pscustomobject]@{
        ok = $false
        action = $Action
        before = [pscustomobject]@{ status = "Unknown" }
        after = [pscustomobject]@{ status = "Unknown" }
        ownedPids = @()
        elapsedMs = [long]$started.ElapsedMilliseconds
        errorCode = "controller_failed"
        message = ([string]$_.Exception.Message -replace '[\r\n]+', ' ')
    } | ConvertTo-Json -Depth 8
    exit 1
}
finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
