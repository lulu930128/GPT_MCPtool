Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'McpControlCenter.Core.psm1')

function Read-McpCcMemoryHealth {
    # Fixed loopback operational contract, never a domain tool or bearer read.
    $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18828/health' -TimeoutSec 3 -MaximumRedirection 0
    if($r.StatusCode -ne 200 -or $r.RawContentLength -gt 65536){throw 'MEMORY_PROBE_FAILED'}
    return $r.Content|ConvertFrom-Json
}
function Invoke-McpCcMemoryMaintenanceTick($Manifest,[string]$RuntimeRoot) {
    # Sample under the existing component mutex; the ordinary action reenters it
    # on this same thread. No independent per-intent claim or handoff receipt.
    $mutex=New-Object Threading.Mutex($false,'Local\McpControlCenter.Action.codex_bridge')
    $acquired=$false
    try {
        try{$acquired=$mutex.WaitOne(0,$false)}catch [Threading.AbandonedMutexException]{$acquired=$true}
        if(-not $acquired){return}
        $health=Read-McpCcMemoryHealth
        if($null -eq $health.PSObject.Properties['memoryMaintenance']){return}
        $m=$health.memoryMaintenance
        if($null -eq $m -or $m.contract -cne 'bridge-memory-maintenance-v1' -or $m.phase -cne 'ready' -or $m.admission -cne 'closed'){return}
        if($m.intentId -cnotmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or
           $health.ok -cne $true -or $health.service -cne 'codex-handoff-bridge' -or $health.pid -ne $m.identity.pid -or
           $health.buildId -cne $m.identity.buildId -or $health.jobs.scope -cne 'all' -or $health.jobs.active -ne 0 -or $health.jobs.awaitingApproval -ne 0){throw 'MEMORY_INTENT_INVALID'}
        $action=$null
        try {
            $action=Invoke-McpCcComponentAction -Manifest $Manifest -ComponentId codex_bridge -Action restart_core `
                -RuntimeRoot $RuntimeRoot -ActionTimeoutSeconds 180
        } catch {
            # Read actual health after a lost result. The original intent's
            # restarting phase prevents another dispatch to the old Core.
        }
        $after=Read-McpCcMemoryHealth
        $verified=$after.ok -ceq $true -and $after.pid -ne $health.pid -and $after.buildId -ceq $health.buildId -and
            $after.memoryMaintenance.intentId -ceq $m.intentId -and $after.memoryMaintenance.phase -ceq 'cooldown' -and
            $after.memoryMaintenance.admission -ceq 'open' -and $after.stores.jobs -ceq 'OPEN' -and $after.stores.review -ceq 'OPEN'
        return [pscustomobject]@{intentId=$m.intentId;phase=$(if($verified){'SUCCEEDED'}elseif($after.pid -eq $health.pid -and $after.memoryMaintenance.phase -ceq 'ready'){'WAITING'}else{'UNKNOWN'});
            code=$(if($verified){'RESTART_OBSERVED'}elseif($null -eq $action){'RESTART_NOT_CONFIRMED'}else{'RESTART_POSTCHECK_UNVERIFIED'})}
    } finally {
        if($acquired){$mutex.ReleaseMutex()};$mutex.Dispose()
    }
}
Export-ModuleMember -Function Invoke-McpCcMemoryMaintenanceTick
