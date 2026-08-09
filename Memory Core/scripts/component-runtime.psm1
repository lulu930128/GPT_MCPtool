Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'memory-core-runtime.psm1') -Force

Export-ModuleMember -Function @(
    'New-MemoryCoreRuntimeContext', 'Get-MemoryCoreRuntimeStatus',
    'Invoke-MemoryCoreLifecycleAction', 'Write-MemoryCoreLifecycleEvent'
)
