param(
    [ValidateSet("SelfTest", "Status", "EnsureRunning", "RepairConnectivity", "RestartCore", "ReloadRuntime", "ShutdownRuntime")]
    [string]$Action = "Status",
    [string]$ProjectRoot,
    [string]$TrainerRoot,
    [string]$HostName = "127.0.0.1",
    [int]$McpPort = 18810,
    [int]$TrainerPort = 18811,
    [string]$TunnelClientPath,
    [string]$TunnelProfileDir,
    [string]$TunnelProfile = "listening-audio",
    [string]$TunnelHealthUrl = "http://127.0.0.1:18812",
    [string]$TunnelArguments,
    [string]$TunnelIdentity,
    [string]$KeyStorePath,
    [string]$SecretPath,
    [int]$ReadyTimeoutSeconds = 30,
    [int[]]$TunnelRecoveryDelaysSeconds = @(15, 30, 60)
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$capabilities = @("ensure_running", "repair_connectivity", "restart_core", "reload_runtime", "shutdown_runtime")
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
$settingsPath = Join-Path $ProjectRoot ".local\runtime.psd1"
if (Test-Path -LiteralPath $settingsPath) {
    $settings = Import-PowerShellDataFile -LiteralPath $settingsPath
    foreach ($name in @("TrainerRoot", "TunnelClientPath", "SecretPath")) {
        if (-not $PSBoundParameters.ContainsKey($name) -and $settings.ContainsKey($name)) {
            Set-Variable -Name $name -Value ([string]$settings[$name])
        }
    }
}
if ([string]::IsNullOrWhiteSpace($TrainerRoot)) { $TrainerRoot = $env:LISTENING_TRAINER_ROOT }
if ([string]::IsNullOrWhiteSpace($TrainerRoot)) { throw "Configure LISTENING_TRAINER_ROOT or .local/runtime.psd1." }
$modulePath = Join-Path $PSScriptRoot "component-runtime.psm1"
if (-not (Test-Path -LiteralPath $modulePath -PathType Leaf)) { throw "Component runtime module is missing." }
Import-Module $modulePath -Force
$context = New-ListeningAudioRuntimeContext `
    -ProjectRoot $ProjectRoot -TrainerRoot $TrainerRoot -HostName $HostName -McpPort $McpPort -TrainerPort $TrainerPort `
    -TunnelClientPath $TunnelClientPath -TunnelProfileDir $TunnelProfileDir -TunnelProfile $TunnelProfile `
    -TunnelHealthUrl $TunnelHealthUrl -TunnelArguments $TunnelArguments -TunnelIdentity $TunnelIdentity `
    -KeyStorePath $KeyStorePath -SecretPath $SecretPath -ReadyTimeoutSeconds $ReadyTimeoutSeconds `
    -TunnelRecoveryDelaysSeconds $TunnelRecoveryDelaysSeconds

if ($Action -eq "SelfTest") {
    [pscustomobject]@{
        runtimeContract = "unified-lifecycle-v3"
        lifecycleModel = "stateless-controller"
        supportsDiagnosticTray = $false
        controllerEntryExists = (Test-Path -LiteralPath $PSCommandPath -PathType Leaf)
        autoStartCore = $true
        autoStartTunnel = $true
        exitUiStopsRuntime = $false
        exactOwnershipEnforced = $true
        orderedCoreRoles = @("trainer", "mcp")
        managerDomainDataAccess = "none"
        credentialValuesExposed = $false
        capabilities = $capabilities
        resultFields = @("ok", "action", "before", "after", "ownedPids", "elapsedMs", "errorCode", "message")
    } | ConvertTo-Json -Depth 5
    exit 0
}

$mutex = New-Object Threading.Mutex($false, "Local\McpComponent.listening_audio.Lifecycle")
$acquired = $false
$started = [Diagnostics.Stopwatch]::StartNew()
$before = $null
try {
    try { $acquired = $mutex.WaitOne(0, $false) }
    catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw "ACTION_BUSY: Another Listening Audio lifecycle action is running." }
    $before = Get-ListeningAudioRuntimeStatus -Context $context
    if ($Action -ne "Status") {
        Invoke-ListeningAudioLifecycleAction -Context $context -Action $Action
        $after = Get-ListeningAudioRuntimeStatus -Context $context
    }
    else { $after = $before }
    $started.Stop()
    [pscustomobject]@{
        ok = $true
        action = $Action
        before = $before
        after = $after
        ownedPids = @($after.ownedPids)
        elapsedMs = [long]$started.ElapsedMilliseconds
        errorCode = $null
        message = $(if ($Action -eq "Status") { "Status checked." } else { "Lifecycle action completed." })
    } | ConvertTo-Json -Depth 8
    exit 0
}
catch {
    $started.Stop()
    $raw = ([string]$_.Exception.Message -replace '[\r\n]+', ' ').Trim()
    $errorCode = "ACTION_FAILED"
    $message = "Lifecycle action failed; inspect component runtime logs."
    if ($raw -match '^([A-Z][A-Z0-9_]+):\s*(.*)$') { $errorCode = $Matches[1]; $message = $Matches[2] }
    try { $after = Get-ListeningAudioRuntimeStatus -Context $context } catch { $after = [pscustomobject]@{ status = "Unknown"; ownedPids = @() } }
    [pscustomobject]@{
        ok = $false
        action = $Action
        before = $(if ($null -ne $before) { $before } else { [pscustomobject]@{ status = "Unknown" } })
        after = $after
        ownedPids = @($after.ownedPids)
        elapsedMs = [long]$started.ElapsedMilliseconds
        errorCode = $errorCode
        message = $message
    } | ConvertTo-Json -Depth 8
    exit 1
}
finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
