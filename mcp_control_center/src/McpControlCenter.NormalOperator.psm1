Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
# Reuse the existing protected-install ACL/path primitives only, never R1 engine or lifecycle.
$script:NormalInstallChecks=Import-Module (Join-Path $PSScriptRoot 'McpControlCenter.InstalledRelease.psm1') -PassThru

function Get-NormalOperatorFailure($Record,[string]$Operation) {
    $errorObject=$Record.Exception
    while ($null -ne $errorObject.InnerException) { $errorObject=$errorObject.InnerException }
    $native=$null
    if ($errorObject -is [ComponentModel.Win32Exception]) { $native=$errorObject.NativeErrorCode }
    $code=if ($errorObject.Message -cmatch '^[A-Z][A-Z0-9_]{2,95}$') { $errorObject.Message } else { 'HOST_PREFLIGHT_FAILED' }
    [pscustomobject]@{ code=$code; operation=$Operation; errorType=$errorObject.GetType().FullName;
        hresult=$errorObject.HResult; nativeErrorCode=$native;
        layer=$(if ($errorObject -is [UnauthorizedAccessException] -or $native -eq 5) { 'permission' } else { 'policy' }) }
}

# Private constructor for a TRANSPORT context, never a Grant/HostLease. All roots
# and peers come from InstalledRelease and OS observations, not protocol fields.
function Open-McpCcNormalInstalledContext {
    param([string]$ManagerRoot,[int]$TrayProcessId)
    & $script:NormalInstallChecks { param($path) Assert-McpCcInstalledAbsolutePath $path } $ManagerRoot
    if ([IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)) -ine $ManagerRoot) { throw 'SOURCE_ROOT_MISMATCH' }
    Assert-McpCcProtectedCodePath $ManagerRoot
    $release=Read-McpCcInstalledRelease $ManagerRoot
    if ($release.schemaVersion -lt 3) { throw 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED' }
    $manifestPin=(Get-FileHash -LiteralPath $release.sourcePath -Algorithm SHA256).Hash
    # OwnerBinding already verifies the complete protected tree. Bind that
    # verification to this exact manifest instead of walking it twice at setup.
    $ownerBinding=Get-McpCcInstalledOwnerBinding $ManagerRoot
    if ($ownerBinding.releaseRoot -ine $release.root -or
        (Get-FileHash -LiteralPath $release.sourcePath -Algorithm SHA256).Hash -cne $manifestPin) { throw 'INSTALLED_CLOSURE_CHANGED' }
    Assert-McpCcInstalledSelection $ownerBinding -TrayBootstrap:($TrayProcessId -eq $PID)
    $nativePath=Join-Path $PSScriptRoot 'NormalOperator.Host.dll'
    Assert-McpCcProtectedCodePath $nativePath
    if (-not ('McpCcNormalHost' -as [type])) { Add-Type -Path $nativePath }
    foreach($name in @('McpCcNormalNative','McpCcNormalPipe','McpCcNormalSecurity','McpCcNormalExecution','McpCcNormalHost')) {
        $type=$name -as [type]
        if ($null -eq $type -or $type.Assembly.Location -ine $nativePath) { throw 'NORMAL_LOADED_SOURCE_REJECTED' }
    }
    $process=Get-Process -Id $TrayProcessId -ErrorAction Stop
    try {
        $proof=[McpCcNormalNative]::Inspect($process)
        $token=[McpCcNormalSecurity]::Observe($process)
        [McpCcNormalSecurity]::AssertNormal($token,[string]$release.state.operatorSid,$proof.session)
        if ($proof.inAnyJob) { throw 'OWNER_IN_JOB' }
        $expectedImage='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
        if ($proof.image -ine $expectedImage) { throw 'TRAY_IMAGE_REJECTED' }
        $cim=Get-CimInstance Win32_Process -Filter "ProcessId=$TrayProcessId" -ErrorAction Stop
        $tray=Join-Path $ManagerRoot 'scripts\tray.ps1'
        $pattern='(?i)^"?'+[regex]::Escape($expectedImage)+'"?\s+-NoProfile\s+(?:-WindowStyle\s+Hidden\s+)?-File\s+"'+[regex]::Escape($tray)+'"(?:\s+-AutoReconcile)?\s*$'
        if ($null -eq $cim -or $cim.CommandLine -inotmatch $pattern) { throw 'EXACT_TRAY_OWNER_REQUIRED' }
        [McpCcNormalSecurity]::AssertUnchanged($process,$token)
        $peer=[McpCcNormalPipe+Peer]::Retain($proof.pid,$proof.sid,$proof.image,$proof.session,$proof.startedUtcTicks,$true)
        return [pscustomobject]@{ release=$release; peer=$peer; channel=[McpCcNormalPipe]::OwnerChannel($proof);
            pin=$manifestPin; proof=$proof; sessionCheckedAt=$null }
    } finally { $process.Dispose() }
}
function Assert-McpCcNormalBinding($Context) {
    Assert-McpCcProtectedCodePath $Context.release.sourcePath
    if ((Get-FileHash -LiteralPath $Context.release.sourcePath -Algorithm SHA256).Hash -cne $Context.pin) { throw 'INSTALLED_CLOSURE_CHANGED' }
    $Context.peer.Check()
}
function Assert-McpCcNormalClosure($Context) {
    $Context.sessionCheckedAt=$null
    Assert-McpCcNormalBinding $Context
    Assert-McpCcInstalledClosure $Context.release
    Assert-McpCcNormalBinding $Context
}
function Assert-McpCcNormalSession($Context) {
    # A successful resolver owns exactly one bounded native session. Consume the
    # reuse before checking; failure/timeout cannot leave a reusable proof.
    $checkedAt=$Context.sessionCheckedAt
    $Context.sessionCheckedAt=$null
    if ($null -eq $checkedAt) { throw 'NORMAL_SESSION_UNVERIFIED' }
    $elapsed=([Diagnostics.Stopwatch]::GetTimestamp()-$checkedAt)/[Diagnostics.Stopwatch]::Frequency
    if ($elapsed -lt 0 -or $elapsed -ge 120) { throw 'NORMAL_SESSION_EXPIRED' }
    Assert-McpCcNormalBinding $Context
}
function Open-McpCcNormalBridgePeer($Context,[int]$ClientId) {
    # ClientId is GetNamedPipeClientProcessId, not an IPC field. Its parent must be
    # the installed Node entrypoint; retain BOTH handles for the session lifetime.
    Assert-McpCcNormalClosure $Context
    $release=$Context.release
    $client=Get-Process -Id $ClientId -ErrorAction Stop
    $parent=$null;$peer=$null;$parentPeer=$null
    try {
        $identity=[McpCcNormalNative]::Inspect($client)
        $cim=Get-CimInstance Win32_Process -Filter "ProcessId=$ClientId" -ErrorAction Stop
        $coreId=[int]$cim.ParentProcessId
        $image='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
        $script=Join-Path $release.root 'codex_bridge\scripts\powershell-host-transport.ps1'
        $helperPattern='(?i)^"?'+[regex]::Escape($image)+'"?\s+-NoProfile\s+-NonInteractive\s+-File\s+"?'+[regex]::Escape($script)+'"?\s+-CoreId\s+'+$coreId+'\s*$'
        if ($identity.image -ine $image -or $cim.CommandLine -inotmatch $helperPattern -or
            $identity.sid -cne $release.state.operatorSid -or $identity.session -ne $Context.proof.session) { throw 'BRIDGE_HELPER_REJECTED' }
        $parent=Get-Process -Id $coreId -ErrorAction Stop
        $node=[McpCcNormalNative]::Inspect($parent)
        $command=Get-CimInstance Win32_Process -Filter "ProcessId=$coreId" -ErrorAction Stop
        $entry=Join-Path $release.root 'codex_bridge\dist\src\http-main.js'
        $nodePath=$release.dependencies.node.path
        $nodePattern='(?i)^"?'+[regex]::Escape($nodePath)+'"?\s+"?'+[regex]::Escape($entry)+'"?\s*$'
        if ($node.image -ine $nodePath -or $command.CommandLine -inotmatch $nodePattern -or
            $node.sid -cne $identity.sid -or $node.session -ne $identity.session -or $node.startedUtcTicks -gt $identity.startedUtcTicks) { throw 'BRIDGE_PARENT_REJECTED' }
        $parentPeer=[McpCcNormalPipe+Peer]::Retain($node.pid,$node.sid,$node.image,$node.session,$node.startedUtcTicks,$false)
        $peer=[McpCcNormalPipe+Peer]::Retain($identity.pid,$identity.sid,$identity.image,$identity.session,$identity.startedUtcTicks,$false)
        $null=$peer.BindParent($parentPeer);$parentPeer=$null
        $Context.sessionCheckedAt=[Diagnostics.Stopwatch]::GetTimestamp()
        $result=$peer;$peer=$null;return $result
    } finally {
        if($peer){$peer.Dispose()};if($parentPeer){$parentPeer.Dispose()}
        if($parent){$parent.Dispose()};$client.Dispose()
    }
}
function Get-McpCcNormalOperatorPreflight {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ManagerRoot,[Parameter(Mandatory)][int]$TrayProcessId)
    $context=$null
    try {
        $context=Open-McpCcNormalInstalledContext $ManagerRoot $TrayProcessId
        return [pscustomobject]@{contract='normal-operator-host-gate-v1';enabled=$false;status='AUTHENTICATED_DIRECT_REQUEST_REQUIRED';
            humanApproval='REMOTE_MCP_REQUEST';canonicalAuthority='RETAINED_NATIVE_CHANNEL_REQUIRED';
            admin='BLOCKED_AWAITING_LOCAL_UAC';automaticResume=$false}
    } catch {
        [pscustomobject]@{ contract='normal-operator-host-gate-v1';enabled=$false;status='BLOCKED';
            failure=(Get-NormalOperatorFailure $_ 'installed native transport preflight');
            humanApproval='BLOCKED_PLATFORM_CAPABILITY';canonicalAuthority='BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED';
            osIpc='SOURCE_IMPLEMENTED_NOT_DEPLOYED';normalRunner='COMPOSED_HOST_LEASE_SEALED';
            admin='BLOCKED_AWAITING_LOCAL_UAC';automaticResume=$false }
    } finally { if($context){$context.peer.Dispose()} }
}
function Invoke-McpCcNormalOperatorOwner {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ManagerRoot,[Parameter(Mandatory)][int]$TrayProcessId,
        [Threading.CancellationToken]$Cancellation=[Threading.CancellationToken]::None)
    if ($TrayProcessId -ne $PID) { throw 'SINGLE_TRAY_OWNER_REQUIRED' }
    $context=$null;$listener=$null
    try {
        $Cancellation.ThrowIfCancellationRequested()
        $context=Open-McpCcNormalInstalledContext $ManagerRoot $TrayProcessId
        $Cancellation.ThrowIfCancellationRequested()
        $resolver=[Func[int,McpCcNormalPipe+Peer]] { param($observedPid) Open-McpCcNormalBridgePeer $context $observedPid }
        $handler=[Action[McpCcNormalPipe+Channel]] { param($channel)
            # Listener calls this only after the resolver and native handshake.
            # Channel retains/rechecks the exact client and parent on every IO.
            Assert-McpCcNormalSession $context
            [McpCcNormalHost]::Serve($channel)
        }
        # Keep the existing owner available for distinct requests. Each session
        # still has a fresh authenticated peer, sequence and durable single claim.
        while (-not $Cancellation.IsCancellationRequested) {
            # A new connection gets a fresh full closure in its resolver. Only
            # the duplicate walk in that same session's handler is reused.
            $listener=New-Object McpCcNormalPipe+Listener($context.channel,[string]$context.release.state.operatorSid)
            try { $listener.Serve($resolver,$handler,$Cancellation) }
            catch {
                if ($Cancellation.IsCancellationRequested) { break }
                # The failed exchange returns through the client's transport.
                # Never replay it; wait for the next independent MCP request.
            } finally { $context.sessionCheckedAt=$null;$listener.Dispose();$listener=$null }
        }
        return [pscustomobject]@{contract='normal-operator-host-gate-v1';enabled=$false;status='STOPPED';automaticResume=$false}
    } catch {
        [pscustomobject]@{ contract='normal-operator-host-gate-v1';enabled=$false;status='BLOCKED';
            failure=(Get-NormalOperatorFailure $_ 'authenticated native host session');automaticResume=$false }
    } finally { if($listener){$listener.Dispose()};if($context){$context.peer.Dispose()} }
}
Export-ModuleMember -Function Get-McpCcNormalOperatorPreflight,Invoke-McpCcNormalOperatorOwner
