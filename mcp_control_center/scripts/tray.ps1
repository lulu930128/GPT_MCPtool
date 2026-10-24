param(
    [string]$ManifestPath,
    [string]$RuntimeRoot,
    [switch]$AutoReconcile,
    [switch]$ReplaceExisting,
    [switch]$SelfTest
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$modulePath = Join-Path $projectRoot "src\McpControlCenter.Core.psm1"
$controllerPath = Join-Path $PSScriptRoot "control-center.ps1"
$healthDetailPath = Join-Path $PSScriptRoot "component-health.ps1"
Import-Module $modulePath -Force

if ([string]::IsNullOrWhiteSpace($ManifestPath)) { $ManifestPath = Get-McpCcDefaultManifestPath }
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) { $RuntimeRoot = Get-McpCcDefaultRuntimeRoot }
$manifest = Read-McpCcManifest -Path $ManifestPath
if ($manifest.schemaVersion -eq 4) {
    Import-Module (Join-Path $projectRoot 'src\McpControlCenter.InstalledRelease.psm1')
    if ($manifest.installedRelease.schemaVersion -lt 3) { throw 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED' }
    if ($ReplaceExisting -or $RuntimeRoot -ine (Get-McpCcInstalledStateRoot $manifest.installedRelease)) { throw 'INSTALLED_CALLER_OVERRIDE_REJECTED' }
    Assert-McpCcInstalledActivation $manifest -TrayBootstrap
}
Assert-McpCcRuntimeRoot -Manifest $manifest -RuntimeRoot $RuntimeRoot
$trayPidPath = Join-Path $RuntimeRoot "tray.pid"
$trayDisplayName = "MCP Control Center"

if ($SelfTest) {
    $selfTestResult = Test-McpCcManifest -Manifest $manifest
    [pscustomobject]@{
        trayDisplayName = $trayDisplayName
        projectRoot = $projectRoot
        controllerPath = $controllerPath
        controllerExists = Test-Path -LiteralPath $controllerPath -PathType Leaf
        manifestPath = $manifest.sourcePath
        runtimeRoot = $RuntimeRoot
        componentCount = @($manifest.components).Count
        expectedTrayContract = $selfTestResult.expectedTrayContract
        expectedLifecycleContract = $selfTestResult.expectedLifecycleContract
        componentContractsValid = $selfTestResult.ok
        componentMenuContract = $selfTestResult.expectedComponentMenuContract
        componentMenuComponentCount = @($manifest.components | Where-Object { $null -ne $_.PSObject.Properties["ui"] -and $null -ne $_.ui.PSObject.Properties["menuContract"] -and [string]$_.ui.menuContract -eq $selfTestResult.expectedComponentMenuContract }).Count
        dailyMenuContract = "component-daily-menu-v1"
        dailyMenuModelsValid = @($manifest.components | Where-Object { @(Get-McpCcTrayComponentModel -Component $_).actions.Count -lt 2 -or @(Get-McpCcTrayComponentModel -Component $_).actions.Count -gt 3 }).Count -eq 0
        frontendComponentCount = @($manifest.components | Where-Object { $null -ne (Get-McpCcTrayComponentModel -Component $_).frontend }).Count
        healthDetailExists = Test-Path -LiteralPath $healthDetailPath -PathType Leaf
        replaceExistingSupported = $true
        autoReconcile = [bool]$AutoReconcile
        healthDetailIndependent = $true
        reconcileProgressContract = "mcpcc-reconcile-progress-v1"
        reconcileProgressPolling = $true
    } | ConvertTo-Json -Depth 6
    if (-not $selfTestResult.ok -or -not (Test-Path -LiteralPath $controllerPath -PathType Leaf) -or -not (Test-Path -LiteralPath $healthDetailPath -PathType Leaf)) { exit 1 }
    exit 0
}

function Read-TrayPid {
    if (-not (Test-Path -LiteralPath $trayPidPath)) { return $null }
    $value = (Get-Content -LiteralPath $trayPidPath -Encoding UTF8 -Raw -ErrorAction SilentlyContinue).Trim()
    $parsed = 0
    if ([int]::TryParse($value, [ref]$parsed) -and $parsed -gt 0) { return $parsed }
    return $null
}

function Test-ExactControlCenterTrayProcess {
    param([int]$ProcessId)
    try {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
        return (
            [string]$process.Name -in @("powershell.exe", "pwsh.exe") -and
            -not [string]::IsNullOrWhiteSpace([string]$process.CommandLine) -and
            [string]$process.CommandLine -like "*$PSCommandPath*"
        )
    }
    catch { return $false }
}

$existingPid = Read-TrayPid
if ($null -ne $existingPid -and $existingPid -ne $PID -and (Test-ExactControlCenterTrayProcess -ProcessId $existingPid)) {
    if (-not $ReplaceExisting) { exit 0 }
    Stop-Process -Id $existingPid -ErrorAction Stop
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ((Get-Process -Id $existingPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 200
    }
    if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
        throw "Previous MCP Control Center tray PID $existingPid did not exit."
    }
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\McpControlCenterTray", [ref]$createdNew)
if (-not $createdNew) {
    $mutex.Dispose()
    exit 0
}
New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
[IO.File]::WriteAllText($trayPidPath, [string]$PID, (New-Object Text.UTF8Encoding($false)))

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:ControllerProcess = $null
$script:PendingLabel = $null
$script:PendingOperationId = $null
$script:SecondsSinceRefresh = 0
$script:Closing = $false
$script:ExitRequested = $false
$script:ExitClock = $null
$script:PendingAction = $null
$script:PendingComponent = $null
$script:PendingRestartMcp = $null
$script:StatusProcess = $null
$script:StatusClock = $null
$script:StatusStopAttempted = $false
$script:StatusStopClock = $null
$script:ControllerWarningShown = $false
$script:ComponentUi = @{}
$script:WorkspaceLocalOwner = $null
$script:WorkspaceLocalWorker = $null
# The existing tray mutex is already acquired. No second manager or poller.
# This source-workspace path does not participate in the installed R1 operator.
if ($manifest.schemaVersion -eq 3) {
    try {
        Import-Module (Join-Path $projectRoot 'src\McpControlCenter.WorkspaceLocal.psm1')
        $script:WorkspaceLocalOwner = New-McpCcWorkspaceLocalOwner -RuntimeRoot $RuntimeRoot
    } catch { Write-Warning 'Workspace local channel unavailable; existing tray continues.' }
}
$script:SelfReloadWorker = $null
$script:SelfReloadShutdown = $null
$script:NormalOperatorWorker = $null
# The installed owner continuously accepts independently authenticated requests.
function Start-NormalOperatorHost {
    if ($script:Closing -or $script:ExitRequested -or $null -ne $script:NormalOperatorWorker) { return }
    $normalWorker = [PowerShell]::Create()
    $normalRunspace = [RunspaceFactory]::CreateRunspace()
    $normalRunspace.ApartmentState = 'STA'
    $normalRunspace.ThreadOptions = 'ReuseThread'
    $normalRunspace.Open()
    $normalWorker.Runspace = $normalRunspace
    $cancellation=New-Object Threading.CancellationTokenSource
    [void]$normalWorker.AddScript('param($module,$root,$ownerPid,$cancel) Import-Module $module; Invoke-McpCcNormalOperatorOwner -ManagerRoot $root -TrayProcessId $ownerPid -Cancellation $cancel.Token')
    [void]$normalWorker.AddArgument((Join-Path $projectRoot 'src\McpControlCenter.NormalOperator.psm1')).AddArgument($projectRoot).AddArgument($PID).AddArgument($cancellation)
    try { $script:NormalOperatorWorker = @{ shell=$normalWorker; runspace=$normalRunspace; pending=$normalWorker.BeginInvoke(); cancellation=$cancellation } }
    catch { $normalWorker.Dispose();$normalRunspace.Dispose();$cancellation.Dispose();throw }
}
# Only the existing installed singleton owns this bounded startup channel. No
# read-only tool starts a child, and this startup is not a human approval ceremony.
if (Test-Path -LiteralPath (Join-Path $projectRoot 'config\installed-release.json') -PathType Leaf) {
    # Discovery alone does not open a pipe. Worker verifies the existing canonical
    # InstalledRelease v3 binding/selection/closure before listener construction.
    Start-NormalOperatorHost
}
# Optional, fail-closed worker belongs to this already independent tray process.
# No install, elevation, task registration, registry mutation or detached launcher.
$selfReloadPolicy = Join-Path $RuntimeRoot 'remote-self-reload-r1\policy.json'
if (Test-Path -LiteralPath $selfReloadPolicy -PathType Leaf) {
    $script:SelfReloadShutdown = New-Object Threading.CancellationTokenSource
    $worker = [PowerShell]::Create()
    [void]$worker.AddScript('param($module,$manifest,$runtime,$shutdown) Import-Module $module; Invoke-R1OwnerLoop -ManifestPath $manifest -RuntimeRoot $runtime -ShutdownSignal $shutdown')
    [void]$worker.AddArgument((Join-Path $projectRoot 'src\McpControlCenter.SelfReload.Owner.psm1')).AddArgument($ManifestPath).AddArgument($RuntimeRoot).AddArgument($script:SelfReloadShutdown)
    $script:SelfReloadWorker = @{ shell=$worker; pending=$worker.BeginInvoke() }
}

function Set-NotifyText([string]$Text) {
    if ($Text.Length -gt 63) { $Text = $Text.Substring(0, 63) }
    $notifyIcon.Text = $Text
}

function Get-StatusLabel([string]$Status) {
    return [string](Get-McpCcStatusPresentation -Status $Status).label
}

function Get-ReconcileProgressPresentation([string]$Status) {
    switch ($Status) {
        "Pending" { return [pscustomobject]@{ symbol = [string][char]0x2026; label = "Pending" } }
        "Running" { return [pscustomobject]@{ symbol = [string][char]0x2026; label = "Checking" } }
        "Ready" { return [pscustomobject]@{ symbol = [string][char]0x2713; label = "Ready" } }
        "Attention" { return [pscustomobject]@{ symbol = [string][char]0x26A0; label = "Needs attention" } }
        "Failed" { return [pscustomobject]@{ symbol = [string][char]0x2715; label = "Failed" } }
        default { return [pscustomobject]@{ symbol = "?"; label = "Unknown" } }
    }
}

function Quote-ProcessArgument([string]$Value) {
    if ($null -eq $Value) { return '""' }
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Show-Warning([string]$Message) {
    [System.Windows.Forms.MessageBox]::Show(
        $Message,
        $trayDisplayName,
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
}

function Set-TrayRestartFeedback([string]$Message, [switch]$Warning) {
    # Transient UI only; controller last-actions and controller_error remain the
    # sole durable action receipts. Status refresh must not erase this result.
    $restartResultItem.Text = "Restart MCP | $Message"
    $kind = if ($Warning) { [Windows.Forms.ToolTipIcon]::Warning } else { [Windows.Forms.ToolTipIcon]::Info }
    $notifyIcon.ShowBalloonTip(3000, $trayDisplayName, $Message, $kind)
}

function Test-TrayRestartAllowed([string]$Component) {
    if (-not $script:ComponentUi.ContainsKey($Component) -or -not $script:ComponentUi[$Component].supportsRestartMcp) { return $false }
    try {
        $state = Read-McpCcState -RuntimeRoot $RuntimeRoot
        if ($null -eq $state) { return $false }
        $matches = @($state.components | Where-Object { [string]$_.id -ceq $Component })
        return ($matches.Count -eq 1 -and [bool](Get-McpCcRestartMcpDecision -ComponentStatus $matches[0]).allowed)
    }
    catch { return $false }
}

function Invoke-TrayRestartMcpClick {
    param($Sender)
    if ($script:Closing -or $script:ExitRequested) { return }
    $matches = @($script:ComponentUi.GetEnumerator() | Where-Object { [object]::ReferenceEquals($_.Value.restartMcp, $Sender) })
    if ($matches.Count -ne 1) {
        Set-TrayRestartFeedback 'Not dispatched: the menu item does not identify one component.' -Warning
        return
    }
    $componentId = [string]$matches[0].Key
    $componentName = [string]$matches[0].Value.displayName
    $choice = [Windows.Forms.MessageBox]::Show(
        "Restart the complete MCP runtime for ${componentName}? A stopped component will be started without replacing a healthy instance.",
        $trayDisplayName,
        [Windows.Forms.MessageBoxButtons]::YesNo,
        [Windows.Forms.MessageBoxIcon]::Warning
    )
    if ($choice -eq [Windows.Forms.DialogResult]::Yes) {
        # The modal confirmation pumps events: recheck all gates after Yes.
        Start-ControllerAction -Action RestartMcp -Component $componentId
    }
}

function Update-TrayPendingRestart {
    param([switch]$StatusCompleted)
    if ($null -eq $script:PendingRestartMcp) { return }
    $pending = $script:PendingRestartMcp
    $state = Get-TrayControllerState
    $reason = $null
    if ($script:Closing -or $script:ExitRequested) { $reason = 'control center is exiting' }
    elseif (Test-TrayMaintenanceBusy) { $reason = 'Workspace manual maintenance is pending' }
    elseif ($pending.clock.Elapsed.TotalSeconds -ge 120) { $reason = 'the 120-second wait expired' }
    elseif ($state -eq 'Unknown') { $reason = 'Status process ownership could not be observed' }
    elseif ($state -eq 'Idle' -and -not $StatusCompleted) { $reason = 'the original Status completion was not confirmed' }
    elseif ($state -ne 'Idle' -and ($script:PendingAction -ne 'Status' -or $script:StatusStopAttempted -or
        -not [object]::ReferenceEquals($pending.process, $script:ControllerProcess))) { $reason = 'the original Status is no longer eligible' }
    if ($null -ne $reason) {
        $script:PendingRestartMcp = $null
        Set-TrayRestartFeedback "Cancelled / $($pending.component): $reason; not dispatched." -Warning
        return
    }
    if ($state -ne 'Idle') { return }
    # Consume before dispatch; reentrant timer callbacks cannot replay it. The
    # controller still performs its original fresh ownership/security checks.
    $script:PendingRestartMcp = $null
    Start-ControllerAction -Action RestartMcp -Component $pending.component
}

function Get-TrayControllerState {
    if ($null -eq $script:ControllerProcess) { return 'Idle' }
    try {
        # PowerShell property getter failures can yield null instead of throwing.
        $hasExited = $script:ControllerProcess.HasExited
        if ($hasExited -isnot [bool]) { return 'Unknown' }
        if ($hasExited) { return 'Exited' }
        return 'Running'
    }
    catch { return 'Unknown' }
}

function Test-TrayMaintenanceBusy {
    if ($null -ne $script:WorkspaceLocalWorker) { return $true }
    if ($null -ne $script:WorkspaceLocalOwner -and $script:WorkspaceLocalOwner.HasActiveRequest) { return $true }
    # Native Host remains authorization-closed. Its passive listener is cancellable
    # admission, not manual maintenance; do not prevent Exit from cancelling it.
    return $false
}

function Show-TrayControllerWarning {
    if ($script:ControllerWarningShown) { return }
    $script:ControllerWarningShown = $true
    # Non-modal: a failed cancellation must not block the WinForms timer.
    $notifyIcon.ShowBalloonTip(1800, $trayDisplayName, 'Status could not be confirmed stopped. Refresh is paused; any requested Exit remains pending. Component operations are unchanged.', [Windows.Forms.ToolTipIcon]::Warning)
}

function Stop-TrayApplication {
    [Windows.Forms.Application]::Exit()
}

function Complete-TrayExit {
    if (-not $script:ExitRequested -or $script:Closing) { return }
    if ((Get-TrayControllerState) -ne 'Idle' -or (Test-TrayMaintenanceBusy)) { return }
    # R1 is a long-lived owner, not a busy flag. Exit signals cooperative drain;
    # wait for the existing operation/postcheck and owner finally blocks to finish.
    if ($null -ne $script:SelfReloadWorker -and -not $script:SelfReloadWorker.pending.IsCompleted) { return }
    if ($null -ne $script:NormalOperatorWorker -and -not $script:NormalOperatorWorker.pending.IsCompleted) {
        if ($script:ExitClock.Elapsed.TotalSeconds -ge 5) { Show-TrayControllerWarning }
        return # cancellation already sent; never dispose a still-running runspace
    }
    # The owner closes admission under the same lock used to accept requests.
    if ($null -ne $script:WorkspaceLocalOwner -and -not $script:WorkspaceLocalOwner.TryBeginShutdown()) { return }
    $script:Closing = $true
    $timer.Stop()
    $notifyIcon.Visible = $false
    Stop-TrayApplication
}

function Request-TrayExit {
    if ($script:Closing -or $script:ExitRequested) { return }
    if ($null -ne $script:PendingRestartMcp) {
        $script:PendingRestartMcp = $null
        Set-TrayRestartFeedback 'Cancelled: Exit requested; not dispatched.' -Warning
    }
    if (Test-TrayMaintenanceBusy) {
        Show-Warning 'Wait for manual maintenance to finish before closing.'
        return
    }
    $state = Get-TrayControllerState
    if ($state -eq 'Unknown' -or ($state -eq 'Running' -and $script:PendingAction -ne 'Status')) {
        Show-Warning "Wait for $($script:PendingLabel) to finish before closing the control center."
        return
    }
    $script:ExitRequested = $true
    $script:ExitClock = [Diagnostics.Stopwatch]::StartNew()
    if ($null -ne $script:NormalOperatorWorker) { $script:NormalOperatorWorker.cancellation.Cancel() }
    if ($null -ne $script:SelfReloadShutdown) { $script:SelfReloadShutdown.Cancel() }
    # A request accepted just before this gate still drains on the existing timer.
    if ($null -ne $script:WorkspaceLocalOwner) { $null = $script:WorkspaceLocalOwner.TryBeginShutdown() }
    Update-TrayControllerLifecycle
}

function Update-TrayControllerLifecycle {
    if ($script:Closing) { return }
    # Check expiry, maintenance and unknown handles before reaping Status. Only
    # a normal completion of that same Status may release the one-shot request.
    Update-TrayPendingRestart
    $state = Get-TrayControllerState
    if ($state -eq 'Unknown') { Show-TrayControllerWarning; return }
    if ($state -eq 'Running' -and $script:PendingAction -eq 'Status') {
        # Monotonic overall deadline, with a shorter grace period after explicit Exit.
        $expired = ($null -ne $script:StatusClock -and $script:StatusClock.Elapsed.TotalSeconds -ge 120) -or
            ($script:ExitRequested -and $script:ExitClock.Elapsed.TotalSeconds -ge 5)
        if ($expired -and -not $script:StatusStopAttempted) {
            $script:StatusStopAttempted = $true
            $script:StatusStopClock = [Diagnostics.Stopwatch]::StartNew()
            try {
                if ($null -eq $script:StatusProcess -or -not [object]::ReferenceEquals($script:StatusProcess, $script:ControllerProcess)) { throw 'STATUS_HANDLE_UNAVAILABLE' }
                # Kill this retained process handle only, never its tree or a PID lookup.
                if (-not $script:StatusProcess.HasExited) { $script:StatusProcess.Kill() }
            }
            catch { Show-TrayControllerWarning }
        }
        if ($script:StatusStopAttempted -and $script:StatusStopClock.Elapsed.TotalSeconds -ge 5) { Show-TrayControllerWarning }
        $state = Get-TrayControllerState
    }
    if ($state -eq 'Exited') {
        try { $exitCode = $script:ControllerProcess.ExitCode }
        catch { $exitCode = -1 }
        $completedLabel = $script:PendingLabel
        $completedAction = $script:PendingAction
        $completedComponent = $script:PendingComponent
        if (($script:StatusStopAttempted -or $exitCode -ne 0) -and $null -ne $script:PendingRestartMcp) {
            $script:PendingRestartMcp = $null
            Set-TrayRestartFeedback 'Cancelled: Status did not finish normally; not dispatched.' -Warning
        }
        try { $script:ControllerProcess.Dispose() } catch { }
        $script:ControllerProcess = $null
        $script:StatusProcess = $null
        $script:StatusClock = $null
        $script:PendingAction = $null
        $script:PendingComponent = $null
        $script:PendingLabel = $null
        $script:PendingOperationId = $null
        $script:SecondsSinceRefresh = 0
        if (-not $script:ExitRequested) {
            try { Update-UiFromState }
            catch { $lastRefreshItem.Text = 'Last update: unavailable; inspect control-center logs.' }
            if ($exitCode -ne 0) {
                $notifyIcon.ShowBalloonTip(1800, $trayDisplayName, "$completedLabel completed with an attention state.", [Windows.Forms.ToolTipIcon]::Warning)
            }
            if ($completedAction -eq 'RestartMcp') {
                $result = if ($exitCode -eq 0) { 'Completed' } else { 'Failed or unconfirmed' }
                Set-TrayRestartFeedback "$result / $completedComponent. Logs: last-actions/$completedComponent.json; events (controller_error)." -Warning:($exitCode -ne 0)
            }
        }
        Update-TrayPendingRestart -StatusCompleted:($completedAction -eq 'Status' -and $exitCode -eq 0)
    }
    Complete-TrayExit
}

function Start-ControllerAction {
    param(
        [ValidateSet("Status", "Reconcile", "Start", "Restart", "RestartMcp", "RepairConnectivity", "RestartCore", "ShutdownRuntime", "ShowDiagnosticTray", "Doctor")][string]$Action,
        [string]$Component
    )
    if ($script:Closing -or $script:ExitRequested) { return }
    if (Test-TrayMaintenanceBusy) {
        if ($Action -eq 'RestartMcp') { Set-TrayRestartFeedback "Not dispatched / ${Component}: Workspace manual maintenance is pending." -Warning }
        Show-Warning 'Workspace manual maintenance is pending; inspect its request receipt.'
        return
    }
    if ($null -ne $script:PendingRestartMcp) {
        Show-Warning "Restart MCP is already pending for $($script:PendingRestartMcp.component); this request was not accepted."
        return
    }
    $controllerState = Get-TrayControllerState
    if ($Action -eq 'RestartMcp' -and -not (Test-TrayRestartAllowed -Component $Component)) {
        Set-TrayRestartFeedback "Not dispatched / ${Component}: restart eligibility or ownership is unknown; refresh and inspect MCP health." -Warning
        return
    }
    if ($controllerState -notin @('Idle', 'Exited')) {
        if ($Action -eq 'RestartMcp' -and $controllerState -eq 'Running' -and $script:PendingAction -eq 'Status' -and
            -not $script:StatusStopAttempted -and $null -ne $script:StatusClock -and $script:StatusClock.Elapsed.TotalSeconds -lt 120 -and
            [object]::ReferenceEquals($script:StatusProcess, $script:ControllerProcess)) {
            $script:PendingRestartMcp = [pscustomobject]@{ component = $Component; process = $script:ControllerProcess; clock = [Diagnostics.Stopwatch]::StartNew() }
            Set-TrayRestartFeedback "Pending / ${Component}: waiting for the current Status (at most 120 seconds)."
            return
        }
        if ($Action -eq 'RestartMcp') { Set-TrayRestartFeedback "Not dispatched / ${Component}: controller is busy or its state is unknown." -Warning }
        Show-Warning "The control center is already running $($script:PendingLabel)."
        return
    }
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $controllerPath,
        "-Action", $Action,
        "-ManifestPath", $ManifestPath,
        "-RuntimeRoot", $RuntimeRoot
    )
    $script:PendingOperationId = $null
    if ($manifest.schemaVersion -eq 4 -and $Action -eq 'Status') { $arguments+='-PublishObservation' }
    if ($Action -eq "Reconcile") {
        $script:PendingOperationId = [Guid]::NewGuid().ToString("D")
        $arguments += @("-OperationId", $script:PendingOperationId)
    }
    if (-not [string]::IsNullOrWhiteSpace($Component)) { $arguments += @("-Component", $Component) }
    try {
        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = if ($manifest.schemaVersion -eq 4) { 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' } else { (Get-Command powershell.exe -ErrorAction Stop).Source }
        $startInfo.Arguments = ($arguments | ForEach-Object { Quote-ProcessArgument ([string]$_) }) -join " "
        $startInfo.WorkingDirectory = $projectRoot
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $script:ControllerProcess = [Diagnostics.Process]::Start($startInfo)
        if ($null -eq $script:ControllerProcess) { throw 'CONTROLLER_NOT_STARTED' }
    }
    catch {
        if ($Action -ne 'RestartMcp') { throw }
        Set-TrayRestartFeedback "Launch failed / ${Component}: no controller was started; no new action receipt is available." -Warning
        return
    }
    $script:PendingAction = $Action
    $script:PendingComponent = $Component
    $script:StatusProcess = $null
    $script:StatusClock = $null
    $script:StatusStopAttempted = $false
    $script:ControllerWarningShown = $false
    if ($Action -eq 'Status') {
        $script:StatusClock = [Diagnostics.Stopwatch]::StartNew()
        try {
            # Force acquisition now, while this is the exact child we just started.
            $null = $script:ControllerProcess.Handle
            $script:StatusProcess = $script:ControllerProcess
        }
        catch { Show-TrayControllerWarning }
    }
    $script:PendingLabel = if ([string]::IsNullOrWhiteSpace($Component)) { $Action } else { "$Action / $Component" }
    $overallItem.Text = "MCP Control Center | Running: $($script:PendingLabel)"
    Set-NotifyText "$trayDisplayName | $($script:PendingLabel)"
    if ($Action -eq 'RestartMcp') { Set-TrayRestartFeedback "Started / ${Component}: waiting for the controller result." }
    if ($Action -eq "Reconcile") { Show-ReconcilePendingUi }
}

function Start-HealthDetail {
    param([Parameter(Mandatory = $true)][string]$Component)

    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $healthDetailPath,
        "-Component", $Component,
        "-ManifestPath", $ManifestPath,
        "-RuntimeRoot", $RuntimeRoot
    )
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = if ($manifest.schemaVersion -eq 4) { 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' } else { (Get-Command powershell.exe -ErrorAction Stop).Source }
    $startInfo.Arguments = ($arguments | ForEach-Object { Quote-ProcessArgument ([string]$_) }) -join " "
    $startInfo.WorkingDirectory = $projectRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    try {
        $process = [Diagnostics.Process]::Start($startInfo)
        if ($null -eq $process) { throw "The component health window did not start." }
        $process.Dispose()
    }
    catch {
        Show-Warning "Could not open MCP health for $Component. Run full diagnostics for details."
    }
}

function Update-UiFromState {
    $state = Read-McpCcState -RuntimeRoot $RuntimeRoot
    if ($null -ne $script:WorkspaceLocalOwner) {
        Publish-McpCcWorkspaceLocalState -Owner $script:WorkspaceLocalOwner -State $state
    }
    if ($null -eq $state) {
        $overallItem.Text = "MCP Control Center | First check pending"
        $lastRefreshItem.Text = "Last update: none"
        return
    }
    $readyCount = @($state.components | Where-Object { [string]$_.status -eq "Ready" }).Count
    $componentCount = @($state.components).Count
    $overallLabel = "$readyCount/$componentCount Ready"
    $overallItem.Text = "MCP Control Center | $overallLabel"
    $lastRefreshItem.Text = "Last update: $([DateTime]::Parse([string]$state.generatedAt).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss'))"
    foreach ($component in @($state.components)) {
        if (-not $script:ComponentUi.ContainsKey([string]$component.id)) { continue }
        $ui = $script:ComponentUi[[string]$component.id]
        $presentation = Get-McpCcStatusPresentation -Status ([string]$component.status)
        $ui.status.Text = "Status: $($presentation.symbol) $($presentation.label)"
        $ui.parent.Text = "$($presentation.symbol) $($component.displayName) - $($presentation.label)"
        $restartDecision = Get-McpCcRestartMcpDecision -ComponentStatus $component
        $ui.restartMcp.Enabled = ($ui.supportsRestartMcp -and [bool]$restartDecision.allowed)
        $ui.health.Enabled = $true
    }
    if ($state.overall -eq "Ready") { $notifyIcon.Icon = [Drawing.SystemIcons]::Information }
    elseif ($state.overall -eq "Degraded") { $notifyIcon.Icon = [Drawing.SystemIcons]::Warning }
    else { $notifyIcon.Icon = [Drawing.SystemIcons]::Error }
    Set-NotifyText "$trayDisplayName | $overallLabel"
}

function Show-ReconcilePendingUi {
    $overallItem.Text = "MCP Control Center | Running: Reconcile | 0/$(@($manifest.components).Count) complete"
    $lastRefreshItem.Text = "Last update: $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))"
    foreach ($component in @($manifest.components)) {
        if (-not $script:ComponentUi.ContainsKey([string]$component.id)) { continue }
        $ui = $script:ComponentUi[[string]$component.id]
        $presentation = Get-ReconcileProgressPresentation -Status "Pending"
        $ui.status.Text = "Reconcile: $($presentation.symbol) $($presentation.label)"
        $ui.parent.Text = "$($presentation.symbol) $($component.displayName) - $($presentation.label)"
        $ui.restartMcp.Enabled = $false
        $ui.health.Enabled = $true
    }
    $notifyIcon.Icon = [Drawing.SystemIcons]::Warning
    Set-NotifyText "$trayDisplayName | Reconcile 0/$(@($manifest.components).Count)"
}

function Update-UiFromReconcileProgress {
    if ([string]::IsNullOrWhiteSpace($script:PendingOperationId)) { return $false }
    $progress = Read-McpCcReconcileProgress -RuntimeRoot $RuntimeRoot -ExpectedOperationId $script:PendingOperationId
    if ($null -eq $progress) { return $false }

    $overallItem.Text = "MCP Control Center | Running: Reconcile | $([int]$progress.completedCount)/$([int]$progress.componentCount) complete"
    $lastRefreshItem.Text = "Last update: $([DateTime]::Parse([string]$progress.updatedAt).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss'))"
    foreach ($component in @($progress.components)) {
        if (-not $script:ComponentUi.ContainsKey([string]$component.id)) { continue }
        $ui = $script:ComponentUi[[string]$component.id]
        $presentation = Get-ReconcileProgressPresentation -Status ([string]$component.progressStatus)
        $ui.status.Text = "Reconcile: $($presentation.symbol) $($presentation.label)"
        $ui.parent.Text = "$($presentation.symbol) $($component.displayName) - $($presentation.label)"
        $ui.restartMcp.Enabled = $false
        $ui.health.Enabled = $true
    }
    if (@($progress.components | Where-Object { [string]$_.progressStatus -eq "Failed" }).Count -gt 0) {
        $notifyIcon.Icon = [Drawing.SystemIcons]::Error
    }
    else { $notifyIcon.Icon = [Drawing.SystemIcons]::Warning }
    Set-NotifyText "$trayDisplayName | Reconcile $([int]$progress.completedCount)/$([int]$progress.componentCount)"
    return $true
}

$contextMenu = New-Object Windows.Forms.ContextMenu
$overallItem = New-Object Windows.Forms.MenuItem "MCP Control Center | Starting"
$overallItem.Enabled = $false
$lastRefreshItem = New-Object Windows.Forms.MenuItem "Last update: none"
$lastRefreshItem.Enabled = $false
$contextMenu.MenuItems.Add($overallItem) | Out-Null
$contextMenu.MenuItems.Add($lastRefreshItem) | Out-Null
$restartResultItem = New-Object Windows.Forms.MenuItem 'Restart MCP | No request in this session'
$restartResultItem.Enabled = $false
$contextMenu.MenuItems.Add($restartResultItem) | Out-Null
$normalOperatorItem = New-Object Windows.Forms.MenuItem('NORMAL: accepting MCP requests')
$normalOperatorItem.Enabled=$false
$contextMenu.MenuItems.Add($normalOperatorItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null

$restartMcpClickHandler = { param($sender, $eventArgs) Invoke-TrayRestartMcpClick -Sender $sender }
foreach ($component in @($manifest.components | Sort-Object startupOrder)) {
    $componentId = [string]$component.id
    $componentName = [string]$component.displayName
    $menuModel = Get-McpCcTrayComponentModel -Component $component
    $supportsRestartMcp = @($menuModel.actions | Where-Object { [string]$_.id -eq "restart_mcp" }).Count -eq 1
    $parent = New-Object Windows.Forms.MenuItem "$componentName - Not checked"
    $statusItem = New-Object Windows.Forms.MenuItem "Status: Not checked"
    $statusItem.Enabled = $false
    $restartMcpItem = New-Object Windows.Forms.MenuItem "Restart MCP"
    $healthItem = New-Object Windows.Forms.MenuItem "Open MCP health"
    $definition = $component
    $restartMcpItem.add_Click($restartMcpClickHandler)
    $healthItem.add_Click(({ Start-HealthDetail -Component $componentId }).GetNewClosure())
    $parent.MenuItems.Add($statusItem) | Out-Null
    $parent.MenuItems.Add("-") | Out-Null
    if ($supportsRestartMcp) { $parent.MenuItems.Add($restartMcpItem) | Out-Null }
    $parent.MenuItems.Add($healthItem) | Out-Null
    if ($null -ne $menuModel.frontend) {
        $frontendItem = New-Object Windows.Forms.MenuItem ([string]$menuModel.frontend.label)
        if ([string]$menuModel.frontend.kind -eq "vbs") {
            $frontendPath = Resolve-McpCcChildPath -Root $component.resolvedRoot -RelativePath ([string]$menuModel.frontend.path) -Label "primary UI launcher"
            $frontendItem.add_Click(({
                $wscript = Join-Path $env:WINDIR "System32\wscript.exe"
                Start-Process -FilePath $wscript -ArgumentList "`"$frontendPath`"" -WorkingDirectory $definition.resolvedRoot -WindowStyle Hidden
            }).GetNewClosure())
        }
        elseif ([string]$menuModel.frontend.kind -eq "loopback-url") {
            $frontendTarget = [string]$menuModel.frontend.target
            $frontendItem.add_Click(({ Start-Process $frontendTarget }).GetNewClosure())
        }
        $parent.MenuItems.Add($frontendItem) | Out-Null
    }
    $contextMenu.MenuItems.Add($parent) | Out-Null
    $script:ComponentUi[$componentId] = [pscustomobject]@{
        displayName = $componentName
        parent = $parent
        status = $statusItem
        restartMcp = $restartMcpItem
        supportsRestartMcp = $supportsRestartMcp
        health = $healthItem
    }
}

$contextMenu.MenuItems.Add("-") | Out-Null
$refreshItem = New-Object Windows.Forms.MenuItem "Refresh now"
$reconcileItem = New-Object Windows.Forms.MenuItem "Run safe startup reconciliation"
$doctorItem = New-Object Windows.Forms.MenuItem "Run full diagnostics"
$openRuntimeItem = New-Object Windows.Forms.MenuItem "Open control-center logs"
$copyAdoptionItem = New-Object Windows.Forms.MenuItem "Copy Startup adoption command"
$exitItem = New-Object Windows.Forms.MenuItem "Exit control center only"

$refreshItem.add_Click({ Start-ControllerAction -Action Status })
$reconcileItem.add_Click({ Start-ControllerAction -Action Reconcile })
$doctorItem.add_Click({ Start-ControllerAction -Action Doctor })
$openRuntimeItem.add_Click({ New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null; Start-Process explorer.exe -ArgumentList "`"$RuntimeRoot`"" })
$copyAdoptionItem.add_Click({
    $command = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\startup.ps1`" -Action Adopt -Apply"
    [Windows.Forms.Clipboard]::SetText($command)
    $notifyIcon.ShowBalloonTip(1200, $trayDisplayName, "Copied. Run Plan before applying Startup adoption.", [Windows.Forms.ToolTipIcon]::Info)
})
$exitItem.add_Click({ Request-TrayExit })

foreach ($item in @($refreshItem, $reconcileItem, $doctorItem, "-", $openRuntimeItem, $copyAdoptionItem, "-", $exitItem)) {
    $contextMenu.MenuItems.Add($item) | Out-Null
}

$notifyIcon = New-Object Windows.Forms.NotifyIcon
$notifyIcon.ContextMenu = $contextMenu
$notifyIcon.Icon = [Drawing.SystemIcons]::Warning
$notifyIcon.Text = "$trayDisplayName | Starting"
$notifyIcon.Visible = $true

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({
    if ($script:Closing) { return }
    if ($null -ne $script:WorkspaceLocalWorker -and $script:WorkspaceLocalWorker.pending.IsCompleted) {
        try { $null=$script:WorkspaceLocalWorker.shell.EndInvoke($script:WorkspaceLocalWorker.pending) }
        catch { Write-Warning 'Workspace maintenance result unknown; inspect its request receipt.' }
        finally {
            if ($script:WorkspaceLocalOwner.HasActiveRequest) {
                try { $script:WorkspaceLocalOwner.Complete($script:WorkspaceLocalWorker.requestId,'UNKNOWN') }
                catch { Write-Warning 'Workspace receipt update unavailable; durable UNKNOWN remains.' }
            }
            $script:WorkspaceLocalWorker.shell.Dispose(); $script:WorkspaceLocalWorker=$null
        }
        # Existing periodic Status refresh will publish new observations.
        $script:SecondsSinceRefresh=[int]$manifest.settings.refreshIntervalSeconds
    }
    if ($null -ne $script:WorkspaceLocalOwner -and $null -eq $script:WorkspaceLocalWorker -and $null -eq $script:ControllerProcess) {
        $request=$script:WorkspaceLocalOwner.TakePending()
        if ($null -ne $request) {
            $script:WorkspaceLocalOwner.Publish($null)
            $maintenance=[PowerShell]::Create()
            [void]$maintenance.AddScript('param($core,$module,$owner,$request,$manifest,$runtime) Import-Module $core; Import-Module $module; Invoke-McpCcWorkspaceLocalRestart -Owner $owner -Request $request -Manifest $manifest -RuntimeRoot $runtime')
            [void]$maintenance.AddArgument($modulePath).AddArgument((Join-Path $projectRoot 'src\McpControlCenter.WorkspaceLocal.psm1')).AddArgument($script:WorkspaceLocalOwner).AddArgument($request).AddArgument($manifest).AddArgument($RuntimeRoot)
            try { $script:WorkspaceLocalWorker=@{shell=$maintenance;pending=$maintenance.BeginInvoke();requestId=$request.requestId} }
            catch { $maintenance.Dispose();$script:WorkspaceLocalOwner.Complete($request.requestId,'UNKNOWN') }
        }
    }
    if ($null -ne $script:NormalOperatorWorker -and $script:NormalOperatorWorker.pending.IsCompleted) {
        try {
            $gateResults=@($script:NormalOperatorWorker.shell.EndInvoke($script:NormalOperatorWorker.pending))
            $gateCode='HOST_PREFLIGHT_FAILED'
            if ($gateResults.Count -eq 1 -and $gateResults[0].status -ceq 'BLOCKED' -and
                $gateResults[0].failure.code -cmatch '^[A-Z][A-Z0-9_]{2,95}$') { $gateCode=$gateResults[0].failure.code }
            $normalOperatorItem.Text='NORMAL Operator: BLOCKED / '+$gateCode
            if($gateResults.Count -eq 1 -and $gateResults[0].status -ceq 'STOPPED') {
                $normalOperatorItem.Text='NORMAL Operator: stopped'
            }
        } catch { $normalOperatorItem.Text='NORMAL Operator: BLOCKED / HOST_PREFLIGHT_FAILED' }
        finally {
            $script:NormalOperatorWorker.shell.Dispose()
            $script:NormalOperatorWorker.runspace.Dispose()
            $script:NormalOperatorWorker.cancellation.Dispose()
            $script:NormalOperatorWorker=$null
        }
    }
    $hadController = $null -ne $script:ControllerProcess
    Update-TrayControllerLifecycle
    if ($script:Closing -or $script:ExitRequested) { return }
    if ($null -ne $script:ControllerProcess -and $script:PendingLabel -eq "Reconcile") {
        Update-UiFromReconcileProgress | Out-Null
    }
    elseif (-not $hadController -and $null -eq $script:ControllerProcess -and $null -eq $script:WorkspaceLocalWorker) {
        $script:SecondsSinceRefresh += 1
        if ($script:SecondsSinceRefresh -ge [int]$manifest.settings.refreshIntervalSeconds) {
            $script:SecondsSinceRefresh = 0
            Start-ControllerAction -Action Status
        }
    }
})
$timer.Start()

try {
    Update-UiFromState
    if ($AutoReconcile) { Start-ControllerAction -Action Reconcile }
    else { Start-ControllerAction -Action Status }
    [Windows.Forms.Application]::Run()
}
finally {
    if ($null -ne $script:WorkspaceLocalOwner) { $script:WorkspaceLocalOwner.Dispose() }
    if ($null -ne $script:WorkspaceLocalWorker) { $script:WorkspaceLocalWorker.shell.Dispose() }
    if ($null -ne $script:NormalOperatorWorker) {
        $script:NormalOperatorWorker.cancellation.Cancel()
        $script:NormalOperatorWorker.shell.Stop()
        $script:NormalOperatorWorker.shell.Dispose()
        $script:NormalOperatorWorker.runspace.Dispose()
        $script:NormalOperatorWorker.cancellation.Dispose()
    }
    if ($null -ne $script:SelfReloadWorker) {
        $script:SelfReloadWorker.shell.Stop()
        $script:SelfReloadWorker.shell.Dispose()
    }
    if ($null -ne $script:SelfReloadShutdown) { $script:SelfReloadShutdown.Dispose() }
    $timer.Stop()
    $timer.Dispose()
    if ($null -ne $script:ControllerProcess) { try { $script:ControllerProcess.Dispose() } catch { } }
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    if ((Read-TrayPid) -eq $PID) { Remove-Item -LiteralPath $trayPidPath -Force -ErrorAction SilentlyContinue }
    if ($createdNew) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
