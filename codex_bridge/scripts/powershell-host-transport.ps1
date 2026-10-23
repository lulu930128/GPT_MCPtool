param([Parameter(Mandatory=$true)][int]$CoreId)
# Fixed installed transport child of Bridge. No candidate execution, local UI,
# secret input, Grant issuer, Journal, service or lifecycle operation.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$context=$null;$bridgePeer=$null
try {
    $manager=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\mcp_control_center'))
    $install=Import-Module (Join-Path $manager 'src\McpControlCenter.InstalledRelease.psm1') -PassThru
    $normal=Import-Module (Join-Path $manager 'src\McpControlCenter.NormalOperator.psm1') -PassThru
    $binding=Get-McpCcInstalledOwnerBinding $manager
    Assert-McpCcInstalledSelection $binding
    $pidPath=Join-Path $binding.ownerRoot 'tray.pid'
    & $install { param($p,$sid) Assert-McpCcInstalledPrivatePath $p $sid } $pidPath $binding.operatorSid
    $raw=[IO.File]::ReadAllText($pidPath)
    if($raw -cnotmatch '^\d{1,10}$'){throw 'INSTALLED_OWNER_UNKNOWN'}
    $trayId=[int]$raw
    $context=& $normal { param($r,$p) Open-McpCcNormalInstalledContext $r $p } $manager $trayId
    $self=Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
    if($null -eq $self -or $self.ParentProcessId -ne $CoreId){throw 'BRIDGE_PARENT_REJECTED'}
    # Uses the same exact installed child/parent verifier as the server, retaining
    # the native parent handle throughout RPC. CoreId alone never proves identity.
    $bridgePeer=& $normal { param($c,$p) Open-McpCcNormalBridgePeer $c $p } $context $PID
    [McpCcNormalHost]::Relay($context.channel,$context.peer,$bridgePeer)
} catch {
    # No raw exceptions, paths, request bytes, token material or stdout/stderr leak.
    [Console]::Error.WriteLine('HOST_TRANSPORT_UNAVAILABLE')
    exit 1
} finally {
    if($bridgePeer){$bridgePeer.Dispose()}
    if($context){$context.peer.Dispose()}
}
