Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$componentRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$controllerPath = Join-Path $componentRoot "scripts\runtime-control.ps1"
$integrationPath = Join-Path $componentRoot "docs\ControlCenterIntegration.md"
if (-not (Test-Path -LiteralPath $controllerPath -PathType Leaf)) { throw "Controller entrypoint is missing." }
if (-not (Test-Path -LiteralPath $integrationPath -PathType Leaf)) { throw "Control Center integration contract is missing." }
$integration = Get-Content -LiteralPath $integrationPath -Raw -Encoding UTF8
foreach ($required in @("LifecycleOwnershipPolicy.md", "process start time", "unrelated PID reuse", "foreign listener", "cleanup races", "unrelated processes remain alive")) {
    if ($integration.IndexOf($required, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw "Ownership conformance requirement is missing: $required" }
}
$text = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $controllerPath -Action SelfTest
if ($LASTEXITCODE -ne 0) { throw "Controller SelfTest exited with $LASTEXITCODE." }
$document = $text | ConvertFrom-Json
$expectedCapabilities = @(
    "ensure_running"
    "reload_runtime"
    "shutdown_runtime"
    # __OPTIONAL_DIAGNOSTIC_CAPABILITY_PS__
)
if ([string]$document.runtimeContract -ne "unified-lifecycle-v3") { throw "Unexpected runtime contract." }
if ((@($document.capabilities) -join ',') -ne ($expectedCapabilities -join ',')) { throw "Capability mismatch." }
[pscustomobject]@{
    ok = $true
    component = "__COMPONENT_ID__"
    capabilities = @($document.capabilities)
} | ConvertTo-Json -Depth 5
