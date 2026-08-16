Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$componentRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$controllerPath = Join-Path $componentRoot "scripts\runtime-control.ps1"
$runtimeModulePath = Join-Path $componentRoot "scripts\component-runtime.psm1"
if (-not (Test-Path -LiteralPath $controllerPath -PathType Leaf)) { throw "Controller entrypoint is missing." }
if (-not (Test-Path -LiteralPath $runtimeModulePath -PathType Leaf)) { throw "Runtime module is missing." }
$runtimeModuleSource = Get-Content -LiteralPath $runtimeModulePath -Raw -Encoding UTF8
if ($runtimeModuleSource -notmatch 'ArgumentList\s+@\("-m",\s*"english_study_hub",\s*"serve"') {
    throw "Hub lifecycle must invoke the package entrypoint that dispatches the CLI."
}
if ($runtimeModuleSource -match 'english_study_hub\.cli') {
    throw "Hub lifecycle must not invoke the non-dispatching cli module directly."
}
if ($runtimeModuleSource -notmatch 'Get-EnglishStudyLineage' -or $runtimeModuleSource -notmatch 'Get-EnglishStudyOwnedDescendants') {
    throw "Runtime ownership must validate and stop an exact Windows process lineage."
}
$text = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $controllerPath -Action SelfTest
if ($LASTEXITCODE -ne 0) { throw "Controller SelfTest exited with $LASTEXITCODE." }
$document = $text | ConvertFrom-Json
$expectedCapabilities = @(
    "ensure_running"
    "restart_core"
    "reload_runtime"
    "shutdown_runtime"
    "show_diagnostic_tray"
)
if ([string]$document.runtimeContract -ne "unified-lifecycle-v3") { throw "Unexpected runtime contract." }
if ((@($document.capabilities) -join ',') -ne ($expectedCapabilities -join ',')) { throw "Capability mismatch." }
[pscustomobject]@{
    ok = $true
    component = "english_study"
    capabilities = @($document.capabilities)
    exactOwnershipEnforced = [bool]$document.exactOwnershipEnforced
} | ConvertTo-Json -Depth 5
