Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$source=Split-Path -Parent $PSScriptRoot
$module=Import-Module (Join-Path $source 'src/McpControlCenter.WorkspaceUpdate.psm1') -Force -PassThru
$root=Join-Path ([IO.Path]::GetTempPath()) ('cc-bridge-state-'+[guid]::NewGuid().ToString('N'))
$checks=0
function Check($Value,[string]$Label){if(-not $Value){throw ('FAIL: '+$Label)};$script:checks++}
try {
    $common=Join-Path $root 'project_reading/scripts/component-update-common.ps1'
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $common))
    [IO.File]::WriteAllText($common,@'
function Invoke-ComponentUpdateProcess {
    param($Executable,$Arguments,$WorkingDirectory,[switch]$Json)
    if($Arguments -notmatch '-Action Status$'){throw 'FIXTURE_MUTATION_REJECTED'}
    if($script:Mode -eq 'stopped'){return [pscustomobject]@{ok=$true;after=@{status='Stopped';server=@{ownership='Stopped'};tunnel=@{ownership='Stopped'}}}}
    return [pscustomobject]@{ok=$true;after=@{status='OwnershipUnknown';server=@{ownership='OwnershipUnknown'};tunnel=@{ownership='Stopped'}}}
}
'@)
    & $module {
        param($Root)
        $script:Root=$Root;$script:Mode='active';$script:Calls=0;$script:Operation=$null
        function script:Get-McpCcUpdateDefinition {param($Workspace,$Id) [pscustomobject]@{root=$script:Root}}
        function script:Get-McpCcUpdateDigest {param($Workspace,$Definition) return ('a'*64)}
        function script:Get-McpDailyStatus {param($Root) return @{version='selected-old';root=(Join-Path $script:Root 'selected')}}
        function script:Invoke-RestMethod {
            param($Uri,$TimeoutSec,[switch]$UseBasicParsing)
            if($script:Mode -ne 'active' -and $script:Mode -ne 'idle'){throw 'HTTP_UNAVAILABLE'}
            [pscustomobject]@{service='codex-handoff-bridge';controller='ready';jobs=@{scope='all';active=$(if($script:Mode -eq 'active'){1}else{0});awaitingApproval=0}}
        }
        function script:Import-Module {param($Name,[switch]$Force) if($Name -notlike '*McpControlCenter.DailyCode.psm1'){throw 'FIXTURE_IMPORT_REJECTED'}}
        function script:Invoke-McpDailyUpdate {
            param($Root,$Version,[switch]$CodeOnly,$CandidateRoot,$OperationId,$SourceDigest)
            $script:Calls++;$script:Operation=$OperationId
            [pscustomobject]@{phase='ACCEPTED';operationId=$OperationId;selectedVersion=$Version;observedRuntimeVersion=$Version;observedBuildId=('b'*64);preparedBuildId=('b'*64)}
        }
    } $root
    $manifest=[pscustomobject]@{codeDeployment=@{workspaceRoot=$root};components=@([pscustomobject]@{id='codex_bridge';probes=@([pscustomobject]@{role='core';kind='json';url='http://127.0.0.1:18789/health'})})}
    $owner=[pscustomobject]@{phase=$null;code=$null;id=$null}
    $owner|Add-Member ScriptMethod CompleteUpdate {param($Id,$Phase,$Code,$Selected,$Observed,$Build,$Ready,$Prepared) $this.id=$Id;$this.phase=$Phase;$this.code=$Code}
    $id=[guid]::NewGuid().ToString('D')
    $request=[pscustomobject]@{componentId='codex_bridge';requestId=$id;operationId=$id.Replace('-','');versionId='test-next';expectedSourceDigest=('a'*64);phase='QUEUED'}
    Invoke-McpCcWorkspaceUpdate $owner $request $manifest $root
    Check ($owner.phase -eq 'QUEUED' -and $owner.code -eq 'WAITING_FOR_IDLE') 'active work waits'
    Check ((& $module {$script:Calls}) -eq 0) 'active work never dispatches DailyCode'
    & $module {$script:Mode='unknown'}
    Invoke-McpCcWorkspaceUpdate $owner $request $manifest $root
    Check ($owner.phase -eq 'RECOVERY_REQUIRED' -and $owner.code -eq 'STATE_UNVERIFIED') 'HTTP absence and unknown ownership stay unresolved'
    Check ((& $module {$script:Calls}) -eq 0) 'unknown state never dispatches DailyCode'
    & $module {$script:Mode='stopped'}
    Invoke-McpCcWorkspaceUpdate $owner $request $manifest $root
    Check ($owner.phase -eq 'ACCEPTED' -and $owner.id -eq $id) 'confirmed stopped delegates to canonical DailyCode'
    Check ((& $module {$script:Calls}) -eq 1 -and (& $module {$script:Operation}) -eq $request.operationId) 'stopped path retains original operation ID'
    & $module {$script:Mode='idle'}
    Invoke-McpCcWorkspaceUpdate $owner $request $manifest $root
    Check ($owner.phase -eq 'ACCEPTED' -and (& $module {$script:Calls}) -eq 2) 'confirmed idle remains supported'
    [pscustomobject]@{ok=$true;checks=$checks;fixture='CC_BRIDGE_DISPATCH_BOUNDARY';liveMutation=$false}|ConvertTo-Json -Compress
}finally{
    Remove-Module $module
    $resolved=[IO.Path]::GetFullPath($root)
    if(-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -cnotmatch '^cc-bridge-state-[a-f0-9]{32}$'){throw 'FIXTURE_CLEANUP_PATH_REJECTED'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
