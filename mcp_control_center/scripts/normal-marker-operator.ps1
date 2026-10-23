[CmdletBinding()]
param([ValidateSet('Preflight')][string]$Action='Preflight', [Parameter(Mandatory)][int]$TrayProcessId)
$ErrorActionPreference='Stop'
$managerRoot=Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $managerRoot 'src\McpControlCenter.NormalOperator.psm1')
$result=Get-McpCcNormalOperatorPreflight -ManagerRoot $managerRoot -TrayProcessId $TrayProcessId
$result | ConvertTo-Json -Depth 8 -Compress
if (-not $result.enabled) { exit 2 }
exit 0
