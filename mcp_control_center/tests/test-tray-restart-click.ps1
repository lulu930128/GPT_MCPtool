param(
    [string]$TrayPath = (Join-Path $PSScriptRoot '..\scripts\tray.ps1'),
    [switch]$ReproduceClosure
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Windows.Forms;
public static class TrayClickFixture {
    public static DialogResult Choice = DialogResult.Yes;
    public static int Prompts;
    public static string Prompt;
    public static Action DuringPrompt;
    public static object Process;
    public static bool FailStart;
    public static List<string> Launches = new List<string>();
    public static DialogResult Show(string text, string title, MessageBoxButtons buttons, MessageBoxIcon icon) {
        Prompts++; Prompt = text; if (DuringPrompt != null) DuringPrompt(); return Choice;
    }
    public static object Start(ProcessStartInfo info) {
        Launches.Add(info.Arguments);
        if (FailStart) throw new InvalidOperationException("FIXTURE_LAUNCH_FAILED");
        return Process;
    }
}
'@ -ReferencedAssemblies System.Windows.Forms
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($TrayPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'TRAY_PARSE_FAILED' }
$script:checks = 0
function Check([bool]$Value, [string]$Message) {
    if (-not $Value) { throw "CHECK_FAILED: $Message" }; $script:checks++
}
function Get-ClickRegistration([string]$Variable) {
    $node = $ast.Find({ param($n)
        $n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and
        $n.Expression.Extent.Text -ceq $Variable -and $n.Member.Value -eq 'add_Click'
    }, $true)
    if ($null -eq $node) { throw "REGISTRATION_MISSING: $Variable" }
    # Only the modal answer is substituted; execute the production registration
    # and real MenuItem.PerformClick in this script's scope, never a visible GUI.
    return $node.Extent.Text.Replace('[Windows.Forms.MessageBox]::Show(', '[TrayClickFixture]::Show(')
}
if ($ReproduceClosure) {
    # Register in an isolated module script scope, then invoke from the event caller.
    # Direct synchronous invocation inside the registration scope can mask this.
    $setup = @'
param($restartRegistration, $refreshRegistration)
$dispatches = [Collections.Generic.List[string]]::new()
function Start-ControllerAction { param($Action, $Component) $dispatches.Add($Action) }
$trayDisplayName = 'fixture'; $componentName = 'First'; $componentId = 'first'
$restartMcpItem = [Windows.Forms.MenuItem]::new('Restart MCP')
$refreshItem = [Windows.Forms.MenuItem]::new('Refresh now')
. ([scriptblock]::Create($restartRegistration))
. ([scriptblock]::Create($refreshRegistration))
[pscustomobject]@{ restart = $restartMcpItem; refresh = $refreshItem; dispatches = $dispatches }
'@
    $fixture = New-Module -AsCustomObject -ScriptBlock ([scriptblock]::Create($setup.Replace('[pscustomobject]@{ restart = $restartMcpItem; refresh = $refreshItem; dispatches = $dispatches }', 'Export-ModuleMember -Variable restartMcpItem,refreshItem,dispatches -Function @()'))) -ArgumentList (Get-ClickRegistration '$restartMcpItem'), (Get-ClickRegistration '$refreshItem')
    try {
        $failure = $null
        try { $fixture.restartMcpItem.PerformClick() } catch { $failure = $_ }
        [pscustomobject]@{ prompts = [TrayClickFixture]::Prompts; dispatches = $fixture.dispatches.Count; failure = [string]$failure } | ConvertTo-Json -Compress
        Check ($null -ne $failure -and $failure.ToString() -match 'Start-ControllerAction') 'closure loses the script-local function'
        Check ($fixture.dispatches.Count -eq 0 -and [TrayClickFixture]::Prompts -eq 1) 'Yes did not dispatch'
        $fixture.refreshItem.PerformClick()
        Check ($fixture.dispatches.Count -eq 1) 'plain Refresh callback resolves the same script-local function'
        [pscustomobject]@{ ok = $true; rootCause = 'GetNewClosure script function resolution'; restartDispatches = 0; refreshDispatches = 1; errorId = $failure.FullyQualifiedErrorId } | ConvertTo-Json -Compress
    }
    finally { $fixture.restartMcpItem.Dispose(); $fixture.refreshItem.Dispose() }
    exit 0
}
# Load bodies/registrations only. Never run tray bootstrap, real Process.Start,
# real MessageBox.Show, a controller, IPC, runtime writes or live health probes.
$registration = Get-ClickRegistration '$restartMcpItem'
$functions = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $false) | ForEach-Object { $_.Extent.Text }) -join "`n"
$functions = $functions.Replace('[Diagnostics.Process]::Start($startInfo)', '[TrayClickFixture]::Start($startInfo)').Replace('[Windows.Forms.MessageBox]::Show(', '[TrayClickFixture]::Show(')
$core = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\src\McpControlCenter.Core.psm1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'CORE_PARSE_FAILED' }
$decision = $core.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-McpCcRestartMcpDecision' }, $false).Extent.Text
$handler = $ast.Find({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$restartMcpClickHandler' }, $false)
$handlerText = if ($null -ne $handler) { $handler.Extent.Text } else { '' }
$uiAssignment = $ast.Find({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$script:ComponentUi[$componentId]' }, $true).Extent.Text
$tickNode = $ast.Find({ param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Expression.Extent.Text -eq '$timer' -and $n.Member.Value -eq 'add_Tick' }, $true)
$tickText = $tickNode.Arguments[0].Extent.Text
$scope = New-Module -ScriptBlock {
    param($bodies, $decisionBody, $handlerBody, $clickRegistration, $refreshRegistration, $uiBody, $timerBody)
    Set-StrictMode -Version 3.0
    . ([scriptblock]::Create($bodies))
    . ([scriptblock]::Create($decisionBody))
    . ([scriptblock]::Create($handlerBody))
    $script:tick = & ([scriptblock]::Create($timerBody))
    $script:ComponentUi = @{}
    foreach ($componentId in @('first', 'middle', 'last')) {
        $componentName = "Name $componentId"
        $parent = [Windows.Forms.MenuItem]::new($componentName)
        $statusItem = [Windows.Forms.MenuItem]::new('Status')
        $restartMcpItem = [Windows.Forms.MenuItem]::new('Restart MCP')
        $healthItem = [Windows.Forms.MenuItem]::new('Health')
        $supportsRestartMcp = $true
        . ([scriptblock]::Create($clickRegistration))
        . ([scriptblock]::Create($uiBody))
    }
    $refreshItem = [Windows.Forms.MenuItem]::new('Refresh')
    . ([scriptblock]::Create($refreshRegistration))
    function Read-McpCcState { param($RuntimeRoot) if ($script:readFails) { throw 'FIXTURE_READ_FAILED' }; return $script:state }
    function Get-McpCcStatusPresentation { param($Status) return @{ symbol = '+'; label = $Status } }
    function Show-Warning { param($Message) $script:warnings.Add($Message) }
    function Stop-TrayApplication { $script:exitCalls++ }
    function Check([bool]$Value, [string]$Message) {
        if (-not $Value) { throw "CHECK_FAILED: $Message" }; $script:checks++
    }
    function New-Child {
        $child = [pscustomobject]@{ HasExited = $false; ExitCode = 0; Handle = 123; disposed = 0; killed = 0 }
        $child | Add-Member ScriptMethod Dispose { $this.disposed++ }
        $child | Add-Member ScriptMethod Kill { $this.killed++; $this.HasExited = $true }
        return $child
    }
    function Reset-Fixture {
        $script:Closing = $false; $script:ExitRequested = $false; $script:ExitClock = $null
        $script:ControllerProcess = $null; $script:PendingAction = $null; $script:PendingLabel = $null; $script:PendingOperationId = $null
        $script:PendingRestartMcp = $null; $script:StatusProcess = $null; $script:StatusClock = $null; $script:StatusStopAttempted = $false; $script:StatusStopClock = $null
        $script:PendingComponent = $null
        $script:ControllerWarningShown = $false; $script:SecondsSinceRefresh = 0
        $script:WorkspaceLocalOwner = $null; $script:WorkspaceLocalWorker = $null
        $script:NormalOperatorWorker = $null; $script:SelfReloadWorker = $null; $script:SelfReloadShutdown = $null
        $script:trayDisplayName = 'fixture'; $script:RuntimeRoot = 'X:\fixture-only'; $script:ManifestPath = 'X:\fixture-only\manifest.json'
        $script:controllerPath = 'X:\fixture-only\control-center.ps1'; $script:projectRoot = 'X:\fixture-only'
        $script:manifest = [pscustomobject]@{ schemaVersion = 4; settings = @{ refreshIntervalSeconds = 30 } }
        $script:restartResultItem = [pscustomobject]@{ Text = '' }
        $script:overallItem = [pscustomobject]@{ Text = '' }; $script:lastRefreshItem = [pscustomobject]@{ Text = '' }
        $script:notifyIcon = [pscustomobject]@{ Visible = $true; Icon = $null; Text = '' }
        $script:notifyIcon | Add-Member ScriptMethod ShowBalloonTip { param($ms,$title,$message,$kind) $script:balloons.Add($message) }
        $script:timer = [pscustomobject]@{}
        $script:timer | Add-Member ScriptMethod Stop { }
        $script:readFails = $false; $script:exitCalls = 0
        $script:warnings = [Collections.Generic.List[string]]::new(); $script:balloons = [Collections.Generic.List[string]]::new()
        $script:state = [pscustomobject]@{ overall = 'Ready'; generatedAt = [datetime]::UtcNow.ToString('o'); components = @(
            foreach ($id in @('first','middle','last')) { [pscustomobject]@{ id = $id; displayName = "Name $id"; status = 'Ready'; issues = @() } }
        ) }
        [TrayClickFixture]::Launches.Clear(); [TrayClickFixture]::Prompts = 0; [TrayClickFixture]::Choice = [Windows.Forms.DialogResult]::Yes
        [TrayClickFixture]::DuringPrompt = $null; [TrayClickFixture]::FailStart = $false; [TrayClickFixture]::Process = New-Child
    }
    function Set-Status {
        $script:ControllerProcess = New-Child
        $script:PendingAction = 'Status'; $script:PendingLabel = 'Status'; $script:StatusProcess = $script:ControllerProcess
        $script:StatusClock = [pscustomobject]@{ Elapsed = [timespan]::FromSeconds(21) }
    }
    Export-ModuleMember -Function @()
} -ArgumentList $functions, $decision, $handlerText, $registration, (Get-ClickRegistration '$refreshItem'), $uiAssignment, $tickText

try {
    # Event invoked from outside the private module: identical MenuItem bindings,
    # unlike a direct call from a scope where private functions happen to resolve.
    & $scope { $script:checks = 0; Reset-Fixture }
    $first = & $scope { $script:ComponentUi.first.restartMcp }
    $first.PerformClick()
    & $scope { Check ([TrayClickFixture]::Launches.Count -eq 1) 'actual Yes event dispatches once across script/module scope' }
    & $scope {
        foreach ($id in @('first','middle','last')) {
            Reset-Fixture
            $script:ComponentUi[$id].restartMcp.PerformClick()
            Check ([TrayClickFixture]::Launches.Count -eq 1 -and [TrayClickFixture]::Launches[0] -match ('"-Action" "RestartMcp".*"-Component" "' + $id + '"')) "$id uses its own CLI id exactly once"
            Check ([TrayClickFixture]::Prompt -match "Name $id" -and $script:restartResultItem.Text -match "Started / $id") "$id confirmation and start are visible"
        }
        foreach ($choice in @([Windows.Forms.DialogResult]::No, [Windows.Forms.DialogResult]::Cancel)) {
            Reset-Fixture; [TrayClickFixture]::Choice = $choice; $script:ComponentUi.first.restartMcp.PerformClick()
            Check ([TrayClickFixture]::Launches.Count -eq 0 -and $null -eq $script:PendingRestartMcp) "$choice never dispatches"
        }
        Reset-Fixture
        Invoke-TrayRestartMcpClick -Sender ([Windows.Forms.MenuItem]::new('Restart MCP'))
        Check ([TrayClickFixture]::Prompts -eq 0 -and [TrayClickFixture]::Launches.Count -eq 0 -and $script:restartResultItem.Text -match 'Not dispatched') 'unknown object with identical label is refused'
        $script:ComponentUi.alias = $script:ComponentUi.first
        try {
            $script:ComponentUi.first.restartMcp.PerformClick()
            Check ([TrayClickFixture]::Prompts -eq 0 -and [TrayClickFixture]::Launches.Count -eq 0) 'duplicate reference is not a unique identity'
        } finally { $script:ComponentUi.Remove('alias') }

        Reset-Fixture; Set-Status; $statusChild = $script:ControllerProcess
        $script:ComponentUi.first.restartMcp.PerformClick()
        Check ($null -ne $script:PendingRestartMcp -and [TrayClickFixture]::Launches.Count -eq 0 -and $script:restartResultItem.Text -match 'Pending / first') '21-second Status accepts one visible pending restart'
        $pending = $script:PendingRestartMcp
        $script:ComponentUi.first.restartMcp.PerformClick(); $script:ComponentUi.last.restartMcp.PerformClick()
        Check ([object]::ReferenceEquals($pending, $script:PendingRestartMcp) -and $script:PendingRestartMcp.component -eq 'first' -and $script:warnings.Count -eq 2) 'duplicate and other component cannot overwrite the one slot'
        $script:SecondsSinceRefresh = 30
        & $script:tick
        Check ([TrayClickFixture]::Launches.Count -eq 0) 'timer does not bypass running Status'
        $statusChild.HasExited = $true
        & $script:tick; & $script:tick
        Check ([TrayClickFixture]::Launches.Count -eq 1 -and [TrayClickFixture]::Launches[0] -match 'RestartMcp.*first' -and $null -eq $script:PendingRestartMcp) 'Status completion dispatches exactly once before periodic refresh'
        Check ($statusChild.disposed -eq 1 -and $statusChild.killed -eq 0) 'completed Status retains original reaping ownership'

        foreach ($mode in @('unknown','otherAction','maintenanceOwner','maintenanceWorker','expired','handleChanged','handleLost','stopAttempted','statusFailed','ownershipChanged','stateReadFailed','exit')) {
            Reset-Fixture; Set-Status
            $script:ComponentUi.first.restartMcp.PerformClick(); $statusChild = $script:ControllerProcess
            switch ($mode) {
                'unknown' { $statusChild.PSObject.Properties.Remove('HasExited'); $statusChild | Add-Member ScriptProperty HasExited { throw 'FIXTURE_UNKNOWN' } }
                'otherAction' { $script:PendingAction = 'Doctor' }
                'maintenanceOwner' { $script:WorkspaceLocalOwner = [pscustomobject]@{ HasActiveRequest = $true } }
                'maintenanceWorker' { $script:WorkspaceLocalWorker = @{ pending = @{ IsCompleted = $false } } }
                'expired' { $script:PendingRestartMcp.clock = [pscustomobject]@{ Elapsed = [timespan]::FromSeconds(120) } }
                'handleChanged' { $script:ControllerProcess = New-Child }
                'handleLost' { $script:ControllerProcess = $null }
                'stopAttempted' { $script:StatusStopAttempted = $true; $script:StatusStopClock = [Diagnostics.Stopwatch]::StartNew() }
                'statusFailed' { $statusChild.ExitCode = 1; $statusChild.HasExited = $true }
                'ownershipChanged' { $script:state.components[0].status = 'OwnershipUnknown'; $statusChild.HasExited = $true }
                'stateReadFailed' { $script:readFails = $true; $statusChild.HasExited = $true }
                'exit' { Request-TrayExit; $statusChild.HasExited = $true }
            }
            Update-TrayControllerLifecycle
            Check ($null -eq $script:PendingRestartMcp -and [TrayClickFixture]::Launches.Count -eq 0) "$mode cancels instead of dispatching"
            Check ($script:restartResultItem.Text -match 'Cancelled|Not dispatched') "$mode leaves visible outcome"
        }
        foreach ($mode in @('Doctor','Reconcile','RestartMcp','unknown','owner','worker','unretained','stopping','overdue')) {
            Reset-Fixture; Set-Status
            switch ($mode) {
                'unknown' { $script:ControllerProcess.PSObject.Properties.Remove('HasExited'); $script:ControllerProcess | Add-Member ScriptProperty HasExited { throw 'FIXTURE_UNKNOWN' } }
                'owner' { $script:WorkspaceLocalOwner = [pscustomobject]@{ HasActiveRequest = $true } }
                'worker' { $script:WorkspaceLocalWorker = @{ pending = @{ IsCompleted = $false } } }
                'unretained' { $script:StatusProcess = $null }
                'stopping' { $script:StatusStopAttempted = $true }
                'overdue' { $script:StatusClock.Elapsed = [timespan]::FromSeconds(120) }
                default { $script:PendingAction = $mode }
            }
            $script:ComponentUi.first.restartMcp.PerformClick()
            Check ($null -eq $script:PendingRestartMcp -and [TrayClickFixture]::Launches.Count -eq 0 -and $script:restartResultItem.Text -match 'Not dispatched') "$mode cannot admit pending"
        }
        foreach ($mode in @('OwnershipUnknown','OwnershipMismatch','missing','duplicate','readFailure','unsupported')) {
            Reset-Fixture; Set-Status
            switch ($mode) {
                'missing' { $script:state.components = @() }
                'duplicate' { $script:state.components += $script:state.components[0] }
                'readFailure' { $script:readFails = $true }
                'unsupported' { $script:ComponentUi.first.supportsRestartMcp = $false }
                default { $script:state.components[0].status = $mode }
            }
            $script:ComponentUi.first.restartMcp.PerformClick()
            Check ($null -eq $script:PendingRestartMcp -and [TrayClickFixture]::Launches.Count -eq 0) "$mode fails closed before pending admission"
            $script:ComponentUi.first.supportsRestartMcp = $true
        }
        Reset-Fixture; Set-Status
        foreach ($action in @('Status','Reconcile','Doctor','Start','ShutdownRuntime')) { Start-ControllerAction -Action $action -Component first }
        Check ([TrayClickFixture]::Launches.Count -eq 0 -and $null -eq $script:PendingRestartMcp -and $script:warnings.Count -eq 5) 'all other operations retain busy rejection'

        foreach ($mode in @('exitBefore','exitDuring','maintenanceDuring','statusDuring')) {
            Reset-Fixture
            switch ($mode) {
                'exitBefore' { $script:ExitRequested = $true }
                'exitDuring' { [TrayClickFixture]::DuringPrompt = { $script:ExitRequested = $true } }
                'maintenanceDuring' { [TrayClickFixture]::DuringPrompt = { $script:WorkspaceLocalWorker = @{ pending = @{ IsCompleted = $false } } } }
                'statusDuring' { [TrayClickFixture]::DuringPrompt = { Set-Status } }
            }
            $script:ComponentUi.first.restartMcp.PerformClick()
            Check ([TrayClickFixture]::Launches.Count -eq 0) "$mode rechecks after modal event pumping"
            if ($mode -eq 'statusDuring') { Check ($null -ne $script:PendingRestartMcp) 'Status started during dialog uses bounded pending' }
        }
        Reset-Fixture; [TrayClickFixture]::FailStart = $true
        $script:ComponentUi.first.restartMcp.PerformClick()
        Check ($null -eq $script:ControllerProcess -and $null -eq $script:PendingRestartMcp -and $script:restartResultItem.Text -match 'Launch failed') 'spawn failure is explicit and never retried'
        foreach ($exitCode in @(0,1)) {
            Reset-Fixture; $script:ComponentUi.first.restartMcp.PerformClick()
            $script:ControllerProcess.ExitCode = $exitCode; $script:ControllerProcess.HasExited = $true
            & $script:tick
            $resultText = $script:restartResultItem.Text
            Update-UiFromState
            Check ($resultText -match 'last-actions/.*controller_error' -and $script:restartResultItem.Text -eq $resultText) 'result points to existing receipts and survives Ready refresh'
            if ($exitCode -ne 0) { Check ($resultText -match 'Failed or unconfirmed') 'controller failure is not presented as Ready success' }
        }
        Reset-Fixture; $script:ComponentUi.first.restartMcp.PerformClick()
        $script:ControllerProcess.ExitCode = 1; $script:ControllerProcess.HasExited = $true; $script:readFails = $true
        & $script:tick
        Check ($script:restartResultItem.Text -match 'Failed or unconfirmed' -and $script:lastRefreshItem.Text -match 'unavailable') 'state read failure cannot hide the action failure or break lifecycle completion'
        Reset-Fixture; $refreshItem.PerformClick()
        Check ([TrayClickFixture]::Launches.Count -eq 1 -and [TrayClickFixture]::Launches[0] -match '"-Action" "Status"') 'unchanged Refresh handler dispatches Status'
        [pscustomobject]@{ ok = $true; checks = $script:checks; fixtureOnly = $true; liveGui = $false; liveController = $false } | ConvertTo-Json -Compress
    }
}
finally {
    & $scope {
        foreach ($ui in $script:ComponentUi.Values) { $ui.parent.Dispose(); $ui.status.Dispose(); $ui.restartMcp.Dispose(); $ui.health.Dispose() }
        $refreshItem.Dispose()
    }
}
