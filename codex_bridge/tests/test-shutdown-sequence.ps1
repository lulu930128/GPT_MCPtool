# Actual lifecycle functions with synthetic process/IPC/IO boundaries. No OS E2E claim.
param([string]$RuntimeModule=(Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\codex-bridge-runtime.psm1'))
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$checks=0
function Check($Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
Add-Type -TypeDefinition @'
using System;
public sealed class CbOwnedProcess : IDisposable {
    public int ProcessId;
    public string ExecutablePath;
    public string StartTimeUtc = "2026-01-01T00:00:00.0000000Z";
    public bool HasExited, Disposed, WaitFailure;
    public int Terminations;
    public void WaitForExit(int timeout) { if(WaitFailure) throw new TimeoutException(); HasExited=true; }
    public void TerminateAndWait() { Terminations++; HasExited=true; }
    public void Dispose() { Disposed=true; }
}
'@
$module=Import-Module $RuntimeModule -PassThru -Force
try {
    & $module {
        $script:ctx=[pscustomobject]@{nodePath='C:\fixture\node.exe';requireAllJobs=$true;
            serverPidFile='server.pid';serverOwnerFile='server.owner';tunnelPidFile='tunnel.pid';tunnelOwnerFile='tunnel.owner';
            port=1;tunnelHealthPort=2;httpEntry='fixture';tunnelProfile='fixture';tunnelClientPath='C:\fixture\tunnel.exe'}
        function script:Reset-Fixture {
            $script:core=New-Object CbOwnedProcess;$script:core.ProcessId=101;$script:core.ExecutablePath=$script:ctx.nodePath
            $script:tunnel=New-Object CbOwnedProcess;$script:tunnel.ProcessId=102;$script:tunnel.ExecutablePath=$script:ctx.tunnelClientPath
            $script:mode='ok';$script:healthReadsAfterExit=0;$script:removed=New-Object 'System.Collections.Generic.List[string]'
        }
        function script:Assert-CbInstalledMutationBlocked {param($Context)}
        function script:Get-CbExpectedBuildId {param($Context) 'fixture'}
        function script:Resolve-CbRoleOwnership {param($Context,$Role,[switch]$ReadOnly)
            $p=if($Role -eq 'server'){$script:core}else{$script:tunnel}
            if($Role -eq 'server' -and $p.HasExited -and $script:mode -eq 'replacement'){
                return [pscustomobject]@{state='Foreign';canMutate=$false;pid=303}
            }
            if($Role -eq 'tunnel' -and $script:core.HasExited -and $script:mode -eq 'tunnel-changed'){
                return [pscustomobject]@{state='OwnershipUnknown';canMutate=$false;pid=404}
            }
            [pscustomobject]@{state=$(if($p.HasExited){'Stopped'}else{'OwnedReady'});canMutate=$true;pid=$(if($p.HasExited){$null}else{$p.ProcessId})}
        }
        function script:Get-CbHealth {param($Context)
            if($script:core.HasExited){$script:healthReadsAfterExit++;return $null}
            if($script:mode -eq 'unknown-work'){return $null}
            [pscustomobject]@{controller='ready';jobs=[pscustomobject]@{scope='all';active=$(if($script:mode -eq 'active'){1}else{0});awaitingApproval=0}}
        }
        function script:Open-CbOwnedProcess {param($ProcessId,[switch]$QueryOnly)
            if($ProcessId -eq 101){if(-not $QueryOnly){throw 'CORE_MUST_BE_QUERY_ONLY'};return $script:core}
            if($ProcessId -eq 102){return $script:tunnel};throw 'UNEXPECTED_PID'
        }
        function script:Test-CbExecutableIdentity {param($Context,$Role,$Process) $true}
        function script:Test-CbOwnerMetadata {param($Context,$Role,$Process) $true}
        function script:Invoke-CbCooperativeExchange {param($Context,$ProcessId,$Action,$ExpectedInstance)
            if($Action -eq 'shutdown'){
                if(-not [object]::ReferenceEquals($ExpectedInstance,$script:core)){throw 'CORE_HANDLE_CHANGED'}
                if($script:mode -eq 'lost-response'){throw 'COOPERATIVE_SHUTDOWN_UNKNOWN'}
            }
        }
        function script:Remove-CbRuntimeFile {param($Path,$ExpectedPid) $script:removed.Add($Path)}
        Reset-Fixture
    }
    & $module {Invoke-CodexBridgeLifecycleAction $script:ctx ShutdownRuntime}
    $state=& $module {[pscustomobject]@{core=$script:core;tunnel=$script:tunnel;health=$script:healthReadsAfterExit;removed=$script:removed.ToArray()}}
    Check ($state.core.HasExited -and $state.tunnel.Terminations -eq 1) 'Shutdown must finish core then tunnel'
    Check ($state.health -eq 0) 'Closed core must not be asked for health again'
    Check ($state.core.Disposed -and $state.tunnel.Disposed) 'Both retained handles must close'
    Check (($state.removed -join ',') -ceq 'server.pid,server.owner,tunnel.pid,tunnel.owner') 'Only stopped roles lose ownership markers'
    foreach($case in @(
        @{mode='active';code='ACTIVE_WORK_PRESENT'},
        @{mode='unknown-work';code='ACTIVE_STATE_UNKNOWN'},
        @{mode='lost-response';code='COOPERATIVE_SHUTDOWN_UNKNOWN'},
        @{mode='wait-timeout';code='COOPERATIVE_SHUTDOWN_UNKNOWN'},
        @{mode='replacement';code='CORE_STOP_EVIDENCE_REJECTED'},
        @{mode='tunnel-changed';code='OWNERSHIP_MISMATCH'})){
        & $module {param($mode) Reset-Fixture;$script:mode=$mode;$script:core.WaitFailure=$mode -eq 'wait-timeout'} $case.mode
        $failure=$null
        try {& $module {Invoke-CodexBridgeLifecycleAction $script:ctx ShutdownRuntime}}catch{$failure=$_.Exception.Message}
        Check ($failure -like ($case.code+'*')) ('Expected '+$case.mode+' to fail closed; got '+$failure)
        $state=& $module {[pscustomobject]@{core=$script:core;tunnel=$script:tunnel;removed=$script:removed.ToArray()}}
        Check ($state.tunnel.Terminations -eq 0 -and $state.removed -notcontains 'tunnel.pid') ('Refusal must preserve tunnel: '+$case.mode)
    }
    # The private role function still requires live idle evidence without a retained core handle.
    & $module {Reset-Fixture;$script:core.HasExited=$true}
    $failure=$null
    try {& $module {Stop-CbOwnedRole $script:ctx tunnel}}catch{$failure=$_.Exception.Message}
    Check ($failure -like 'ACTIVE_STATE_UNKNOWN*') 'Absent core alone is not authority to finish a partial stop'
    foreach($case in @('json-proof','live-handle','wrong-image')){
        $failure=$null
        try {& $module {param($mode)
            Reset-Fixture;$script:core.HasExited=$true
            $proof=$script:core
            if($mode -eq 'json-proof'){$proof=[pscustomobject]@{HasExited=$true;ExecutablePath=$script:ctx.nodePath}}
            if($mode -eq 'live-handle'){$script:core.HasExited=$false}
            if($mode -eq 'wrong-image'){$script:core.ExecutablePath='C:\fixture\other.exe'}
            Stop-CbOwnedRole $script:ctx tunnel -StoppedCoreHandle $proof
        } $case}catch{$failure=$_.Exception.Message}
        Check ($failure -like 'CORE_STOP_EVIDENCE_REJECTED*') ('Invalid proof accepted: '+$case)
        Check ((& $module {$script:tunnel.Terminations}) -eq 0) ('Invalid proof terminated tunnel: '+$case)
    }
    [pscustomobject]@{ok=$true;checks=$checks;shutdown='ACTUAL_FUNCTIONS_SYNTHETIC_BOUNDARIES';nativePipe='NOT_RUN';runtimeTouched=$false}|ConvertTo-Json
}finally {Remove-Module $module -Force}
