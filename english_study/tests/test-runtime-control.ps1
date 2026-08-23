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
if ($runtimeModuleSource -notmatch 'Repair-EnglishStudyConnectivity' -or $runtimeModuleSource -notmatch 'TUNNEL_KEY_MISSING') {
    throw "Runtime must own bounded tunnel repair and fail closed when the DPAPI key is unavailable."
}
if ($runtimeModuleSource -notmatch 'Stop-EnglishStudyRole -Context \$Context -Role tunnel' -or $runtimeModuleSource -notmatch 'CONTROL_PLANE_API_KEY') {
    throw "Runtime must stop the exact tunnel role and inject its credential only into the child environment."
}
$tunnelScriptPath = Join-Path $componentRoot "scripts\tunnel.ps1"
$keyStorePath = Join-Path $componentRoot "scripts\key-store.ps1"
if (-not (Test-Path -LiteralPath $tunnelScriptPath -PathType Leaf) -or -not (Test-Path -LiteralPath $keyStorePath -PathType Leaf)) {
    throw "Component-owned tunnel and key-store scripts are missing."
}
$text = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $controllerPath -Action SelfTest
if ($LASTEXITCODE -ne 0) { throw "Controller SelfTest exited with $LASTEXITCODE." }
$document = $text | ConvertFrom-Json
$expectedCapabilities = @(
    "ensure_running"
    "repair_connectivity"
    "restart_core"
    "reload_runtime"
    "shutdown_runtime"
    "show_diagnostic_tray"
)
if ([string]$document.runtimeContract -ne "unified-lifecycle-v3") { throw "Unexpected runtime contract." }
if ((@($document.capabilities) -join ',') -ne ($expectedCapabilities -join ',')) { throw "Capability mismatch." }
if (-not [bool]$document.autoStartTunnel -or [bool]$document.credentialValuesExposed) { throw "Tunnel self-test safety contract mismatch." }
[pscustomobject]@{
    ok = $true
    component = "english_study"
    capabilities = @($document.capabilities)
    exactOwnershipEnforced = [bool]$document.exactOwnershipEnforced
} | ConvertTo-Json -Depth 5
