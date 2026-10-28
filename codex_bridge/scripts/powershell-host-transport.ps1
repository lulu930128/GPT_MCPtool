param([Parameter(Mandatory=$true)][int]$CoreId)
# Fixed installed transport child of Bridge. No candidate execution, local UI,
# secret input, Grant issuer, Journal, service or lifecycle operation.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$context=$null;$bridgePeer=$null
try {
    $bridgeRoot=Split-Path -Parent $PSScriptRoot
    . (Join-Path $PSScriptRoot 'cooperative-layout.ps1')
    $daily=Get-CbCooperativeDailyLayout $bridgeRoot
    if($null -ne $daily){
        $wrapper=Get-CbCooperativeControllerWrapper $bridgeRoot
        $manager=Split-Path -Parent (Split-Path -Parent $wrapper)
        $deployment=Import-Module (Join-Path $manager 'src\McpControlCenter.Deployment.psm1') -PassThru
        $layout=Get-McpCcDeploymentLayout $manager
        Assert-McpCcDeploymentSelected $layout
        $pidPath=Join-Path $layout.stateRoot 'tray.pid'
        & $deployment {param($p) Assert-CcDeploymentPath $p} $pidPath
    } else {
        $manager=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\mcp_control_center'))
        $install=Import-Module (Join-Path $manager 'src\McpControlCenter.InstalledRelease.psm1') -PassThru
        $binding=Get-McpCcInstalledOwnerBinding $manager
        Assert-McpCcInstalledSelection $binding
        $pidPath=Join-Path $binding.ownerRoot 'tray.pid'
        & $install { param($p,$sid) Assert-McpCcInstalledPrivatePath $p $sid } $pidPath $binding.operatorSid
    }
    $normal=Import-Module (Join-Path $manager 'src\McpControlCenter.NormalOperator.psm1') -PassThru
    if(-not(Test-Path -LiteralPath (Join-Path $manager 'src\NormalOperator.Host.dll') -PathType Leaf)){throw 'NORMAL_HOST_BINARY_MISSING'}
    if(-not(Test-Path -LiteralPath $pidPath -PathType Leaf)){throw 'NORMAL_HOST_LISTENER_NOT_RUNNING'}
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
    $failure=$_.Exception
    while($null -ne $failure.InnerException){$failure=$failure.InnerException}
    $code='NORMAL_HOST_OWNER_REJECTED'
    if($failure -is [UnauthorizedAccessException] -or ($failure -is [ComponentModel.Win32Exception] -and $failure.NativeErrorCode -eq 5)){$code='NORMAL_HOST_ACCESS_DENIED'}
    elseif($failure -is [ComponentModel.Win32Exception] -or $failure -is [IO.IOException] -or $failure -is [TimeoutException]){$code='NORMAL_HOST_CONNECTION_FAILED'}
    elseif($failure.Message -cin @('NORMAL_HOST_BINARY_MISSING','NORMAL_DEPLOYMENT_MISSING','NORMAL_HOST_LISTENER_NOT_RUNNING','HOST_TRANSPORT_BUSY','NORMAL_HOST_CONNECTION_FAILED')){$code=$failure.Message}
    [Console]::Error.WriteLine($code)
    exit 1
} finally {
    if($bridgePeer){$bridgePeer.Dispose()}
    if($context){$context.peer.Dispose()}
}
