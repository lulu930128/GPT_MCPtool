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
    try{$h=Invoke-RestMethod -Uri $uri.AbsoluteUri -TimeoutSec 3 -UseBasicParsing}catch{
        # HTTP absence alone is not stopped evidence. Ask the existing selected
        # controller, which resolves exact process/listener ownership read-only.
        $workspace=Get-McpCcUpdateWorkspace $Manifest
        . (Join-Path $workspace 'project_reading/scripts/component-update-common.ps1')
        try {
            Import-Module (Join-Path $PSScriptRoot 'McpControlCenter.DailyCode.psm1') -Force
            $dailyRoot=Join-Path $workspace 'codex_bridge/Runtime'
            $selected=Get-McpDailyStatus $dailyRoot
            $codeRoot=Join-Path $selected.root 'codex_bridge'
            $s=Invoke-ComponentUpdateProcess -Executable (Join-Path $PSHOME 'powershell.exe') -Arguments ('-NoProfile -NonInteractive -File "'+(Join-Path $codeRoot 'scripts/runtime-control.ps1')+'" -Action Status') -WorkingDirectory $codeRoot -Json
            if((Get-McpDailyStatus $dailyRoot).version -ceq $selected.version -and $s.ok -and $s.after.status -ceq 'Stopped' -and $s.after.server.ownership -ceq 'Stopped' -and $s.after.tunnel.ownership -ceq 'Stopped'){return $true}
        }catch{}
        throw 'STATE_UNVERIFIED'
    }
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
        # An unverified state is visible for original-ID inspection, never an
        # endless idle retry. Only confirmed active work uses the idle queue.
        if($code -in @('ACTIVE_STATE_UNKNOWN','STATE_UNVERIFIED')){$phase='RECOVERY_REQUIRED'}
        $Owner.CompleteUpdate($Request.requestId,$phase,$code,$null,$null,$null,$null,$null)
    }
}
Export-ModuleMember -Function Publish-McpCcUpdateSources,Invoke-McpCcWorkspaceUpdate,Get-McpCcUpdateDefinition,Get-McpCcUpdateDigest

Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'

function Initialize-McpCcOmiSource {
    $repo='C:\project\Open Market Intelligence'
    foreach($name in @('apply-omi-update.ps1','omi-runtime-control.ps1','OmiRuntimeControl.cs','OmiOwnedShutdown.cs')) {
        $path=Join-Path $repo ('scripts/'+$name)
        for($p=$path;$p;$p=[IO.Path]::GetDirectoryName($p)) {
            if((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'OMI_REPARSE_REJECTED'}
        }
    }
    if(-not ('Omi.RuntimeControl.Controller' -as [type])) {
        Add-Type -Path @((Join-Path $repo 'scripts/OmiRuntimeControl.cs'),(Join-Path $repo 'scripts/OmiOwnedShutdown.cs')) -ReferencedAssemblies System.Web.Extensions,System.Core,System.Windows.Forms
    }
    # Both scripts define functions only when dot-sourced. No credentials, status
    # mutation, Controller construction or execution startup occurs here.
    . (Join-Path $repo 'scripts/apply-omi-update.ps1')
    . (Join-Path $repo 'scripts/omi-runtime-control.ps1')
    $script:RepoRoot=$repo
    $lifecycle=Get-OmiLifecycleSourceId
    $application=[Omi.OwnedShutdown.ProductionSession]::ApplicationRelease($repo)
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$digest=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("cc-omi-launcher-update-v1`n$lifecycle`n$application")))).Replace('-','').ToLowerInvariant()}
    finally{$sha.Dispose()}
    return [pscustomobject]@{digest=$digest;lifecycle=$lifecycle;application=$application}
}
function Assert-McpCcOmiDeployment($Manifest) {
    if(-not [McpCc.WorkspaceLocal.OmiContract]::IndependentOwner()){throw 'OMI_CC_OWNER_JOB_UNVERIFIED'}
    if(-not $Manifest.PSObject.Properties['codeDeployment'] -or
        $Manifest.codeDeployment.workspaceRoot -ine 'C:\GPT_MCPtool' -or
        $Manifest.codeDeployment.managerRoot -ine [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))) {throw 'OMI_DEPLOYED_CC_REQUIRED'}
    Import-Module (Join-Path $PSScriptRoot 'McpControlCenter.Deployment.psm1')
    $d=$Manifest.codeDeployment
    $selector=Get-Content -LiteralPath (Join-Path $d.runtimeRoot 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if($selector.contract -cne 'mcpcc-current-v1' -or $selector.version -cne $d.version){throw 'OMI_CC_SELECTION_CHANGED'}
    $null=Test-McpCcDeploymentVersion $d.runtimeRoot $d.version
}
function Publish-McpCcOmiSource($Owner,$Manifest) {
    try{Assert-McpCcOmiDeployment $Manifest;$s=Initialize-McpCcOmiSource;$Owner.PublishOmiSource($s.digest,$Manifest.codeDeployment.version)}
    catch{$Owner.PublishOmiSource($null,$null)}
}
function Get-McpCcOmiPreflight {
    $repo='C:\project\Open Market Intelligence'
    # Reuse OMI's exact capture and read-only status functions, not port/PID guesses.
    . (Join-Path $repo 'scripts/apply-omi-update.ps1')
    $identity=Get-OmiUpdateOwner -Repo $repo
    try {
        $sha=[Security.Cryptography.SHA256]::Create()
        try{$suffix=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($repo.ToLowerInvariant())))).Replace('-','').ToLowerInvariant().Substring(0,24)}finally{$sha.Dispose()}
        $status=Read-OmiUpdateOwnerStatus ('omi-runtime-'+$suffix) $identity.Process
        if($status.schema -cne 'omi.runtime-control.v1' -or -not $status.owner_id -or $status.launcher.pid -ne $identity.Pid -or
            [Math]::Abs(([DateTime]::Parse($status.launcher.created_at).ToUniversalTime().Ticks)-$identity.Created.Ticks) -ge 10 -or
            $identity.Process.HasExited){throw 'OMI_OLD_OWNER_UNVERIFIED'}
        if($status.restart.update_action -cne 'ApplyUpdate'){throw 'OMI_ADOPTION_GATE_UNVERIFIED'}
        if(-not [Omi.RuntimeControl.Controller]::ExecutionLeasesFree($repo)){throw 'UPDATE_EXECUTION_STOP_REQUIRED'}
        return [pscustomobject]@{ownerId=$status.owner_id;pid=$identity.Pid;createdTicks=$identity.Created.Ticks}
    } finally {foreach($node in $identity.Nodes){$node.Process.Dispose()}}
}
function Start-McpCcOmiUpdater {return [McpCc.WorkspaceLocal.OmiChild]::Start()}
function Read-McpCcOmiNativeReceipt([string]$Output) {
    # Original updater emits progress text before its final compressed JSON.
    # Only the last nonempty line is a receipt; no whole-stdout JSON assumption.
    $lines=@($Output.TrimEnd() -split '\r?\n');$line=$lines[-1]
    if($line.Length -gt 16384 -or -not $line.StartsWith('{')){throw 'OMI_UPDATER_RECEIPT_UNVERIFIED'}
    try{$r=$line | ConvertFrom-Json -ErrorAction Stop}catch{throw 'OMI_UPDATER_RECEIPT_UNVERIFIED'}
    foreach($key in @('request_id','action','status','phase','old_owner_stop','owner_pid','owner_created','launcher_adoption','update_applied','backend_readiness','frontend_readiness','successor','vbs_invocations')) {
        if(-not $r.PSObject.Properties[$key]){throw 'OMI_UPDATER_SCHEMA_UNVERIFIED'}
    }
    if([string]$r.request_id -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
        $r.action -cne 'ApplyUpdate' -or [string]$r.status -cnotmatch '^UPDATE_[A-Z_]+$' -or
        $r.old_owner_stop -cnotin @('UNCONFIRMED','CONFIRMED','FORCED_EXIT_CONFIRMED')){throw 'OMI_UPDATER_SCHEMA_UNVERIFIED'}
    return $r
}
function ConvertFrom-McpCcOmiResult([string]$Output,[int]$ExitCode,$Source,$Old) {
    $r=Read-McpCcOmiNativeReceipt $Output
    # No schema field is invented for the legacy receipt. Validate its actual
    # shape and native correlation, including the successor's operation UUID.
    $s=$r.successor
    if(-not $s -or -not $s.update_operation -or $s.update_operation.request_id -cne $r.request_id){throw 'OMI_NATIVE_CORRELATION_UNVERIFIED'}
    if($r.owner_pid -ne $Old.pid -or [Math]::Abs(([DateTime]::Parse($r.owner_created).ToUniversalTime().Ticks)-$Old.createdTicks) -ge 10 -or
        $s.launcher_pid -le 0 -or $s.launcher_pid -eq $Old.pid -or [DateTime]::Parse($s.launcher_created).ToUniversalTime().Ticks -le $Old.createdTicks){throw 'OMI_OWNER_GENERATION_UNVERIFIED'}
    if($ExitCode -ne 0 -or $r.status -cne 'UPDATE_BACKEND_READY' -or $r.phase -cne 'COMPLETE' -or $r.vbs_invocations -cne 1 -or
        $r.old_owner_stop -cnotin @('CONFIRMED','FORCED_EXIT_CONFIRMED') -or
        $r.launcher_adoption -cne 'VERIFIED' -or $r.update_applied -cne 'LAUNCHER_AND_BACKEND_VERIFIED' -or
        $r.backend_readiness -cne 'VERIFIED' -or $s.backend_verified -cne $true -or $s.http_readiness -cne 'VERIFIED' -or
        $s.loaded_lifecycle_source_id -cne $Source.lifecycle -or $s.application_release_id -cne $Source.application -or
        $s.update_operation.status -cne 'succeeded'){throw 'OMI_UPDATER_RESULT_UNVERIFIED'}
    return $r.request_id
}
function Invoke-McpCcOmiUpdate($Owner,$Request,$Manifest) {
    $dispatched=$false;$child=$null;$nativeId=$null
    try {
        Assert-McpCcOmiDeployment $Manifest
        $source=Initialize-McpCcOmiSource
        if($source.digest -cne $Request.expectedSourceDigest){throw 'OMI_SOURCE_CHANGED'}
        $old=Get-McpCcOmiPreflight
        $Owner.PreflightOmi($Request.requestId,$source.lifecycle,$source.application,$old.ownerId,$old.pid,$old.createdTicks)
        # Recheck source immediately before the sole fixed launch. The original
        # updater re-attests exact owner, execution fence and all writer gates.
        if((Initialize-McpCcOmiSource).digest -cne $source.digest){throw 'OMI_SOURCE_CHANGED'}
        $dispatched=$true
        $child=Start-McpCcOmiUpdater
        $Owner.ProgressOmi($Request.requestId,$child.Pid,$child.CreatedTicks)
        $clock=[Diagnostics.Stopwatch]::StartNew();$timedOut=$false
        while(-not $child.Finished) {
            if(-not $timedOut -and $clock.ElapsedMilliseconds -ge 900000){
                $timedOut=$true;$Owner.ObserveOmi($Request.requestId,'OMI_UPDATER_TIMEOUT_CHECK_ORIGINAL_RECEIPT')
            }
            Start-Sleep -Milliseconds 50
        }
        # Keep validated native UUID even when a terminal success check fails.
        try{$nativeId=(Read-McpCcOmiNativeReceipt $child.Output).request_id}catch{if($child.ExitCode -ne 0){throw $child.ErrorCode};throw}
        if($timedOut){throw 'OMI_UPDATER_TIMEOUT_CHECK_ORIGINAL_RECEIPT'}
        $nativeId=ConvertFrom-McpCcOmiResult $child.Output $child.ExitCode $source $old
        if((Initialize-McpCcOmiSource).digest -cne $source.digest){throw 'OMI_SOURCE_CHANGED_DURING_UPDATE'}
        $Owner.CompleteOmi($Request.requestId,'ACCEPTED','OMI_LAUNCHER_BACKEND_VERIFIED',$nativeId)
    } catch {
        $code=($_.Exception.Message -split ':')[0]
        if($code -cnotmatch '^[A-Z][A-Z0-9_]{0,95}$'){$code='OMI_UPDATE_UNVERIFIED'}
        $phase=if($dispatched){'RECOVERY_REQUIRED'}else{'REJECTED'}
        $Owner.CompleteOmi($Request.requestId,$phase,$code,$nativeId)
    } finally {
        # Even a receipt-write/observation failure cannot drop a live updater.
        # The existing tray maintenance worker remains busy until it exits.
        if($child){try{while(-not $child.Finished){Start-Sleep -Milliseconds 100}}finally{$child.Dispose()}}
    }
}
Export-ModuleMember -Function Publish-McpCcOmiSource,Invoke-McpCcOmiUpdate
