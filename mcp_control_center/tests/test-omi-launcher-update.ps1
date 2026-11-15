param([ValidateSet('Harness','Owner','Client','Updater','Successor','CompileClient')][string]$Mode='Harness',[string]$FixtureRoot,[string]$PipeName,[int]$OwnerPid,[long]$OwnerTicks,[string]$RequestId)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$cc=Split-Path -Parent $PSScriptRoot
function Compile-Fixture {
    $native=Get-Content (Join-Path $cc 'src/WorkspaceLocal.Native.cs') -Raw -Encoding UTF8
    $fixture=Get-Content (Join-Path $PSScriptRoot 'OmiUpdate.Check.cs') -Raw -Encoding UTF8
    Add-Type -TypeDefinition ($native+"`n"+$fixture) -ReferencedAssemblies System.Web.Extensions,System.Core
}
function Wait-File([string]$Path,[int]$Seconds=20) {
    $w=[Diagnostics.Stopwatch]::StartNew()
    while(-not(Test-Path -LiteralPath $Path)){if($w.Elapsed.TotalSeconds -ge $Seconds){throw "FIXTURE_FILE_TIMEOUT: $([IO.Path]::GetFileName($Path))"};Start-Sleep -Milliseconds 30}
}
function Spawn([string]$Role,[string]$Extra='') {
    $i=[Diagnostics.ProcessStartInfo]::new()
    $i.FileName=Join-Path $PSHOME 'powershell.exe'
    $i.Arguments='-NoProfile -NonInteractive -File "'+$PSCommandPath+'" -Mode '+$Role+' -FixtureRoot "'+$FixtureRoot+'" '+$Extra
    $i.UseShellExecute=$false;$i.CreateNoWindow=$true
    return [Diagnostics.Process]::Start($i)
}
if($Mode -eq 'CompileClient') {
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $cc 'scripts/omi-launcher-update-client.ps1'),[ref]$tokens,[ref]$errors)
    $function=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Import-McpCcOmiClientNative'},$true)
    . ([scriptblock]::Create($function.Extent.Text))
    [Environment]::SetEnvironmentVariable('TEMP',$null,'Process');[Environment]::SetEnvironmentVariable('TMP',$null,'Process')
    Import-McpCcOmiClientNative (Join-Path $cc 'src/WorkspaceLocal.Native.cs')
    if([Environment]::GetEnvironmentVariable('TEMP','Process') -or [Environment]::GetEnvironmentVariable('TMP','Process') -or -not ('McpCc.WorkspaceLocal.OmiClient' -as [type])){throw 'SCOPED_CLIENT_COMPILE_FAILED'}
    Set-Content (Join-Path $FixtureRoot 'compile-client-ok') 'TEMP_TMP_RESTORED'
    exit 0
}
if($Mode -eq 'Successor') {
    # Intentionally retain inherited standard handles until the harness releases
    # this inert process. No runtime, credentials, network, database or login.
    [ordered]@{pid=$PID;parentPid=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)).ParentProcessId;created=(Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o');stdoutCanWrite=[Console]::OpenStandardOutput().CanWrite}|ConvertTo-Json -Compress|Set-Content (Join-Path $FixtureRoot 'successor.json') -Encoding UTF8
    Wait-File (Join-Path $FixtureRoot 'release-successor') 45
    exit 0
}
if($Mode -eq 'Updater') {
    Add-Content (Join-Path $FixtureRoot 'invocations.txt') 'once'
    Wait-File (Join-Path $FixtureRoot 'client-exited')
    $child=Spawn Successor
    $child.Dispose()
    Wait-File (Join-Path $FixtureRoot 'successor.json')
    $parentPid=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)).ParentProcessId
    $parent=Get-Process -Id $parentPid
    $s=Get-Content (Join-Path $FixtureRoot 'successor.json') -Raw|ConvertFrom-Json
    Write-Host 'EXIT_REQUESTED; waiting for original owner and schema worker exit'
    $nativeId=[guid]::NewGuid().ToString('D')
    [ordered]@{request_id=$nativeId;action='ApplyUpdate';status='UPDATE_BACKEND_READY';phase='COMPLETE';old_owner_stop='CONFIRMED';owner_pid=$parentPid;owner_created=$parent.StartTime.ToUniversalTime().ToString('o');launcher_adoption='VERIFIED';
        update_applied='LAUNCHER_AND_BACKEND_VERIFIED';backend_readiness='VERIFIED';frontend_readiness='UNVERIFIED';vbs_invocations=1;
        successor=@{launcher_pid=$s.pid;launcher_created=$s.created;backend_verified=$true;http_readiness='VERIFIED';loaded_lifecycle_source_id=('b'*64);application_release_id=('c'*64);update_operation=@{request_id=$nativeId;status='succeeded'}}}|ConvertTo-Json -Depth 6 -Compress
    exit 0
}
Compile-Fixture
if($Mode -eq 'Client') {
    [McpCc.WorkspaceLocal.OmiFixture]::Call($PipeName,'omi_apply',$RequestId,('a'*64),$OwnerPid,$OwnerTicks)|Set-Content (Join-Path $FixtureRoot 'client-reply.json') -Encoding UTF8
    exit 0
}
if($Mode -eq 'Owner') {
    $owner=[McpCc.WorkspaceLocal.OmiFixture]::Open($PipeName,$FixtureRoot)
    $module=Import-Module (Join-Path $cc 'src/McpControlCenter.WorkspaceUpdate.psm1') -Force -PassThru
    # All replacements are confined to this private fixture process/module.
    & $module {
        param($script,$root)
        $script:fixtureScript=$script;$script:fixtureRoot=$root
        function script:Assert-McpCcOmiDeployment {param($Manifest)}
        function script:Initialize-McpCcOmiSource {[pscustomobject]@{digest=('a'*64);lifecycle=('b'*64);application=('c'*64)}}
        function script:Get-McpCcOmiPreflight {[pscustomobject]@{ownerId='00000000-0000-0000-0000-000000000001';pid=$PID;createdTicks=(Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks}}
        function script:Start-McpCcOmiUpdater {$script:fixtureChild=[McpCc.WorkspaceLocal.OmiFixture]::Child($script:fixtureScript,$script:fixtureRoot);return $script:fixtureChild}
    } $PSCommandPath $FixtureRoot
    try {
        Set-Content (Join-Path $FixtureRoot 'owner-ready') $PID
        $w=[Diagnostics.Stopwatch]::StartNew();$r=$null
        while(-not $r){if($w.Elapsed.TotalSeconds -gt 20){throw 'FIXTURE_REQUEST_TIMEOUT'};$r=$owner.TakePendingOmi();Start-Sleep -Milliseconds 20}
        Invoke-McpCcOmiUpdate $owner $r ([pscustomobject]@{})
        & $module {param($root) [ordered]@{streamDrainBoundReached=$script:fixtureChild.StreamDrainBoundReached}|ConvertTo-Json -Compress|Set-Content (Join-Path $root 'capture.json')} $FixtureRoot
        [McpCc.WorkspaceLocal.OmiFixture]::Receipt($owner,$r.requestId)|Set-Content (Join-Path $FixtureRoot 'result.json') -Encoding UTF8
        Wait-File (Join-Path $FixtureRoot 'release-owner') 30
    } finally {$owner.Dispose()}
    exit 0
}
$script:checks=0
function Check([bool]$Value,[string]$Reason){if(-not $Value){throw "FAIL: $Reason"};$script:checks++}
$FixtureRoot=Join-Path $env:TEMP ('mcpcc-omi-fixture-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $FixtureRoot | Out-Null
$script:checks+=[McpCc.WorkspaceLocal.OmiFixture]::Run((Join-Path $FixtureRoot 'unit'))
$PipeName='mcpcc-omi-fixture-'+[guid]::NewGuid().ToString('N');$RequestId=[guid]::NewGuid().ToString('D')
$owner=Spawn Owner ('-PipeName '+$PipeName)
$successor=$null;$client=$null
try {
    $compiler=Spawn CompileClient
    try{Check ($compiler.WaitForExit(15000) -and $compiler.ExitCode -eq 0 -and (Test-Path (Join-Path $FixtureRoot 'compile-client-ok'))) 'real product client compiler with TEMP/TMP absent restores both'}finally{$compiler.Dispose()}
    Wait-File (Join-Path $FixtureRoot 'owner-ready')
    $client=Spawn Client ('-PipeName '+$PipeName+' -RequestId '+$RequestId+' -OwnerPid '+$owner.Id+' -OwnerTicks '+$owner.StartTime.ToUniversalTime().Ticks)
    Check ($client.WaitForExit(20000) -and $client.ExitCode -eq 0) 'independent short client finishes'
    $reply=Get-Content (Join-Path $FixtureRoot 'client-reply.json') -Raw|ConvertFrom-Json
    Check ($reply.code -ceq 'OMI_APPLY_QUEUED') 'client durably accepted by owner'
    Check (-not $owner.HasExited) 'owner outlives short client'
    Set-Content (Join-Path $FixtureRoot 'client-exited') 'yes'
    Wait-File (Join-Path $FixtureRoot 'result.json') 25
    $r=(Get-Content (Join-Path $FixtureRoot 'result.json') -Raw|ConvertFrom-Json).receipt
    Check ($r.phase -ceq 'ACCEPTED' -and $r.nativeRequestId -and $r.nativeRequestId -cne $RequestId) 'CC UUID retains different native correlation'
    Check ($r.updaterPid -gt 0 -and $r.oldLauncherPid -eq $owner.Id -and $r.expectedLifecycle -ceq ('b'*64)) 'durable owner/worker/source evidence'
    $s=Get-Content (Join-Path $FixtureRoot 'successor.json') -Raw|ConvertFrom-Json
    $successor=Get-Process -Id $s.pid
    Check (-not $successor.HasExited -and $s.stdoutCanWrite -and $s.parentPid -eq $r.updaterPid) 'successor survives updater and client with inherited stdout'
    $capture=Get-Content (Join-Path $FixtureRoot 'capture.json') -Raw|ConvertFrom-Json
    Check ($capture.streamDrainBoundReached) 'inherited stdout really remains open; finite capture does not wait for successor'
    Check (@(Get-Content (Join-Path $FixtureRoot 'invocations.txt')).Count -eq 1) 'one updater invocation'
    $replay=[McpCc.WorkspaceLocal.OmiFixture]::Call($PipeName,'omi_apply',$RequestId,('a'*64),$owner.Id,$owner.StartTime.ToUniversalTime().Ticks)|ConvertFrom-Json
    Check ($replay.code -ceq 'REQUEST_REPLAY' -and $replay.receipt.phase -ceq 'ACCEPTED') 'real IPC replay does not start another updater'
    $module=Import-Module (Join-Path $cc 'src/McpControlCenter.WorkspaceUpdate.psm1') -Force -PassThru
    # Validate the original prefix + final-line receipt using the real adapter.
    $old=[pscustomobject]@{pid=$owner.Id;createdTicks=$owner.StartTime.ToUniversalTime().Ticks}
    $valid=[ordered]@{request_id=[guid]::NewGuid().ToString();action='ApplyUpdate';status='UPDATE_BACKEND_READY';phase='COMPLETE';old_owner_stop='CONFIRMED';owner_pid=$old.pid;owner_created=$owner.StartTime.ToUniversalTime().ToString('o');launcher_adoption='VERIFIED';update_applied='LAUNCHER_AND_BACKEND_VERIFIED';backend_readiness='VERIFIED';frontend_readiness='UNVERIFIED';vbs_invocations=1;successor=@{launcher_pid=$s.pid;launcher_created=$s.created;backend_verified=$true;http_readiness='VERIFIED';loaded_lifecycle_source_id=('b'*64);application_release_id=('c'*64);update_operation=@{request_id='';status='succeeded'}}}
    $valid.successor.update_operation.request_id=$valid.request_id
    $source=[pscustomobject]@{lifecycle=('b'*64);application=('c'*64)}
    $text='EXIT_REQUESTED; waiting...'+"`n"+($valid|ConvertTo-Json -Depth 6 -Compress)
    Check ((& $module {param($s,$v,$old) ConvertFrom-McpCcOmiResult $s 0 $v $old} $text $source $old) -ceq $valid.request_id) 'progress prefix + validated native receipt'
    foreach($case in @('exit','lifecycle','application','correlation','schema','no-json','old-generation')) {
        $v=($valid|ConvertTo-Json -Depth 8|ConvertFrom-Json);$exitCode=0
        switch($case){'exit'{$exitCode=2}'lifecycle'{$v.successor.loaded_lifecycle_source_id='bad'}'application'{$v.successor.application_release_id='bad'}'correlation'{$v.successor.update_operation.request_id=[guid]::NewGuid().ToString()}'schema'{$v.action='arbitrary'}'no-json'{$v=$null}'old-generation'{$v.successor.launcher_pid=$old.pid}}
        $out=if($v){$v|ConvertTo-Json -Depth 8 -Compress}else{'EXIT_REQUESTED'}
        $rejected=$false;try{& $module {param($s,$e,$p,$old) ConvertFrom-McpCcOmiResult $s $e $p $old} $out $exitCode $source $old|Out-Null}catch{$rejected=$true}
        Check $rejected ('reject unverified '+$case)
    }
    # Owner adapter negative paths: no production imports, pipe, updater or OMI IO.
    foreach($case in @('native-busy','source-drift','launch-unknown','native-receipt-unknown')) {
        $gate=[McpCc.WorkspaceLocal.OmiFixture]::Open(('mcpcc-omi-fixture-'+[guid]::NewGuid().ToString('N')),(Join-Path $FixtureRoot $case))
        try {
            & $module {
                param($case)
                $script:gateCase=$case;$script:sourceCalls=0;$script:starts=0
                function script:Assert-McpCcOmiDeployment {param($Manifest)}
                function script:Initialize-McpCcOmiSource {$script:sourceCalls++;[pscustomobject]@{digest=if($script:gateCase -eq 'source-drift' -and $script:sourceCalls -gt 1){'d'*64}else{'a'*64};lifecycle=('b'*64);application=('c'*64)}}
                function script:Get-McpCcOmiPreflight {if($script:gateCase -eq 'native-busy'){throw 'UPDATE_EXECUTION_STOP_REQUIRED'};[pscustomobject]@{ownerId='00000000-0000-0000-0000-000000000001';pid=$PID;createdTicks=(Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks}}
                function script:Start-McpCcOmiUpdater {
                    $script:starts++
                    if($script:gateCase -eq 'launch-unknown'){throw 'OMI_UPDATER_START_FAILED'}
                    $c=[pscustomobject]@{Pid=$PID;CreatedTicks=(Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks;Finished=$true;Output='progress without receipt';ExitCode=0;ErrorCode='OMI_UPDATER_RESULT_UNVERIFIED'}
                    $c|Add-Member ScriptMethod Dispose {};return $c
                }
            } $case
            $key=[guid]::NewGuid().ToString('D');[void][McpCc.WorkspaceLocal.OmiFixture]::Submit($gate,$key,('a'*64))
            Invoke-McpCcOmiUpdate $gate $gate.TakePendingOmi() ([pscustomobject]@{})
            $result=([McpCc.WorkspaceLocal.OmiFixture]::Receipt($gate,$key)|ConvertFrom-Json).receipt
            $expectedPhase=if($case -in @('native-busy','source-drift')){'REJECTED'}else{'RECOVERY_REQUIRED'}
            Check ($result.phase -ceq $expectedPhase) ('preserve refusal/uncertainty '+$case)
            $starts=& $module {$script:starts}
            Check ($starts -eq $(if($expectedPhase -eq 'REJECTED'){0}else{1})) ('no unexpected spawn '+$case)
            [void][McpCc.WorkspaceLocal.OmiFixture]::Submit($gate,$key,('a'*64))
            Check ($null -eq $gate.TakePendingOmi()) ('same UUID cannot retry '+$case)
        }finally{$gate.Dispose()}
    }
    # Current source packager is byte-identical to the selected old packager.
    # Stage only an isolated source copy; never write the real Runtime tree.
    $deployment=Import-Module (Join-Path $cc 'src/McpControlCenter.Deployment.psm1') -Force -PassThru
    $oldPackager=Join-Path $cc 'Runtime/versions/r2-cc-20261031-01/src/McpControlCenter.Deployment.psm1'
    Check ((Get-FileHash $deployment.Path).Hash -ceq (Get-FileHash $oldPackager).Hash) 'official old owner inventory can package this route'
    $packageSource=Join-Path $FixtureRoot 'packaging/mcp_control_center'
    foreach($p in @(& $deployment {$script:CodeFiles})) {
        $to=Join-Path $packageSource $p;[void][IO.Directory]::CreateDirectory((Split-Path $to));[IO.File]::Copy((Join-Path $cc $p),$to)
    }
    $candidate=New-McpCcDeploymentCandidate $packageSource 'fixture-omi'
    Check ($candidate.phase -ceq 'STAGED' -and -not(Test-Path (Join-Path $packageSource 'Runtime/current.json'))) 'isolated candidate only; no selection'
    Check ((Get-Content (Join-Path $candidate.codeRoot 'src/McpControlCenter.WorkspaceUpdate.psm1') -Raw).Contains('function Invoke-McpCcOmiUpdate')) 'fixed route included by existing code inventory'
    Check ((Get-Content (Join-Path $candidate.codeRoot 'scripts/tray.ps1') -Raw).Contains('TakePendingOmi')) 'real tray composition packaged'
    Check (-not(Test-Path (Join-Path $candidate.codeRoot 'scripts/omi-launcher-update-client.ps1'))) 'source-side client cannot silently expand deployed inventory'
} finally {
    Set-Content (Join-Path $FixtureRoot 'release-successor') 'yes'
    Set-Content (Join-Path $FixtureRoot 'release-owner') 'yes'
    if($successor){Check ($successor.WaitForExit(10000)) 'synthetic successor exits cooperatively';$successor.Dispose()}
    Check ($owner.WaitForExit(15000) -and $owner.ExitCode -eq 0) 'synthetic owner exits cooperatively'
    $owner.Dispose();if($client){$client.Dispose()}
}
[ordered]@{ok=$true;checks=$script:checks;evidence='ISOLATED_CC_OWNER_CLIENT_UPDATER_SUCCESSOR';productionPipe=$false;fixtureRoot=$FixtureRoot}|ConvertTo-Json -Compress
