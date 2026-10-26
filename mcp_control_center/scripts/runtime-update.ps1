param(
    [ValidateSet('Stage','Status','SelectStopped')][string]$Action = 'Status',
    [string]$Version
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..\src\McpControlCenter.Deployment.psm1') -Force
$source = 'C:\GPT_MCPtool\mcp_control_center'
switch ($Action) {
    'Stage' { New-McpCcDeploymentCandidate $source $Version | ConvertTo-Json -Depth 5 }
    'Status' { Get-McpCcDeploymentStatus $source | ConvertTo-Json -Depth 6 }
    'SelectStopped' { Set-McpCcDeploymentSelection $source $Version | ConvertTo-Json -Depth 5 }
}
