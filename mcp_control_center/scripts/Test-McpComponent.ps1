param(
    [Parameter(Mandatory = $true)][string]$ComponentRoot,
    [string]$WorkspaceRoot
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$managerRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$modulePath = Join-Path $managerRoot "src\McpControlCenter.Core.psm1"
Import-Module $modulePath -Force
if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) { $WorkspaceRoot = Split-Path -Parent $managerRoot }
$resolvedWorkspace = (Resolve-Path -LiteralPath $WorkspaceRoot -ErrorAction Stop).Path
$component = Read-McpCcComponentCandidate -ComponentRoot $ComponentRoot -WorkspaceRoot $resolvedWorkspace

$requiredFiles = @(
    [pscustomobject]@{ id = "descriptor"; path = $component.descriptorPath },
    [pscustomobject]@{ id = "contract"; path = $component.resolvedContractScript }
)
if ($component.runtimeMode -eq "component-controller") {
    $requiredFiles += @(
        [pscustomobject]@{ id = "runtime_module"; path = (Join-Path $component.resolvedRoot "scripts\component-runtime.psm1") },
        [pscustomobject]@{ id = "targeted_test"; path = (Join-Path $component.resolvedRoot "tests\test-runtime-control.ps1") },
        [pscustomobject]@{ id = "integration_doc"; path = (Join-Path $component.resolvedRoot "docs\ControlCenterIntegration.md") }
    )
}
$fileChecks = @($requiredFiles | ForEach-Object {
    [pscustomobject]@{ id = $_.id; path = $_.path; exists = Test-Path -LiteralPath $_.path -PathType Leaf }
})
$unresolvedTokens = @()
foreach ($file in @($fileChecks | Where-Object exists)) {
    $extension = [IO.Path]::GetExtension([string]$file.path)
    if ($extension -in @(".json", ".ps1", ".psm1", ".vbs", ".md")) {
        $text = [IO.File]::ReadAllText([string]$file.path, [Text.Encoding]::UTF8)
        if ($text -match '__[A-Z0-9_]+__') { $unresolvedTokens += [string]$file.path }
    }
}
$contract = Test-McpCcComponentContract -Component $component
$traits = @($component.traits | ForEach-Object { [string]$_ })
$traitRequirements = @()
foreach ($trait in $traits) {
    $requirement = switch ($trait) {
        "tunnel" { "Prove bounded connectivity repair and tunnel ownership before activation." }
        "external-dependency" { "Prove the controller never starts or stops the external dependency." }
        "multi-core" { "Prove ordered start/stop and partial-start recovery for every owned core." }
        "data-sensitive" { "Use isolated test data and a read-only formal-data baseline for live migration." }
        "credential-sensitive" { "Prove credential redaction across SelfTest, stdout, state and events." }
        "approval-sensitive" { "Prove reload/restart cannot submit or approve work." }
        "primary-ui" { "Keep the primary UI component-owned and validate only its launcher or loopback target." }
        "diagnostic-ui" { "Keep the diagnostic UI on demand and independent from runtime ownership." }
    }
    if (-not [string]::IsNullOrWhiteSpace($requirement)) {
        $traitRequirements += [pscustomobject]@{ trait = $trait; requirement = $requirement }
    }
}
$runtimeModulePath = Join-Path $component.resolvedRoot "scripts\component-runtime.psm1"
$safeStubPresent = $false
if (Test-Path -LiteralPath $runtimeModulePath -PathType Leaf) {
    $safeStubPresent = [IO.File]::ReadAllText($runtimeModulePath, [Text.Encoding]::UTF8).Contains('errorCode = "not_implemented"')
}
$ok = (
    @($fileChecks | Where-Object { -not $_.exists }).Count -eq 0 -and
    $unresolvedTokens.Count -eq 0 -and
    [bool]$contract.ok
)
[pscustomobject]@{
    ok = $ok
    componentId = [string]$component.id
    displayName = [string]$component.displayName
    runtimeMode = [string]$component.runtimeMode
    descriptorPath = [string]$component.descriptorPath
    capabilities = @($component.capabilities)
    traits = $traits
    files = $fileChecks
    unresolvedTemplateTokens = $unresolvedTokens
    contract = $contract
    registrationReady = $ok
    activationReady = ($ok -and -not $safeStubPresent)
    safeStubPresent = $safeStubPresent
    traitRequirements = $traitRequirements
    sideEffects = @("none")
} | ConvertTo-Json -Depth 10
exit $(if ($ok) { 0 } else { 1 })
