Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'personal-asset-os-runtime.psm1') -Force

Export-ModuleMember -Function @(
  'New-PersonalAssetOsRuntimeContext', 'Get-PersonalAssetOsRuntimeStatus',
  'Invoke-PersonalAssetOsLifecycleAction', 'Write-PersonalAssetOsLifecycleEvent'
)
