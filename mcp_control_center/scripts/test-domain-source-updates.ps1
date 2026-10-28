Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$checks=0
function Assert-Check([bool]$Condition,[string]$Name){if(-not $Condition){throw ('CHECK_FAILED: '+$Name)};$script:checks++}
function Get-Callback([string]$Path,[string]$Name){
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'SCRIPT_PARSE_FAILED'}
    $assignment=$ast.Find({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -ceq ('$'+$Name)},$true)
    if($null -eq $assignment){throw 'CALLBACK_NOT_FOUND'}
    return & ([scriptblock]::Create($assignment.Right.Extent.Text))
}
function Test-MemoryCallbacks {
    $path=Join-Path $workspace 'Memory Core\scripts\update-from-source.ps1'
    $preflight=Get-Callback $path 'preflight';$observe=Get-Callback $path 'observe'
    $reply=[pscustomobject]@{ok=$true;after=[pscustomobject]@{status='Ready';backend=[pscustomobject]@{ownership='OwnedReady'};mcp=[pscustomobject]@{ownership='OwnedReady'};tunnel=[pscustomobject]@{ownership='OwnedReady'}}}
    $status={$reply}
    Assert-Check (& $preflight).allowed 'memory owned preflight'
    $reply.after.mcp.ownership='OwnershipMismatch'
    Assert-Check (-not (& $preflight).allowed) 'memory foreign owner denied'
    $reply.after.mcp.ownership='OwnedReady'
    $backend=[pscustomobject]@{status='ok';database='ok';version='1.0';build_id='0123456789abcdef'}
    $mcp=[pscustomobject]@{status='ok';service='memory-core-mcp';version='1.0';build_id='0123456789abcdef'}
    function Invoke-RestMethod {param($Uri,[switch]$UseBasicParsing,$TimeoutSec) if($Uri -match ':18765/'){return $backend};return $mcp}
    Assert-Check (& $observe).ready 'memory exact paired loaded identity'
    $mcp.build_id='fedcba9876543210'
    Assert-Check (-not (& $observe).ready) 'memory mixed build denied'
    $backend.PSObject.Properties.Remove('build_id')
    $code='';try{& $observe|Out-Null}catch{$code=$_.Exception.Message}
    Assert-Check ($code -ceq 'UPDATE_LOADED_IDENTITY_UNVERIFIED') 'memory legacy loaded identity unknown'
    Assert-Check ((Get-Callback $path 'reload').ToString().Contains('-Lifecycle')) 'memory exact owner lifecycle scope'
}
function Test-AssetCallbacks {
    $path=Join-Path $workspace 'personal-asset-os\scripts\update-from-source.ps1'
    $preflight=Get-Callback $path 'preflight';$observe=Get-Callback $path 'observe'
    $reply=[pscustomobject]@{ok=$true;after=[pscustomobject]@{status='Ready';server=[pscustomobject]@{ownership='OwnedReady'};tunnel=[pscustomobject]@{ownership='OwnedReady'}}}
    $status={$reply};$identity={[pscustomobject]@{version='1.0';buildId='0123456789abcdef';schemaRevision='schema1'}}
    $health=[pscustomobject]@{ok=$true;service='personal-asset-os';version='1.0';database='ready';buildId='0123456789abcdef';buildIdentity='startup-v1';schemaRevision='schema1'}
    $ready=[pscustomobject]@{ready=$true;frontendReady=$true;buildId='0123456789abcdef';buildIdentity='startup-v1'}
    function Invoke-RestMethod {param($Uri,[switch]$UseBasicParsing,$TimeoutSec) if($Uri -match '/readyz$'){return $ready};return $health}
    Assert-Check (& $preflight).allowed 'asset exact existing schema preflight'
    $health.schemaRevision='schema0'
    $gate=& $preflight
    Assert-Check (-not $gate.allowed -and $gate.code -ceq 'MIGRATION_REQUIRED') 'asset schema migration denied'
    $health.schemaRevision='schema1';$reply.after.server.ownership='OwnershipMismatch'
    Assert-Check (-not (& $preflight).allowed) 'asset foreign owner denied'
    $reply.after.server.ownership='OwnedReady'
    Assert-Check (& $observe).ready 'asset loaded readiness'
    $ready.buildId='fedcba9876543210'
    Assert-Check (-not (& $observe).ready) 'asset mixed health identity denied'
    $ready.buildId=$health.buildId;$health.PSObject.Properties.Remove('buildIdentity')
    $code='';try{& $observe|Out-Null}catch{$code=$_.Exception.Message}
    Assert-Check ($code -ceq 'UPDATE_LOADED_IDENTITY_UNVERIFIED') 'asset legacy dynamic source identity denied'
    Assert-Check ((Get-Callback $path 'reload').ToString().Contains('-Lifecycle')) 'asset exact owner lifecycle scope'
}
Test-MemoryCallbacks
Test-AssetCallbacks
[pscustomobject]@{status='PASS_ISOLATED_CALLBACKS';checks=$checks;liveMutation=$false}|ConvertTo-Json
