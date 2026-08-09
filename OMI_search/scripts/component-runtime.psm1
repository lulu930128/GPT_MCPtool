Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$implementationPath = Join-Path $PSScriptRoot "omi-search-runtime.psm1"
if (-not (Test-Path -LiteralPath $implementationPath -PathType Leaf)) {
  throw "OMI Search runtime implementation is missing."
}
Import-Module $implementationPath -Force
Export-ModuleMember -Function @(
  "New-OmiSearchRuntimeContext",
  "Get-OmiSearchRuntimeStatus",
  "Invoke-OmiSearchLifecycleAction",
  "Write-OmiSearchLifecycleEvent"
)
