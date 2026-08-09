Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$implementationPath = Join-Path $PSScriptRoot "project-reading-runtime.psm1"
if (-not (Test-Path -LiteralPath $implementationPath -PathType Leaf)) {
  throw "Project Reading runtime implementation is missing."
}

# Keep the generic Control Center facade stable while Project Reading retains
# its component-specific lifecycle implementation and exact ownership rules.
Import-Module $implementationPath -Force
Export-ModuleMember -Function @(
  "New-PrRuntimeContext",
  "Get-PrRuntimeStatus",
  "Invoke-PrLifecycleAction",
  "Write-PrLifecycleEvent"
)
