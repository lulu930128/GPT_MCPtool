Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$implementationPath=Join-Path $PSScriptRoot 'codex-bridge-runtime.psm1'
if(-not(Test-Path -LiteralPath $implementationPath -PathType Leaf)){throw 'Codex Bridge runtime implementation is missing.'}
Import-Module $implementationPath -Force
Export-ModuleMember -Function @('New-CodexBridgeRuntimeContext','Get-CodexBridgeRuntimeStatus','Invoke-CodexBridgeLifecycleAction','Write-CodexBridgeLifecycleEvent')
