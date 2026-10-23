Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$module=Import-Module (Join-Path $root 'scripts\codex-bridge-runtime.psm1') -Force -PassThru
Add-Type -Path (Join-Path $root 'scripts\OwnedProcess.Native.cs')
$passed=0
function Check([bool]$Value,[string]$Message) { if (-not $Value) { throw $Message }; $script:passed++ }
# A new harmless fixture only. No caller PID and no production listener is used.
$start=New-Object Diagnostics.ProcessStartInfo
$start.FileName=Join-Path $PSHOME 'powershell.exe'
$start.Arguments='-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 60"'
$start.UseShellExecute=$false;$start.CreateNoWindow=$true
$child=[Diagnostics.Process]::Start($start);$native=$null
try {
    $native=& $module {param($id) Open-CbOwnedProcess -ProcessId $id} $child.Id
    Check ($native -is [CbOwnedProcess]) 'PowerShell constructs real native instance'
    $metadata=& $module {param($id) Get-CbProcess -ProcessId $id} $child.Id
    Check ($native.StartTimeUtc -ceq $metadata.StartTimeUtc) 'Native FILETIME and legacy owner timestamp are ordinal-equal'
    Check ($native.ExecutablePath -ieq $metadata.ExecutablePath) 'Native executable equals legacy exact executable'
    Check (-not $native.HasExited) 'New child is live through held handle'
    $native.TerminateAndWait()
    Check $native.HasExited 'Termination waits for the same native instance'
    Check ($child.WaitForExit(5000)) 'Fixture process exited'
    $native.Dispose();$denied=$false
    try { $native.TerminateAndWait() } catch { $denied=$true }
    Check $denied 'Disposed handle cannot be queried or reused'
    $native=$null
    $denied=$false;try { $invalid=New-Object -TypeName CbOwnedProcess -ArgumentList @(0) } catch { $denied=$true }
    Check $denied 'Invalid PID constructor fails closed'
} finally {
    if ($null -ne $native) { $native.Dispose() }
    # Exact Process object from Start; only fixture cleanup, never lookup by arbitrary PID.
    if (-not $child.HasExited) { $child.Kill();$null=$child.WaitForExit(5000) };$child.Dispose()
}

# Deterministic PID-reuse interleavings at the native-open seam. Tests call the real stop
# function and real identity/owner validation. All filesystem state is disposable.
$tempBase=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$fixture=Join-Path $tempBase ('cb-handle-race-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    $results=& $module {
        param($dir)
        $script:testTerminated=0;$script:testDisposed=0;$script:testOpen=0;$script:testResolve=0
        $script:testMode='owned'
        $script:testInstance=[pscustomobject]@{ProcessId=8123;ExecutablePath='C:\fixture\node.exe';StartTimeUtc='2026-01-01T00:00:00.0000000Z';HasExited=$false}
        $script:testInstance | Add-Member ScriptMethod TerminateAndWait {
            if ($script:testMode -eq 'terminate-failure') { throw 'ACCESS_DENIED_FIXTURE' }
            $script:testTerminated++;$this.HasExited=$true
        }
        $script:testInstance | Add-Member ScriptMethod Dispose {$script:testDisposed++}
        function script:Open-CbOwnedProcess {
            param($ProcessId)
            $script:testOpen++
            if ($script:testMode -eq 'open-failure') { throw 'ACCESS_DENIED_FIXTURE' }
            $script:testInstance
        }
        function script:Resolve-CbRoleOwnership {
            $script:testResolve++
            if ($script:testMode -eq 'foreign-listener' -or ($script:testMode -eq 'listener-race' -and $script:testResolve -gt 1)) {
                return [pscustomobject]@{canMutate=$false;state='OwnershipMismatch';pid=8123}
            }
            [pscustomobject]@{canMutate=$true;state='OwnedReady';pid=8123}
        }
        function script:Get-CbHealth { [pscustomobject]@{jobs=[pscustomobject]@{active=0;awaitingApproval=0};controller='ready'} }
        $context=[pscustomobject]@{nodePath='C:\fixture\node.exe';httpEntry='C:\fixture\http-main.js';port=1;
            serverPidFile=(Join-Path $dir 'server.pid');serverOwnerFile=(Join-Path $dir 'server.owner.json');
            tunnelClientPath='C:\fixture\node.exe';tunnelProfile='fixture';tunnelHealthPort=2;
            tunnelPidFile=(Join-Path $dir 'tunnel.pid');tunnelOwnerFile=(Join-Path $dir 'tunnel.owner.json')}
        $out=@()
        foreach ($role in @('server','tunnel')) {
        $definition=Get-CbRoleDefinition $context $role
        foreach ($mode in @('pid-reused','foreign-executable','foreign-listener','listener-race','open-failure','already-exited','terminate-failure','owned')) {
            $script:testMode=$mode;$script:testTerminated=0;$script:testDisposed=0;$script:testOpen=0;$script:testResolve=0
            $script:testInstance.StartTimeUtc='2026-01-01T00:00:00.0000000Z';$script:testInstance.ExecutablePath=$context.nodePath;$script:testInstance.HasExited=$false
            Write-CbAtomicText -Path $definition.pidFile -Value '8123'
            Write-CbOwnerMetadata -Context $context -Role $role -Process $script:testInstance
            if ($mode -eq 'pid-reused') { $script:testInstance.StartTimeUtc='2026-01-01T00:00:01.0000000Z' }
            if ($mode -eq 'foreign-executable') { $script:testInstance.ExecutablePath='C:\foreign\node.exe' }
            if ($mode -eq 'already-exited') { $script:testInstance.HasExited=$true }
            $blocked=$false;try { Stop-CbOwnedRole -Context $context -Role $role } catch { $blocked=$true }
            $out+=[pscustomobject]@{role=$role;mode=$mode;blocked=$blocked;kills=$script:testTerminated;disposed=$script:testDisposed;opens=$script:testOpen;
                evidencePreserved=(Test-Path -LiteralPath $definition.ownerFile)}
        }
        }
        $out
    } $fixture
    foreach ($result in $results) {
        if ($result.mode -eq 'owned' -and $result.role -eq 'server') { Check ($result.blocked -and $result.kills -eq 0 -and $result.disposed -eq 1 -and $result.evidencePreserved) 'Even exact owned core refuses forced termination without cooperative delivery' }
        elseif ($result.mode -eq 'owned') { Check (-not $result.blocked -and $result.kills -eq 1 -and $result.disposed -eq 1 -and -not $result.evidencePreserved) 'Exact owned tunnel retains bounded native termination' }
        else {
            Check ($result.blocked -and $result.kills -eq 0 -and $result.evidencePreserved) ("Rejected without kill or evidence loss: "+$result.mode)
            Check ($result.disposed -eq $(if ($result.mode -in @('foreign-listener','open-failure')) {0} else {1})) ("Dispose on failure: "+$result.mode)
        }
    }
} finally {
    $resolved=[IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith($tempBase+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'UNSAFE_FIXTURE_CLEANUP' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
[pscustomobject]@{ok=$true;assertions=$passed;powershellVersion=$PSVersionTable.PSVersion.ToString();productionRuntimeTouched=$false}|ConvertTo-Json
