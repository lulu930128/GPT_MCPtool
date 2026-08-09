Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

Import-Module (Join-Path $PSScriptRoot 'japanese-study-runtime.psm1') -Force

Export-ModuleMember -Function @(
  'New-JapaneseStudyRuntimeContext', 'Get-JapaneseStudyRuntimeStatus',
  'Invoke-JapaneseStudyLifecycleAction', 'Write-JapaneseStudyLifecycleEvent'
)
