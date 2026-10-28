Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
function Get-McpCcUpdateWorkspace($Manifest) {
    if($Manifest.PSObject.Properties['codeDeployment']){return [string]$Manifest.codeDeployment.workspaceRoot}
    return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
}
function Get-McpCcUpdateDefinition([string]$Workspace,[string]$Id) {
    $folders=@{codex_bridge='codex_bridge';project_reading='project_reading';mcp_control_center='mcp_control_center';omi_search='OMI_search';japanese_study='japanese_study';memory_core='Memory Core';personal_asset_os='personal-asset-os';english_study='english_study';listening_audio='listening_audio'}
    if(-not $folders.ContainsKey($Id)){throw 'UPDATE_TARGET_REJECTED'}
    . (Join-Path $Workspace 'project_reading\scripts\component-update-common.ps1')
    $root=Join-Path $Workspace $folders[$Id]
    $path=Join-Path $root 'control-center\update.json'
    if(-not(Test-Path -LiteralPath $path)){throw 'NOT_SUPPORTED'}
    $d=Read-ComponentUpdateJson $path
    if(@($d.PSObject.Properties.Name|Where-Object {$_ -cnotin @('schemaVersion','componentId','owner','entrypoint','sourcePaths')}).Count -or
        $d.schemaVersion -ne 1 -or $d.componentId -cne $Id -or @($d.sourcePaths).Count -lt 1 -or @($d.sourcePaths).Count -gt 40){throw 'UPDATE_DESCRIPTOR_INVALID'}
    $entry=if($Id -eq 'codex_bridge'){'scripts/daily-code-update.ps1'}elseif($Id -eq 'mcp_control_center'){'scripts/runtime-bootstrap.ps1'}else{'scripts/update-from-source.ps1'}
    $owner=if($Id -eq 'codex_bridge'){'daily_code'}elseif($Id -eq 'mcp_control_center'){'independent_bootstrap'}else{'component_controller'}
    if($d.entrypoint -cne $entry -or $d.owner -cne $owner){throw 'UPDATE_DESCRIPTOR_INVALID'}
    $scriptPath=Join-Path $root $entry;Assert-ComponentUpdatePath $scriptPath
    if(-not(Test-Path -LiteralPath $scriptPath -PathType Leaf)){throw 'UPDATE_ENTRY_MISSING'}
    return [pscustomobject]@{root=$root;entry=$scriptPath;descriptor=$d}
}
function Get-McpCcUpdateDigest([string]$Workspace,$Definition) {
    . (Join-Path $Workspace 'project_reading\scripts\component-update-common.ps1')
    $digest=Get-ComponentUpdateSourceDigest -Root $Definition.root -Paths $Definition.descriptor.sourcePaths
    if($Definition.descriptor.componentId -eq 'codex_bridge'){
        # Bridge packaging explicitly owns these shared code dependencies.
        $parts=@($digest)
        foreach($p in @('NormalOperator.Native.cs','RemoteSelfReload.Native.cs')){
            $path=Join-Path $Workspace ('mcp_control_center/src/'+$p);Assert-ComponentUpdatePath $path
            $parts+=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        $hash=[Security.Cryptography.SHA256]::Create()
        try{$digest=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes(($parts -join "`n"))))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
    }
    return $digest
}
function Publish-McpCcUpdateSources($Owner,$Manifest) {
    $workspace=Get-McpCcUpdateWorkspace $Manifest
    foreach($id in [McpCc.WorkspaceLocal.UpdateContract]::Ids){
        try{$d=Get-McpCcUpdateDefinition $workspace $id;$digest=Get-McpCcUpdateDigest $workspace $d;$Owner.PublishSourceDigest($id,$digest)}
        catch{$Owner.PublishSourceDigest($id,$null)}
    }
}
function Get-McpCcUpdateError($Failure) {
    $code=([string]$Failure.Exception.Message -split ':')[0]
    if($code -cnotmatch '^[A-Z][A-Z0-9_]{0,95}$'){return 'UPDATE_OWNER_FAILED'}
    return $code
}
function Get-McpCcUpdateField($Value,[string]$Name) {
    if($null -ne $Value -and $null -ne $Value.PSObject.Properties[$Name]){return $Value.$Name}
    return $null
}
function Start-McpCcBootstrapProcess($Info) {
    $child=[Diagnostics.Process]::Start($Info);$child.Dispose()
}
function Start-McpCcUpdateBootstrap($Owner,$Request,[string]$Pin) {
    $current=$Owner.ReadUpdate($Request.requestId)
    if($current.phase -in @('ACCEPTED','REJECTED')){$Owner.ReleaseUpdate($Request.requestId);return}
    if($current.preparedBuildId){$Pin=$current.preparedBuildId}
    if($Pin -cnotmatch '^[0-9a-f]{64}$'){throw 'CC_BOOTSTRAP_PREPARED_PIN_REQUIRED'}
    $Owner.CompleteUpdate($Request.requestId,'RUNNING','CC_BOOTSTRAP_PENDING',$null,$null,$null,$null,$Pin)
    if($Owner.ReadUpdate($Request.requestId).phase -in @('ACCEPTED','REJECTED')){return}
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=Join-Path $PSHOME 'powershell.exe'
    $info.Arguments='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+(Join-Path $PSScriptRoot '../scripts/runtime-bootstrap.ps1')+'" -VersionId '+$Request.versionId+' -RequestId '+$Request.requestId
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true
    Start-McpCcBootstrapProcess $info
}
function Test-McpCcBridgeUpdateIdle($Manifest) {
    $component=@($Manifest.components|Where-Object {$_.id -ceq 'codex_bridge'})
    if($component.Count -ne 1){throw 'ACTIVE_STATE_UNKNOWN'}
    $probe=@($component[0].probes|Where-Object {$_.role -ceq 'core' -and $_.kind -ceq 'json'})
    if($probe.Count -ne 1){throw 'ACTIVE_STATE_UNKNOWN'}
    $uri=[uri]$probe[0].url
    if(-not $uri.IsLoopback -or $uri.Scheme -cne 'http' -or $uri.AbsolutePath -cne '/health'){throw 'ACTIVE_STATE_UNKNOWN'}
    try{$h=Invoke-RestMethod -Uri $uri.AbsoluteUri -TimeoutSec 3 -UseBasicParsing}catch{throw 'ACTIVE_STATE_UNKNOWN'}
    if($h.service -cne 'codex-handoff-bridge' -or $h.jobs.scope -cne 'all' -or $h.controller -cnotin @('ready','idle') -or
        $h.jobs.active -isnot [int] -or $h.jobs.awaitingApproval -isnot [int] -or $h.jobs.active -lt 0 -or $h.jobs.awaitingApproval -lt 0){throw 'ACTIVE_STATE_UNKNOWN'}
    return ($h.jobs.active -eq 0 -and $h.jobs.awaitingApproval -eq 0)
}
function Invoke-McpCcWorkspaceUpdate($Owner,$Request,$Manifest,[string]$RuntimeRoot) {
    $workspace=Get-McpCcUpdateWorkspace $Manifest
    $dispatch=$false
    try{
        $dailyRoot=Join-Path $workspace 'codex_bridge/Runtime'
        $dailyRequest=Join-Path $dailyRoot ('operations/'+$Request.operationId+'/request.json')
        if($Request.componentId -eq 'codex_bridge' -and (Test-Path -LiteralPath $dailyRequest)){
            # A canonical reservation owns recovery and terminal replay. Validate
            # original parameters there before considering current source or idle.
            Import-Module (Join-Path $PSScriptRoot 'McpControlCenter.DailyCode.psm1') -Force
            $dispatch=$true
            $result=Repair-McpDailyOperation -Root $dailyRoot -OperationId $Request.operationId -Version $Request.versionId -SourceDigest $Request.expectedSourceDigest
        }else{
        $d=Get-McpCcUpdateDefinition $workspace $Request.componentId
        if($Request.phase -eq 'RECOVERY_REQUIRED' -or ($Request.phase -eq 'RUNNING' -and $Request.componentId -eq 'mcp_control_center')){
            # Never silently turn an uncertain dispatch into a fresh Update.
            if($Request.componentId -eq 'codex_bridge'){
                Import-Module (Join-Path $PSScriptRoot 'McpControlCenter.DailyCode.psm1') -Force
                $root=Join-Path $workspace 'codex_bridge/Runtime'
                $intent=Join-Path $root ('operations/'+$Request.operationId+'/intent.json')
                $dispatch=$true
                if(Test-Path -LiteralPath $intent){$result=Repair-McpDailyOperation -Root $root -OperationId $Request.operationId -Version $Request.versionId -SourceDigest $Request.expectedSourceDigest}
                else{
                    if((Get-McpCcUpdateDigest $workspace $d) -cne $Request.expectedSourceDigest){throw 'SOURCE_CHANGED_USE_NEW_REQUEST'}
                    if(-not(Test-McpCcBridgeUpdateIdle $Manifest)){$Owner.CompleteUpdate($Request.requestId,'QUEUED','WAITING_FOR_IDLE',$null,$null,$null,$null,$null);return}
                    $result=Invoke-McpDailyUpdate -Root $root -Version $Request.versionId -CodeOnly -CandidateRoot $workspace -OperationId $Request.operationId -SourceDigest $Request.expectedSourceDigest
                }
            }elseif($Request.componentId -eq 'mcp_control_center'){
                $dispatch=$true
                Start-McpCcUpdateBootstrap $Owner $Request $Request.preparedBuildId
                return
            }else{
                . (Join-Path $workspace 'project_reading/scripts/component-update-common.ps1')
                $dispatch=$true
                $args='-NoProfile -NonInteractive -File "'+$d.entry+'" -Action Recover -RequestId '+$Request.requestId+' -VersionId '+$Request.versionId+' -ExpectedSourceDigest '+$Request.expectedSourceDigest
                $result=Invoke-ComponentUpdateProcess -Executable (Join-Path $PSHOME 'powershell.exe') -Arguments $args -WorkingDirectory $d.root -TimeoutMs 180000 -Json -Lifecycle -StructuredOutcome -ExpectedOperationId $Request.operationId
            }
        }else{
            $digest=Get-McpCcUpdateDigest $workspace $d
            if($digest -cne $Request.expectedSourceDigest){throw 'SOURCE_CHANGED_USE_NEW_REQUEST'}
            if($Request.componentId -eq 'codex_bridge'){
                if(-not(Test-McpCcBridgeUpdateIdle $Manifest)){
                    $Owner.CompleteUpdate($Request.requestId,'QUEUED','WAITING_FOR_IDLE',$null,$null,$null,$null,$null);return
                }
                Import-Module (Join-Path $PSScriptRoot 'McpControlCenter.DailyCode.psm1') -Force
                # DailyCode is the sole transaction owner: do not call the
                # ordinary action wrapper while holding its action mutex.
                $dispatch=$true
                $result=Invoke-McpDailyUpdate -Root (Join-Path $workspace 'codex_bridge/Runtime') -Version $Request.versionId -CodeOnly -CandidateRoot $workspace -OperationId $Request.operationId -SourceDigest $digest
            }elseif($Request.componentId -eq 'mcp_control_center'){
                Import-Module (Join-Path $PSScriptRoot 'McpControlCenter.Deployment.psm1') -Force
                $candidate=Join-Path $d.root ('Runtime/versions/'+$Request.versionId)
                $null=New-McpCcDeploymentCandidate $d.root $Request.versionId -ReuseEquivalent
                if((Get-McpCcUpdateDigest $workspace $d) -cne $digest){throw 'SOURCE_CHANGED_USE_NEW_REQUEST'}
                $pin=(Get-FileHash -LiteralPath (Join-Path $candidate 'code-inventory.json') -Algorithm SHA256).Hash.ToLowerInvariant()
                $dispatch=$true
                Start-McpCcUpdateBootstrap $Owner $Request $pin
                # The short-lived existing deployment owner now carries the
                # durable request. The tray may cooperatively drain and Exit.
                return
            }else{
                . (Join-Path $workspace 'project_reading/scripts/component-update-common.ps1')
                $dispatch=$true
                $args='-NoProfile -NonInteractive -File "'+$d.entry+'" -Action Update -RequestId '+$Request.requestId+' -VersionId '+$Request.versionId+' -ExpectedSourceDigest '+$digest
                $result=Invoke-ComponentUpdateProcess -Executable (Join-Path $PSHOME 'powershell.exe') -Arguments $args -WorkingDirectory $d.root -TimeoutMs 300000 -Json -Lifecycle -StructuredOutcome -ExpectedOperationId $Request.operationId
            }
        }
        }
        if($Request.componentId -eq 'codex_bridge'){
            if($result.operationId -cne $Request.operationId){
                if($result.operationId -cmatch '^[0-9a-f]{32}$'){$Owner.SetUpdateBlocker($Request.requestId,[string]$result.operationId)}
                throw 'UPDATE_BLOCKED_BY_OTHER_OPERATION'
            }
            $phase=if($result.phase -eq 'ACCEPTED'){'ACCEPTED'}elseif($result.phase -in @('REJECTED','NOT_APPLIED','ROLLED_BACK','SUPERSEDED')){'REJECTED'}else{'RECOVERY_REQUIRED'}
            $version=[string]$result.selectedVersion;$observedVersion=[string]$result.observedRuntimeVersion;$build=[string]$result.observedBuildId
            $prepared=$null
            if($phase -eq 'ACCEPTED'){
                # Loaded ID is checked by canonical Verify against the candidate.
                $prepared=[string]$result.preparedBuildId
                # Read the independently computed canonical build from the
                # version's source owner, never substitute the observed ID.
                if(-not $prepared){throw 'UPDATE_PREPARED_IDENTITY_MISSING'}
                if($version -cne $Request.versionId -or $observedVersion -cne $Request.versionId -or $build -cne $prepared){throw 'UPDATE_LOADED_IDENTITY_MISMATCH'}
            }
            $code=if($phase -eq 'ACCEPTED'){'UPDATE_ACCEPTED'}elseif($result.code){[string]$result.code}else{'UPDATE_NOT_ACCEPTED'}
            $Owner.CompleteUpdate($Request.requestId,$phase,$code,$version,$observedVersion,$build,($phase -eq 'ACCEPTED'),$prepared)
        }else{
            if($result.operationId -cne $Request.operationId){throw 'UPDATE_OPERATION_MISMATCH'}
            $blocker=Get-McpCcUpdateField $result 'blockedByOperationId'
            if($blocker){$Owner.SetUpdateBlocker($Request.requestId,[string]$blocker)}
            if($result.phase -eq 'ACCEPTED' -and ($result.ready -ne $true -or -not $result.preparedBuildId -or $result.preparedBuildId -cne $result.observedBuildId)){throw 'UPDATE_LOADED_IDENTITY_MISMATCH'}
            $Owner.CompleteUpdate($Request.requestId,[string]$result.phase,[string]$result.code,(Get-McpCcUpdateField $result 'selectedVersion'),(Get-McpCcUpdateField $result 'observedVersion'),(Get-McpCcUpdateField $result 'observedBuildId'),(Get-McpCcUpdateField $result 'ready'),(Get-McpCcUpdateField $result 'preparedBuildId'))
        }
    }catch{
        $code=Get-McpCcUpdateError $_
        $phase=if($dispatch){'RECOVERY_REQUIRED'}else{'REJECTED'}
        if($code -eq 'ACTIVE_STATE_UNKNOWN'){$phase='QUEUED'}
        $Owner.CompleteUpdate($Request.requestId,$phase,$code,$null,$null,$null,$null,$null)
    }
}
Export-ModuleMember -Function Publish-McpCcUpdateSources,Invoke-McpCcWorkspaceUpdate,Get-McpCcUpdateDefinition,Get-McpCcUpdateDigest
