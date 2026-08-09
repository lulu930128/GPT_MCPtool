Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$modulePath = Join-Path $projectRoot "src\McpControlCenter.Core.psm1"
Import-Module $modulePath -Force
$script:Passed = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
    $script:Passed += 1
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ([string]$Actual -ne [string]$Expected) {
        throw "Assertion failed: $Message. Expected '$Expected', got '$Actual'."
    }
    $script:Passed += 1
}

function Assert-Throws([scriptblock]$Action, [string]$Message) {
    $threw = $false
    try { & $Action }
    catch { $threw = $true }
    if (-not $threw) { throw "Assertion failed: $Message" }
    $script:Passed += 1
}

function New-ProbeResult {
    param(
        [string]$Role,
        [bool]$Success,
        [bool]$TcpOpen = $true,
        [bool]$OwnerKnown = $false,
        $OwnerMatches = $null
    )
    return [pscustomobject]@{
        role = $Role
        success = $Success
        tcpOpen = $TcpOpen
        owner = [pscustomobject]@{ known = $OwnerKnown; matchesExpected = $OwnerMatches }
    }
}

$manifest = Read-McpCcManifest -Path (Join-Path $projectRoot "config\components.json")
Assert-Equal @($manifest.components).Count 6 "manifest has six components"
Assert-Equal $manifest.schemaVersion 2 "live pilot manifest uses schema version 2"
Assert-True (@($manifest.components | Where-Object { -not $_.autoStart }).Count -eq 0) "all unified components are auto-start enabled"
Assert-True (@($manifest.components | Where-Object { $_.runtimeMode -eq "component-controller" }).Count -eq 1) "only one pilot component uses controller mode"
$projectComponent = @($manifest.components | Where-Object { $_.id -eq "project_reading" })[0]
Assert-Equal $projectComponent.runtimeMode "component-controller" "Project Reading is the controller pilot"
Assert-True (@($manifest.components | Where-Object { $_.id -ne "project_reading" -and $_.runtimeMode -ne "legacy-tray" }).Count -eq 0) "the other five components remain in legacy tray mode"
$projectStartPlan = Invoke-McpCcComponentAction -Manifest $manifest -ComponentId "project_reading" -Action ensure_running -PlanOnly
Assert-Equal $projectStartPlan.manifestAction "ensure_running" "pilot ensure_running maps to the fixed controller action"
Assert-Equal ($projectStartPlan.arguments -join " ") "-Action EnsureRunning" "pilot ensure_running arguments are manager-owned"
$projectRestartPlan = Invoke-McpCcComponentAction -Manifest $manifest -ComponentId "project_reading" -Action restart_core -PlanOnly
Assert-Equal $projectRestartPlan.manifestAction "restart_core" "pilot exposes the bounded restart_core capability"
$legacyStartPlan = Invoke-McpCcComponentAction -Manifest $manifest -ComponentId "omi_search" -Action ensure_running -PlanOnly
Assert-Equal $legacyStartPlan.manifestAction "start" "legacy ensure_running maps to the existing start action"
$legacyReloadPlan = Invoke-McpCcComponentAction -Manifest $manifest -ComponentId "omi_search" -Action reload_runtime -PlanOnly
Assert-Equal $legacyReloadPlan.manifestAction "restart" "legacy reload_runtime maps to the existing restart action"
Assert-Throws { Invoke-McpCcComponentAction -Manifest $manifest -ComponentId "omi_search" -Action restart_core -PlanOnly } "legacy tray does not claim the v3 restart_core capability"
$memoryCore = @($manifest.components | Where-Object { $_.id -eq "memory_core" })[0]
$omiSearch = @($manifest.components | Where-Object { $_.id -eq "omi_search" })[0]
Assert-Equal (@(Get-McpCcRunningAcceptanceStates -Component $projectComponent) -join ",") "Ready" "component without a dependency must reach Ready"
Assert-Equal (@(Get-McpCcRunningAcceptanceStates -Component $omiSearch) -join ",") "Ready,BlockedUpstream" "dependency-aware component may finish startup with its owned runtime ready"
$memoryBackendProbe = @($memoryCore.probes | Where-Object { $_.id -eq "backend" })[0]
Assert-True ($memoryBackendProbe.resolvedOwnerManagedPidFile.EndsWith("Memory Core\data\runtime\backend.pid", [StringComparison]::OrdinalIgnoreCase)) "managed PID file remains inside Memory Core"
Assert-Equal $memoryBackendProbe.port 18765 "Memory Core backend probe uses the non-excluded default port"
Assert-True (Test-McpCcCommandLineContains -CommandLine 'python.exe -m uvicorn memory_core.main:app --port 18765' -ExpectedFragments @("memory_core.main:app")) "listener module identity is accepted without a repo path"
Assert-True (-not (Test-McpCcCommandLineContains -CommandLine 'python.exe -m uvicorn other.main:app --port 18765' -ExpectedFragments @("memory_core.main:app"))) "wrong listener module is rejected"

$processTable = @{
    300 = [pscustomobject]@{ ProcessId = 300; ParentProcessId = 200 }
    200 = [pscustomobject]@{ ProcessId = 200; ParentProcessId = 100 }
    100 = [pscustomobject]@{ ProcessId = 100; ParentProcessId = 10 }
    400 = [pscustomobject]@{ ProcessId = 400; ParentProcessId = 10 }
    10 = [pscustomobject]@{ ProcessId = 10; ParentProcessId = 0 }
}
$processLookup = { param([int]$LookupProcessId) $processTable[$LookupProcessId] }.GetNewClosure()
$descendant = Get-McpCcProcessLineage -ProcessId 300 -ExpectedAncestorProcessId 100 -ProcessLookup $processLookup
Assert-True ($descendant.known -and $descendant.matches -and $descendant.depth -eq 2) "listener descendant is linked to its managed PID"
$self = Get-McpCcProcessLineage -ProcessId 100 -ExpectedAncestorProcessId 100 -ProcessLookup $processLookup
Assert-True ($self.known -and $self.matches -and $self.depth -eq 0) "managed PID may own the listener directly"
$unrelated = Get-McpCcProcessLineage -ProcessId 400 -ExpectedAncestorProcessId 100 -ProcessLookup $processLookup
Assert-True ($unrelated.known -and -not $unrelated.matches) "unrelated listener is rejected"
Assert-Throws { Assert-McpCcLoopbackUrl -Url "https://example.com/health" } "external HTTPS probe is rejected"
Assert-Throws { Assert-McpCcLoopbackUrl -Url "http://192.168.1.2/health" } "non-loopback probe is rejected"

$componentRoot = Join-Path $manifest.workspaceRoot "project_reading"
$safePath = Resolve-McpCcChildPath -Root $componentRoot -RelativePath "scripts\tray.ps1"
Assert-True (Test-McpCcPathWithinRoot -Path $safePath -Root $componentRoot) "component child path remains in root"
Assert-Throws { Resolve-McpCcChildPath -Root $componentRoot -RelativePath "..\OMI_search\server.py" } "component action cannot escape root"

$component = $manifest.components[0]
$ready = Resolve-McpCcComponentState -Component $component -RootExists $true -StartActionExists $true -ProbeResults @(
    (New-ProbeResult -Role "core" -Success $true),
    (New-ProbeResult -Role "connectivity" -Success $true)
)
Assert-Equal $ready "Ready" "healthy core and tunnel are ready"

$degraded = Resolve-McpCcComponentState -Component $component -RootExists $true -StartActionExists $true -ProbeResults @(
    (New-ProbeResult -Role "core" -Success $true),
    (New-ProbeResult -Role "connectivity" -Success $false -TcpOpen $true)
)
Assert-Equal $degraded "Degraded" "tunnel failure is connectivity degradation"

$blocked = Resolve-McpCcComponentState -Component $component -RootExists $true -StartActionExists $true -ProbeResults @(
    (New-ProbeResult -Role "dependency" -Success $false -TcpOpen $false),
    (New-ProbeResult -Role "core" -Success $true),
    (New-ProbeResult -Role "connectivity" -Success $true)
)
Assert-Equal $blocked "BlockedUpstream" "dependency failure is explicit after owned runtime is ready"

$dependencyAndCoreDown = Resolve-McpCcComponentState -Component $component -RootExists $true -StartActionExists $true -ProbeResults @(
    (New-ProbeResult -Role "dependency" -Success $false -TcpOpen $false),
    (New-ProbeResult -Role "core" -Success $false -TcpOpen $false),
    (New-ProbeResult -Role "connectivity" -Success $false -TcpOpen $false)
)
Assert-Equal $dependencyAndCoreDown "Stopped" "stopped owned core is not hidden by dependency failure"

$dependencyAndConnectivityDown = Resolve-McpCcComponentState -Component $component -RootExists $true -StartActionExists $true -ProbeResults @(
    (New-ProbeResult -Role "dependency" -Success $false -TcpOpen $false),
    (New-ProbeResult -Role "core" -Success $true),
    (New-ProbeResult -Role "connectivity" -Success $false -TcpOpen $false)
)
Assert-Equal $dependencyAndConnectivityDown "Degraded" "connectivity failure is not hidden by dependency failure"

$stoppedPlan = Get-McpCcReconcilePlan -Manifest ([pscustomobject]@{ components = @($omiSearch) }) -State ([pscustomobject]@{ components = @([pscustomobject]@{ id = "omi_search"; status = "Stopped" }) })
Assert-Equal $stoppedPlan[0].decision "Start" "reconcile starts a dependency-aware component whose owned core is stopped"
$blockedPlan = Get-McpCcReconcilePlan -Manifest ([pscustomobject]@{ components = @($omiSearch) }) -State ([pscustomobject]@{ components = @([pscustomobject]@{ id = "omi_search"; status = "BlockedUpstream" }) })
Assert-Equal $blockedPlan[0].decision "WaitForDependency" "reconcile preserves a running component blocked only by its upstream"

$stopped = Resolve-McpCcComponentState -Component $component -RootExists $true -StartActionExists $true -ProbeResults @(
    (New-ProbeResult -Role "core" -Success $false -TcpOpen $false)
)
Assert-Equal $stopped "Stopped" "closed failed core port is stopped"

$unhealthy = Resolve-McpCcComponentState -Component $component -RootExists $true -StartActionExists $true -ProbeResults @(
    (New-ProbeResult -Role "core" -Success $false -TcpOpen $true)
)
Assert-Equal $unhealthy "Unhealthy" "open failed core port is unhealthy"

$ownership = Resolve-McpCcComponentState -Component $component -RootExists $true -StartActionExists $true -ProbeResults @(
    (New-ProbeResult -Role "core" -Success $true -TcpOpen $true -OwnerKnown $true -OwnerMatches $false)
)
Assert-Equal $ownership "OwnershipMismatch" "unexpected port owner is not trusted"

Assert-Equal (Resolve-McpCcComponentState -Component $component -RootExists $false -StartActionExists $false -ProbeResults @()) "NotInstalled" "missing component root is explicit"
Assert-Equal (Resolve-McpCcComponentState -Component $component -RootExists $true -StartActionExists $false -ProbeResults @()) "Misconfigured" "missing launcher is explicit"

$safe = ConvertTo-McpCcSafeObject -Value ([pscustomobject]@{
    token = "do-not-store"
    nested = [pscustomobject]@{ payload = "private"; status = "ok" }
})
Assert-Equal $safe.token "[redacted]" "token property is redacted"
Assert-Equal $safe.nested.payload "[redacted]" "nested payload is redacted"
Assert-Equal $safe.nested.status "ok" "safe status survives redaction"

$projectControllerContractComponent = $manifest.components[0].PSObject.Copy()
$projectControllerContractComponent.runtimeMode = "component-controller"
$projectControllerContractComponent.resolvedContractScript = Join-Path $manifest.workspaceRoot "project_reading\scripts\runtime-control.ps1"
$projectControllerContract = Test-McpCcComponentContract -Component $projectControllerContractComponent
Assert-True ($projectControllerContract.ok -and @($projectControllerContract.capabilities).Count -eq 6) "real Project Reading controller satisfies the Option C v3 contract"

$expectedLauncher = Join-Path $componentRoot "scripts\start-tray.vbs"
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
Assert-True (Test-McpCcShortcutMatches -TargetPath $wscript -Arguments "`"$expectedLauncher`"" -ExpectedLauncher $expectedLauncher) "exact Startup shortcut is recognized"
Assert-True (-not (Test-McpCcShortcutMatches -TargetPath $wscript -Arguments '"C:\wrong\start.vbs"' -ExpectedLauncher $expectedLauncher)) "wrong Startup target is rejected"

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$testRoot = Join-Path $tempBase ("mcp-control-center-tests-" + [Guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
    $documentPath = Join-Path $testRoot "state.json"
    Write-McpCcJsonAtomic -Path $documentPath -Document ([pscustomobject]@{ ok = $true; value = 7 })
    $roundTrip = Get-Content -LiteralPath $documentPath -Encoding UTF8 -Raw | ConvertFrom-Json
    Assert-True ($roundTrip.ok -eq $true -and $roundTrip.value -eq 7) "atomic JSON document round-trips"
    Write-McpCcEvent -RuntimeRoot $testRoot -BootId "boot-test" -Type "redaction_test" -Details @{ apiKey = "never-write"; status = "ok" }
    $eventText = Get-Content -LiteralPath (Get-ChildItem (Join-Path $testRoot "events") -Filter "*.jsonl" | Select-Object -First 1).FullName -Encoding UTF8 -Raw
    Assert-True ($eventText -notmatch "never-write") "event log does not contain secret values"
    Assert-True ($eventText -match "\[redacted\]") "event log records redaction marker"

    $v2Workspace = Join-Path $testRoot "v2-workspace"
    $v2ManagerRoot = Join-Path $v2Workspace "mcp_control_center"
    $v2ConfigRoot = Join-Path $v2ManagerRoot "config"
    New-Item -ItemType Directory -Force -Path $v2ConfigRoot | Out-Null
    $controllerSource = @'
param(
    [ValidateSet("SelfTest", "EnsureRunning", "RepairConnectivity", "RestartCore", "ReloadRuntime", "ShutdownRuntime")]
    [string]$Action = "SelfTest"
)
if ($Action -eq "SelfTest") {
    [pscustomobject]@{
        runtimeContract = "unified-lifecycle-v3"
        lifecycleModel = "stateless-controller"
        supportsDiagnosticTray = $true
        controllerEntryExists = $true
        autoStartCore = $true
        autoStartTunnel = $true
        exitUiStopsRuntime = $false
        exactOwnershipEnforced = $true
        capabilities = @("ensure_running", "repair_connectivity", "restart_core", "reload_runtime", "shutdown_runtime", "show_diagnostic_tray")
    } | ConvertTo-Json -Depth 4
    exit 0
}
[pscustomobject]@{
    ok = $true
    action = $Action
    before = [pscustomobject]@{ status = "Ready" }
    after = [pscustomobject]@{ status = "Ready" }
    ownedPids = @()
    elapsedMs = 1
    errorCode = $null
    message = "fixture"
} | ConvertTo-Json -Depth 4
'@
    $componentIds = @("project_reading", "omi_search", "japanese_study", "memory_core", "codex_bridge", "personal_asset_os")
    $v2Components = @()
    for ($componentIndex = 0; $componentIndex -lt $componentIds.Count; $componentIndex++) {
        $componentId = $componentIds[$componentIndex]
        $componentRoot = Join-Path $v2Workspace $componentId
        $scriptsRoot = Join-Path $componentRoot "scripts"
        New-Item -ItemType Directory -Force -Path $scriptsRoot | Out-Null
        [IO.File]::WriteAllText((Join-Path $scriptsRoot "runtime-control.ps1"), $controllerSource, (New-Object Text.UTF8Encoding($false)))
        [IO.File]::WriteAllText((Join-Path $scriptsRoot "show-diagnostic-tray.vbs"), "' test fixture", (New-Object Text.UTF8Encoding($false)))
        $basePort = 12000 + ($componentIndex * 10)
        $v2Components += [pscustomobject]@{
            id = $componentId
            displayName = $componentId
            root = "..\..\$componentId"
            runtimeMode = "component-controller"
            contractScript = "scripts\runtime-control.ps1"
            autoStart = $true
            startupOrder = ($componentIndex + 1) * 10
            legacyStartup = [pscustomobject]@{ shortcutName = "$componentId.lnk"; launcher = "scripts\show-diagnostic-tray.vbs" }
            actions = [pscustomobject]@{
                ensure_running = [pscustomobject]@{ kind = "powershell"; path = "scripts\runtime-control.ps1" }
                repair_connectivity = [pscustomobject]@{ kind = "powershell"; path = "scripts\runtime-control.ps1" }
                restart_core = [pscustomobject]@{ kind = "powershell"; path = "scripts\runtime-control.ps1" }
                reload_runtime = [pscustomobject]@{ kind = "powershell"; path = "scripts\runtime-control.ps1" }
                shutdown_runtime = [pscustomobject]@{ kind = "powershell"; path = "scripts\runtime-control.ps1" }
                show_diagnostic_tray = [pscustomobject]@{ kind = "vbs"; path = "scripts\show-diagnostic-tray.vbs" }
            }
            probes = @(
                [pscustomobject]@{
                    id = "core"; label = "Core"; role = "core"; kind = "json"
                    url = "http://127.0.0.1:$basePort/health"; port = $basePort; required = $true
                    expected = [pscustomobject]@{ ok = $true }
                },
                [pscustomobject]@{
                    id = "tunnel"; label = "Tunnel"; role = "connectivity"; kind = "text"
                    url = "http://127.0.0.1:$($basePort + 1)/readyz"; port = $basePort + 1; required = $true
                    expectedText = @("ready")
                }
            )
        }
    }
    $v2ManifestDocument = [pscustomobject]@{
        schemaVersion = 2
        settings = [pscustomobject]@{
            initialDelaySeconds = 0
            betweenComponentsSeconds = 0
            probeTimeoutSeconds = 1
            postStartTimeoutSeconds = 5
            controllerActionTimeoutSeconds = 180
            refreshIntervalSeconds = 10
            eventRetentionDays = 1
        }
        components = $v2Components
    }
    $v2ManifestPath = Join-Path $v2ConfigRoot "components.json"
    Write-McpCcJsonAtomic -Path $v2ManifestPath -Document $v2ManifestDocument
    $v2Manifest = Read-McpCcManifest -Path $v2ManifestPath
    Assert-Equal $v2Manifest.schemaVersion 2 "schema v2 manifest is accepted"
    Assert-True (@($v2Manifest.components | Where-Object { $_.runtimeMode -ne "component-controller" }).Count -eq 0) "schema v2 controller modes are preserved"
    Assert-True (@($v2Manifest.components[0].capabilities).Count -eq 6) "controller capabilities are normalized"
    Assert-Equal $v2Manifest.settings.controllerActionTimeoutSeconds 180 "schema v2 controller timeout is explicit"
    $v2SelfTest = Test-McpCcManifest -Manifest $v2Manifest
    Assert-True $v2SelfTest.ok "all schema v2 lifecycle contracts pass self-test"
    Assert-Equal $v2SelfTest.expectedLifecycleContract "unified-lifecycle-v3" "v3 lifecycle contract identity is explicit"
    $controllerPlan = Invoke-McpCcComponentAction -Manifest $v2Manifest -ComponentId "project_reading" -Action ensure_running -PlanOnly
    Assert-Equal $controllerPlan.manifestAction "ensure_running" "controller action uses its fixed semantic manifest key"
    Assert-Equal ($controllerPlan.arguments -join " ") "-Action EnsureRunning" "controller action arguments are generated by the manager"
    $controllerExecution = Invoke-McpCcComponentAction -Manifest $v2Manifest -ComponentId "project_reading" -Action ensure_running -RuntimeRoot $testRoot
    Assert-True ($controllerExecution.exitCode -eq 0 -and $controllerExecution.result.ok -eq $true) "controller action executes through the fixed PowerShell entrypoint"
    Assert-Equal $controllerExecution.result.action "EnsureRunning" "controller receives only the manager-generated action value"
    $repairPlan = Invoke-McpCcComponentAction -Manifest $v2Manifest -ComponentId "project_reading" -Action repair_connectivity -PlanOnly
    Assert-Equal ($repairPlan.arguments -join " ") "-Action RepairConnectivity" "repair connectivity uses a fixed manager argument"
    $shutdownPlan = Invoke-McpCcComponentAction -Manifest $v2Manifest -ComponentId "project_reading" -Action shutdown_runtime -PlanOnly
    Assert-Equal ($shutdownPlan.arguments -join " ") "-Action ShutdownRuntime" "shutdown runtime uses a fixed manager argument"
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $testRoot "action-capture") -File).Count -eq 0) "controller stdout and stderr capture files are removed"
    $diagnosticPlan = Invoke-McpCcComponentAction -Manifest $v2Manifest -ComponentId "project_reading" -Action show_diagnostic_tray -PlanOnly
    Assert-Equal $diagnosticPlan.manifestAction "show_diagnostic_tray" "diagnostic tray uses a declared v3 capability"

    $projectControllerPath = Join-Path $v2Workspace "project_reading\scripts\runtime-control.ps1"
    $invalidResultSource = 'param([string]$Action); [pscustomobject]@{ ok = $true; action = $Action } | ConvertTo-Json'
    [IO.File]::WriteAllText($projectControllerPath, $invalidResultSource, (New-Object Text.UTF8Encoding($false)))
    Assert-Throws { Invoke-McpCcComponentAction -Manifest $v2Manifest -ComponentId "project_reading" -Action ensure_running -RuntimeRoot $testRoot } "controller action rejects incomplete JSON results"

    $timeoutSource = 'param([string]$Action); Start-Sleep -Seconds 3'
    [IO.File]::WriteAllText($projectControllerPath, $timeoutSource, (New-Object Text.UTF8Encoding($false)))
    Assert-Throws { Invoke-McpCcComponentAction -Manifest $v2Manifest -ComponentId "project_reading" -Action ensure_running -RuntimeRoot $testRoot -ActionTimeoutSeconds 1 } "controller action enforces a bounded timeout"

    $oversizedSource = 'param([string]$Action); Write-Output ("x" * 4096)'
    [IO.File]::WriteAllText($projectControllerPath, $oversizedSource, (New-Object Text.UTF8Encoding($false)))
    Assert-Throws { Invoke-McpCcComponentAction -Manifest $v2Manifest -ComponentId "project_reading" -Action ensure_running -RuntimeRoot $testRoot -MaxCapturedOutputBytes 1024 } "controller action enforces a bounded output limit"
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $testRoot "action-capture") -File).Count -eq 0) "failed controller actions also remove capture files"
    [IO.File]::WriteAllText($projectControllerPath, $controllerSource, (New-Object Text.UTF8Encoding($false)))

    $invalidManifest = Get-Content -LiteralPath $v2ManifestPath -Encoding UTF8 -Raw | ConvertFrom-Json
    $invalidManifest.components[0].actions.ensure_running | Add-Member -NotePropertyName arguments -NotePropertyValue @("-Command", "arbitrary")
    $invalidManifestPath = Join-Path $v2ConfigRoot "invalid-components.json"
    Write-McpCcJsonAtomic -Path $invalidManifestPath -Document $invalidManifest
    Assert-Throws { Read-McpCcManifest -Path $invalidManifestPath } "schema v2 controller actions reject manifest-provided arguments"
}
finally {
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    if ($resolvedTestRoot.StartsWith($tempBase + '\', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTestRoot)) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}

$sourceFiles = @(Get-ChildItem -LiteralPath $projectRoot -Recurse -File | Where-Object { $_.Extension -in @(".ps1", ".psm1") })
$parseFailures = @()
foreach ($file in $sourceFiles) {
    $tokens = $null
    $parseErrors = $null
    [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors) | Out-Null
    foreach ($error in @($parseErrors)) {
        $parseFailures += "$($file.FullName):$($error.Extent.StartLineNumber): $($error.Message)"
    }
}
Assert-True ($parseFailures.Count -eq 0) "all PowerShell source parses"

[pscustomobject]@{
    ok = $true
    assertions = $script:Passed
    sourceFilesParsed = $sourceFiles.Count
    componentCount = @($manifest.components).Count
} | ConvertTo-Json -Depth 4
