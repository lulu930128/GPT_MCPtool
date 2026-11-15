Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$fixture=Join-Path $root ('.tmp\memory-lifecycle-'+[guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $fixture -Force)
$module=Import-Module (Join-Path $root 'scripts\codex-bridge-runtime.psm1') -Force -PassThru
& $module {
    param($dir)
    $script:stops=0;$script:starts=0;$script:new=$false;$script:fail=$false;$script:wrongBuild=$false;$script:active=$false;$script:preflightBusy=$false
    $script:old=[pscustomobject]@{pid=31001;instance=[guid]::NewGuid().ToString();buildId='fixture';startedAt='2026-11-10T01:00:00.000Z'}
    $script:next=[pscustomobject]@{pid=31002;instance=[guid]::NewGuid().ToString();buildId='fixture';startedAt='2026-11-10T02:00:00.000Z'}
    $script:c=[pscustomobject]@{dataDir=$dir;projectRoot=$dir}
    function script:Assert-CbInstalledMutationBlocked {}
    function script:Get-CbExpectedBuildId {return 'fixture'}
    function script:Assert-CbShutdownPreflight {}
    function script:Assert-CbStartupPreflight {if($script:preflightBusy){throw 'ACTION_BUSY: fixture busy'}}
    function script:Assert-CbCooperativeShutdownAvailable {}
    function script:Assert-CbDailySelected {}
    function script:Test-CbTunnelReady {return $true}
    function script:Get-CbHealth {
        $state=Get-Content (Join-Path $script:c.dataDir 'memory-maintenance.json') -Raw|ConvertFrom-Json
        $identity=if($script:new){$script:next}else{$script:old}
        return [pscustomobject]@{ok=$true;pid=$identity.pid;buildId=$(if($script:wrongBuild -and $script:new){'other'}else{'fixture'});
            jobs=@{scope='all';active=0;awaitingApproval=0};stores=@{jobs='OPEN';review='OPEN'};
            memoryMaintenance=@{intentId=$state.intentId;phase=$state.phase;admission=$(if($state.phase -eq 'cooldown'){'open'}else{'closed'});identity=$identity}}
    }
    function script:Resolve-CbRoleOwnership($Context,$Role,[switch]$ReadOnly) {
        return @{pid=$(if($Role -eq 'tunnel'){32000}elseif($script:new){31002}else{31001});state='OwnedReady';canMutate=$true}
    }
    function script:Get-CbProcess($ProcessId) {return @{StartTimeUtc=$(if($ProcessId -eq 31002){'2026-11-10T02:00:00.000Z'}else{'2026-11-10T01:00:00.000Z'})}}
    function script:Stop-CbOwnedRole($Context,$Role) {if($Role -cne 'server'){throw 'TUNNEL_MUTATION'};if($script:active){throw 'ACTIVE_WORK_PRESENT: fixture accepted work'};$script:stops++}
    function script:Start-CbServer {
        $script:starts++;if($script:fail){throw 'FIXTURE_START_FAILED'};$script:new=$true
        # New Bridge startup owns reconciliation; the controller must not overwrite it.
        $path=Join-Path $script:c.dataDir 'memory-maintenance.json'
        $value=Get-Content $path -Raw|ConvertFrom-Json;$value.phase='cooldown'
        $value|Add-Member next $script:next
        $value|Add-Member completedAt '2026-11-12T00:00:00.000Z'
        $value|Add-Member cooldownUntil '2026-11-12T00:10:00.000Z'
        Write-CbMemoryIntent $path $value
    }
    function New-Intent {
        $script:new=$false;$script:fail=$false;$script:wrongBuild=$false
        $value=@{contract='bridge-memory-maintenance-v1';intentId=[guid]::NewGuid().ToString();phase='ready';reason='HEAP_USED_LIMIT';
            thresholdBytes=1572864000;heapUsed=1572864001;triggeredAt='2026-11-10T01:30:00.000Z';old=$script:old}
        [IO.File]::WriteAllText((Join-Path $script:c.dataDir 'memory-maintenance.json'),($value|ConvertTo-Json -Depth 5))
        return $value
    }
    $intent=New-Intent
    Invoke-CodexBridgeLifecycleAction $script:c RestartCore
    $result=Get-Content (Join-Path $dir 'memory-maintenance.json') -Raw|ConvertFrom-Json
    if($result.phase -cne 'cooldown' -or $script:stops -ne 1 -or $script:starts -ne 1 -or
        ([DateTime]::Parse($result.cooldownUntil)-[DateTime]::Parse($result.completedAt)).TotalSeconds -ne 600){throw 'SUCCESS_CONTRACT_FAILED'}
    $rejected=$false;try{Invoke-CodexBridgeLifecycleAction $script:c RestartCore -MemoryMaintenanceIntentId $intent.intentId}catch{$rejected=$true}
    if(-not$rejected -or $script:starts -ne 1){throw 'REPLAY_NOT_REJECTED'}
    $intent=New-Intent;$script:fail=$true
    try{Invoke-CodexBridgeLifecycleAction $script:c RestartCore -MemoryMaintenanceIntentId $intent.intentId;throw 'EXPECTED_FAILURE'}catch{if($_.Exception.Message -eq 'EXPECTED_FAILURE'){throw}}
    $result=Get-Content (Join-Path $dir 'memory-maintenance.json') -Raw|ConvertFrom-Json
    if($result.phase -cne 'restarting'){throw 'UNKNOWN_RESULT_LOST'}
    $count=$script:starts;try{Invoke-CodexBridgeLifecycleAction $script:c RestartCore -MemoryMaintenanceIntentId $intent.intentId}catch{}
    if($script:starts -ne $count){throw 'FAILURE_REPLAY'}
    $intent=New-Intent;$script:wrongBuild=$true
    try{Invoke-CodexBridgeLifecycleAction $script:c RestartCore -MemoryMaintenanceIntentId $intent.intentId}catch{}
    $result=Get-Content (Join-Path $dir 'memory-maintenance.json') -Raw|ConvertFrom-Json
    if($result.phase -cne 'cooldown'){throw 'NEW_RUNTIME_RESULT_OVERWRITTEN'}
    $intent=New-Intent;$count=$script:starts
    try{Invoke-CodexBridgeLifecycleAction $script:c RestartCore -MemoryMaintenanceIntentId ([guid]::NewGuid().ToString())}catch{}
    if($script:starts -ne $count){throw 'WRONG_INTENT_EXECUTED'}
    $intent=New-Intent;$script:preflightBusy=$true;$count=$script:starts
    try{Invoke-CodexBridgeLifecycleAction $script:c RestartCore}catch{}
    $result=Get-Content (Join-Path $dir 'memory-maintenance.json') -Raw|ConvertFrom-Json
    if($result.phase -cne 'ready' -or $script:starts -ne $count){throw 'PREFLIGHT_BUSY_LATCHED'}
    $script:preflightBusy=$false;$script:active=$true
    try{Invoke-CodexBridgeLifecycleAction $script:c RestartCore}catch{}
    $result=Get-Content (Join-Path $dir 'memory-maintenance.json') -Raw|ConvertFrom-Json
    if($result.phase -cne 'ready' -or $script:starts -ne $count){throw 'ACTIVE_WORK_INTERRUPTED'}
    $script:active=$false;Invoke-CodexBridgeLifecycleAction $script:c RestartCore
    if($script:starts -ne ($count+1)){throw 'DRAIN_RETRY_FAILED'}
    [pscustomobject]@{ok=$true;checks=9;surface='ISOLATED_LIFECYCLE_FIXTURE';productionRestart=$false}
} $fixture | ConvertTo-Json
