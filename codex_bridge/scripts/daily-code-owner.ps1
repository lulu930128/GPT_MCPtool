# Fixed semantic adapter to the existing controller; never accepts a command string.
param([Parameter(Mandatory=$true)][string]$ReleaseRoot,
    [ValidateSet('Preflight','Stop','Stopped','Start','Ready')][string]$Action)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$ps='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
try {
    . (Join-Path $PSScriptRoot 'daily-runtime-settings.ps1')
    $s=Read-CbDailySettings $ReleaseRoot
    $bridge=Join-Path $ReleaseRoot 'codex_bridge'
    # Use the receiver's existing authenticated controller entry, never a new IPC caller.
    if($Action -eq 'Stop'){
        $output=& $ps -NoProfile -NonInteractive -File (Join-Path $bridge 'scripts\runtime-control.ps1') -Action ShutdownRuntime
        $exit=$LASTEXITCODE;$result=($output -join "`n")|ConvertFrom-Json
        if($exit -ne 0 -or -not $result.ok){throw ([string]$result.errorCode)}
        @{ok=$true;action=$Action}|ConvertTo-Json -Compress
        exit 0
    }
    $module=Import-Module (Join-Path $bridge 'scripts\codex-bridge-runtime.psm1') -PassThru -Force
    $context=New-CbDailyContext $bridge -RequireBearer:($Action -in @('Preflight','Start','Ready'))
    $mutex=New-Object Threading.Mutex($false,'Local\CodexBridgeMcpRuntimeControl')
    $held=$false
    try {
        try {$held=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {throw 'DAILY_CONTROLLER_UNKNOWN'}
        if(-not $held){throw 'ACTION_BUSY'}
        switch($Action) {
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
            Start { Invoke-CodexBridgeLifecycleAction -Context $context -Action EnsureRunning }
            Ready {
                $status=Get-CodexBridgeRuntimeStatus -Context $context
                if($status.status -cne 'Ready' -or $status.server.ownership -cne 'OwnedReady' -or $status.tunnel.ownership -cne 'OwnedReady') {throw 'DAILY_READINESS_FAILED'}
                . (Join-Path $PSScriptRoot 'daily-bearer.ps1')
                Assert-CbDailyMcpAuthentication $context
            }
        }
    } finally {$context.token=$null;if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}
    @{ok=$true;action=$Action}|ConvertTo-Json -Compress
} catch {
    $code=([string]$_.Exception.Message -split ':')[0]
    if($code -cnotmatch '^[A-Z][A-Z0-9_]+$'){$code='DAILY_OWNER_FAILED'}
    @{ok=$false;action=$Action;code=$code}|ConvertTo-Json -Compress
    exit 1
}
