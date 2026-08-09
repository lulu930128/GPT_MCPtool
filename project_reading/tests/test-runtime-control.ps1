Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$implementationTest = Join-Path (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\scripts")) "test-runtime-control.ps1"
if (-not (Test-Path -LiteralPath $implementationTest -PathType Leaf)) {
  throw "Project Reading lifecycle implementation test is missing."
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $implementationTest
exit $LASTEXITCODE
