Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$script:Passed = 0
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
    $script:Passed++
}

# Execute the production ItemExecutor and audit/gate bodies with IO replaced.
# No module bootstrap, controller process, runtime file, listener or sleep is used.
$tokens = $null
$parseErrors = $null
$coreAst = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $projectRoot 'src\McpControlCenter.Core.psm1'), [ref]$tokens, [ref]$parseErrors)
Assert-True ($parseErrors.Count -eq 0) 'core source parses'
foreach ($name in @(
    'Get-McpCcObjectProperty', 'Get-McpCcComponent', 'Get-McpCcRuntimeMode',
    'Get-McpCcComponentTimingSeconds', 'Assert-McpCcSafeRuntimeRoot',
    'Get-McpCcControllerAudit', 'Get-McpCcControllerMutationGate',
    'Get-McpCcRunningAcceptanceStates', 'Invoke-McpCcReconcileItems',
    'Get-McpCcActionErrorCode', 'Get-McpCcSafeActionMessage'
)) {
    $functionAst = $coreAst.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
    }, $true)
    Assert-True ($null -ne $functionAst) "production function exists: $name"
    . ([scriptblock]::Create($functionAst.Extent.Text))
}
$controllerAst = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $projectRoot 'scripts\control-center.ps1'), [ref]$tokens, [ref]$parseErrors)
Assert-True ($parseErrors.Count -eq 0) 'controller source parses'
$reconcileCalls = @($controllerAst.FindAll({ param($node)
    $node -is [Management.Automation.Language.CommandAst] -and
    $node.GetCommandName() -ceq 'Invoke-McpCcReconcileItems'
}, $true))
Assert-True ($reconcileCalls.Count -eq 1) 'one canonical reconciliation executor exists'
$elements = $reconcileCalls[0].CommandElements
$executor = $null
for ($index = 0; $index -lt $elements.Count - 1; $index++) {
    if ($elements[$index] -is [Management.Automation.Language.CommandParameterAst] -and
        $elements[$index].ParameterName -ceq 'ItemExecutor') {
        $executor = $elements[$index + 1].ScriptBlock.GetScriptBlock()
    }
}
Assert-True ($null -ne $executor) 'production ItemExecutor is selected'

function Get-McpCcComponentStatus {
    param($Component, $TimeoutSeconds)
    return [pscustomobject]@{ status = $script:MonitorStatus }
}
function Assert-McpCcInstalledActivation {
    param($Manifest)
    $script:ActivationCalls++
    Assert-True ($Manifest.schemaVersion -eq 4) 'installed gate retains schema identity'
    Assert-True ([object]::ReferenceEquals($Manifest.installedRelease, $script:Release)) 'installed release context is preserved'
    Assert-True ($Manifest.registryEntries.Count -eq 2) 'installed registry context is preserved'
    Assert-True ($Manifest.components.Count -eq 1) 'installed audit is scoped to one component'
    if ($script:DenyActivation) { throw 'INSTALLED_STARTUP_NOT_SELECTED' }
}
function Invoke-McpCcBoundedPowerShell {
    param($ScriptPath, $Arguments, $WorkingDirectory, $RuntimeRoot, $TimeoutSeconds, $MaxCapturedOutputBytes)
    Assert-True (($Arguments -join ',') -ceq '-Action,Status') 'audit only requests controller Status'
    $script:AuditCalls.Add($ScriptPath)
    if ($script:ControllerStatus -eq 'ControllerError') { throw 'fixture status failure' }
    $document = [pscustomobject]@{
        ok = $true; action = 'Status'; after = [pscustomobject]@{ status = $script:ControllerStatus }
        elapsedMs = 0; errorCode = $null; message = 'Fixture status.'
    }
    return [pscustomobject]@{ exitCode = 0; stdout = ($document | ConvertTo-Json -Depth 4 -Compress) }
}
function Get-McpCcAutomaticRepairDecision {
    param($Manifest, $Component, $ComponentStatus)
    return [pscustomobject]@{ allowed = $false }
}
function Invoke-McpCcComponentAction {
    param($Manifest, $ComponentId, $Action, $RuntimeRoot)
    Assert-True ($Action -ceq 'ensure_running') 'stopped component only delegates EnsureRunning'
    Assert-True ($Manifest.components.Count -eq 2) 'delegation retains the full original manifest'
    $script:Actions.Add($ComponentId)
    return [pscustomobject]@{ delegated = $true }
}
function Wait-ForComponentRunningState {
    param($Manifest, $ComponentDefinition, $TimeoutSeconds)
    return [pscustomobject]@{ status = 'Ready' }
}
function Write-McpCcEvent { param($RuntimeRoot, $BootId, $Type, $Component, $Details) }
function Start-Sleep { param($Seconds) }

$RuntimeRoot = Join-Path ([IO.Path]::GetTempPath()) 'mcp-cc-reconcile-context-no-io'
$bootId = 'fixture-boot'
$script:Release = [pscustomobject]@{ schemaVersion = 3; releaseId = 'fixture-release' }
foreach ($schemaVersion in @(2, 3, 4)) {
    foreach ($case in @('Stopped', 'Ready', 'OwnershipUnknown', 'OwnershipMismatch', 'ControllerError', 'ActivationDenied')) {
        if ($case -eq 'ActivationDenied' -and $schemaVersion -ne 4) { continue }
        $script:MonitorStatus = if ($case -eq 'Ready') { 'Ready' } else { 'Stopped' }
        $script:ControllerStatus = if ($case -in @('Stopped', 'Ready', 'ActivationDenied')) { 'Stopped' } else { $case }
        $script:DenyActivation = $case -eq 'ActivationDenied'
        $script:ActivationCalls = 0
        $script:AuditCalls = New-Object 'Collections.Generic.List[string]'
        $script:Actions = New-Object 'Collections.Generic.List[string]'
        $definitions = @(foreach ($id in @('fixture_a', 'fixture_b')) {
            [pscustomobject]@{
                id = $id; runtimeMode = 'component-controller'; startupOrder = 1
                resolvedRoot = $projectRoot; resolvedContractScript = $id; probes = @()
            }
        })
        $manifest = [pscustomobject]@{
            schemaVersion = $schemaVersion; components = $definitions; registryEntries = $definitions
            settings = [pscustomobject]@{
                probeTimeoutSeconds = 1; controllerActionTimeoutSeconds = 1
                postStartTimeoutSeconds = 1; betweenComponentsSeconds = 0
            }
        }
        if ($schemaVersion -eq 4) {
            $manifest | Add-Member -NotePropertyName installedRelease -NotePropertyValue $script:Release
        }
        $plan = @($definitions | ForEach-Object {
            [pscustomobject]@{ component = $_.id; currentStatus = 'Stopped' }
        })
        $results = @(Invoke-McpCcReconcileItems -Plan $plan -ItemExecutor $executor)
        $label = "schema $schemaVersion / $case"
        Assert-True ($results.Count -eq 2) "$label returns both component results"
        Assert-True (($manifest.components.id -join ',') -ceq 'fixture_a,fixture_b') "$label preserves original component scope"
        if ($case -eq 'Stopped') {
            Assert-True (@($results | Where-Object { $_.ok -and $_.action -eq 'Start' -and $_.after -eq 'Ready' }).Count -eq 2) "$label reaches Start instead of failing before audit"
            Assert-True (($script:Actions -join ',') -ceq 'fixture_a,fixture_b') "$label delegates each component once"
        } elseif ($case -eq 'Ready') {
            Assert-True (@($results | Where-Object { $_.action -eq 'NoAction' }).Count -eq 2) "$label preserves ready runtimes"
        } elseif ($case -eq 'ActivationDenied') {
            Assert-True (@($results | Where-Object { -not $_.ok }).Count -eq 2) "$label fails closed"
        } else {
            $expectedCode = if ($case -eq 'OwnershipUnknown') { 'OWNERSHIP_UNKNOWN' } elseif ($case -eq 'OwnershipMismatch') { 'OWNERSHIP_MISMATCH' } else { 'CONTROLLER_STATUS_FAILED' }
            Assert-True (@($results | Where-Object { $_.action -eq 'ManualAttention' -and $_.reasonCode -eq $expectedCode }).Count -eq 2) "$label preserves the ownership gate"
        }
        if ($case -ne 'Stopped') { Assert-True ($script:Actions.Count -eq 0) "$label makes no lifecycle mutation" }
        if ($case -in @('Ready', 'ActivationDenied')) {
            Assert-True ($script:AuditCalls.Count -eq 0) "$label does not invoke a controller"
        } else {
            Assert-True (($script:AuditCalls -join ',') -ceq 'fixture_a,fixture_b') "$label audits only the selected component once"
        }
        $expectedActivations = if ($schemaVersion -eq 4 -and $case -ne 'Ready') { 2 } else { 0 }
        Assert-True ($script:ActivationCalls -eq $expectedActivations) "$label preserves installed activation checks"
    }
}
[pscustomobject]@{ ok = $true; assertions = $script:Passed; canonicalExecutor = $true; controller = 'MOCK'; liveMutation = $false } | ConvertTo-Json -Compress
