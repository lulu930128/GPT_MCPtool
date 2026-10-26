Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\scripts\tray.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'TRAY_PARSE_FAILED' }
$script:checks = 0
function Check([bool]$Value, [string]$Message) {
    if (-not $Value) { throw "CHECK_FAILED: $Message" }; $script:checks++
}
foreach ($name in @('Get-TrayWorkspaceLocalStatusText', 'New-TrayExitSignal', 'Initialize-TrayExitSignal', 'Get-TrayControllerState', 'Test-TrayMaintenanceBusy', 'Show-TrayControllerWarning', 'Complete-TrayExit', 'Request-TrayExit', 'Update-TrayControllerLifecycle', 'Update-TrayPendingRestart', 'Start-ControllerAction', 'Start-NormalOperatorHost')) {
    $node = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $true)
    . ([scriptblock]::Create($node.Extent.Text))
}
# Invoke the actual registered callbacks without launching WinForms, a controller,
# a production IPC owner, or acquiring the tray singleton.
$tickNode = $ast.Find({ param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Expression.Extent.Text -eq '$timer' -and $n.Member.Value -eq 'add_Tick' }, $true)
$script:tick = $tickNode.Arguments[0].ScriptBlock.GetScriptBlock()
$exitNode = $ast.Find({ param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Expression.Extent.Text -eq '$exitItem' -and $n.Member.Value -eq 'add_Click' }, $true)
$script:click = $exitNode.Arguments[0].ScriptBlock.GetScriptBlock()
function Stop-TrayApplication { $script:exitCalls++ }
function Show-Warning { param($Message) $script:warnings++ }
function Update-UiFromState { $script:updates++ }
function Set-TrayRestartFeedback { param($Message, [switch]$Warning) $script:balloons++ }
function Update-UiFromReconcileProgress { $script:progress++; return $true }
function Reset-Fixture {
    $script:Closing = $false; $script:ExitRequested = $false; $script:ExitClock = $null
    $script:UpgradeExitSignal = $null
    $script:ControllerProcess = $null; $script:PendingAction = $null; $script:PendingLabel = $null; $script:PendingOperationId = $null
    $script:PendingRestartMcp = $null
    $script:PendingComponent = $null
    $script:StatusProcess = $null; $script:StatusClock = $null; $script:StatusStopAttempted = $false; $script:StatusStopClock = $null
    $script:ControllerWarningShown = $false; $script:SecondsSinceRefresh = 30
    $script:WorkspaceLocalOwner = $null; $script:WorkspaceLocalWorker = $null
    $script:WorkspaceLocalStartupReason = 'WORKSPACE_LOCAL_NATIVE_MISSING'
    $script:workspaceLocalItem = [pscustomobject]@{ Text = '' }
    $script:NormalOperatorWorker = $null; $script:SelfReloadWorker = $null; $script:SelfReloadShutdown = $null
    $script:exitCalls = 0; $script:warnings = 0; $script:updates = 0; $script:balloons = 0; $script:progress = 0
    $script:timer = [pscustomobject]@{ stops = 0 }
    $script:timer | Add-Member ScriptMethod Stop { $this.stops++ }
    $script:notifyIcon = [pscustomobject]@{ Visible = $true }
    $script:notifyIcon | Add-Member ScriptMethod ShowBalloonTip { param($ms, $title, $message, $kind) $script:balloons++ }
    $script:trayDisplayName = 'fixture'
    $script:manifest = [pscustomobject]@{ schemaVersion = 4; settings = @{ refreshIntervalSeconds = 30 } }
}
function Set-Controller([string]$Action = 'Status', [bool]$Exited = $false) {
    $script:ControllerProcess = [pscustomobject]@{ HasExited = $Exited; ExitCode = 0; kills = 0; disposals = 0; denyKill = $false; killCompletes = $true }
    $script:ControllerProcess | Add-Member ScriptMethod Kill {
        $this.kills++
        if ($this.denyKill) { throw 'FIXTURE_DENIED' }
        if ($this.killCompletes) { $this.HasExited = $true }
    }
    $script:ControllerProcess | Add-Member ScriptMethod Dispose { $this.disposals++ }
    $script:PendingAction = $Action; $script:PendingLabel = $Action
    if ($Action -eq 'Status') {
        $script:StatusProcess = $script:ControllerProcess
        $script:StatusClock = [pscustomobject]@{ Elapsed = [timespan]::FromSeconds(0) }
    }
}
function New-Owner {
    $owner = [pscustomobject]@{ Running = $true; HasActiveRequest = $false; closing = $false; race = $false; gateCalls = 0; takes = 0 }
    $owner | Add-Member ScriptMethod TryBeginShutdown {
        $this.gateCalls++
        if ($this.race) { $this.HasActiveRequest = $true; $this.race = $false }
        $this.closing = $true
        if ($this.HasActiveRequest) { return $false }
        return $true
    }
    $owner | Add-Member ScriptMethod TakePending { $this.takes++; return $null }
    return $owner
}

Reset-Fixture
Set-Controller
$child = $script:ControllerProcess
& $script:click; & $script:click; & $script:click
Check ($script:ExitRequested -and -not $script:Closing -and $script:exitCalls -eq 0 -and $script:warnings -eq 0) 'running Status latches idempotent exit'
& $script:tick
Start-ControllerAction -Action Status
Start-ControllerAction -Action RestartMcp -Component 'fixture'
Start-NormalOperatorHost
Check ([object]::ReferenceEquals($script:ControllerProcess, $child) -and $script:SecondsSinceRefresh -eq 30) 'pending exit suppresses periodic and manual launches'
$child.HasExited = $true
& $script:tick; & $script:tick; & $script:click
Check ($script:Closing -and $script:exitCalls -eq 1 -and $script:timer.stops -eq 1 -and -not $script:notifyIcon.Visible) 'completion exits automatically exactly once'
Check ($child.kills -eq 0 -and $child.disposals -eq 1 -and $script:updates -eq 0) 'natural completion is reaped without extra refresh'

Reset-Fixture
Set-Controller -Exited $true
& $script:click
Check ($script:Closing -and $script:exitCalls -eq 1) 'already completed Status exits on first click'
Reset-Fixture
& $script:click
Check ($script:Closing) 'idle exit works'

foreach ($action in @('Reconcile', 'Doctor', 'RestartMcp', 'Start', 'ShutdownRuntime')) {
    Reset-Fixture
    Set-Controller -Action $action
    $child = $script:ControllerProcess
    $script:StatusClock = [pscustomobject]@{ Elapsed = [timespan]::FromSeconds(999) }
    & $script:click; & $script:tick
    Check (-not $script:ExitRequested -and -not $script:Closing -and $child.kills -eq 0 -and $script:warnings -eq 1) "$action is never interrupted or queued for exit"
}
Reset-Fixture
Set-Controller
$child = $script:ControllerProcess
& $script:click
$script:ExitClock = [pscustomobject]@{ Elapsed = [timespan]::FromSeconds(5) }
& $script:tick
Check ($child.kills -eq 1 -and $script:Closing) 'exit grace cancels exact Status child and exits'
Reset-Fixture
Set-Controller
$child = $script:ControllerProcess
$script:StatusClock.Elapsed = [timespan]::FromSeconds(120)
& $script:tick
Check ($child.kills -eq 1 -and -not $script:Closing -and $null -eq $script:ControllerProcess -and $script:SecondsSinceRefresh -eq 0) 'overall Status deadline reaps without immediate reschedule'

foreach ($mode in @('denied', 'delayed', 'wrongHandle', 'disposed')) {
    Reset-Fixture
    Set-Controller
    $child = $script:ControllerProcess
    & $script:click
    switch ($mode) {
        'denied' { $child.denyKill = $true }
        'delayed' { $child.killCompletes = $false }
        'wrongHandle' { $script:StatusProcess = [pscustomobject]@{ HasExited = $false } }
        'disposed' { $child.PSObject.Properties.Remove('HasExited'); $child | Add-Member ScriptProperty HasExited { throw 'FIXTURE_DISPOSED' } }
    }
    $script:ExitClock = [pscustomobject]@{ Elapsed = [timespan]::FromSeconds(6) }
    & $script:tick
    $script:StatusStopClock = [pscustomobject]@{ Elapsed = [timespan]::FromSeconds(6) }
    & $script:tick; & $script:click
    Check ($script:ExitRequested -and -not $script:Closing -and $script:balloons -eq 1 -and $child.kills -le 1) "$mode is fail-safe, non-modal and idempotent"
    if ($mode -ne 'disposed') {
        $child.HasExited = $true; & $script:tick
        Check ($script:Closing) "$mode can finish on later confirmed child exit"
    }
}

Reset-Fixture
$script:WorkspaceLocalOwner = New-Owner
$script:WorkspaceLocalOwner.HasActiveRequest = $true
& $script:click
Check (-not $script:ExitRequested -and $script:warnings -eq 1) 'existing Workspace request keeps guarded behavior'
Reset-Fixture
$script:WorkspaceLocalWorker = @{ pending = @{ IsCompleted = $false } }
& $script:click
Check (-not $script:ExitRequested) 'Workspace worker cannot be interrupted even if owner request flag is absent'
Reset-Fixture
$script:WorkspaceLocalOwner = New-Owner
$script:WorkspaceLocalOwner.race = $true
& $script:click; & $script:tick
Check ($script:ExitRequested -and -not $script:Closing -and $script:WorkspaceLocalOwner.takes -eq 1) 'request racing exit gate is allowed to drain on existing timer'
$script:WorkspaceLocalOwner.HasActiveRequest = $false
& $script:tick
Check ($script:Closing -and $script:WorkspaceLocalOwner.closing) 'exit closes admission atomically after raced request completes'

foreach ($mode in @('idle', 'active')) {
    Reset-Fixture
    $script:SelfReloadShutdown = New-Object Threading.CancellationTokenSource
    $script:SelfReloadWorker = @{ pending = @{ IsCompleted = $false } }
    & $script:click
    Check ($script:ExitRequested -and $script:SelfReloadShutdown.IsCancellationRequested -and -not $script:Closing) "$mode long-lived R1 owner gets a cooperative shutdown request"
    & $script:tick
    Check (-not $script:Closing -and $script:warnings -eq 0) "$mode R1 owner is awaited without Stop or Dispose"
    $script:SelfReloadWorker.pending.IsCompleted = $true
    & $script:tick
    Check ($script:Closing) "$mode R1 owner completion releases pending exit"
    $script:SelfReloadShutdown.Dispose()
}

# Exercise the actual one-shot named event and timer callback in this fixture
# process only; its PID/start-time name cannot address the production tray.
foreach($mode in @('idle','status','workspace','worker','controller','unknown','race','r1')){
    Reset-Fixture
    $script:manifest | Add-Member NoteProperty installedRelease @{state=@{operatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}}
    $script:UpgradeExitSignal=New-TrayExitSignal
    $duplicate=$null
    try {New-TrayExitSignal|Out-Null}catch{$duplicate=$_.Exception.Message}
    Check ($duplicate -ceq 'UPGRADE_TRAY_SIGNAL_ALREADY_EXISTS') 'signal never adopts a preexisting event'
    try {
        switch($mode){
            'status' {Set-Controller}
            'workspace' {$script:WorkspaceLocalOwner=New-Owner;$script:WorkspaceLocalOwner.HasActiveRequest=$true}
            'worker' {$script:WorkspaceLocalWorker=@{pending=@{IsCompleted=$false}}}
            'controller' {Set-Controller -Action RestartMcp}
            'unknown' {Set-Controller;$script:ControllerProcess.HasExited=$null}
            'race' {$script:WorkspaceLocalOwner=New-Owner;$script:WorkspaceLocalOwner.race=$true}
            'r1' {$script:SelfReloadShutdown=[Threading.CancellationTokenSource]::new();$script:SelfReloadWorker=@{pending=@{IsCompleted=$false}}}
        }
        $null=$script:UpgradeExitSignal.Set()
        & $script:tick
        Check ($script:warnings -eq 0) "$mode event never blocks timer on a modal warning"
        Check (-not $script:UpgradeExitSignal.WaitOne(0)) "$mode event is consumed once"
        if($mode -in @('workspace','worker','controller','unknown')){
            Check (-not $script:ExitRequested -and -not $script:Closing -and $script:balloons -eq 1) "$mode rejects automatic exit"
            $script:ControllerProcess=$null;$script:WorkspaceLocalOwner=$null;$script:WorkspaceLocalWorker=$null
            $script:SecondsSinceRefresh=0
            & $script:tick
            Check (-not $script:ExitRequested) "$mode rejection is not replayed after work finishes"
        } elseif($mode -eq 'idle') {Check $script:Closing 'idle event reaches existing Complete-TrayExit'}
        else {
            Check ($script:ExitRequested -and -not $script:Closing) "$mode cooperative exit waits for drain"
            if($mode -eq 'status'){$script:ControllerProcess.HasExited=$true}
            if($mode -eq 'race'){$script:WorkspaceLocalOwner.HasActiveRequest=$false}
            if($mode -eq 'r1'){$script:SelfReloadWorker.pending.IsCompleted=$true}
            & $script:tick
            Check $script:Closing "$mode event completes only after original worker/controller drains"
        }
    } finally {
        $script:UpgradeExitSignal.Dispose();$script:UpgradeExitSignal=$null
        if($script:SelfReloadShutdown){$script:SelfReloadShutdown.Dispose()}
    }
}

Reset-Fixture
& {
    function New-TrayExitSignal {throw 'FIXTURE_EVENT_API_OR_ACL_UNAVAILABLE'}
    Initialize-TrayExitSignal -WarningAction SilentlyContinue
    Check ($null -eq $script:UpgradeExitSignal -and -not $script:Closing) 'optional event initialization failure leaves ordinary tray alive'
    & $script:click
    Check $script:Closing 'ordinary Exit remains usable without the optional event'
}

# Verify the real lock-protected Workspace gate without constructing a pipe,
# touching production receipts or invoking component maintenance.
$native = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\src\WorkspaceLocal.Native.cs') -Raw -Encoding UTF8
$fixture = @'
namespace McpCc.WorkspaceLocal {
    public static class ExitFixture {
        public static bool Run() {
            var type=typeof(Owner);
            var owner=(Owner)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(type);
            var flags=System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance;
            type.GetField("sync",flags).SetValue(owner,new object());
            type.GetField("activeRequest",flags).SetValue(owner,"fixture-active");
            if(owner.TryBeginShutdown()) return false;
            type.GetField("activeRequest",flags).SetValue(owner,null);
            if(!owner.TryBeginShutdown() || !owner.TryBeginShutdown()) return false;
            if(!(bool)type.GetField("closing",flags).GetValue(owner)) return false;
            // ReceiptStore.Read of a nonexistent fixture directory performs no write.
            type.GetField("receipts",flags).SetValue(owner,new ReceiptStore(System.IO.Path.Combine(System.IO.Path.GetTempPath(),"mcpcc-exit-no-io-"+System.Guid.NewGuid().ToString("N"))));
            var request=new System.Collections.Generic.Dictionary<string,string> {{"operation","restart"},{"requestId",System.Guid.NewGuid().ToString("D")},{"nonce",new string('a',64)},{"componentId","personal_asset_os"},{"action","reload_runtime"}};
            return owner.Dispatch(request).Contains("OWNER_CLOSING") && !owner.HasActiveRequest && owner.TakePending()==null;
        }
    }
}
'@
Add-Type -TypeDefinition ($native + "`n" + $fixture) -ReferencedAssemblies System.Web.Extensions,System.Core
Check ([McpCc.WorkspaceLocal.ExitFixture]::Run()) 'real Workspace admission gate shares the request lock and is idempotent'
$r1Ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\src\McpControlCenter.SelfReload.Owner.psm1'), [ref]$tokens, [ref]$errors)
Check ($errors.Count -eq 0) 'R1 source parses in Windows PowerShell 5.1'
$r1Loop = $r1Ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-R1OwnerLoop' }, $true)
. ([scriptblock]::Create($r1Loop.Extent.Text))
# Execute the production R1 loop with an in-memory pipe/mutex and a fake operation.
# No protected policy, deployment, component action or real named pipe is opened.
Add-Type -TypeDefinition @'
public static class McpCcReloadNative {
    public static object FixturePipe;
    public static object OpenPipe(string owner, string bridge) { return FixturePipe; }
}
'@
function Read-McpCcManifest { param($Path) return @{} }
function Get-R1Deployment { param($RuntimeRoot, $Manifest) return @{ ownerSid = 'fixture'; root = 'fixture'; policy = @{ bridgeSid = 'fixture' } } }
function New-R1Engine { param($Root, $Policy, $Snapshot, $Execute, $Postcheck) return [pscustomobject]@{ poisoned = $false } }
function New-Object {
    param($TypeName, $ArgumentList)
    if ($TypeName -ne 'Threading.Mutex') { throw "UNEXPECTED_CONSTRUCTION: $TypeName" }
    return $script:fakeMutex
}
function Invoke-R1Tick {
    param($Engine)
    $script:r1Ticks++
    if ($script:activeOperation) {
        & $script:click
        Check (-not $script:Closing) 'Exit during real loop tick waits for the in-flight operation'
        $script:operationFinished = $true
    }
}
foreach ($mode in @('idle', 'active')) {
    Reset-Fixture
    $script:SelfReloadShutdown = [Threading.CancellationTokenSource]::new()
    $script:SelfReloadWorker = @{ pending = @{ IsCompleted = $false } }
    $script:activeOperation = $mode -eq 'active'; $script:operationFinished = $false; $script:r1Ticks = 0
    $script:fakeMutex = [pscustomobject]@{ released = $false; disposed = $false }
    $script:fakeMutex | Add-Member ScriptMethod WaitOne { param($ms) return $true }
    $script:fakeMutex | Add-Member ScriptMethod ReleaseMutex { $this.released = $true }
    $script:fakeMutex | Add-Member ScriptMethod Dispose { $this.disposed = $true }
    $script:fakeWait = [pscustomobject]@{}
    $script:fakeWait | Add-Member ScriptMethod Wait { param($ms) if (-not $script:ExitRequested) { & $script:click }; return $false }
    $script:fakePipe = [pscustomobject]@{ IsConnected = $false; disposed = $false }
    $script:fakePipe | Add-Member ScriptMethod WaitForConnectionAsync { return $script:fakeWait }
    $script:fakePipe | Add-Member ScriptMethod Dispose { $this.disposed = $true }
    [McpCcReloadNative]::FixturePipe = $script:fakePipe
    Invoke-R1OwnerLoop -ManifestPath 'fixture' -RuntimeRoot 'fixture' -ShutdownSignal $script:SelfReloadShutdown
    Check ($script:r1Ticks -eq 1 -and $script:fakePipe.disposed -and $script:fakeMutex.released -and $script:fakeMutex.disposed) "$mode R1 loop cooperatively drains and releases its own resources"
    if ($mode -eq 'active') { Check ($script:operationFinished) 'in-flight R1 operation finishes before owner returns' }
    $script:SelfReloadWorker.pending.IsCompleted = $true
    & $script:tick
    Check ($script:Closing) "$mode real R1 loop completion unblocks tray Exit"
    $script:SelfReloadShutdown.Dispose()
}
[pscustomobject]@{ ok = $true; checks = $script:checks; fixtureOnly = $true; liveTray = $false } | ConvertTo-Json -Compress
