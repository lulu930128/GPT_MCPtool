# Fixed semantic adapter to the existing controller; never accepts a command string.
param([Parameter(Mandatory=$true)][string]$ReleaseRoot,
    [ValidateSet('Preflight','Stop','Stopped','Start','Ready','Observe','RecoverStopped','Verify')][string]$Action,
    [ValidatePattern('^[0-9a-f]{32}$')][string]$OperationId)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$ps='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
try {
    . (Join-Path $PSScriptRoot 'daily-runtime-settings.ps1')
    $s=Read-CbDailySettings $ReleaseRoot
    $bridge=Join-Path $ReleaseRoot 'codex_bridge'
    $module=Import-Module (Join-Path $bridge 'scripts\codex-bridge-runtime.psm1') -PassThru -Force
    $context=New-CbDailyContext $bridge -RequireBearer:($Action -in @('Preflight','Start','Ready','Verify'))
    $helper=Join-Path $PSScriptRoot 'daily-lifecycle.ps1'
    $lease=$null;$evidence=$null
    $mutex=New-Object Threading.Mutex($false,'Local\CodexBridgeMcpRuntimeControl')
    $held=$false
    try {
        $lease=& $module {param($c,$h) . $h;Open-CbDailyMutation $c} $context $helper
        # Stop delegates to the ORIGINAL receiver-authenticated controller. Do
        # not hold its lifecycle mutex in this parent while waiting for the child.
        if($Action -eq 'Stop'){
            $output=& $ps -NoProfile -NonInteractive -File (Join-Path $bridge 'scripts\runtime-control.ps1') -Action ShutdownRuntime
            $exit=$LASTEXITCODE;$result=($output -join "`n")|ConvertFrom-Json
            if($exit -ne 0 -or -not $result.ok){throw ([string]$result.errorCode)}
            @{ok=$true;action=$Action}|ConvertTo-Json -Compress
            exit 0
        }
        try {$held=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$held=$true}
        if(-not $held){throw 'ACTION_BUSY'}
        switch($Action) {
            Observe {$evidence=& $module {param($c,$h) . $h;Get-CbDailyObservation $c} $context $helper}
            RecoverStopped {
                if(-not $OperationId){throw 'DAILY_OPERATION_REQUIRED'}
                $operation=Join-Path (Split-Path -Parent (Split-Path -Parent $ReleaseRoot)) ('operations\'+$OperationId)
                if(-not(Test-Path -LiteralPath (Join-Path $operation 'intent.json'))){throw 'DAILY_OPERATION_REQUIRED'}
                $evidence=& $module {param($c,$h,$op) . $h;Complete-CbDailyStopped $c $op} $context $helper $operation
            }
            Preflight {
                & $module {param($c) Assert-CbStartupPreflight $c -IncludeTunnel} $context
                & $module {Initialize-CbCooperativeNative}
                # Candidate preflight validates local launch inputs only. Authentication
                # is verified by Ready against the newly selected runtime after start.
            }
            Stopped {
                & $module {param($c)
                    foreach($role in @('server','tunnel')) {
                        $o=Resolve-CbRoleOwnership -Context $c -Role $role -ReadOnly
                        if(-not $o.canMutate -or $o.state -cne 'Stopped'){throw 'DAILY_STOP_NOT_CONFIRMED'}
                    }
                } $context
                if(Test-Path -LiteralPath (Join-Path $s.dataDir 'powershell-approval\approval.lock')){throw 'DAILY_STATE_LOCK_PRESENT'}
            }
            Start {
                # Clear the lease before entering even an OLD module's process
                # factory. Only short-lived owner -> controller keeps delegation.
                $saved=@{}
                foreach($name in @('CB_DAILY_PARENT_PID','CB_DAILY_PARENT_TICKS','CB_DAILY_LOCK_HANDLE')){
                    $saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process')
                    [Environment]::SetEnvironmentVariable($name,$null,'Process')
                }
                try {Invoke-CodexBridgeLifecycleAction -Context $context -Action EnsureRunning}
                finally {foreach($name in $saved.Keys){[Environment]::SetEnvironmentVariable($name,$saved[$name],'Process')}}
            }
            {$_ -in @('Ready','Verify')} {
                $status=Get-CodexBridgeRuntimeStatus -Context $context
                if($status.status -cne 'Ready' -or $status.server.ownership -cne 'OwnedReady' -or $status.tunnel.ownership -cne 'OwnedReady') {throw 'DAILY_READINESS_FAILED'}
                . (Join-Path $PSScriptRoot 'daily-bearer.ps1')
                $store=Assert-CbDailyMcpAuthentication $context -RequireReviewStore
                $loaded=& $module {param($c) $health=Get-CbHealth $c;return [string]$health.buildId} $context
                if($loaded -cne $status.canonicalBuildId){throw 'DAILY_BUILD_IDENTITY_CHANGED'}
                $evidence=@{version=(Split-Path -Leaf $ReleaseRoot);buildId=$loaded;preparedBuildId=$status.canonicalBuildId;reviewStore=$store;ownedPids=@($status.ownedPids)}
            }
        }
    } finally {$context.token=$null;if($held){$mutex.ReleaseMutex()};$mutex.Dispose();if($lease){$lease.Dispose()}}
    @{ok=$true;action=$Action;evidence=$evidence}|ConvertTo-Json -Compress -Depth 8
} catch {
    $code=([string]$_.Exception.Message -split ':')[0]
    if($code -cnotmatch '^[A-Z][A-Z0-9_]+$'){$code='DAILY_OWNER_FAILED'}
    @{ok=$false;action=$Action;code=$code}|ConvertTo-Json -Compress
    exit 1
}
