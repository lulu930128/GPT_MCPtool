# Short-lived deployment owner, composed from the existing Stage/SelectStopped
# and ordinary cooperative tray Exit/start primitives. Never stops a component.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-z0-9][a-z0-9_-]{0,47}$')][string]$VersionId,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$RequestId)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$manager=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Import-Module (Join-Path $manager 'src/McpControlCenter.Deployment.psm1') -Force
$layout=Get-McpCcDeploymentLayout $manager
$source=if($layout){$layout.sourceRoot}else{$manager}
$workspace=Split-Path -Parent $source
$runtime=Join-Path $source 'Runtime';$state=Join-Path $source '.local/runtime'
$ps=Join-Path $PSHOME 'powershell.exe'
if(-not('McpCc.WorkspaceLocal.UpdateStore' -as [type])){Add-Type -Path (Join-Path $manager 'src/WorkspaceLocal.Native.cs') -ReferencedAssemblies System.Web.Extensions,System.Core}
$store=[McpCc.WorkspaceLocal.UpdateStore]::new($state)
$request=$store.Read($RequestId)
if(-not $request -or $request.componentId -cne 'mcp_control_center' -or $request.versionId -cne $VersionId){throw 'CC_BOOTSTRAP_REQUEST_REQUIRED'}
if($request.phase -in @('ACCEPTED','REJECTED')){$request|ConvertTo-Json -Depth 6;exit 0}
$lease=New-Object Threading.Mutex($false,'Local.McpCc.RuntimeBootstrap.v1')
$held=$false;$stopped=$false
$history=Join-Path $state ('workspace-update-requests/bootstrap/'+$RequestId)
$transition=Join-Path $history 'transition-intent.json'
. (Join-Path $workspace 'project_reading/scripts/component-update-common.ps1')
function Get-BootstrapTray([string]$Version){
    $entry=Join-Path $runtime ('versions/'+$Version+'/scripts/tray.ps1')
    $pattern='(?i)-File\s+"?'+[regex]::Escape($entry.Replace('/','\'))+'"?(?:\s|$)'
    $rows=@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'"|Where-Object {$_.CommandLine -match $pattern})
    if($rows.Count -gt 1){throw 'CC_MULTIPLE_TRAYS'}
    if($rows.Count -eq 0){return $null}
    $process=[Diagnostics.Process]::GetProcessById([int]$rows[0].ProcessId);$null=$process.Handle
    $ticks=$process.StartTime.ToUniversalTime().Ticks;$cim=$rows[0].CreationDate.ToUniversalTime().Ticks
    if($process.Path -ine $ps -or ($ticks-($ticks%10)) -ne ($cim-($cim%10))){$process.Dispose();throw 'CC_TRAY_INSTANCE_CHANGED'}
    return $process
}
try{
    try{$held=$lease.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true}
    if(-not $held){$store.Read($RequestId)|ConvertTo-Json -Depth 6;exit 0}
    # A queued replay may have been completed by the previous bootstrap while
    # this process was starting. Never overwrite that terminal receipt.
    $request=$store.Read($RequestId)
    if($request.phase -in @('ACCEPTED','REJECTED')){$request|ConvertTo-Json -Depth 6;exit 0}
    $stopped=Test-Path -LiteralPath $transition
    $candidate=Test-McpCcDeploymentVersion $runtime $VersionId
    $pin=(Get-FileHash -LiteralPath (Join-Path $candidate.managerRoot 'code-inventory.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    if(-not $request.preparedBuildId -or $pin -cne $request.preparedBuildId){throw 'CC_CANDIDATE_CHANGED'}
    $selection=Get-Content -LiteralPath (Join-Path $runtime 'current.json') -Raw -Encoding UTF8|ConvertFrom-Json
    if($selection.contract -cne 'mcpcc-current-v1'){throw 'CC_SELECTOR_INVALID'}
    $oldVersion=[string]$selection.version
    if(Test-Path -LiteralPath $transition){
        $original=Read-ComponentUpdateJson $transition
        if($original.requestId -cne $RequestId -or $original.to -cne $VersionId -or $original.preparedBuildId -cne $pin -or
            $original.from -cnotmatch '^[a-z0-9][a-z0-9_-]{0,47}$'){throw 'CC_BOOTSTRAP_TRANSITION_INVALID'}
        if($oldVersion -cne $original.from -and $oldVersion -cne $original.to){throw 'CC_BOOTSTRAP_SUPERSEDED'}
    }
    $tray=Get-BootstrapTray $oldVersion
    if($oldVersion -cne $VersionId){
        if(-not(Test-Path -LiteralPath $transition)){
            Write-ComponentUpdateJson $transition @{requestId=$RequestId;from=$oldVersion;to=$VersionId;preparedBuildId=$pin;createdAt=[DateTime]::UtcNow.ToString('o')}
        }
        # Once Exit may be signalled, uncertainty belongs to this operation even
        # when a resumed helper did not itself perform the earlier transition.
        $stopped=$true
        if($tray){
            try{
                # The worker releases its in-process active request before this
                # fixed event is signalled. Exit retains normal busy/drain gates.
                $signal=[Threading.EventWaitHandle]::OpenExisting('Local\McpCc.InstalledTrayExit.v1.'+$tray.Id+'.'+$tray.StartTime.ToUniversalTime().Ticks)
                try{[void]$signal.Set()}finally{$signal.Dispose()}
                if(-not $tray.WaitForExit(60000)){throw 'CC_TRAY_EXIT_REFUSED_OR_BUSY'}
            }finally{$tray.Dispose()}
        }
        $null=Set-McpCcDeploymentSelection $source $VersionId
    }elseif($tray){$tray.Dispose();$tray=$null;$stopped=$true}
    $targetTray=Get-BootstrapTray $VersionId
    if(-not $targetTray){
        # Includes interruption after selection and before ordinary Start.
        # The stable launcher verifies the selected tree and singleton again.
        $start=Start-Process -FilePath (Join-Path $env:WINDIR 'System32/wscript.exe') -ArgumentList ('"'+(Join-Path $source 'scripts/start-runtime-tray.vbs')+'"') -WindowStyle Hidden -PassThru
        $start.Dispose()
        $stopped=$true
    }else{$targetTray.Dispose()}
    $watch=[Diagnostics.Stopwatch]::StartNew();$observed=$null
    while(-not $observed -and $watch.ElapsedMilliseconds -lt 30000){Start-Sleep -Milliseconds 250;$observed=Get-BootstrapTray $VersionId}
    if(-not $observed){throw 'CC_TRAY_START_UNVERIFIED'}
    try{
        # Its ordinary Exit signal is created only by the live selected owner.
        $signal=$null
        while(-not $signal -and $watch.ElapsedMilliseconds -lt 45000){
            try{$signal=[Threading.EventWaitHandle]::OpenExisting('Local\McpCc.InstalledTrayExit.v1.'+$observed.Id+'.'+$observed.StartTime.ToUniversalTime().Ticks)}
            catch [Threading.WaitHandleCannotBeOpenedException]{Start-Sleep -Milliseconds 250}
        }
        if(-not $signal -or $observed.HasExited){throw 'CC_TRAY_READINESS_UNVERIFIED'}
        $signal.Dispose()
        $ipcReady=$false
        while(-not $ipcReady -and $watch.ElapsedMilliseconds -lt 60000){
            try{$ipcReady=[McpCc.WorkspaceLocal.OwnerProbe]::Status($observed.Id,$observed.StartTime.ToUniversalTime().Ticks)}catch{$ipcReady=$false}
            if(-not $ipcReady){Start-Sleep -Milliseconds 250}
        }
        if(-not $ipcReady){throw 'CC_WORKSPACE_IPC_NOT_READY'}
        $null=Test-McpCcDeploymentVersion $runtime $VersionId
        $again=Get-Content -LiteralPath (Join-Path $runtime 'current.json') -Raw -Encoding UTF8|ConvertFrom-Json
        if($again.version -cne $VersionId){throw 'CC_SELECTION_CHANGED'}
        $store.Complete($RequestId,'ACCEPTED','CC_OWNER_AND_IPC_VERIFIED',$VersionId,$VersionId,$pin,$true,$pin)
        $store.Read($RequestId)|ConvertTo-Json -Depth 6
    }finally{$observed.Dispose()}
}catch{
    $code=([string]$_.Exception.Message -split ':')[0]
    if($code -cnotmatch '^[A-Z][A-Z0-9_]{0,95}$'){$code='CC_BOOTSTRAP_FAILED'}
    $store.Complete($RequestId,$(if($code -eq 'CC_BOOTSTRAP_SUPERSEDED'){'REJECTED'}elseif($stopped){'RECOVERY_REQUIRED'}else{'REJECTED'}),$code,$null,$null,$null,$null,$request.preparedBuildId)
    $store.Read($RequestId)|ConvertTo-Json -Depth 6
    exit 1
}finally{if($held){$lease.ReleaseMutex()};$lease.Dispose()}
