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

$captureRegression = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "test-controller-capture.ps1")) | ConvertFrom-Json
Assert-True ($LASTEXITCODE -eq 0 -and $captureRegression.ok) "controller capture regression passes"

function Copy-JsonDocument($Value) {
    return (($Value | ConvertTo-Json -Depth 30) | ConvertFrom-Json)
}

function New-ProbeResult {
    param(
        [string]$Role,
        [bool]$Success,
        [bool]$TcpOpen = $true,
        [bool]$OwnerKnown = $false,
        $OwnerMatches = $null,
        [bool]$Required = $true,
        [string]$ErrorCode = $null
    )
    return [pscustomobject]@{
        role = $Role
        required = $Required
        success = $Success
        tcpOpen = $TcpOpen
        errorCode = $ErrorCode
        owner = [pscustomobject]@{ known = $OwnerKnown; matchesExpected = $OwnerMatches }
    }
}

$dynamicRangeFixture = @'
Protocol tcp Dynamic Port Range
---------------------------------
Start Port      : 1024
Number of Ports : 13977
'@
$parsedDynamicRange = ConvertFrom-McpCcDynamicPortRangeText -Text $dynamicRangeFixture
Assert-Equal $parsedDynamicRange.start 1024 "dynamic port parser reads the start value without depending on labels"
Assert-Equal $parsedDynamicRange.end 15000 "dynamic port parser derives the inclusive end"
Assert-Equal $parsedDynamicRange.count 13977 "dynamic port parser preserves the count"

$excludedRangeFixture = @'
Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
      8744        8843
     50000       50059     *
'@
$parsedExcludedRanges = @(ConvertFrom-McpCcExcludedPortRangeText -Text $excludedRangeFixture)
Assert-Equal $parsedExcludedRanges.Count 2 "excluded port parser reads bounded numeric rows"
Assert-True (-not $parsedExcludedRanges[0].administered -and $parsedExcludedRanges[1].administered) "excluded port parser preserves administered markers"

$portPolicyRunner = {
    param([string[]]$Arguments)
    if ("$Arguments" -match "dynamicportrange") { return $dynamicRangeFixture }
    if ("$Arguments" -match "excludedportrange") { return $excludedRangeFixture }
    throw "unexpected netsh fixture arguments"
}.GetNewClosure()
$fixturePortPolicy = Get-McpCcWindowsTcpPortPolicy -CommandRunner $portPolicyRunner
Assert-True ($fixturePortPolicy.available -and $null -eq $fixturePortPolicy.errorCode) "IPv4 and IPv6 port policy collection is explicit"
$unavailablePortPolicy = Get-McpCcWindowsTcpPortPolicy -CommandRunner { param([string[]]$IgnoredArguments) throw "fixture unavailable" }
Assert-True (-not $unavailablePortPolicy.available -and $unavailablePortPolicy.errorCode -eq "PORT_POLICY_UNAVAILABLE") "port-policy command failure remains explicit"
$unavailableAssessment = Test-McpCcPortAgainstPolicy -Port 18828 -HostName "127.0.0.1" -Policy $unavailablePortPolicy
Assert-True (-not $unavailableAssessment.known -and $null -eq $unavailableAssessment.safe) "unavailable policy does not invent an unsafe component result"
$excludedAssessment = Test-McpCcPortAgainstPolicy -Port 8787 -HostName "127.0.0.1" -Policy $fixturePortPolicy
Assert-True ($excludedAssessment.known -and -not $excludedAssessment.safe -and $excludedAssessment.errorCode -eq "PORT_EXCLUDED") "excluded range takes precedence over the broader dynamic range"
$dynamicAssessment = Test-McpCcPortAgainstPolicy -Port 12000 -HostName "127.0.0.1" -Policy $fixturePortPolicy
Assert-Equal $dynamicAssessment.errorCode "PORT_IN_DYNAMIC_RANGE" "unexcluded fixed services still reject the Windows dynamic client range"
$safeAssessment = Test-McpCcPortAgainstPolicy -Port 18828 -HostName "127.0.0.1" -Policy $fixturePortPolicy
Assert-True ($safeAssessment.known -and $safeAssessment.safe) "fixed service ports above the current dynamic range remain eligible"
$fixturePolicySummary = ConvertTo-McpCcPortPolicySummary -Policy $fixturePortPolicy
Assert-Equal $fixturePolicySummary.ipv4.dynamicEnd 15000 "public port-policy summary preserves the dynamic range boundary"
Assert-Equal $fixturePolicySummary.ipv4.excludedRangeCount 2 "public port-policy summary exposes only the bounded excluded-range count"
Assert-True ($null -eq $fixturePolicySummary.ipv4.PSObject.Properties["excludedRanges"]) "public state omits the full Windows excluded-range inventory"
$unsafeProbe = [pscustomobject]@{
    id = "fixture"; label = "Fixture"; role = "core"; required = $true; kind = "json"
    url = "http://127.0.0.1:8787/health"; port = 8787
}
$unsafeProbeResult = Get-McpCcProbeResult -Probe $unsafeProbe -TimeoutSeconds 5 -PortPolicy $fixturePortPolicy -TcpPortTester { param([int]$IgnoredPort) $false }
Assert-Equal $unsafeProbeResult.errorCode "PORT_EXCLUDED" "probe preflight rejects an unsafe port before HTTP health polling"
Assert-True ($unsafeProbeResult.portPolicy.known -and -not $unsafeProbeResult.portPolicy.safe) "probe output publishes bounded port-policy evidence"

$manifest = Read-McpCcManifest -Path (Join-Path $projectRoot "config\components.json")
Assert-Equal @($manifest.components).Count 6 "manifest has six components"
Assert-Equal $manifest.schemaVersion 2 "live pilot manifest uses schema version 2"
Assert-True (@($manifest.components | Where-Object { -not $_.autoStart }).Count -eq 0) "all unified components are auto-start enabled"
Assert-True (@($manifest.components | Where-Object { $_.runtimeMode -eq "component-controller" }).Count -eq 1) "rollback manifest retains the original single controller pilot"
$projectComponent = @($manifest.components | Where-Object { $_.id -eq "project_reading" })[0]
Assert-Equal $projectComponent.runtimeMode "component-controller" "Project Reading is the controller pilot"
Assert-True (@($manifest.components | Where-Object { $_.id -ne "project_reading" -and $_.runtimeMode -ne "legacy-tray" }).Count -eq 0) "rollback manifest retains the other five legacy tray definitions"
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

$registryManifest = Read-McpCcManifest
Assert-Equal $registryManifest.schemaVersion 3 "default control-center registry uses schema version 3"
Assert-True ((Get-McpCcDefaultManifestPath).EndsWith("mcp_control_center\config\registry.json", [StringComparison]::OrdinalIgnoreCase)) "default loader selects registry v3"
Assert-Equal $registryManifest.registeredCount 7 "registry v3 has seven registered components"
Assert-Equal $registryManifest.enabledCount 7 "registry v3 enables all seven production components"
$expectedActiveIds = @($manifest.components.id) + "english_study"
Assert-Equal (@($registryManifest.components.id) -join ",") ($expectedActiveIds -join ",") "registry v3 preserves legacy order and appends English Study"
Assert-True (@($registryManifest.components | Where-Object { $_.runtimeMode -eq "component-controller" }).Count -eq 7) "registry v3 activates all seven component controllers"
Assert-True (@($registryManifest.components | Where-Object { $_.runtimeMode -eq "legacy-tray" }).Count -eq 0) "registry v3 no longer requires a component legacy tray"
$registeredEnglish = @($registryManifest.registeredComponents | Where-Object { $_.id -eq "english_study" })[0]
Assert-True ($null -ne $registeredEnglish) "English Study remains visible to registry validation"
Assert-True ($registeredEnglish.enabled -and $registeredEnglish.autoStart) "English Study is adopted into the production startup chain"
Assert-Equal $registeredEnglish.startupOrder 70 "English Study registration follows the established components"
Assert-Equal $registeredEnglish.runtimeMode "component-controller" "English Study activates its component-owned lifecycle"
Assert-Equal (@($registeredEnglish.capabilities) -join ",") "ensure_running,repair_connectivity,restart_core,reload_runtime,shutdown_runtime,show_diagnostic_tray" "English Study exposes only its bounded lifecycle capabilities"
$registryEnglishTunnel = @($registeredEnglish.probes | Where-Object { $_.id -eq "tunnel" })[0]
$registryEnglishHub = @($registeredEnglish.probes | Where-Object { $_.id -eq "hub" })[0]
$registryEnglishMcp = @($registeredEnglish.probes | Where-Object { $_.id -eq "mcp" })[0]
Assert-Equal $registryEnglishHub.port 18887 "English Study Hub uses a reboot-stable fixed port"
Assert-Equal $registryEnglishMcp.port 18886 "English Study MCP uses a reboot-stable fixed port"
Assert-Equal $registryEnglishTunnel.port 18888 "English Study tunnel uses a reboot-stable fixed port"
Assert-Equal (@($registeredEnglish.traits) -join ",") "tunnel,multi-core,credential-sensitive,primary-ui,diagnostic-ui" "English Study declares its tunnel, credential, and primary UI boundary"
foreach ($legacyDefinition in @($manifest.components)) {
    $registryDefinition = @($registryManifest.components | Where-Object { $_.id -eq $legacyDefinition.id })[0]
    Assert-Equal $registryDefinition.displayName $legacyDefinition.displayName "registry v3 preserves display name for $($legacyDefinition.id)"
    Assert-Equal $registryDefinition.startupOrder $legacyDefinition.startupOrder "registry v3 preserves startup order for $($legacyDefinition.id)"
    Assert-Equal (@($registryDefinition.probes | ForEach-Object { "$($_.id)|$($_.role)|$($_.kind)|$($_.url)|$($_.port)|$($_.required)" }) -join ",") (@($legacyDefinition.probes | ForEach-Object { "$($_.id)|$($_.role)|$($_.kind)|$($_.url)|$($_.port)|$($_.required)" }) -join ",") "registry v3 preserves probe identity for $($legacyDefinition.id)"
}
$registryProject = @($registryManifest.components | Where-Object { $_.id -eq "project_reading" })[0]
Assert-Equal (@($registryProject.capabilities) -join ",") "ensure_running,repair_connectivity,restart_core,reload_runtime,shutdown_runtime,show_diagnostic_tray" "Project Reading descriptor declares the exact controller capabilities"
Assert-Equal (Get-McpCcComponentTimingSeconds -Manifest $registryManifest -Component $registryProject -Name "postStartTimeoutSeconds") 45 "component timing inherits the registry default"
$timingOverrideComponent = $registryProject.PSObject.Copy()
$timingOverrideComponent.timing = [pscustomobject]@{ postStartTimeoutSeconds = 73 }
Assert-Equal (Get-McpCcComponentTimingSeconds -Manifest $registryManifest -Component $timingOverrideComponent -Name "postStartTimeoutSeconds") 73 "component timing may override the registry default"
$registryMemory = @($registryManifest.components | Where-Object { $_.id -eq "memory_core" })[0]
Assert-True ($registryMemory.ui.primaryLauncher.path -eq "scripts\start-memory-core-viewer.vbs") "Memory Core keeps its component-owned primary UI launcher"
Assert-Equal $registryMemory.runtimeMode "component-controller" "Memory Core descriptor activates the v3 controller"
Assert-Equal (@($registryMemory.capabilities) -join ",") "ensure_running,repair_connectivity,restart_core,reload_runtime,shutdown_runtime,show_diagnostic_tray" "Memory Core declares the complete controller capability set"
Assert-Equal (@($registryMemory.traits) -join ",") "tunnel,multi-core,data-sensitive,primary-ui,diagnostic-ui" "Memory Core retains its multi-core, data-sensitive and primary-UI differences"
$registryMemoryBackend = @($registryMemory.probes | Where-Object { $_.id -eq "backend" })[0]
$registryMemoryMcp = @($registryMemory.probes | Where-Object { $_.id -eq "mcp" })[0]
$registryMemoryTunnel = @($registryMemory.probes | Where-Object { $_.id -eq "tunnel" })[0]
Assert-True ($registryMemoryBackend.resolvedOwnerManagedPidFile.EndsWith("Memory Core\data\runtime\backend.pid", [StringComparison]::OrdinalIgnoreCase)) "Memory Core backend keeps component-owned PID authority"
Assert-True ($registryMemoryMcp.resolvedOwnerManagedPidFile.EndsWith("Memory Core\data\runtime\mcp.pid", [StringComparison]::OrdinalIgnoreCase)) "Memory Core MCP keeps component-owned PID authority"
$registryCodex = @($registryManifest.components | Where-Object { $_.id -eq "codex_bridge" })[0]
$registryCodexTunnel = @($registryCodex.probes | Where-Object { $_.id -eq "tunnel" })[0]
Assert-Equal $registryCodexTunnel.port 18829 "Codex tunnel admin port stays outside the adjacent MCP and English Study port block"
Assert-Equal $registryCodexTunnel.url "http://127.0.0.1:18829/readyz" "Codex tunnel readiness URL matches the isolated admin port"
Assert-True ($registryMemoryTunnel.resolvedOwnerManagedPidFile.EndsWith("Memory Core\data\runtime\tunnel-client.pid", [StringComparison]::OrdinalIgnoreCase)) "Memory Core tunnel keeps component-owned PID authority"
$registryJapanese = @($registryManifest.components | Where-Object { $_.id -eq "japanese_study" })[0]
Assert-Equal $registryJapanese.runtimeMode "component-controller" "Japanese Study descriptor activates the v3 controller"
Assert-Equal (@($registryJapanese.capabilities) -join ",") "ensure_running,repair_connectivity,restart_core,reload_runtime,shutdown_runtime,show_diagnostic_tray" "Japanese Study declares the complete controller capability set"
Assert-Equal (@($registryJapanese.traits) -join ",") "tunnel,multi-core,credential-sensitive,primary-ui,diagnostic-ui" "Japanese Study retains its ordered multi-core, credential-sensitive and primary-UI differences"
Assert-Equal $registryJapanese.ui.primaryLauncher.path "scripts\start-japanese-study-desktop.vbs" "Japanese Study keeps a component-owned primary UI launcher"
$registryJapaneseHub = @($registryJapanese.probes | Where-Object { $_.id -eq "hub" })[0]
Assert-True ($registryJapaneseHub.resolvedOwnerManagedPidFile.EndsWith("japanese_study\.tmp\japanese-study-hub-runner.pid", [StringComparison]::OrdinalIgnoreCase)) "Japanese Study Hub uses its component-owned runner PID file"
$registryEnglish = @($registryManifest.components | Where-Object { $_.id -eq "english_study" })[0]
Assert-Equal (@($registryEnglish.traits) -join ",") "tunnel,multi-core,credential-sensitive,primary-ui,diagnostic-ui" "English Study retains its ordered multi-core, credential-sensitive and primary-UI differences"
Assert-Equal $registryEnglish.ui.primaryLauncher.path "scripts\start-english-study-desktop.vbs" "English Study keeps a component-owned primary UI launcher"
$registryOmi = @($registryManifest.components | Where-Object { $_.id -eq "omi_search" })[0]
Assert-True ("omi_api_base_url" -notin @($registryOmi.probes.summaryFields)) "OMI descriptor does not expose an upstream URL in public summaries"
Assert-Equal $registryOmi.runtimeMode "component-controller" "OMI Search descriptor activates the v3 controller"
Assert-Equal (@($registryOmi.capabilities) -join ",") "ensure_running,repair_connectivity,restart_core,reload_runtime,shutdown_runtime,show_diagnostic_tray" "OMI Search declares the complete controller capability set"
Assert-Equal (@($registryOmi.traits) -join ",") "tunnel,external-dependency,diagnostic-ui" "OMI Search retains its component-specific trait differences"
$registryOmiCore = @($registryOmi.probes | Where-Object { $_.id -eq "mcp" })[0]
Assert-True ($registryOmiCore.resolvedOwnerManagedPidFile.EndsWith("OMI_search\.tmp\omi-search-http-server.pid", [StringComparison]::OrdinalIgnoreCase)) "OMI controller core uses its component-owned managed PID file"
$registryCodex = @($registryManifest.components | Where-Object { $_.id -eq "codex_bridge" })[0]
Assert-True ("controller" -notin @($registryCodex.probes.summaryFields)) "Codex Bridge descriptor does not expose controller metadata in public summaries"
Assert-Equal $registryCodex.runtimeMode "component-controller" "Codex Bridge descriptor activates the v3 controller"
Assert-Equal (@($registryCodex.capabilities) -join ",") "ensure_running,repair_connectivity,restart_core,reload_runtime,shutdown_runtime,show_diagnostic_tray" "Codex Bridge declares the complete controller capability set"
Assert-Equal $registryCodex.connectivityEvidence.remoteEvidencePath ".tmp\remote-registration-evidence.json" "Codex Bridge declares component-owned remote evidence"
Assert-True (Test-McpCcPathWithinRoot -Path $registryCodex.connectivityEvidence.resolvedRemoteEvidencePath -Root $registryCodex.resolvedRoot) "Codex remote evidence stays within the component root"
Assert-Equal (@($registryCodex.traits) -join ",") "tunnel,approval-sensitive,diagnostic-ui" "Codex Bridge retains its approval-sensitive component difference"
$registryCodexCore = @($registryCodex.probes | Where-Object { $_.id -eq "mcp" })[0]
Assert-True ($registryCodexCore.resolvedOwnerManagedPidFile.EndsWith("codex_bridge\.tmp\codex-bridge-http-server.pid", [StringComparison]::OrdinalIgnoreCase)) "Codex Bridge core uses its component-owned managed PID file"
$registryPaos = @($registryManifest.components | Where-Object { $_.id -eq "personal_asset_os" })[0]
Assert-Equal $registryPaos.runtimeMode "component-controller" "Personal Asset OS descriptor activates the v3 controller"
Assert-Equal (@($registryPaos.capabilities) -join ",") "ensure_running,repair_connectivity,restart_core,reload_runtime,shutdown_runtime,show_diagnostic_tray" "Personal Asset OS declares the complete controller capability set"
Assert-Equal (@($registryPaos.traits) -join ",") "tunnel,data-sensitive,primary-ui,diagnostic-ui" "Personal Asset OS retains its data-sensitive and primary-UI differences"
$registryPaosCore = @($registryPaos.probes | Where-Object { $_.id -eq "app" })[0]
Assert-True ($registryPaosCore.resolvedOwnerManagedPidFile.EndsWith("personal-asset-os\.tmp\personal-asset-os-server.pid", [StringComparison]::OrdinalIgnoreCase)) "Personal Asset OS uses its component-owned runner PID file"
Assert-True ("dataDir" -notin @($registryPaos.probes.summaryFields)) "Personal Asset OS public summaries omit the formal data path"
$productionPorts = @($registryManifest.components | ForEach-Object { @($_.probes) } | ForEach-Object { [int]$_.port } | Sort-Object -Unique)
Assert-Equal ($productionPorts -join ",") "18765,18787,18788,18790,18791,18792,18797,18799,18800,18818,18828,18829,18876,18877,18886,18887,18888" "production fixed ports use the reboot-stable high-port cohort"
foreach ($productionPort in $productionPorts) {
    $assessment = Test-McpCcPortAgainstPolicy -Port $productionPort -HostName "127.0.0.1" -Policy $fixturePortPolicy
    Assert-True ($assessment.known -and $assessment.safe) "production port $productionPort stays outside the fixed-service exclusion policy"
}
$expectedComponentMenus = [ordered]@{
    project_reading = "copy_mcp_url,copy_health_url,copy_tunnel_id,open_mcp_health,open_tunnel_ui,open_runtime_logs"
    omi_search = "copy_mcp_url,copy_health_url,copy_tunnel_id,open_mcp_health,open_tunnel_ui,open_runtime_logs,save_control_plane_key,show_key_status"
    japanese_study = "copy_mcp_url,copy_health_url,copy_tunnel_id,open_mcp_health,open_tunnel_ui,open_runtime_logs,open_study_browser,open_hub_health,save_tunnel_key,show_key_status"
    memory_core = "copy_mcp_url,copy_health_url,copy_tunnel_id,open_mcp_health,open_tunnel_ui,open_runtime_logs,open_control_center,open_backend_api_docs,replace_runtime_tunnel_key,show_key_status"
    codex_bridge = "copy_mcp_url,copy_health_url,copy_tunnel_id,open_mcp_health,open_tunnel_ui,open_runtime_logs,open_jobs_folder"
    personal_asset_os = "copy_mcp_url,copy_health_url,copy_tunnel_id,open_mcp_health,open_tunnel_ui,open_runtime_logs,open_dashboard,create_verified_backup,copy_app_url,open_data_folder,open_backup_folder"
    english_study = "copy_mcp_url,copy_health_url,copy_tunnel_id,open_mcp_health,open_tunnel_ui,open_runtime_logs,open_study_browser,open_hub_health,save_tunnel_key,show_key_status"
}
foreach ($componentId in $expectedComponentMenus.Keys) {
    $definition = @($registryManifest.components | Where-Object { $_.id -eq $componentId })[0]
    Assert-Equal $definition.ui.menuContract "component-menu-v1" "$componentId uses the shared component menu contract"
    Assert-True ($definition.ui.actionEntrypoint.path -eq "scripts\control-center-ui.ps1") "$componentId keeps UI action execution inside its component root"
    Assert-Equal (@($definition.ui.menuActions.id) -join ",") $expectedComponentMenus[$componentId] "$componentId restores its declared tray functions in template order"
}
$expectedDailyMenus = [ordered]@{
    project_reading = "restart_mcp,open_health"
    omi_search = "restart_mcp,open_health"
    japanese_study = "restart_mcp,open_health,open_frontend"
    memory_core = "restart_mcp,open_health,open_frontend"
    codex_bridge = "restart_mcp,open_health"
    personal_asset_os = "restart_mcp,open_health,open_frontend"
    english_study = "restart_mcp,open_health,open_frontend"
}
foreach ($componentId in $expectedDailyMenus.Keys) {
    $definition = @($registryManifest.components | Where-Object { $_.id -eq $componentId })[0]
    $dailyModel = Get-McpCcTrayComponentModel -Component $definition
    Assert-Equal (@($dailyModel.actions.id) -join ",") $expectedDailyMenus[$componentId] "$componentId exposes only the bounded daily tray actions"
    Assert-True (@($dailyModel.actions).Count -le 3) "$componentId daily tray remains bounded to at most three actions"
}
$legacyDailyModels = @($manifest.components | ForEach-Object { Get-McpCcTrayComponentModel -Component $_ })
Assert-True (@($legacyDailyModels | Where-Object { (@($_.actions.id) -join ",") -ne "restart_mcp,open_health" }).Count -eq 0) "rollback schema v2 components retain the two safe daily tray actions"
Assert-True (@($legacyDailyModels | Where-Object { $null -ne $_.frontend }).Count -eq 0) "rollback schema v2 does not invent frontend metadata"
$japaneseDailyModel = Get-McpCcTrayComponentModel -Component $registryJapanese
Assert-Equal $japaneseDailyModel.frontend.kind "vbs" "Japanese Study frontend uses its validated VBS launcher"
Assert-True ($japaneseDailyModel.frontend.path.EndsWith("scripts\start-japanese-study-desktop.vbs", [StringComparison]::OrdinalIgnoreCase)) "Japanese Study daily frontend keeps its exact launcher"
$memoryDailyModel = Get-McpCcTrayComponentModel -Component $registryMemory
Assert-Equal $memoryDailyModel.frontend.kind "vbs" "Memory Core frontend uses its validated VBS launcher"
$paosDailyModel = Get-McpCcTrayComponentModel -Component $registryPaos
Assert-Equal $paosDailyModel.frontend.kind "loopback-url" "Personal Asset OS frontend uses its validated loopback target"
Assert-Equal $paosDailyModel.frontend.label "Open Dashboard" "Personal Asset OS daily frontend uses the product-facing dashboard label"
Assert-Equal $paosDailyModel.frontend.target "http://127.0.0.1:18876/" "Personal Asset OS daily frontend preserves its descriptor target"
Assert-Equal ([string]@($registryJapanese.ui.menuActions | Where-Object { $_.id -eq "open_study_browser" })[0].label) "Open Japanese Study browser" "Japanese Study exposes its desktop browser with an explicit label"
Assert-Equal ([string]@($registryEnglish.ui.menuActions | Where-Object { $_.id -eq "open_study_browser" })[0].label) "Open English Study" "English Study exposes its desktop with the product-facing label"
Assert-Equal ([string]@($registryMemory.ui.menuActions | Where-Object { $_.id -eq "open_control_center" })[0].label) "Open Memory Core viewer" "Memory Core identifies its viewer without colliding with the manager name"
$japaneseUiSelfTest = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $registryJapanese.resolvedRoot "scripts\control-center-ui.ps1") -SelfTest | ConvertFrom-Json
Assert-True $japaneseUiSelfTest.ok "Japanese Study component-owned UI dependencies are ready"
Assert-Equal $japaneseUiSelfTest.desktopApiBaseUrl "http://127.0.0.1:18791" "Japanese Study desktop launcher targets the managed Hub port"
$englishDailyModel = Get-McpCcTrayComponentModel -Component $registryEnglish
Assert-Equal $englishDailyModel.frontend.kind "vbs" "English Study frontend uses its validated VBS launcher"
Assert-True ($englishDailyModel.frontend.path.EndsWith("scripts\start-english-study-desktop.vbs", [StringComparison]::OrdinalIgnoreCase)) "English Study daily frontend keeps its exact launcher"
$englishUiSource = Get-Content -LiteralPath (Join-Path $registryEnglish.resolvedRoot "scripts\control-center-ui.ps1") -Encoding UTF8 -Raw
Assert-True ($englishUiSource.Contains('-m english_study_hub desktop') -and -not $englishUiSource.Contains('-m english_study_hub.cli desktop')) "English Study desktop action uses the package CLI entrypoint"
$englishUiSelfTest = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $registryEnglish.resolvedRoot "scripts\control-center-ui.ps1") -SelfTest | ConvertFrom-Json
Assert-True $englishUiSelfTest.ok "English Study component-owned UI dependencies are ready"
Assert-Equal $englishUiSelfTest.desktopApiBaseUrl "http://127.0.0.1:18887" "English Study desktop launcher targets the managed Hub port"
$projectUiPlan = Invoke-McpCcComponentUiAction -Manifest $registryManifest -ComponentId "project_reading" -ActionId "copy_mcp_url" -PlanOnly
Assert-Equal ($projectUiPlan.arguments -join " ") "-Action copy_mcp_url" "component UI action arguments are fixed by the manager"
Assert-True ($projectUiPlan.path.EndsWith("project_reading\scripts\control-center-ui.ps1", [StringComparison]::OrdinalIgnoreCase)) "component UI action resolves only inside the component root"
Assert-Throws { Invoke-McpCcComponentUiAction -Manifest $registryManifest -ComponentId "project_reading" -ActionId "undeclared_action" -PlanOnly } "undeclared component UI actions are rejected"
$paosBackupAction = @($registryPaos.ui.menuActions | Where-Object { $_.id -eq "create_verified_backup" })[0]
Assert-Equal $paosBackupAction.confirmation "required" "Personal Asset OS backup remains an explicit confirmed component-owned action"
$registrySelfTest = Test-McpCcManifest -Manifest $registryManifest
Assert-True $registrySelfTest.ok "registry v3 passes all seven registered component contracts"
Assert-Equal $registrySelfTest.registeredCount 7 "registry self-test reports registered count"
Assert-Equal $registrySelfTest.enabledCount 7 "registry self-test reports enabled count"
Assert-Equal $registrySelfTest.expectedComponentMenuContract "component-menu-v1" "registry self-test publishes the shared component menu contract"
foreach ($schemaPath in @("registry-v3.schema.json", "component-descriptor-v1.schema.json")) {
    $null = Get-Content -LiteralPath (Join-Path $projectRoot "schemas\$schemaPath") -Encoding UTF8 -Raw | ConvertFrom-Json
    $script:Passed += 1
}
$coreModuleSource = Get-Content -LiteralPath $modulePath -Encoding UTF8 -Raw
Assert-True ($coreModuleSource -notmatch '-ExpectedCommandFragments\s+\$\(if') "probe ownership does not pass an inline empty array that shifts named-parameter binding"
Assert-True ($coreModuleSource -match '\$ownerFragments\s*=\s*@\(if') "probe ownership materializes an actual empty array before named-parameter binding"
$traySource = Get-Content -LiteralPath (Join-Path $projectRoot "scripts\tray.ps1") -Encoding UTF8 -Raw
Assert-True ($traySource -match 'Get-McpCcTrayComponentModel') "tray rendering is driven by the bounded pure menu model"
Assert-True ($traySource -match 'Start-ControllerAction -Action RestartMcp') "tray exposes the manager-owned Restart MCP facade"
Assert-True ($traySource -match 'function Start-HealthDetail') "component health opens in an independent process"
Assert-True ($traySource -notmatch 'New-Object Windows\.Forms\.MenuItem "(Start component|Repair connectivity|Restart MCP server|Reload component|Stop component)"') "daily tray no longer constructs maintenance lifecycle entries"
Assert-True ($traySource -notmatch 'Start-IndependentControllerAction -Action ComponentMenuAction') "daily tray no longer flattens component adapter actions"
Assert-True ($traySource -notmatch 'menuActionDefinition\.arguments') "component menu descriptors cannot inject command arguments"
$controllerSourceText = Get-Content -LiteralPath (Join-Path $projectRoot "scripts\control-center.ps1") -Encoding UTF8 -Raw
Assert-True ($controllerSourceText -match '"RestartMcp"\s*\{') "manager exposes the RestartMcp semantic action"
Assert-True ($controllerSourceText -match 'Get-McpCcRestartMcpDecision') "manager routes RestartMcp through the shared fail-closed decision"
Assert-True ($controllerSourceText -match 'Invoke-McpCcReconcileItems\s+-Plan\s+\$plan') "manager routes reconciliation through the tested component fault-isolation boundary"
Assert-True ($controllerSourceText -match 'reconcile_component_failed') "manager records a bounded per-component reconciliation failure event"
Assert-True ($controllerSourceText -match 'Get-McpCcAutomaticRepairDecision') "reconcile reclassifies current evidence before any automatic repair"
Assert-True ($controllerSourceText -match 'Invoke-McpCcComponentAction[^\r\n]+-Action repair_connectivity') "eligible repair delegates only the component-owned connectivity action"
Assert-True ($controllerSourceText -notmatch '(?s)repair_connectivity.+while\s*\(') "manager does not add an outer repair retry loop"
$japaneseTunnelSourceText = Get-Content -LiteralPath (Join-Path $manifest.workspaceRoot "japanese_study\scripts\tunnel.ps1") -Encoding UTF8 -Raw
Assert-True ($japaneseTunnelSourceText -match '\^\\s\*tunnel_id\\s\*:') "Japanese tunnel identity parser anchors to the profile field name"
Assert-True ($japaneseTunnelSourceText -notmatch 'Select-String[^\r\n]+tunnel_') "Japanese tunnel identity parser cannot mistake the tunnel_id key for its value"
$healthScriptPath = Join-Path $projectRoot "scripts\component-health.ps1"
$healthSelfTest = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $healthScriptPath -Component "project_reading" -SelfTest | ConvertFrom-Json
Assert-True ($LASTEXITCODE -eq 0 -and $healthSelfTest.ok -and $healthSelfTest.formContract -eq "component-health-detail-v1") "component health script passes its no-listener self-test"
Assert-True (-not $healthSelfTest.opensListener -and $healthSelfTest.managerDomainDataAccess -eq "none" -and $healthSelfTest.managerSecretAccess -eq "none") "component health self-test preserves manager trust boundaries"
$healthSmokeRuntime = Join-Path ([IO.Path]::GetTempPath()) ("mcp-cc-health-smoke-" + [Guid]::NewGuid().ToString("N"))
$healthSmoke = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $healthScriptPath -RuntimeRoot $healthSmokeRuntime -Component "personal_asset_os" -SmokeTest | ConvertFrom-Json
Assert-True ($LASTEXITCODE -eq 0 -and $healthSmoke.ok -and $healthSmoke.formContract -eq "component-health-detail-v1") "component health form builds without showing a window"
Assert-True ($healthSmoke.formWidth -ge $healthSmoke.minimumWidth -and $healthSmoke.formHeight -ge $healthSmoke.minimumHeight) "component health form respects its minimum layout bounds"
Assert-True ($healthSmoke.probeColumnCount -eq 8 -and $healthSmoke.adapterButtonCount -eq 5 -and -not $healthSmoke.opensListener) "component health smoke keeps the bounded no-listener diagnostic surface"
Assert-Equal $healthSmoke.emptyProbeHealth "Not checked" "component health does not invent a monitor exception before the first status publish"

$controllerAudit = Get-McpCcControllerAudit -Manifest $registryManifest -RuntimeRoot (Join-Path ([IO.Path]::GetTempPath()) "mcp-cc-controller-audit-test") -StatusInvoker {
    param($Definition, $IgnoredRuntimeRoot)
    $status = if ([string]$Definition.id -eq "omi_search") { "OwnershipMismatch" } else { "Ready" }
    return [pscustomobject]@{ ok=$true; action="Status"; before=$null; after=[pscustomobject]@{ status=$status }; ownedPids=@(); elapsedMs=0; errorCode=$null; message="Status checked." }
}
Assert-Equal $controllerAudit.manageableCount 6 "controller audit counts components that remain safe to manage"
Assert-Equal $controllerAudit.unmanageableCount 1 "controller audit rejects an ownership mismatch even when health probes may be ready"
Assert-True (-not @($controllerAudit.entries | Where-Object { $_.component -eq "omi_search" })[0].manageable) "controller audit exposes the unmanageable component without domain payloads"

$legacyTrayScripts = [ordered]@{
    project_reading = "project_reading\scripts\tray.ps1"
    omi_search = "OMI_search\scripts\tray.ps1"
    japanese_study = "japanese_study\scripts\tray.ps1"
    memory_core = "Memory Core\scripts\memory_core_tray.ps1"
    codex_bridge = "codex_bridge\scripts\tray.ps1"
    personal_asset_os = "personal-asset-os\scripts\tray.ps1"
}
foreach ($componentId in $legacyTrayScripts.Keys) {
    $traySelfTest = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $manifest.workspaceRoot $legacyTrayScripts[$componentId]) -SelfTest | ConvertFrom-Json
    Assert-True ($traySelfTest.legacyRuntimeTrayBlocked -eq $true) "v3 blocks stale persistent tray launch for $componentId"
}

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

$connectivityNow = [DateTimeOffset]::Parse("2026-08-14T12:00:00Z")
$localReadyConnectivity = New-McpCcConnectivityDetail -ProbeResults @(
    (New-ProbeResult -Role "connectivity" -Success $true -OwnerKnown $true -OwnerMatches $true)
) -CheckedAt $connectivityNow.ToString("o") -NowUtc $connectivityNow
Assert-Equal $localReadyConnectivity.contractVersion "component-connectivity-v1" "connectivity detail publishes its additive contract version"
Assert-Equal $localReadyConnectivity.localTunnel.status "Ready" "local tunnel readiness remains a loopback evidence layer"
Assert-Equal $localReadyConnectivity.remoteRegistration.status "NotChecked" "remote registration is not invented from local readiness"
Assert-Equal $localReadyConnectivity.chatgptConnector.status "NotChecked" "ChatGPT end-to-end readiness is not invented from local readiness"
Assert-Equal (Resolve-McpCcStatusWithConnectivity -LocalStatus "Ready" -Connectivity $localReadyConnectivity) "Ready" "missing remote evidence preserves the compatible local status"
Assert-Equal (Get-McpCcReadinessScope -LocalStatus "Ready" -Connectivity $localReadyConnectivity) "local" "ready local tunnel declares only local readiness scope"

$remoteFailureEvidence = [pscustomobject]@{
    remoteRegistration = [pscustomobject]@{
        status = "Failed"
        checkedAt = "2026-08-14T11:59:00Z"
        validUntil = "2026-08-14T12:04:00Z"
        errorCode = "REMOTE_TUNNEL_NOT_FOUND"
        source = "component_controller"
        secret = "never-project-this"
    }
}
$remoteFailedConnectivity = New-McpCcConnectivityDetail -ProbeResults @(
    (New-ProbeResult -Role "connectivity" -Success $true -OwnerKnown $true -OwnerMatches $true)
) -CheckedAt $connectivityNow.ToString("o") -RemoteEvidence $remoteFailureEvidence -NowUtc $connectivityNow
Assert-Equal $remoteFailedConnectivity.remoteRegistration.status "Failed" "fresh explicit remote failure remains distinct from local readiness"
Assert-Equal $remoteFailedConnectivity.remoteRegistration.errorCode "REMOTE_TUNNEL_NOT_FOUND" "remote failure preserves a bounded error code"
Assert-Equal (Resolve-McpCcStatusWithConnectivity -LocalStatus "Ready" -Connectivity $remoteFailedConnectivity) "Degraded" "fresh explicit remote failure degrades a locally ready component"
Assert-True (($remoteFailedConnectivity | ConvertTo-Json -Depth 8) -notmatch "never-project-this") "connectivity projection drops non-contract remote fields"

$staleRemoteEvidence = [pscustomobject]@{
    remoteRegistration = [pscustomobject]@{
        status = "Failed"
        checkedAt = "2026-08-14T11:50:00Z"
        validUntil = "2026-08-14T11:55:00Z"
        errorCode = "REMOTE_TUNNEL_NOT_FOUND"
        source = "component_controller"
    }
}
$staleConnectivity = New-McpCcConnectivityDetail -ProbeResults @(
    (New-ProbeResult -Role "connectivity" -Success $true -OwnerKnown $true -OwnerMatches $true)
) -CheckedAt $connectivityNow.ToString("o") -RemoteEvidence $staleRemoteEvidence -NowUtc $connectivityNow
Assert-Equal $staleConnectivity.remoteRegistration.status "Stale" "expired remote evidence is projected as stale"
Assert-Equal $staleConnectivity.remoteRegistration.observedStatus "Failed" "stale projection retains the prior observed status"
Assert-Equal (Resolve-McpCcStatusWithConnectivity -LocalStatus "Ready" -Connectivity $staleConnectivity) "Ready" "stale remote failure does not permanently degrade current local status"

$endToEndEvidence = [pscustomobject]@{
    remoteRegistration = [pscustomobject]@{
        status = "Ready"; checkedAt = "2026-08-14T11:59:00Z"; validUntil = "2026-08-14T12:04:00Z"; errorCode = $null; source = "component_controller"
    }
    chatgptConnector = [pscustomobject]@{
        status = "Ready"; checkedAt = "2026-08-14T11:59:30Z"; validUntil = "2026-08-14T12:04:30Z"; errorCode = $null; source = "explicit_e2e"
    }
}
$endToEndConnectivity = New-McpCcConnectivityDetail -ProbeResults @(
    (New-ProbeResult -Role "connectivity" -Success $true -OwnerKnown $true -OwnerMatches $true)
) -CheckedAt $connectivityNow.ToString("o") -RemoteEvidence $endToEndEvidence -NowUtc $connectivityNow
Assert-Equal (Get-McpCcReadinessScope -LocalStatus "Ready" -Connectivity $endToEndConnectivity) "end_to_end" "only fresh explicit connector evidence reaches end-to-end scope"

$invalidRemote = ConvertTo-McpCcRemoteConnectivityEvidence -Evidence ([pscustomobject]@{
    status = "Failed"; checkedAt = "not-a-time"; validUntil = "also-invalid"; errorCode = "bad/path"; source = "bad/path"
}) -Scope "remote_registration" -NowUtc $connectivityNow
Assert-Equal $invalidRemote.status "Unknown" "invalid remote evidence fails closed to Unknown"
Assert-Equal $invalidRemote.errorCode "REMOTE_EVIDENCE_INVALID" "invalid remote evidence uses a fixed safe code"

$stoppedPlan = Get-McpCcReconcilePlan -Manifest ([pscustomobject]@{ components = @($omiSearch) }) -State ([pscustomobject]@{ components = @([pscustomobject]@{ id = "omi_search"; status = "Stopped" }) })
Assert-Equal $stoppedPlan[0].decision "Start" "reconcile starts a dependency-aware component whose owned core is stopped"
$blockedPlan = Get-McpCcReconcilePlan -Manifest ([pscustomobject]@{ components = @($omiSearch) }) -State ([pscustomobject]@{ components = @([pscustomobject]@{ id = "omi_search"; status = "BlockedUpstream" }) })
Assert-Equal $blockedPlan[0].decision "WaitForDependency" "reconcile preserves a running component blocked only by its upstream"

$repairableStatus = [pscustomobject]@{
    id = "codex_bridge"; status = "Degraded"; localStatus = "Degraded"; issues = @()
    connectivity = [pscustomobject]@{
        localTunnel = [pscustomobject]@{ status = "Failed"; errorCode = "HTTP_ERROR" }
        remoteRegistration = [pscustomobject]@{ status = "NotChecked" }
        chatgptConnector = [pscustomobject]@{ status = "NotChecked" }
    }
    probes = @(
        (New-ProbeResult -Role "core" -Success $true -TcpOpen $true -OwnerKnown $true -OwnerMatches $true),
        (New-ProbeResult -Role "connectivity" -Success $false -TcpOpen $false -ErrorCode "HTTP_ERROR")
    )
}
$repairDecision = Get-McpCcAutomaticRepairDecision -Manifest $registryManifest -Component $registryCodex -ComponentStatus $repairableStatus
Assert-True ($repairDecision.allowed -and $repairDecision.action -eq "repair_connectivity") "only a verified local transient tunnel failure is auto-repairable"
Assert-Equal $repairDecision.classification "LocalTransientConnectivity" "repair policy labels the eligible failure layer"
Assert-Equal $repairDecision.managerAttemptLimit 1 "manager delegates at most one repair attempt"
Assert-Equal $repairDecision.retryOwner "component_controller" "bounded retry ownership remains in the component"
Assert-Equal $repairDecision.controllerTimeoutSeconds 180 "manager keeps the registry controller timeout bound"
$repairPlanManifest = [pscustomobject]@{ settings = $registryManifest.settings; components = @($registryCodex) }
$repairPlan = Get-McpCcReconcilePlan -Manifest $repairPlanManifest -State ([pscustomobject]@{ components = @($repairableStatus) })
Assert-Equal $repairPlan[0].decision "RepairConnectivity" "reconcile plans a scoped local connectivity repair"
Assert-Equal $repairPlan[0].managerAttemptLimit 1 "reconcile plan exposes the one-attempt manager bound"

$remoteFailureStatus = Copy-JsonDocument $repairableStatus
$remoteFailureStatus.localStatus = "Ready"
$remoteFailureStatus.connectivity.localTunnel.status = "Ready"
$remoteFailureStatus.connectivity.localTunnel.errorCode = $null
$remoteFailureStatus.connectivity.remoteRegistration.status = "Failed"
$remoteDecision = Get-McpCcAutomaticRepairDecision -Manifest $registryManifest -Component $registryCodex -ComponentStatus $remoteFailureStatus
Assert-True (-not $remoteDecision.allowed -and $remoteDecision.classification -eq "RemoteFailure") "remote registration failure never restarts the local tunnel"
Assert-Equal $remoteDecision.errorCode "REMOTE_REPAIR_NOT_ALLOWED" "remote failure has a fixed manual-attention reason"

$configurationFailureStatus = Copy-JsonDocument $repairableStatus
$configurationFailureStatus.issues = @([pscustomobject]@{ code = "TUNNEL_ID_MISMATCH" })
$configurationDecision = Get-McpCcAutomaticRepairDecision -Manifest $registryManifest -Component $registryCodex -ComponentStatus $configurationFailureStatus
Assert-True (-not $configurationDecision.allowed -and $configurationDecision.errorCode -eq "TUNNEL_ID_MISMATCH") "identity mismatch never enters automatic repair"

$activeWorkStatus = Copy-JsonDocument $repairableStatus
$activeWorkStatus.issues = @([pscustomobject]@{ code = "ACTIVE_WORK_PRESENT" })
$activeWorkDecision = Get-McpCcAutomaticRepairDecision -Manifest $registryManifest -Component $registryCodex -ComponentStatus $activeWorkStatus
Assert-True (-not $activeWorkDecision.allowed -and $activeWorkDecision.errorCode -eq "ACTIVE_WORK_PRESENT") "active work remains manual attention"

$unknownOwnerStatus = Copy-JsonDocument $repairableStatus
$unknownOwnerStatus.probes[1].tcpOpen = $true
$unknownOwnerStatus.probes[1].owner.known = $false
$unknownOwnerDecision = Get-McpCcAutomaticRepairDecision -Manifest $registryManifest -Component $registryCodex -ComponentStatus $unknownOwnerStatus
Assert-True (-not $unknownOwnerDecision.allowed -and $unknownOwnerDecision.errorCode -eq "OWNERSHIP_UNVERIFIED") "open tunnel with unknown ownership is not auto-repaired"

$nonTransientStatus = Copy-JsonDocument $repairableStatus
$nonTransientStatus.connectivity.localTunnel.errorCode = "TUNNEL_PROFILE_INVALID"
$nonTransientDecision = Get-McpCcAutomaticRepairDecision -Manifest $registryManifest -Component $registryCodex -ComponentStatus $nonTransientStatus
Assert-True (-not $nonTransientDecision.allowed -and $nonTransientDecision.errorCode -eq "LOCAL_FAILURE_NOT_TRANSIENT") "non-transient local failure remains manual attention"

$faultIsolationPlan = @(
    [pscustomobject]@{ component = "component_a"; currentStatus = "Ready"; decision = "NoAction" },
    [pscustomobject]@{ component = "component_b"; currentStatus = "Stopped"; decision = "Start" },
    [pscustomobject]@{ component = "component_c"; currentStatus = "Stopped"; decision = "Start" }
)
$faultIsolationActions = @(Invoke-McpCcReconcileItems -Plan $faultIsolationPlan -ItemExecutor {
    param($Item)
    if ($Item.component -eq "component_b") {
        throw "TUNNEL_NOT_READY: fixture private details must not escape"
    }
    return [pscustomobject]@{
        component = [string]$Item.component
        action = if ($Item.decision -eq "Start") { "Start" } else { "NoAction" }
        before = [string]$Item.currentStatus
        after = if ($Item.decision -eq "Start") { "Ready" } else { [string]$Item.currentStatus }
        ok = $true
        errorCode = $null
        message = "fixture completed"
    }
} -FailureObserver {
    param($Item, $Failure)
    if ($Item.component -eq "component_b") { throw "observer failure must not abort reconciliation" }
})
Assert-Equal @($faultIsolationActions).Count 3 "reconcile returns one action result for every plan item after a component failure"
Assert-Equal (@($faultIsolationActions.component) -join ",") "component_a,component_b,component_c" "reconcile preserves component order across a failure"
Assert-True (-not $faultIsolationActions[1].ok -and $faultIsolationActions[1].action -eq "Failed") "failed reconcile item is explicit"
Assert-Equal $faultIsolationActions[1].errorCode "TUNNEL_NOT_READY" "reconcile preserves an allowlisted component error code"
Assert-Equal $faultIsolationActions[1].after "Unknown" "failed reconcile item does not invent a post-action state"
Assert-True ($faultIsolationActions[1].message -notmatch "private details") "reconcile failure output omits raw component error details"
Assert-True ($faultIsolationActions[2].ok -and $faultIsolationActions[2].after -eq "Ready") "a later component still runs after an earlier component and observer failure"

$codexPaosState = [pscustomobject]@{
    components = @(
        [pscustomobject]@{ id = "codex_bridge"; status = "OwnershipMismatch" },
        [pscustomobject]@{ id = "personal_asset_os"; status = "Stopped" }
    )
}
$codexPaosPlan = @(Get-McpCcReconcilePlan -Manifest ([pscustomobject]@{ components = @($registryCodex, $registryPaos) }) -State $codexPaosState)
Assert-Equal (@($codexPaosPlan.decision) -join ",") "ManualAttention,Start" "ownership mismatch remains non-mutating while PAOS still plans Start"
$codexPaosActions = @(Invoke-McpCcReconcileItems -Plan $codexPaosPlan -ItemExecutor {
    param($Item)
    return [pscustomobject]@{
        component = [string]$Item.component
        action = if ($Item.decision -eq "Start") { "Start" } else { "ManualAttention" }
        before = [string]$Item.currentStatus
        after = if ($Item.decision -eq "Start") { "Ready" } else { [string]$Item.currentStatus }
        ok = $true
        errorCode = $null
        message = "fixture completed"
    }
})
Assert-Equal $codexPaosActions[0].action "ManualAttention" "ownership mismatch never becomes an automatic mutation"
Assert-True ($codexPaosActions[1].component -eq "personal_asset_os" -and $codexPaosActions[1].action -eq "Start") "Codex failure state does not block the following PAOS action"

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

$unsafePortState = Resolve-McpCcComponentState -Component $component -RootExists $true -StartActionExists $true -ProbeResults @(
    (New-ProbeResult -Role "core" -Success $false -TcpOpen $false -ErrorCode "PORT_IN_DYNAMIC_RANGE")
)
Assert-Equal $unsafePortState "Misconfigured" "unsafe fixed port is configuration failure rather than a restartable stopped state"

Assert-Equal (Resolve-McpCcComponentState -Component $component -RootExists $false -StartActionExists $false -ProbeResults @()) "NotInstalled" "missing component root is explicit"
Assert-Equal (Resolve-McpCcComponentState -Component $component -RootExists $true -StartActionExists $false -ProbeResults @()) "Misconfigured" "missing launcher is explicit"

$restartRouting = [ordered]@{
    Ready = "reload_runtime"
    Degraded = "reload_runtime"
    BlockedUpstream = "reload_runtime"
    Unhealthy = "reload_runtime"
    Stopped = "ensure_running"
}
foreach ($statusName in $restartRouting.Keys) {
    $decision = Get-McpCcRestartMcpDecision -ComponentStatus ([pscustomobject]@{ status = $statusName; issues = @() })
    Assert-True $decision.allowed "Restart MCP allows the safe $statusName state"
    Assert-Equal $decision.action $restartRouting[$statusName] "Restart MCP routes $statusName to the expected controller capability"
}
foreach ($statusName in @("OwnershipMismatch", "Misconfigured", "NotInstalled", "Unknown")) {
    $decision = Get-McpCcRestartMcpDecision -ComponentStatus ([pscustomobject]@{ status = $statusName; issues = @() })
    Assert-True (-not $decision.allowed -and $null -eq $decision.action) "Restart MCP rejects $statusName"
}
$monitorDecision = Get-McpCcRestartMcpDecision -ComponentStatus ([pscustomobject]@{
    status = "Unhealthy"
    issues = @([pscustomobject]@{ code = "MONITOR_EXCEPTION" })
})
Assert-True (-not $monitorDecision.allowed -and $monitorDecision.errorCode -eq "MONITOR_EXCEPTION") "monitor failures remain fail-closed even when projected as Unhealthy"

$faultManifest = [pscustomobject]@{
    settings = [pscustomobject]@{ probeTimeoutSeconds = 1 }
    components = @($registryProject, $registryOmi)
}
$faultState = Get-McpCcSystemState -Manifest $faultManifest -BootId "fault-test" -StatusProvider {
    param($Definition, $IgnoredTimeout)
    if ([string]$Definition.id -eq "project_reading") { throw "fixture monitor failure with private details" }
    return [pscustomobject]@{
        id = [string]$Definition.id
        displayName = [string]$Definition.displayName
        runtimeMode = [string]$Definition.runtimeMode
        capabilities = @($Definition.capabilities)
        autoStart = [bool]$Definition.autoStart
        startupOrder = [int]$Definition.startupOrder
        status = "Ready"
        checkedAt = [DateTime]::UtcNow.ToString("o")
        elapsedMs = 1
        rootExists = $true
        startActionExists = $true
        healthUrl = "http://127.0.0.1:1/health"
        probes = @()
        issues = @()
    }
}
Assert-Equal @($faultState.components).Count 2 "a monitor exception does not remove other components from system state"
$faultedComponent = @($faultState.components | Where-Object { $_.id -eq "project_reading" })[0]
Assert-Equal $faultedComponent.status "Unhealthy" "a monitor exception uses the compatible Unhealthy projection"
Assert-Equal $faultedComponent.issues[0].code "MONITOR_EXCEPTION" "a monitor exception emits the fixed sanitized issue code"
Assert-True ($faultedComponent.issues[0].message -notmatch "private details") "monitor exception details are not copied into public state"
Assert-Equal @($faultState.components | Where-Object { $_.status -eq "Ready" }).Count 1 "healthy components survive another component monitor failure"
Assert-Equal $faultState.overall "Failed" "a monitor exception makes aggregate state critical"
$faultHealthModel = Get-McpCcComponentHealthModel -Manifest $registryManifest -State $faultState -ComponentId "project_reading"
Assert-Equal $faultHealthModel.issues[0].code "MONITOR_EXCEPTION" "health detail preserves the sanitized monitor issue"
Assert-Equal @($faultHealthModel.probes).Count 0 "health detail does not invent probes after a monitor exception"

$healthFixtureState = [pscustomobject]@{
    generatedAt = [DateTime]::UtcNow.ToString("o")
    components = @([pscustomobject]@{
        id = "personal_asset_os"
        displayName = "Personal Asset OS"
        status = "Ready"
        checkedAt = [DateTime]::UtcNow.ToString("o")
        elapsedMs = 12
        healthUrl = "http://127.0.0.1:18876/api/health"
        issues = @()
        probes = @(
            [pscustomobject]@{
                id = "app"; label = "Personal Asset OS"; role = "core"; required = $true
                url = "http://127.0.0.1:18876/api/health"; port = 18876; success = $true; elapsedMs = 4; tcpOpen = $true
                errorCode = $null; error = $null
                owner = [pscustomobject]@{ known = $true; pid = 1234; managedPid = 1234; processName = "python.exe"; relation = "Self"; matchesExpected = $true }
            },
            [pscustomobject]@{
                id = "tunnel"; label = "Secure MCP Tunnel"; role = "connectivity"; required = $true
                url = "http://127.0.0.1:18877/readyz"; port = 18877; success = $true; elapsedMs = 3; tcpOpen = $true
                errorCode = $null; error = $null
                owner = [pscustomobject]@{ known = $true; pid = 2234; managedPid = 2234; processName = "tunnel-client.exe"; relation = "Self"; matchesExpected = $true }
            }
        )
    })
}
$healthFixtureLastAction = [pscustomobject]@{ component = "personal_asset_os"; action = "RestartMcp"; ok = $true; errorCode = $null; message = "Action completed." }
$healthModel = Get-McpCcComponentHealthModel -Manifest $registryManifest -State $healthFixtureState -ComponentId "personal_asset_os" -LastAction $healthFixtureLastAction
Assert-Equal $healthModel.statusLabel "Ready locally" "health detail states the bounded readiness scope instead of implying end-to-end readiness"
Assert-Equal $healthModel.readinessScope "local" "health detail projects local-only readiness explicitly"
Assert-Equal $healthModel.connectivity.remoteRegistration.status "NotChecked" "health detail keeps remote registration visibly unverified"
Assert-Equal $healthModel.probes[0].ownership "Verified" "health detail reports verified component ownership"
Assert-True ($healthModel.tunnelReady -and "copy_tunnel_id" -in @($healthModel.actionIds)) "health detail exposes connectivity state and only declared adapter actions"
Assert-True ($healthModel.lastAction.ok -eq $true) "health detail associates only the selected component's safe last action"

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
$genericValidatorPath = Join-Path $projectRoot "scripts\Test-McpComponent.ps1"
$projectReadingRoot = Join-Path $manifest.workspaceRoot "project_reading"
$projectReadingValidationText = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
    -File $genericValidatorPath `
    -ComponentRoot $projectReadingRoot `
    -WorkspaceRoot $manifest.workspaceRoot
if ($LASTEXITCODE -ne 0) { throw "Project Reading generic component validation failed." }
$projectReadingValidation = $projectReadingValidationText | ConvertFrom-Json
Assert-True ($projectReadingValidation.registrationReady -and $projectReadingValidation.activationReady -and -not $projectReadingValidation.safeStubPresent) "Project Reading is the activation-ready New Component Kit reference"
$omiSearchRoot = Join-Path $manifest.workspaceRoot "OMI_search"
$omiSearchValidationText = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
    -File $genericValidatorPath `
    -ComponentRoot $omiSearchRoot `
    -WorkspaceRoot $manifest.workspaceRoot
if ($LASTEXITCODE -ne 0) { throw "OMI Search generic component validation failed." }
$omiSearchValidation = $omiSearchValidationText | ConvertFrom-Json
Assert-True ($omiSearchValidation.registrationReady -and $omiSearchValidation.activationReady -and -not $omiSearchValidation.safeStubPresent) "OMI Search is activation-ready with component-owned differences"
Assert-True ("external-dependency" -in @($omiSearchValidation.traits)) "OMI validator retains the external dependency safety requirement"
$codexBridgeRoot = Join-Path $manifest.workspaceRoot "codex_bridge"
$codexBridgeValidationText = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
    -File $genericValidatorPath `
    -ComponentRoot $codexBridgeRoot `
    -WorkspaceRoot $manifest.workspaceRoot
if ($LASTEXITCODE -ne 0) { throw "Codex Bridge generic component validation failed." }
$codexBridgeValidation = $codexBridgeValidationText | ConvertFrom-Json
Assert-True ($codexBridgeValidation.registrationReady -and $codexBridgeValidation.activationReady -and -not $codexBridgeValidation.safeStubPresent) "Codex Bridge is activation-ready with component-owned differences"
Assert-True ("approval-sensitive" -in @($codexBridgeValidation.traits)) "Codex Bridge validator retains the approval-sensitive safety requirement"
$japaneseStudyRoot = Join-Path $manifest.workspaceRoot "japanese_study"
$japaneseStudyValidationText = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
    -File $genericValidatorPath `
    -ComponentRoot $japaneseStudyRoot `
    -WorkspaceRoot $manifest.workspaceRoot
if ($LASTEXITCODE -ne 0) { throw "Japanese Study generic component validation failed." }
$japaneseStudyValidation = $japaneseStudyValidationText | ConvertFrom-Json
Assert-True ($japaneseStudyValidation.registrationReady -and $japaneseStudyValidation.activationReady -and -not $japaneseStudyValidation.safeStubPresent) "Japanese Study is activation-ready with component-owned differences"
Assert-True ("multi-core" -in @($japaneseStudyValidation.traits) -and "credential-sensitive" -in @($japaneseStudyValidation.traits)) "Japanese Study validator retains multi-core and credential-sensitive requirements"

$expectedLauncher = Join-Path $componentRoot "scripts\start-tray.vbs"
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
Assert-True (Test-McpCcShortcutMatches -TargetPath $wscript -Arguments "`"$expectedLauncher`"" -ExpectedLauncher $expectedLauncher) "exact Startup shortcut is recognized"
Assert-True (-not (Test-McpCcShortcutMatches -TargetPath $wscript -Arguments '"C:\wrong\start.vbs"' -ExpectedLauncher $expectedLauncher)) "wrong Startup target is rejected"

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$testRoot = Join-Path $tempBase ("mcp-control-center-tests-" + [Guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
    $remoteEvidenceFixturePath = Join-Path $testRoot "remote-registration-evidence.json"
    $remoteEvidenceFixtureComponent = [pscustomobject]@{
        connectivityEvidence = [pscustomobject]@{ resolvedRemoteEvidencePath = $remoteEvidenceFixturePath }
    }
    Write-McpCcJsonAtomic -Path $remoteEvidenceFixturePath -Document ([pscustomobject]@{
        contractVersion = "component-connectivity-v1"
        remoteRegistration = [pscustomobject]@{
            status = "Ready"; checkedAt = "2026-08-14T11:59:00Z"; validUntil = "2026-08-14T12:04:00Z"
            errorCode = $null; source = "codex_bridge_remote_diagnostic"
        }
    })
    $persistedReadyEvidence = Read-McpCcRemoteEvidenceFile -Component $remoteEvidenceFixtureComponent -NowUtc $connectivityNow
    $persistedReadyConnectivity = New-McpCcConnectivityDetail -ProbeResults @((New-ProbeResult -Role "connectivity" -Success $true -OwnerKnown $true -OwnerMatches $true)) -RemoteEvidence $persistedReadyEvidence -NowUtc $connectivityNow
    Assert-Equal $persistedReadyConnectivity.remoteRegistration.status "Ready" "manager reads fresh sanitized component evidence"
    Assert-Equal (Get-McpCcReadinessScope -LocalStatus "Ready" -Connectivity $persistedReadyConnectivity) "remote_registration" "persisted registration evidence raises only the remote scope"

    $persistedStaleEvidence = Read-McpCcRemoteEvidenceFile -Component $remoteEvidenceFixtureComponent -NowUtc ([DateTimeOffset]::Parse("2026-08-14T12:05:00Z"))
    $persistedStaleConnectivity = New-McpCcConnectivityDetail -ProbeResults @((New-ProbeResult -Role "connectivity" -Success $true -OwnerKnown $true -OwnerMatches $true)) -RemoteEvidence $persistedStaleEvidence -NowUtc ([DateTimeOffset]::Parse("2026-08-14T12:05:00Z"))
    Assert-Equal $persistedStaleConnectivity.remoteRegistration.status "Stale" "manager expires persisted evidence by TTL"

    [IO.File]::WriteAllText($remoteEvidenceFixturePath, '{"contractVersion":"component-connectivity-v1","remoteRegistration":{"status":"Ready","checkedAt":"2026-08-14T11:59:00Z","validUntil":"2026-08-14T12:04:00Z","errorCode":null,"source":"fixture","secret":"never-project"}}', (New-Object Text.UTF8Encoding($false)))
    $unsafePersistedEvidence = Read-McpCcRemoteEvidenceFile -Component $remoteEvidenceFixtureComponent -NowUtc $connectivityNow
    $unsafePersistedText = $unsafePersistedEvidence | ConvertTo-Json -Depth 6
    Assert-Equal $unsafePersistedEvidence.remoteRegistration.status "Unknown" "manager rejects evidence with non-contract fields"
    Assert-True ($unsafePersistedText -notmatch "never-project" -and $unsafePersistedEvidence.remoteRegistration.errorCode -eq "REMOTE_EVIDENCE_INVALID") "invalid persisted evidence never projects secret fields"

    [IO.File]::WriteAllText($remoteEvidenceFixturePath, ('x' * 9000), (New-Object Text.UTF8Encoding($false)))
    $oversizedPersistedEvidence = Read-McpCcRemoteEvidenceFile -Component $remoteEvidenceFixtureComponent -NowUtc $connectivityNow
    Assert-True ($oversizedPersistedEvidence.remoteRegistration.status -eq "Unknown" -and $oversizedPersistedEvidence.remoteRegistration.errorCode -eq "REMOTE_EVIDENCE_INVALID") "manager rejects oversized persisted evidence"

    $documentPath = Join-Path $testRoot "state.json"
    Write-McpCcJsonAtomic -Path $documentPath -Document ([pscustomobject]@{ ok = $true; value = 7 })
    $roundTrip = Get-Content -LiteralPath $documentPath -Encoding UTF8 -Raw | ConvertFrom-Json
    Assert-True ($roundTrip.ok -eq $true -and $roundTrip.value -eq 7) "atomic JSON document round-trips"
    Write-McpCcEvent -RuntimeRoot $testRoot -BootId "boot-test" -Type "redaction_test" -Details @{ apiKey = "never-write"; status = "ok" }
    $eventText = Get-Content -LiteralPath (Get-ChildItem (Join-Path $testRoot "events") -Filter "*.jsonl" | Select-Object -First 1).FullName -Encoding UTF8 -Raw
    Assert-True ($eventText -notmatch "never-write") "event log does not contain secret values"
    Assert-True ($eventText -match "\[redacted\]") "event log records redaction marker"
    Write-McpCcLastActionResult -RuntimeRoot $testRoot -Component "codex_bridge" -Action "RestartMcp" -RoutedAction "reload_runtime" -Ok $false -ErrorCode "ACTIVE_WORK_PRESENT" | Out-Null
    $lastAction = Read-McpCcLastActionResult -RuntimeRoot $testRoot -Component "codex_bridge"
    Assert-True (-not $lastAction.ok -and $lastAction.errorCode -eq "ACTIVE_WORK_PRESENT") "safe last-action state preserves a bounded rejection code"
    Assert-True ($lastAction.message -match "pending approval" -and $lastAction.message -notmatch "payload") "safe last-action state uses an allowlisted operator message"
    Assert-Equal (Get-McpCcActionErrorCode -Message "Component controller reported failure 'OWNERSHIP_MISMATCH'.") "OWNERSHIP_MISMATCH" "controller failure text maps to a bounded action error code"
    Assert-Equal (Get-McpCcActionErrorCode -Message "Component controller reported failure 'TUNNEL_ID_MISMATCH'.") "TUNNEL_ID_MISMATCH" "manager preserves the tunnel identity mismatch code"
    Assert-True ((Get-McpCcSafeActionMessage -Ok $false -ErrorCode "TUNNEL_ID_MISMATCH") -match "sources disagree" -and (Get-McpCcSafeActionMessage -Ok $false -ErrorCode "TUNNEL_ID_MISMATCH") -notmatch "tunnel_") "manager projects a safe identity mismatch message"
    Assert-Equal (Get-McpCcActionErrorCode -Message "unexpected private failure text") "MANAGER_ACTION_FAILED" "unknown action failures collapse to a generic safe code"

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

    $failedResultSource = @'
param([string]$Action)
[pscustomobject]@{
    ok = $false
    action = $Action
    before = [pscustomobject]@{ status = "Stopped" }
    after = $null
    ownedPids = @()
    elapsedMs = 1
    errorCode = "TUNNEL_NOT_READY"
    message = "fixture private details must not escape"
} | ConvertTo-Json -Depth 4
exit 1
'@
    [IO.File]::WriteAllText($projectControllerPath, $failedResultSource, (New-Object Text.UTF8Encoding($false)))
    $controllerFailureMessage = $null
    try { Invoke-McpCcComponentAction -Manifest $v2Manifest -ComponentId "project_reading" -Action ensure_running -RuntimeRoot $testRoot | Out-Null }
    catch { $controllerFailureMessage = [string]$_.Exception.Message }
    Assert-True (-not [string]::IsNullOrWhiteSpace($controllerFailureMessage)) "manager rejects a controller-reported failed result"
    Assert-Equal (Get-McpCcActionErrorCode -Message $controllerFailureMessage) "TUNNEL_NOT_READY" "manager preserves a bounded controller failure code from nonzero JSON output"
    Assert-True ($controllerFailureMessage -notmatch "private details") "manager does not copy the controller failure message into its exception"

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

    $v3Workspace = Join-Path $testRoot "v3-workspace"
    $v3ManagerRoot = Join-Path $v3Workspace "mcp_control_center"
    $v3ConfigRoot = Join-Path $v3ManagerRoot "config"
    $v3ComponentRoot = Join-Path $v3Workspace "fixture_component"
    $v3DescriptorRoot = Join-Path $v3ComponentRoot "control-center"
    $v3ScriptsRoot = Join-Path $v3ComponentRoot "scripts"
    New-Item -ItemType Directory -Force -Path $v3ConfigRoot, $v3DescriptorRoot, $v3ScriptsRoot | Out-Null
    [IO.File]::WriteAllText((Join-Path $v3ScriptsRoot "tray-contract.ps1"), "'fixture'", (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText(
        (Join-Path $v3ScriptsRoot "ui-action.ps1"),
        'param([string]$Action,[switch]$SelfTest); if($SelfTest){[pscustomobject]@{ok=$true;menuContract="component-menu-v1";actions=@("open_status")}|ConvertTo-Json;exit 0}; [pscustomobject]@{ok=$true;action=$Action;errorCode=$null;message="fixture completed"}|ConvertTo-Json -Compress',
        (New-Object Text.UTF8Encoding($false))
    )
    [IO.File]::WriteAllText((Join-Path $v3ScriptsRoot "start-tray.vbs"), "' fixture", (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText((Join-Path $v3ScriptsRoot "restart-tray.vbs"), "' fixture", (New-Object Text.UTF8Encoding($false)))
    $validV3Descriptor = [pscustomobject]@{
        schemaVersion = 1
        id = "fixture_component"
        displayName = "Fixture Component"
        runtimeMode = "legacy-tray"
        runtimeContract = "unified-always-on-v2"
        traits = @()
        contractScript = "scripts\tray-contract.ps1"
        capabilities = @("ensure_running", "reload_runtime")
        lifecycle = [pscustomobject]@{
            ensureLauncher = [pscustomobject]@{ kind = "vbs"; path = "scripts\start-tray.vbs" }
            reloadLauncher = [pscustomobject]@{ kind = "vbs"; path = "scripts\restart-tray.vbs" }
        }
        probes = @(
            [pscustomobject]@{
                id = "core"
                label = "Core"
                role = "core"
                kind = "json"
                url = "http://127.0.0.1:19001/health"
                port = 19001
                required = $true
                expected = [pscustomobject]@{ status = "ok" }
                publicSummaryFields = @("status")
                ownership = [pscustomobject]@{ commandContains = @("fixture_component") }
            }
        )
        navigation = @([pscustomobject]@{ id = "health"; label = "Open health"; kind = "probe"; target = "core" })
        safety = [pscustomobject]@{
            managerDomainDataAccess = "none"
            managerSecretAccess = "none"
            shutdownConfirmation = "required"
        }
    }
    $validV3Registry = [pscustomobject]@{
        schemaVersion = 3
        settings = [pscustomobject]@{
            initialDelaySeconds = 0
            betweenComponentsSeconds = 0
            probeTimeoutSeconds = 1
            postStartTimeoutSeconds = 5
            controllerActionTimeoutSeconds = 30
            refreshIntervalSeconds = 10
            eventRetentionDays = 1
        }
        components = @([pscustomobject]@{
            id = "fixture_component"
            root = "..\..\fixture_component"
            descriptor = "control-center\component.json"
            enabled = $true
            autoStart = $true
            startupOrder = 10
        })
    }
    $v3DescriptorPath = Join-Path $v3DescriptorRoot "component.json"
    $v3RegistryPath = Join-Path $v3ConfigRoot "registry.json"
    $writeValidV3 = {
        Write-McpCcJsonAtomic -Path $v3DescriptorPath -Document (Copy-JsonDocument $validV3Descriptor)
        Write-McpCcJsonAtomic -Path $v3RegistryPath -Document (Copy-JsonDocument $validV3Registry)
    }.GetNewClosure()
    & $writeValidV3
    $v3Fixture = Read-McpCcManifest -Path $v3RegistryPath
    Assert-True ($v3Fixture.schemaVersion -eq 3 -and $v3Fixture.enabledCount -eq 1) "minimal registry v3 fixture is accepted"

    $validMenuDescriptor = Copy-JsonDocument $validV3Descriptor
    $validMenuDescriptor.runtimeMode = "component-controller"
    $validMenuDescriptor.runtimeContract = "unified-lifecycle-v3"
    $validMenuDescriptor.capabilities = @("ensure_running", "reload_runtime", "shutdown_runtime")
    $validMenuDescriptor.lifecycle = [pscustomobject]@{
        controller = [pscustomobject]@{ kind = "powershell"; path = "scripts\tray-contract.ps1" }
    }
    $validMenuDescriptor | Add-Member -NotePropertyName ui -NotePropertyValue ([pscustomobject]@{
        menuContract = "component-menu-v1"
        actionEntrypoint = [pscustomobject]@{ kind = "powershell"; path = "scripts\ui-action.ps1" }
        menuActions = @([pscustomobject]@{ id = "open_status"; label = "Open status"; group = "connection"; confirmation = "none" })
    })
    Write-McpCcJsonAtomic -Path $v3DescriptorPath -Document $validMenuDescriptor
    $menuFixture = Read-McpCcManifest -Path $v3RegistryPath
    Assert-Equal $menuFixture.components[0].ui.menuContract "component-menu-v1" "registry v3 accepts the bounded component menu contract"
    $menuExecution = Invoke-McpCcComponentUiAction -Manifest $menuFixture -ComponentId "fixture_component" -ActionId "open_status" -RuntimeRoot (Join-Path $testRoot "ui-action-runtime") -ActionTimeoutSeconds 5
    Assert-True ($menuExecution.delegated -and $menuExecution.result.ok -and $menuExecution.result.action -eq "open_status") "component menu execution accepts only bounded component-owned JSON"

    $descriptorWithRemoteEvidence = Copy-JsonDocument $validMenuDescriptor
    $descriptorWithRemoteEvidence | Add-Member -NotePropertyName connectivityEvidence -NotePropertyValue ([pscustomobject]@{ remoteEvidencePath = ".tmp\remote-registration-evidence.json" })
    Write-McpCcJsonAtomic -Path $v3DescriptorPath -Document $descriptorWithRemoteEvidence
    $remoteEvidenceFixture = Read-McpCcManifest -Path $v3RegistryPath
    Assert-Equal $remoteEvidenceFixture.components[0].connectivityEvidence.remoteEvidencePath ".tmp\remote-registration-evidence.json" "registry v3 accepts bounded component evidence binding"
    Assert-True (Test-McpCcPathWithinRoot -Path $remoteEvidenceFixture.components[0].connectivityEvidence.resolvedRemoteEvidencePath -Root $v3ComponentRoot) "registry v3 resolves evidence within the component root"

    $invalidEvidenceDescriptor = Copy-JsonDocument $descriptorWithRemoteEvidence
    $invalidEvidenceDescriptor.connectivityEvidence.remoteEvidencePath = "..\outside.json"
    Write-McpCcJsonAtomic -Path $v3DescriptorPath -Document $invalidEvidenceDescriptor
    Assert-Throws { Read-McpCcManifest -Path $v3RegistryPath } "registry v3 rejects remote evidence paths outside the component root"

    Write-McpCcJsonAtomic -Path $v3DescriptorPath -Document $validMenuDescriptor

    $invalidDescriptor = Copy-JsonDocument $validMenuDescriptor
    $invalidDescriptor.ui.menuActions[0] | Add-Member -NotePropertyName arguments -NotePropertyValue @("-Command", "unsafe")
    Write-McpCcJsonAtomic -Path $v3DescriptorPath -Document $invalidDescriptor
    Assert-Throws { Read-McpCcManifest -Path $v3RegistryPath } "component menus reject descriptor-provided command arguments"

    $invalidDescriptor = Copy-JsonDocument $validMenuDescriptor
    $invalidDescriptor.ui.menuActions[0].group = "arbitrary"
    Write-McpCcJsonAtomic -Path $v3DescriptorPath -Document $invalidDescriptor
    Assert-Throws { Read-McpCcManifest -Path $v3RegistryPath } "component menus reject unknown groups"

    $invalidDescriptor = Copy-JsonDocument $validMenuDescriptor
    $invalidDescriptor.ui.actionEntrypoint.path = "..\outside.ps1"
    Write-McpCcJsonAtomic -Path $v3DescriptorPath -Document $invalidDescriptor
    Assert-Throws { Read-McpCcManifest -Path $v3RegistryPath } "component menu entrypoints cannot escape the component root"

    & $writeValidV3

    $invalidDescriptor = Copy-JsonDocument $validV3Descriptor
    $invalidDescriptor | Add-Member -NotePropertyName arbitraryCommand -NotePropertyValue "powershell -Command unsafe"
    Write-McpCcJsonAtomic -Path $v3DescriptorPath -Document $invalidDescriptor
    Assert-Throws { Read-McpCcManifest -Path $v3RegistryPath } "registry v3 rejects unknown descriptor fields"

    $invalidDescriptor = Copy-JsonDocument $validV3Descriptor
    $invalidDescriptor.id = "different_component"
    Write-McpCcJsonAtomic -Path $v3DescriptorPath -Document $invalidDescriptor
    Assert-Throws { Read-McpCcManifest -Path $v3RegistryPath } "registry v3 rejects registry and descriptor id mismatch"

    $invalidDescriptor = Copy-JsonDocument $validV3Descriptor
    $invalidDescriptor.probes[0].url = "http://192.168.1.9:19001/health"
    Write-McpCcJsonAtomic -Path $v3DescriptorPath -Document $invalidDescriptor
    Assert-Throws { Read-McpCcManifest -Path $v3RegistryPath } "registry v3 rejects non-loopback probes"

    $invalidDescriptor = Copy-JsonDocument $validV3Descriptor
    $invalidDescriptor.probes[0].port = 19002
    Write-McpCcJsonAtomic -Path $v3DescriptorPath -Document $invalidDescriptor
    Assert-Throws { Read-McpCcManifest -Path $v3RegistryPath } "registry v3 rejects probe URL and port mismatch"

    $invalidDescriptor = Copy-JsonDocument $validV3Descriptor
    $invalidDescriptor.probes[0].publicSummaryFields = @("status", "token")
    Write-McpCcJsonAtomic -Path $v3DescriptorPath -Document $invalidDescriptor
    Assert-Throws { Read-McpCcManifest -Path $v3RegistryPath } "registry v3 rejects unsafe public summary fields"

    $invalidDescriptor = Copy-JsonDocument $validV3Descriptor
    $invalidDescriptor.lifecycle.ensureLauncher.path = "..\outside.vbs"
    Write-McpCcJsonAtomic -Path $v3DescriptorPath -Document $invalidDescriptor
    Assert-Throws { Read-McpCcManifest -Path $v3RegistryPath } "registry v3 rejects lifecycle paths outside the component root"

    $invalidDescriptor = Copy-JsonDocument $validV3Descriptor
    $invalidDescriptor.probes[0].ownership = [pscustomobject]@{}
    Write-McpCcJsonAtomic -Path $v3DescriptorPath -Document $invalidDescriptor
    Assert-Throws { Read-McpCcManifest -Path $v3RegistryPath } "registry v3 requires exact ownership evidence for required core probes"

    $invalidDescriptor = Copy-JsonDocument $validV3Descriptor
    $invalidDescriptor.traits = @("invented-trait")
    Write-McpCcJsonAtomic -Path $v3DescriptorPath -Document $invalidDescriptor
    Assert-Throws { Read-McpCcManifest -Path $v3RegistryPath } "registry v3 rejects unknown component traits"

    $invalidDescriptor = Copy-JsonDocument $validV3Descriptor
    $invalidDescriptor.runtimeMode = "component-controller"
    $invalidDescriptor.runtimeContract = "unified-lifecycle-v3"
    $invalidDescriptor.capabilities = @("ensure_running", "reload_runtime", "shutdown_runtime", "show_diagnostic_tray")
    $invalidDescriptor.lifecycle = [pscustomobject]@{
        controller = [pscustomobject]@{ kind = "powershell"; path = "scripts\tray-contract.ps1" }
        diagnosticLauncher = [pscustomobject]@{ kind = "vbs"; path = "scripts\start-tray.vbs" }
    }
    Write-McpCcJsonAtomic -Path $v3DescriptorPath -Document $invalidDescriptor
    Assert-Throws { Read-McpCcManifest -Path $v3RegistryPath } "registry v3 requires diagnostic-ui trait for a diagnostic tray capability"

    & $writeValidV3
    $invalidRegistry = Copy-JsonDocument $validV3Registry
    $invalidRegistry.components[0].enabled = $false
    $invalidRegistry.components[0].autoStart = $true
    Write-McpCcJsonAtomic -Path $v3RegistryPath -Document $invalidRegistry
    Assert-Throws { Read-McpCcManifest -Path $v3RegistryPath } "registry v3 rejects auto-start on a disabled component"

    $invalidRegistry = Copy-JsonDocument $validV3Registry
    $invalidRegistry.components += Copy-JsonDocument $invalidRegistry.components[0]
    Write-McpCcJsonAtomic -Path $v3RegistryPath -Document $invalidRegistry
    Assert-Throws { Read-McpCcManifest -Path $v3RegistryPath } "registry v3 rejects duplicate component ids"

    $invalidRegistry = Copy-JsonDocument $validV3Registry
    $invalidRegistry.components[0].descriptor = "control-center\other.json"
    Write-McpCcJsonAtomic -Path $v3RegistryPath -Document $invalidRegistry
    Assert-Throws { Read-McpCcManifest -Path $v3RegistryPath } "registry v3 requires the canonical component descriptor path"

    & $writeValidV3
    [IO.File]::WriteAllText($v3DescriptorPath, "{" + ("x" * 131072) + "}", (New-Object Text.UTF8Encoding($false)))
    Assert-Throws { Read-McpCcManifest -Path $v3RegistryPath } "registry v3 rejects oversized component descriptors"
    & $writeValidV3

    $newComponentScript = Join-Path $projectRoot "scripts\New-McpComponent.ps1"
    $testComponentScript = Join-Path $projectRoot "scripts\Test-McpComponent.ps1"
    $registerComponentScript = Join-Path $projectRoot "scripts\Register-McpComponent.ps1"
    $gate3Workspace = Join-Path $testRoot "gate3-workspace"
    $gate3ManagerRoot = Join-Path $gate3Workspace "mcp_control_center"
    $gate3ConfigRoot = Join-Path $gate3ManagerRoot "config"
    $gate3ReceiptRoot = Join-Path $testRoot "gate3-private-receipts"
    New-Item -ItemType Directory -Force -Path $gate3Workspace, $gate3ConfigRoot | Out-Null

    $seedScaffold = & $newComponentScript `
        -Id "seed_component" `
        -DisplayName "Seed Component" `
        -CorePort 19101 `
        -WorkspaceRoot $gate3Workspace `
        -Apply | ConvertFrom-Json
    Assert-True ($seedScaffold.applied -and -not $seedScaffold.registered -and -not $seedScaffold.processStarted) "scaffold writes source only"

    $gate3RegistryPath = Join-Path $gate3ConfigRoot "registry.json"
    $gate3Registry = [pscustomobject]@{
        schemaVersion = 3
        settings = [pscustomobject]@{
            initialDelaySeconds = 0
            betweenComponentsSeconds = 0
            probeTimeoutSeconds = 1
            postStartTimeoutSeconds = 5
            controllerActionTimeoutSeconds = 5
            refreshIntervalSeconds = 30
            eventRetentionDays = 30
        }
        components = @([pscustomobject]@{
            id = "seed_component"
            root = "..\..\seed_component"
            descriptor = "control-center\component.json"
            enabled = $true
            autoStart = $false
            startupOrder = 10
        })
    }
    Write-McpCcJsonAtomic -Path $gate3RegistryPath -Document $gate3Registry

    $candidateRoot = Join-Path $gate3Workspace "mock_seventh"
    $newPlan = & $newComponentScript `
        -Id "mock_seventh" `
        -DisplayName "Mock Seventh" `
        -CorePort 19102 `
        -WorkspaceRoot $gate3Workspace `
        -IncludeDiagnosticUi `
        -Plan | ConvertFrom-Json
    Assert-True ($newPlan.safeToApply -and -not (Test-Path -LiteralPath $candidateRoot)) "scaffold plan performs zero writes"

    $newApply = & $newComponentScript `
        -Id "mock_seventh" `
        -DisplayName "Mock Seventh" `
        -CorePort 19102 `
        -WorkspaceRoot $gate3Workspace `
        -IncludeDiagnosticUi `
        -Apply | ConvertFrom-Json
    Assert-True ($newApply.applied -and @($newApply.files).Count -eq 8) "scaffold apply materializes the base template, component menu, and diagnostic trait"
    $candidate = Read-McpCcComponentCandidate -ComponentRoot $candidateRoot -WorkspaceRoot $gate3Workspace
    Assert-True ($candidate.id -eq "mock_seventh" -and "diagnostic-ui" -in @($candidate.traits)) "candidate loader uses strict descriptor normalization"
    Assert-Equal $candidate.ui.menuContract "component-menu-v1" "fresh scaffold includes the shared component menu contract"
    Assert-Equal (@($candidate.ui.menuActions.id) -join ",") "copy_mcp_url,copy_health_url,open_mcp_health,open_runtime_logs" "fresh scaffold starts from the safe common menu template"
    $candidateUiSelfTest = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $candidateRoot "scripts\control-center-ui.ps1") -SelfTest | ConvertFrom-Json
    Assert-True ($LASTEXITCODE -eq 0 -and $candidateUiSelfTest.ok -and $candidateUiSelfTest.menuContract -eq "component-menu-v1") "generated component menu SelfTest passes"

    $candidateHashes = @{}
    foreach ($candidateFile in @(Get-ChildItem -LiteralPath $candidateRoot -File -Recurse)) {
        $relativeCandidatePath = $candidateFile.FullName.Substring($candidateRoot.Length)
        $candidateHashes[$relativeCandidatePath] = (Get-FileHash -LiteralPath $candidateFile.FullName -Algorithm SHA256).Hash
    }
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $newComponentScript `
        -Id "mock_seventh" `
        -DisplayName "Mock Seventh" `
        -CorePort 19102 `
        -WorkspaceRoot $gate3Workspace `
        -Apply 2>&1 | Out-Null
    $repeatScaffoldExitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedErrorActionPreference
    Assert-True ($repeatScaffoldExitCode -ne 0) "scaffold refuses to overwrite an existing component"
    $candidateFilesAfterRepeat = @(Get-ChildItem -LiteralPath $candidateRoot -File -Recurse)
    Assert-Equal $candidateFilesAfterRepeat.Count $candidateHashes.Count "failed scaffold keeps the original file set"
    foreach ($candidateFile in $candidateFilesAfterRepeat) {
        $relativeCandidatePath = $candidateFile.FullName.Substring($candidateRoot.Length)
        Assert-Equal (Get-FileHash -LiteralPath $candidateFile.FullName -Algorithm SHA256).Hash $candidateHashes[$relativeCandidatePath] "failed scaffold keeps $relativeCandidatePath unchanged"
    }

    $candidateValidation = & $testComponentScript -ComponentRoot $candidateRoot -WorkspaceRoot $gate3Workspace | ConvertFrom-Json
    Assert-True ($candidateValidation.registrationReady -and -not $candidateValidation.activationReady -and $candidateValidation.safeStubPresent) "fresh scaffold is registration-ready but activation-blocked"
    $targetedTest = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $candidateRoot "tests\test-runtime-control.ps1") | ConvertFrom-Json
    Assert-True ($LASTEXITCODE -eq 0 -and $targetedTest.ok) "generated targeted controller test passes"

    $registryHashBeforePlan = (Get-FileHash -LiteralPath $gate3RegistryPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $registerPlan = & $registerComponentScript `
        -ComponentRoot $candidateRoot `
        -RegistryPath $gate3RegistryPath `
        -ReceiptRoot $gate3ReceiptRoot `
        -Plan | ConvertFrom-Json
    Assert-True ($registerPlan.safeToApply -and $registerPlan.entry.enabled -eq $false -and $registerPlan.entry.autoStart -eq $false) "registration plan proposes an inert registry entry"
    Assert-Equal (Get-FileHash -LiteralPath $gate3RegistryPath -Algorithm SHA256).Hash.ToLowerInvariant() $registryHashBeforePlan "registration plan performs zero writes"
    Assert-True (-not (Test-McpCcPathWithinRoot -Path $registerPlan.receiptRoot -Root $gate3Workspace)) "registration receipt root remains outside the source workspace"

    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $registerComponentScript `
        -ComponentRoot $candidateRoot `
        -RegistryPath $gate3RegistryPath `
        -ReceiptRoot $gate3ReceiptRoot `
        -ExpectedRegistrySha256 ("0" * 64) `
        -Apply 2>&1 | Out-Null
    $badHashExitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedErrorActionPreference
    Assert-True ($badHashExitCode -ne 0) "registration apply rejects a stale or forged registry hash"
    Assert-Equal (Get-FileHash -LiteralPath $gate3RegistryPath -Algorithm SHA256).Hash.ToLowerInvariant() $registryHashBeforePlan "rejected registration leaves registry bytes unchanged"

    $registerApply = & $registerComponentScript `
        -ComponentRoot $candidateRoot `
        -RegistryPath $gate3RegistryPath `
        -ReceiptRoot $gate3ReceiptRoot `
        -ExpectedRegistrySha256 $registerPlan.registrySha256 `
        -Apply | ConvertFrom-Json
    Assert-True ($registerApply.applied -and -not $registerApply.enabled -and -not $registerApply.autoStart -and -not $registerApply.startupChanged -and -not $registerApply.processStarted) "registration apply remains disabled and side-effect free"
    Assert-True (Test-Path -LiteralPath $registerApply.receiptPath -PathType Leaf) "registration apply writes a private receipt"
    $registeredGate3Manifest = Read-McpCcManifest -Path $gate3RegistryPath
    Assert-Equal @($registeredGate3Manifest.components).Count 1 "disabled registration is excluded from active components"
    Assert-Equal @($registeredGate3Manifest.registeredComponents).Count 2 "disabled registration remains visible to registry validation"

    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $duplicatePlanText = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $registerComponentScript `
        -ComponentRoot $candidateRoot `
        -RegistryPath $gate3RegistryPath `
        -ReceiptRoot $gate3ReceiptRoot `
        -Plan 2>$null
    $duplicatePlanExitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedErrorActionPreference
    $duplicatePlan = $duplicatePlanText | ConvertFrom-Json
    Assert-True ($duplicatePlanExitCode -ne 0 -and "duplicate_id" -in @($duplicatePlan.conflicts)) "registration plan rejects duplicate component ids"

    $portCollisionRoot = Join-Path $gate3Workspace "port_collision"
    & $newComponentScript `
        -Id "port_collision" `
        -DisplayName "Port Collision" `
        -CorePort 19102 `
        -WorkspaceRoot $gate3Workspace `
        -Apply | Out-Null
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $portPlanText = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $registerComponentScript `
        -ComponentRoot $portCollisionRoot `
        -RegistryPath $gate3RegistryPath `
        -ReceiptRoot $gate3ReceiptRoot `
        -Plan 2>$null
    $portPlanExitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedErrorActionPreference
    $portPlan = $portPlanText | ConvertFrom-Json
    Assert-True ($portPlanExitCode -ne 0 -and @($portPlan.conflicts | Where-Object { $_ -like "duplicate_owned_port:19102:*" }).Count -eq 1) "registration plan rejects duplicate owned ports"

    $rollbackPlan = & $registerComponentScript -RollbackReceipt $registerApply.receiptPath -Plan | ConvertFrom-Json
    $rollbackApply = & $registerComponentScript `
        -RollbackReceipt $registerApply.receiptPath `
        -ExpectedRegistrySha256 $rollbackPlan.currentRegistrySha256 `
        -Apply | ConvertFrom-Json
    Assert-True ($rollbackApply.applied -and $rollbackApply.componentRootKept -and -not $rollbackApply.processStarted) "registration rollback keeps component source and runtime stopped"
    Assert-Equal (Get-FileHash -LiteralPath $gate3RegistryPath -Algorithm SHA256).Hash.ToLowerInvariant() $registryHashBeforePlan "registration rollback restores exact registry bytes"
    Assert-True (Test-Path -LiteralPath $registerApply.receiptPath -PathType Leaf) "registration rollback preserves its audit receipt"
    $runtimeArtifacts = @(Get-ChildItem -LiteralPath $candidateRoot -File -Recurse | Where-Object { $_.Extension -in @(".pid", ".log", ".sqlite", ".db") })
    Assert-Equal $runtimeArtifacts.Count 0 "new component kit creates no runtime or domain-data artifacts"
}
finally {
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    if ($resolvedTestRoot.StartsWith($tempBase + '\', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTestRoot)) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}

$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $projectRoot "..")).Path
$inventoryScript = Join-Path $projectRoot "scripts\tunnel-runtime-inventory.ps1"
$inventoryPath = Join-Path $projectRoot "config\tunnel-runtime-inventory.json"
$inventoryHashBeforeSelfTest = (Get-FileHash -LiteralPath $inventoryPath -Algorithm SHA256).Hash
$inventorySelfTest = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $inventoryScript -Action SelfTest | ConvertFrom-Json
Assert-True ($LASTEXITCODE -eq 0 -and $inventorySelfTest.ok) "tunnel runtime inventory SelfTest passes"
Assert-Equal $inventorySelfTest.contractVersion "tunnel-runtime-inventory-v1" "inventory exposes a versioned contract"
Assert-Equal $inventorySelfTest.configuredComponentCount 7 "inventory covers seven production components"
Assert-True ($inventorySelfTest.executesVersionOnly -and -not $inventorySelfTest.mutatesRuntime -and -not $inventorySelfTest.updatesBinary) "inventory SelfTest declares bounded read-only behavior"
Assert-Equal (Get-FileHash -LiteralPath $inventoryPath -Algorithm SHA256).Hash $inventoryHashBeforeSelfTest "inventory SelfTest leaves configuration bytes unchanged"

$inventoryConfig = Get-Content -LiteralPath $inventoryPath -Encoding UTF8 -Raw | ConvertFrom-Json
Assert-Equal @($inventoryConfig.components).Count 7 "inventory configuration declares seven entries"
Assert-Equal @($inventoryConfig.components.id | Sort-Object -Unique).Count 7 "inventory component ids are unique"
Assert-True (@($inventoryConfig.components | Where-Object { [string]$_.override -ne "TunnelClientPath" }).Count -eq 0) "every component keeps the explicit TunnelClientPath override"
Assert-True (-not [IO.Path]::IsPathRooted([string]$inventoryConfig.sharedRuntime.path)) "shared runtime path remains workspace-relative"

$networkPolicySources = @(
    "project_reading\scripts\project-reading-runtime.psm1",
    "OMI_search\scripts\omi-search-runtime.psm1",
    "japanese_study\scripts\japanese-study-runtime.psm1",
    "Memory Core\scripts\memory_core_stack.ps1",
    "codex_bridge\scripts\codex-bridge-runtime.psm1",
    "personal-asset-os\scripts\personal-asset-os-runtime.psm1",
    "english_study\scripts\component-runtime.psm1"
)
foreach ($relativeSourcePath in $networkPolicySources) {
    $sourcePath = Join-Path $workspaceRoot $relativeSourcePath
    $sourceText = Get-Content -LiteralPath $sourcePath -Encoding UTF8 -Raw
    foreach ($proxyName in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy")) {
        Assert-True ($sourceText.Contains($proxyName)) "$relativeSourcePath declares $proxyName child-process handling"
    }
    Assert-True ($sourceText.Contains("127.0.0.1,localhost")) "$relativeSourcePath declares the loopback bypass"
    Assert-True ($sourceText -match '(?s)finally\s*\{.*SetEnvironmentVariable') "$relativeSourcePath restores parent environment in finally"
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
