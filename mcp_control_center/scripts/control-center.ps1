param(
    [ValidateSet("SelfTest", "Status", "Reconcile", "Start", "Restart", "RepairConnectivity", "RestartCore", "ShutdownRuntime", "ShowDiagnosticTray", "ComponentMenuAction", "Doctor")]
    [string]$Action = "Status",
    [string]$Component,
    [ValidatePattern('^[a-z][a-z0-9_]{0,63}$')]
    [string]$UiAction,
    [string]$ManifestPath,
    [string]$RuntimeRoot,
    [switch]$PlanOnly,
    [switch]$NoInitialDelay
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$modulePath = Join-Path $projectRoot "src\McpControlCenter.Core.psm1"
Import-Module $modulePath -Force

if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $ManifestPath = Get-McpCcDefaultManifestPath
}
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
    $RuntimeRoot = Get-McpCcDefaultRuntimeRoot
}

function Wait-ForComponentState {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)]$ComponentDefinition,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
        [string[]]$AcceptedStates = @("Ready")
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $last = $null
    do {
        $last = Get-McpCcComponentStatus -Component $ComponentDefinition -TimeoutSeconds ([int]$Manifest.settings.probeTimeoutSeconds)
        if ($last.status -in $AcceptedStates) { return $last }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    return $last
}

function Wait-ForComponentRunningState {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)]$ComponentDefinition,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )
    $acceptedStates = @(Get-McpCcRunningAcceptanceStates -Component $ComponentDefinition)
    return Wait-ForComponentState `
        -Manifest $Manifest `
        -ComponentDefinition $ComponentDefinition `
        -TimeoutSeconds $TimeoutSeconds `
        -AcceptedStates $acceptedStates
}

function Invoke-StatusAndPublish {
    param([Parameter(Mandatory = $true)]$Manifest, [Parameter(Mandatory = $true)][string]$BootId)
    $state = Get-McpCcSystemState -Manifest $Manifest -BootId $BootId
    Publish-McpCcState -RuntimeRoot $RuntimeRoot -State $state -RetentionDays ([int]$Manifest.settings.eventRetentionDays) | Out-Null
    return $state
}

$bootId = $null
try {
    $manifest = Read-McpCcManifest -Path $ManifestPath
    if (Test-McpCcPathWithinRoot -Path $RuntimeRoot -Root $manifest.workspaceRoot) {
        throw "RuntimeRoot must be outside the source workspace."
    }
    $bootId = Get-McpCcBootId

    switch ($Action) {
        "SelfTest" {
            $result = Test-McpCcManifest -Manifest $manifest
            $result | ConvertTo-Json -Depth 10
            if (-not $result.ok) { exit 1 }
        }
        "Status" {
            Invoke-StatusAndPublish -Manifest $manifest -BootId $bootId | ConvertTo-Json -Depth 12
        }
        "Doctor" {
            $selfTest = Test-McpCcManifest -Manifest $manifest
            $startup = Get-McpCcStartupAudit -Manifest $manifest
            $state = Invoke-StatusAndPublish -Manifest $manifest -BootId $bootId
            $controllerAudit = Get-McpCcControllerAudit -Manifest $manifest -RuntimeRoot $RuntimeRoot
            $doctor = [pscustomobject]@{
                schemaVersion = [int]$manifest.schemaVersion
                generatedAt = [DateTime]::UtcNow.ToString("o")
                bootId = $bootId
                ok = ($selfTest.ok -and $startup.conflictCount -eq 0 -and $state.overall -eq "Ready" -and $controllerAudit.unmanageableCount -eq 0)
                selfTest = $selfTest
                startup = $startup
                state = $state
                controllerAudit = $controllerAudit
            }
            $diagnosticsPath = Join-Path $RuntimeRoot "diagnostics\latest.json"
            Write-McpCcJsonAtomic -Path $diagnosticsPath -Document $doctor
            Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "doctor_completed" -Details @{
                ok = $doctor.ok
                overall = $state.overall
                startupConflicts = $startup.conflictCount
                unmanageableControllers = $controllerAudit.unmanageableCount
            }
            $doctor | ConvertTo-Json -Depth 12
            if (-not $doctor.ok) { exit 2 }
        }
        "Start" {
            if ([string]::IsNullOrWhiteSpace($Component)) { throw "Start requires -Component." }
            Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "action_requested" -Component $Component -Details @{ action = "ensure_running" }
            $delegation = Invoke-McpCcComponentAction -Manifest $manifest -ComponentId $Component -Action ensure_running -PlanOnly:$PlanOnly -RuntimeRoot $RuntimeRoot
            if ($PlanOnly) {
                $delegation | ConvertTo-Json -Depth 6
                break
            }
            Start-Sleep -Seconds 2
            $definition = Get-McpCcComponent -Manifest $manifest -Id $Component
            $acceptedStates = @(Get-McpCcRunningAcceptanceStates -Component $definition)
            $postStatus = Wait-ForComponentRunningState -Manifest $manifest -ComponentDefinition $definition -TimeoutSeconds (Get-McpCcComponentTimingSeconds -Manifest $manifest -Component $definition -Name "postStartTimeoutSeconds")
            $state = Invoke-StatusAndPublish -Manifest $manifest -BootId $bootId
            Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "action_completed" -Component $Component -Details @{
                action = "ensure_running"
                result = $postStatus.status
            }
            [pscustomobject]@{ delegation = $delegation; postStatus = $postStatus; state = $state } | ConvertTo-Json -Depth 12
            if ($postStatus.status -notin $acceptedStates) { exit 2 }
        }
        "Restart" {
            if ([string]::IsNullOrWhiteSpace($Component)) { throw "Restart requires -Component." }
            Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "action_requested" -Component $Component -Details @{ action = "reload_runtime" }
            $delegation = Invoke-McpCcComponentAction -Manifest $manifest -ComponentId $Component -Action reload_runtime -PlanOnly:$PlanOnly -RuntimeRoot $RuntimeRoot
            if ($PlanOnly) {
                $delegation | ConvertTo-Json -Depth 6
                break
            }
            Start-Sleep -Seconds 3
            $definition = Get-McpCcComponent -Manifest $manifest -Id $Component
            $acceptedStates = @(Get-McpCcRunningAcceptanceStates -Component $definition)
            $postStatus = Wait-ForComponentRunningState -Manifest $manifest -ComponentDefinition $definition -TimeoutSeconds (Get-McpCcComponentTimingSeconds -Manifest $manifest -Component $definition -Name "postStartTimeoutSeconds")
            $state = Invoke-StatusAndPublish -Manifest $manifest -BootId $bootId
            Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "action_completed" -Component $Component -Details @{
                action = "reload_runtime"
                result = $postStatus.status
            }
            [pscustomobject]@{ delegation = $delegation; postStatus = $postStatus; state = $state } | ConvertTo-Json -Depth 12
            if ($postStatus.status -notin $acceptedStates) { exit 2 }
        }
        "RestartCore" {
            if ([string]::IsNullOrWhiteSpace($Component)) { throw "RestartCore requires -Component." }
            Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "action_requested" -Component $Component -Details @{ action = "restart_core" }
            $delegation = Invoke-McpCcComponentAction -Manifest $manifest -ComponentId $Component -Action restart_core -PlanOnly:$PlanOnly -RuntimeRoot $RuntimeRoot
            if ($PlanOnly) {
                $delegation | ConvertTo-Json -Depth 6
                break
            }
            Start-Sleep -Seconds 2
            $definition = Get-McpCcComponent -Manifest $manifest -Id $Component
            $acceptedStates = @(Get-McpCcRunningAcceptanceStates -Component $definition)
            $postStatus = Wait-ForComponentRunningState -Manifest $manifest -ComponentDefinition $definition -TimeoutSeconds (Get-McpCcComponentTimingSeconds -Manifest $manifest -Component $definition -Name "postStartTimeoutSeconds")
            $state = Invoke-StatusAndPublish -Manifest $manifest -BootId $bootId
            Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "action_completed" -Component $Component -Details @{
                action = "restart_core"
                result = $postStatus.status
            }
            [pscustomobject]@{ delegation = $delegation; postStatus = $postStatus; state = $state } | ConvertTo-Json -Depth 12
            if ($postStatus.status -notin $acceptedStates) { exit 2 }
        }
        "RepairConnectivity" {
            if ([string]::IsNullOrWhiteSpace($Component)) { throw "RepairConnectivity requires -Component." }
            Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "action_requested" -Component $Component -Details @{ action = "repair_connectivity" }
            $delegation = Invoke-McpCcComponentAction -Manifest $manifest -ComponentId $Component -Action repair_connectivity -PlanOnly:$PlanOnly -RuntimeRoot $RuntimeRoot
            if ($PlanOnly) {
                $delegation | ConvertTo-Json -Depth 6
                break
            }
            Start-Sleep -Seconds 2
            $definition = Get-McpCcComponent -Manifest $manifest -Id $Component
            $acceptedStates = @(Get-McpCcRunningAcceptanceStates -Component $definition)
            $postStatus = Wait-ForComponentRunningState -Manifest $manifest -ComponentDefinition $definition -TimeoutSeconds (Get-McpCcComponentTimingSeconds -Manifest $manifest -Component $definition -Name "postStartTimeoutSeconds")
            $state = Invoke-StatusAndPublish -Manifest $manifest -BootId $bootId
            Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "action_completed" -Component $Component -Details @{
                action = "repair_connectivity"
                result = $postStatus.status
            }
            [pscustomobject]@{ delegation = $delegation; postStatus = $postStatus; state = $state } | ConvertTo-Json -Depth 12
            if ($postStatus.status -notin $acceptedStates) { exit 2 }
        }
        "ShutdownRuntime" {
            if ([string]::IsNullOrWhiteSpace($Component)) { throw "ShutdownRuntime requires -Component." }
            Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "action_requested" -Component $Component -Details @{ action = "shutdown_runtime" }
            $delegation = Invoke-McpCcComponentAction -Manifest $manifest -ComponentId $Component -Action shutdown_runtime -PlanOnly:$PlanOnly -RuntimeRoot $RuntimeRoot
            if ($PlanOnly) {
                $delegation | ConvertTo-Json -Depth 6
                break
            }
            Start-Sleep -Seconds 1
            $definition = Get-McpCcComponent -Manifest $manifest -Id $Component
            $postStatus = Wait-ForComponentState -Manifest $manifest -ComponentDefinition $definition -TimeoutSeconds (Get-McpCcComponentTimingSeconds -Manifest $manifest -Component $definition -Name "postStartTimeoutSeconds") -AcceptedStates @("Stopped")
            $state = Invoke-StatusAndPublish -Manifest $manifest -BootId $bootId
            Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "action_completed" -Component $Component -Details @{
                action = "shutdown_runtime"
                result = $postStatus.status
            }
            [pscustomobject]@{ delegation = $delegation; postStatus = $postStatus; state = $state } | ConvertTo-Json -Depth 12
            if ($postStatus.status -ne "Stopped") { exit 2 }
        }
        "ShowDiagnosticTray" {
            if ([string]::IsNullOrWhiteSpace($Component)) { throw "ShowDiagnosticTray requires -Component." }
            Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "action_requested" -Component $Component -Details @{ action = "show_diagnostic_tray" }
            $delegation = Invoke-McpCcComponentAction -Manifest $manifest -ComponentId $Component -Action show_diagnostic_tray -PlanOnly:$PlanOnly -RuntimeRoot $RuntimeRoot
            if (-not $PlanOnly) {
                Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "action_completed" -Component $Component -Details @{ action = "show_diagnostic_tray"; result = "delegated" }
            }
            $delegation | ConvertTo-Json -Depth 6
        }
        "ComponentMenuAction" {
            if ([string]::IsNullOrWhiteSpace($Component)) { throw "ComponentMenuAction requires -Component." }
            if ([string]::IsNullOrWhiteSpace($UiAction)) { throw "ComponentMenuAction requires -UiAction." }
            Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "ui_action_requested" -Component $Component -Details @{ action = $UiAction }
            $delegation = Invoke-McpCcComponentUiAction `
                -Manifest $manifest `
                -ComponentId $Component `
                -ActionId $UiAction `
                -PlanOnly:$PlanOnly `
                -RuntimeRoot $RuntimeRoot
            if (-not $PlanOnly) {
                Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "ui_action_completed" -Component $Component -Details @{ action = $UiAction; result = "delegated" }
            }
            $delegation | ConvertTo-Json -Depth 8
        }
        "Reconcile" {
            if (-not $NoInitialDelay -and -not $PlanOnly) {
                Start-Sleep -Seconds ([int]$manifest.settings.initialDelaySeconds)
            }
            $initial = Get-McpCcSystemState -Manifest $manifest -BootId $bootId
            $plan = Get-McpCcReconcilePlan -Manifest $manifest -State $initial
            if ($PlanOnly) {
                [pscustomobject]@{ schemaVersion = [int]$manifest.schemaVersion; planOnly = $true; initialState = $initial; plan = $plan } | ConvertTo-Json -Depth 12
                break
            }

            Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "reconcile_started" -Details @{
                initialOverall = $initial.overall
                componentCount = @($manifest.components).Count
            }
            $actions = @()
            foreach ($item in @($plan)) {
                $definition = Get-McpCcComponent -Manifest $manifest -Id $item.component
                $current = Get-McpCcComponentStatus -Component $definition -TimeoutSeconds ([int]$manifest.settings.probeTimeoutSeconds)
                if ($current.status -eq "BlockedUpstream") {
                    $current = Wait-ForComponentState -Manifest $manifest -ComponentDefinition $definition -TimeoutSeconds (Get-McpCcComponentTimingSeconds -Manifest $manifest -Component $definition -Name "postStartTimeoutSeconds") -AcceptedStates @("Ready", "Stopped")
                }
                if ($current.status -eq "Stopped") {
                    $delegation = Invoke-McpCcComponentAction -Manifest $manifest -ComponentId $definition.id -Action ensure_running -RuntimeRoot $RuntimeRoot
                    Start-Sleep -Seconds 2
                    $post = Wait-ForComponentRunningState -Manifest $manifest -ComponentDefinition $definition -TimeoutSeconds (Get-McpCcComponentTimingSeconds -Manifest $manifest -Component $definition -Name "postStartTimeoutSeconds")
                    $actions += [pscustomobject]@{ component = $definition.id; action = "Start"; before = $current.status; after = $post.status; delegation = $delegation }
                    Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "reconcile_component" -Component $definition.id -Details @{ decision = "Start"; before = $current.status; after = $post.status }
                }
                elseif ($current.status -eq "Ready") {
                    $actions += [pscustomobject]@{ component = $definition.id; action = "NoAction"; before = $current.status; after = $current.status }
                }
                else {
                    $actions += [pscustomobject]@{ component = $definition.id; action = "ManualAttention"; before = $current.status; after = $current.status }
                    Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "manual_attention_required" -Component $definition.id -Details @{ status = $current.status; issues = $current.issues }
                }
                if ([int]$manifest.settings.betweenComponentsSeconds -gt 0) {
                    Start-Sleep -Seconds ([int]$manifest.settings.betweenComponentsSeconds)
                }
            }
            $final = Invoke-StatusAndPublish -Manifest $manifest -BootId $bootId
            Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $bootId -Type "reconcile_completed" -Details @{ finalOverall = $final.overall }
            [pscustomobject]@{ schemaVersion = [int]$manifest.schemaVersion; planOnly = $false; initialState = $initial; actions = $actions; finalState = $final } | ConvertTo-Json -Depth 12
            if ($final.overall -ne "Ready") { exit 2 }
        }
    }
}
catch {
    $message = ([string]$_.Exception.Message -replace '[\r\n]+', ' ').Trim()
    try {
        if (-not [string]::IsNullOrWhiteSpace($RuntimeRoot)) {
            Write-McpCcEvent -RuntimeRoot $RuntimeRoot -BootId $(if ($null -ne $bootId) { $bootId } else { Get-McpCcBootId }) -Type "controller_error" -Component $Component -Details @{ action = $Action; uiAction = $UiAction; error = $message }
        }
    }
    catch { }
    [pscustomobject]@{ ok = $false; action = $Action; component = $Component; uiAction = $UiAction; error = $message } | ConvertTo-Json -Depth 5
    exit 1
}
