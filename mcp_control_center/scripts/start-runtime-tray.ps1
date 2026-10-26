# Same stable entry for daily start and explicit cold boot. Never replaces a tray.
param([switch]$Boot)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
# Start-Process/wscript can inherit PowerShell 7's PSModulePath. This entry
# explicitly runs Windows PowerShell and needs its own built-in module set.
$env:PSModulePath = Join-Path $PSHOME 'Modules'
Import-Module (Join-Path $PSScriptRoot '..\src\McpControlCenter.Deployment.psm1') -Force
$source = 'C:\GPT_MCPtool\mcp_control_center'
$status = Get-McpCcDeploymentStatus $source
if (-not $status.selected) { throw 'CC_NOT_SELECTED' }
if ($status.bridgeStatus -cne 'SELECTED_NOT_LIVE_VERIFIED') { throw 'CC_BRIDGE_SELECTION_UNAVAILABLE' }
$layout = Test-McpCcDeploymentVersion $status.runtimeRoot $status.selected
# The OS command line must contain the version's actual tray.ps1 for the existing
# exact-path ownership checks. This waiting launcher is not a second tray owner.
$child = New-Object Diagnostics.Process
$child.StartInfo = New-McpCcDeploymentTrayStartInfo $layout -Boot:$Boot
try {
    if (-not $child.Start()) { throw 'CC_TRAY_NOT_STARTED' }
    $child.WaitForExit()
    if ($child.ExitCode -ne 0) { throw 'CC_TRAY_EXIT_FAILED_NO_AUTOMATIC_RETRY' }
} finally { $child.Dispose() }
