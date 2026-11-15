Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$fixture=Join-Path $root ('.tmp\memory-maintenance-'+[guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $fixture -Force)
$module=Import-Module (Join-Path $root 'src\McpControlCenter.MemoryMaintenance.psm1') -Force -PassThru
& $module {
    param($dir)
    $script:dispatches=0;$script:lost=$false;$script:done=$false;$script:busy=$false;$script:pending=$false;$script:lostAfter=$false
    $script:id=[guid]::NewGuid().ToString()
    $script:instance=[guid]::NewGuid().ToString()
    function script:Read-McpCcMemoryHealth {
        return [pscustomobject]@{ok=$true;service='codex-handoff-bridge';pid=$(if($script:done){102}else{101});buildId='fixture';
            jobs=@{scope='all';active=0;awaitingApproval=0};stores=@{jobs='OPEN';review='OPEN'};memoryMaintenance=@{contract='bridge-memory-maintenance-v1';intentId=$script:id;
                phase=$(if($script:done){'cooldown'}elseif($script:pending){'restarting'}else{'ready'});admission=$(if($script:done){'open'}else{'closed'});
                identity=@{pid=$(if($script:done){102}else{101});instance=$script:instance;buildId='fixture';startedAt='2026-11-10T00:00:00.000Z'}}}
    }
    function script:Invoke-McpCcComponentAction($Manifest,$ComponentId,$Action,$RuntimeRoot,$ActionTimeoutSeconds,$MemoryMaintenanceIntentId) {
        if($ComponentId -cne 'codex_bridge' -or $Action -cne 'restart_core' -or $MemoryMaintenanceIntentId){throw 'WRONG_DISPATCH'}
        $script:dispatches++;if($script:busy){throw 'ACTION_BUSY'}
        $script:pending=$true;if($script:lost){throw 'FIXTURE_LOST_ACK'};$script:done=$true
        if($script:lostAfter){throw 'FIXTURE_RESULT_LOST_AFTER_RESTART'}
        return @{delegated=$true;exitCode=0}
    }
    $result=Invoke-McpCcMemoryMaintenanceTick @{} $dir
    if($result.phase -cne 'SUCCEEDED' -or $script:dispatches -ne 1){throw 'SUCCESS_FAILED'}
    $null=Invoke-McpCcMemoryMaintenanceTick @{} $dir
    if($script:dispatches -ne 1){throw 'DUPLICATE_DISPATCH'}
    $script:id=[guid]::NewGuid().ToString();$script:lost=$true;$script:done=$false;$script:pending=$false
    $result=Invoke-McpCcMemoryMaintenanceTick @{} $dir
    if($result.phase -cne 'UNKNOWN'){throw 'UNKNOWN_UPGRADED'}
    $null=Invoke-McpCcMemoryMaintenanceTick @{} $dir
    if($script:dispatches -ne 2){throw 'UNKNOWN_REPLAYED'}
    $script:pending=$false;$script:lost=$false;$script:busy=$true
    $result=Invoke-McpCcMemoryMaintenanceTick @{} $dir
    if($result.phase -cne 'WAITING'){throw 'BUSY_PERMANENTLY_LATCHED'}
    $script:busy=$false;$result=Invoke-McpCcMemoryMaintenanceTick @{} $dir
    if($result.phase -cne 'SUCCEEDED' -or $script:dispatches -ne 4){throw 'NEXT_POLL_FAILED'}
    if(Test-Path (Join-Path $dir 'memory-maintenance')){throw 'EXTRA_RECEIPT_GATE'}
    # The same component mutex held by another thread prevents even a health poll.
    $worker=[PowerShell]::Create()
    $started=[Threading.ManualResetEventSlim]::new($false);$release=[Threading.ManualResetEventSlim]::new($false)
    [void]$worker.AddScript('param($started,$release) $m=New-Object Threading.Mutex($false,"Local\McpControlCenter.Action.codex_bridge");$null=$m.WaitOne();try{$started.Set();$null=$release.Wait(5000)}finally{$m.ReleaseMutex();$m.Dispose()}').AddArgument($started).AddArgument($release)
    $pending=$worker.BeginInvoke()
    if(-not $started.Wait(5000)){throw 'FIXTURE_MUTEX_NOT_ACQUIRED'}
    $script:done=$false;$script:pending=$false;$count=$script:dispatches
    $null=Invoke-McpCcMemoryMaintenanceTick @{} $dir
    $release.Set();$null=$worker.EndInvoke($pending);$worker.Dispose();$started.Dispose();$release.Dispose()
    if($script:dispatches -ne $count){throw 'CONCURRENT_RESTART'}
    $result=Invoke-McpCcMemoryMaintenanceTick @{} $dir
    if($result.phase -cne 'SUCCEEDED'){throw 'MUTEX_NEXT_POLL_FAILED'}
    $script:done=$false;$script:pending=$false;$script:lostAfter=$true
    $result=Invoke-McpCcMemoryMaintenanceTick @{} $dir
    if($result.phase -cne 'SUCCEEDED'){throw 'HEALTHY_REPLACEMENT_IGNORED_AFTER_LOST_RESULT'}
    [pscustomobject]@{ok=$true;checks=10;surface='ISOLATED_CC_FIXTURE';dispatches=$script:dispatches;productionRestart=$false}
} $fixture | ConvertTo-Json
