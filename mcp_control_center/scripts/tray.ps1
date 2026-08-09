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
Import-Module $modulePath -Force

if ([string]::IsNullOrWhiteSpace($ManifestPath)) { $ManifestPath = Get-McpCcDefaultManifestPath }
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) { $RuntimeRoot = Get-McpCcDefaultRuntimeRoot }
$manifest = Read-McpCcManifest -Path $ManifestPath
if (Test-McpCcPathWithinRoot -Path $RuntimeRoot -Root $manifest.workspaceRoot) {
    throw "RuntimeRoot must be outside the source workspace."
}
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
        replaceExistingSupported = $true
        autoReconcile = [bool]$AutoReconcile
        troubleshootingToolsIndependent = $true
    } | ConvertTo-Json -Depth 6
    if (-not $selfTestResult.ok -or -not (Test-Path -LiteralPath $controllerPath -PathType Leaf)) { exit 1 }
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
$script:SecondsSinceRefresh = 0
$script:Closing = $false
$script:ComponentUi = @{}
$script:IndependentProcesses = @()

function Set-NotifyText([string]$Text) {
    if ($Text.Length -gt 63) { $Text = $Text.Substring(0, 63) }
    $notifyIcon.Text = $Text
}

function Get-StatusLabel([string]$Status) {
    switch ($Status) {
        "Ready" { return "Ready" }
        "Degraded" { return "Connectivity degraded" }
        "BlockedUpstream" { return "Waiting for upstream" }
        "Stopped" { return "Stopped" }
        "Unhealthy" { return "Unhealthy" }
        "OwnershipMismatch" { return "Ownership mismatch" }
        "Misconfigured" { return "Misconfigured" }
        "NotInstalled" { return "Not installed" }
        default { return "Not checked" }
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

function Start-ControllerAction {
    param(
        [ValidateSet("Status", "Reconcile", "Start", "Restart", "RepairConnectivity", "RestartCore", "ShutdownRuntime", "ShowDiagnosticTray", "Doctor")][string]$Action,
        [string]$Component
    )
    if ($null -ne $script:ControllerProcess -and -not $script:ControllerProcess.HasExited) {
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
    if (-not [string]::IsNullOrWhiteSpace($Component)) { $arguments += @("-Component", $Component) }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = (Get-Command powershell.exe -ErrorAction Stop).Source
    $startInfo.Arguments = ($arguments | ForEach-Object { Quote-ProcessArgument ([string]$_) }) -join " "
    $startInfo.WorkingDirectory = $projectRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $script:ControllerProcess = [Diagnostics.Process]::Start($startInfo)
    $script:PendingLabel = if ([string]::IsNullOrWhiteSpace($Component)) { $Action } else { "$Action / $Component" }
    $overallItem.Text = "MCP Control Center | Running: $($script:PendingLabel)"
    Set-NotifyText "$trayDisplayName | $($script:PendingLabel)"
}

function Start-IndependentControllerAction {
    param(
        [ValidateSet("ShowDiagnosticTray", "ComponentMenuAction")][string]$Action,
        [Parameter(Mandatory = $true)][string]$Component,
        [string]$UiAction
    )
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $controllerPath,
        "-Action", $Action,
        "-Component", $Component,
        "-ManifestPath", $ManifestPath,
        "-RuntimeRoot", $RuntimeRoot
    )
    if ($Action -eq "ComponentMenuAction") {
        if ([string]::IsNullOrWhiteSpace($UiAction)) { throw "ComponentMenuAction requires UiAction." }
        $arguments += @("-UiAction", $UiAction)
    }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = (Get-Command powershell.exe -ErrorAction Stop).Source
    $startInfo.Arguments = ($arguments | ForEach-Object { Quote-ProcessArgument ([string]$_) }) -join " "
    $startInfo.WorkingDirectory = $projectRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    try {
        $process = [Diagnostics.Process]::Start($startInfo)
        if ($null -eq $process) { throw "The troubleshooting launcher did not start." }
        $script:IndependentProcesses += [pscustomobject]@{
            process = $process
            label = if ($Action -eq "ComponentMenuAction") { "$Component / $UiAction" } else { "$Component / troubleshooting tools" }
        }
    }
    catch {
        Show-Warning "Could not delegate $Action for $Component. Run full diagnostics for details."
    }
}

function Update-UiFromState {
    $state = Read-McpCcState -RuntimeRoot $RuntimeRoot
    if ($null -eq $state) {
        $overallItem.Text = "MCP Control Center | First check pending"
        $lastRefreshItem.Text = "Last update: none"
        return
    }
    $overallLabel = switch ([string]$state.overall) {
        "Ready" { "All ready" }
        "Degraded" { "Partially degraded" }
        "Failed" { "Attention required" }
        default { [string]$state.overall }
    }
    $overallItem.Text = "MCP Control Center | $overallLabel"
    $lastRefreshItem.Text = "Last update: $([DateTime]::Parse([string]$state.generatedAt).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss'))"
    foreach ($component in @($state.components)) {
        if (-not $script:ComponentUi.ContainsKey([string]$component.id)) { continue }
        $ui = $script:ComponentUi[[string]$component.id]
        $label = Get-StatusLabel ([string]$component.status)
        $ui.status.Text = "Status: $label"
        $ui.parent.Text = "$($component.displayName) - $label"
        $ui.start.Enabled = ($ui.supportsStart -and [string]$component.status -eq "Stopped")
        $ui.restart.Enabled = ($ui.supportsReload -and [string]$component.status -notin @("NotInstalled", "Misconfigured", "OwnershipMismatch"))
        $ui.repair.Enabled = ($ui.supportsRepair -and [string]$component.status -notin @("Stopped", "NotInstalled", "Misconfigured", "OwnershipMismatch"))
        $ui.restartCore.Enabled = ($ui.supportsRestartCore -and [string]$component.status -notin @("Stopped", "NotInstalled", "Misconfigured", "OwnershipMismatch"))
        $ui.shutdown.Enabled = ($ui.supportsShutdown -and [string]$component.status -notin @("Stopped", "NotInstalled", "Misconfigured", "OwnershipMismatch"))
        $ui.diagnostic.Enabled = $ui.supportsDiagnostic
        $ui.health.Enabled = -not [string]::IsNullOrWhiteSpace([string]$component.healthUrl)
    }
    if ($state.overall -eq "Ready") { $notifyIcon.Icon = [Drawing.SystemIcons]::Information }
    elseif ($state.overall -eq "Degraded") { $notifyIcon.Icon = [Drawing.SystemIcons]::Warning }
    else { $notifyIcon.Icon = [Drawing.SystemIcons]::Error }
    Set-NotifyText "$trayDisplayName | $overallLabel"
}

$contextMenu = New-Object Windows.Forms.ContextMenu
$overallItem = New-Object Windows.Forms.MenuItem "MCP Control Center | Starting"
$overallItem.Enabled = $false
$lastRefreshItem = New-Object Windows.Forms.MenuItem "Last update: none"
$lastRefreshItem.Enabled = $false
$contextMenu.MenuItems.Add($overallItem) | Out-Null
$contextMenu.MenuItems.Add($lastRefreshItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null

foreach ($component in @($manifest.components | Sort-Object startupOrder)) {
    $componentId = [string]$component.id
    $componentName = [string]$component.displayName
    $capabilities = @($component.capabilities | ForEach-Object { [string]$_ })
    $supportsStart = "ensure_running" -in $capabilities
    $supportsRepair = "repair_connectivity" -in $capabilities
    $supportsRestartCore = "restart_core" -in $capabilities
    $supportsReload = "reload_runtime" -in $capabilities
    $supportsShutdown = "shutdown_runtime" -in $capabilities
    $supportsDiagnostic = "show_diagnostic_tray" -in $capabilities
    $navigationDefinitions = @(if ($null -ne $component.PSObject.Properties["navigation"]) { $component.navigation } else { @() })
    $primaryLauncher = $null
    $componentMenuActions = @()
    $usesComponentMenu = $false
    if ($null -ne $component.PSObject.Properties["ui"] -and $null -ne $component.ui -and $null -ne $component.ui.PSObject.Properties["primaryLauncher"]) {
        $primaryLauncher = $component.ui.primaryLauncher
    }
    if (
        $null -ne $component.PSObject.Properties["ui"] -and
        $null -ne $component.ui -and
        $null -ne $component.ui.PSObject.Properties["menuContract"] -and
        [string]$component.ui.menuContract -eq "component-menu-v1"
    ) {
        $usesComponentMenu = $true
        $componentMenuActions = @($component.ui.menuActions)
    }
    $parent = New-Object Windows.Forms.MenuItem "$componentName - Not checked"
    $statusItem = New-Object Windows.Forms.MenuItem "Status: Not checked"
    $statusItem.Enabled = $false
    $startItem = New-Object Windows.Forms.MenuItem "Start component"
    $repairItem = New-Object Windows.Forms.MenuItem "Repair connectivity"
    $restartCoreItem = New-Object Windows.Forms.MenuItem "Restart MCP server"
    $restartItem = New-Object Windows.Forms.MenuItem "Reload component"
    $shutdownItem = New-Object Windows.Forms.MenuItem "Stop component"
    $diagnosticItem = New-Object Windows.Forms.MenuItem "Open troubleshooting tools"
    $healthItem = New-Object Windows.Forms.MenuItem "Open health"
    $healthItem.Enabled = $false
    $folderItem = New-Object Windows.Forms.MenuItem "Open component folder"
    $primaryUiItem = New-Object Windows.Forms.MenuItem "Open primary UI"
    $definition = $component
    $startItem.add_Click(({ Start-ControllerAction -Action Start -Component $componentId }).GetNewClosure())
    $repairItem.add_Click(({
        $choice = [Windows.Forms.MessageBox]::Show(
            "Repair only the connectivity runtime for $componentName? A healthy core must not be restarted.",
            $trayDisplayName,
            [Windows.Forms.MessageBoxButtons]::YesNo,
            [Windows.Forms.MessageBoxIcon]::Warning
        )
        if ($choice -eq [Windows.Forms.DialogResult]::Yes) {
            Start-ControllerAction -Action RepairConnectivity -Component $componentId
        }
    }).GetNewClosure())
    $restartCoreItem.add_Click(({
        $choice = [Windows.Forms.MessageBox]::Show(
            "Restart only the core runtime for $componentName?",
            $trayDisplayName,
            [Windows.Forms.MessageBoxButtons]::YesNo,
            [Windows.Forms.MessageBoxIcon]::Warning
        )
        if ($choice -eq [Windows.Forms.DialogResult]::Yes) {
            Start-ControllerAction -Action RestartCore -Component $componentId
        }
    }).GetNewClosure())
    $restartItem.add_Click(({
        $choice = [Windows.Forms.MessageBox]::Show(
            "Reload $componentName through its exact-path lifecycle entrypoint?",
            $trayDisplayName,
            [Windows.Forms.MessageBoxButtons]::YesNo,
            [Windows.Forms.MessageBoxIcon]::Warning
        )
        if ($choice -eq [Windows.Forms.DialogResult]::Yes) {
            Start-ControllerAction -Action Restart -Component $componentId
        }
    }).GetNewClosure())
    $shutdownItem.add_Click(({
        $choice = [Windows.Forms.MessageBox]::Show(
            "Stop the complete runtime for $componentName? This stops its core and connectivity processes only.",
            $trayDisplayName,
            [Windows.Forms.MessageBoxButtons]::YesNo,
            [Windows.Forms.MessageBoxIcon]::Warning
        )
        if ($choice -eq [Windows.Forms.DialogResult]::Yes) {
            Start-ControllerAction -Action ShutdownRuntime -Component $componentId
        }
    }).GetNewClosure())
    $diagnosticItem.add_Click(({ Start-IndependentControllerAction -Action ShowDiagnosticTray -Component $componentId }).GetNewClosure())
    $healthItem.add_Click(({
        $state = Read-McpCcState -RuntimeRoot $RuntimeRoot
        $current = @($state.components | Where-Object { $_.id -eq $componentId } | Select-Object -First 1)
        if ($current.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace([string]$current[0].healthUrl)) {
            Start-Process ([string]$current[0].healthUrl)
        }
    }).GetNewClosure())
    if ($null -ne $primaryLauncher) {
        $primaryLauncherPath = Resolve-McpCcChildPath -Root $component.resolvedRoot -RelativePath ([string]$primaryLauncher.path) -Label "primary UI launcher"
        $primaryUiItem.add_Click(({
            $wscript = Join-Path $env:WINDIR "System32\wscript.exe"
            Start-Process -FilePath $wscript -ArgumentList "`"$primaryLauncherPath`"" -WorkingDirectory $definition.resolvedRoot -WindowStyle Hidden
        }).GetNewClosure())
    }
    $folderItem.add_Click(({ Start-Process explorer.exe -ArgumentList "`"$($definition.resolvedRoot)`"" }).GetNewClosure())
    $parent.MenuItems.Add($statusItem) | Out-Null
    $parent.MenuItems.Add("-") | Out-Null
    if ($supportsStart) { $parent.MenuItems.Add($startItem) | Out-Null }
    if ($supportsRepair) { $parent.MenuItems.Add($repairItem) | Out-Null }
    if ($supportsRestartCore) { $parent.MenuItems.Add($restartCoreItem) | Out-Null }
    if ($supportsReload) { $parent.MenuItems.Add($restartItem) | Out-Null }
    if ($supportsShutdown) { $parent.MenuItems.Add($shutdownItem) | Out-Null }
    $parent.MenuItems.Add("-") | Out-Null
    if ($usesComponentMenu) {
        $previousGroup = $null
        foreach ($menuActionDefinition in $componentMenuActions) {
            $menuActionId = [string]$menuActionDefinition.id
            $menuActionLabel = [string]$menuActionDefinition.label
            $menuActionGroup = [string]$menuActionDefinition.group
            $menuActionConfirmation = [string]$menuActionDefinition.confirmation
            if ($null -ne $previousGroup -and $menuActionGroup -ne $previousGroup) {
                $parent.MenuItems.Add("-") | Out-Null
            }
            $menuActionItem = New-Object Windows.Forms.MenuItem $menuActionLabel
            $menuActionItem.add_Click(({
                if ($menuActionConfirmation -eq "required") {
                    $choice = [Windows.Forms.MessageBox]::Show(
                        "Run '$menuActionLabel' for $componentName?",
                        $trayDisplayName,
                        [Windows.Forms.MessageBoxButtons]::YesNo,
                        [Windows.Forms.MessageBoxIcon]::Warning
                    )
                    if ($choice -ne [Windows.Forms.DialogResult]::Yes) { return }
                }
                Start-IndependentControllerAction -Action ComponentMenuAction -Component $componentId -UiAction $menuActionId
            }).GetNewClosure())
            $parent.MenuItems.Add($menuActionItem) | Out-Null
            $previousGroup = $menuActionGroup
        }
    }
    else {
        if ($null -ne $primaryLauncher) { $parent.MenuItems.Add($primaryUiItem) | Out-Null }
        if ($navigationDefinitions.Count -eq 0) {
            $parent.MenuItems.Add($healthItem) | Out-Null
        }
        else {
            foreach ($navigationDefinition in $navigationDefinitions) {
                $navigationItem = New-Object Windows.Forms.MenuItem ([string]$navigationDefinition.label)
                $navigationKind = [string]$navigationDefinition.kind
                $navigationTarget = [string]$navigationDefinition.target
                $navigationResolvedTarget = switch ($navigationKind) {
                    "probe" { [string]@($component.probes | Where-Object { $_.id -eq $navigationTarget } | Select-Object -First 1)[0].url }
                    "loopback-url" { $navigationTarget }
                    "component-path" { Resolve-McpCcChildPath -Root $component.resolvedRoot -RelativePath $navigationTarget -Label "navigation target" }
                }
                $navigationItem.add_Click(({
                    if ($navigationKind -eq "component-path") {
                        Start-Process explorer.exe -ArgumentList "`"$navigationResolvedTarget`""
                    }
                    else { Start-Process $navigationResolvedTarget }
                }).GetNewClosure())
                $parent.MenuItems.Add($navigationItem) | Out-Null
            }
        }
    }
    $parent.MenuItems.Add("-") | Out-Null
    if ($supportsDiagnostic) { $parent.MenuItems.Add($diagnosticItem) | Out-Null }
    $parent.MenuItems.Add($folderItem) | Out-Null
    $contextMenu.MenuItems.Add($parent) | Out-Null
    $script:ComponentUi[$componentId] = [pscustomobject]@{
        parent = $parent
        status = $statusItem
        start = $startItem
        repair = $repairItem
        restartCore = $restartCoreItem
        restart = $restartItem
        shutdown = $shutdownItem
        diagnostic = $diagnosticItem
        supportsStart = $supportsStart
        supportsRepair = $supportsRepair
        supportsRestartCore = $supportsRestartCore
        supportsReload = $supportsReload
        supportsShutdown = $supportsShutdown
        supportsDiagnostic = $supportsDiagnostic
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
$exitItem.add_Click({
    if ($null -ne $script:ControllerProcess -and -not $script:ControllerProcess.HasExited) {
        Show-Warning "Wait for $($script:PendingLabel) to finish before closing the control center."
        return
    }
    $script:Closing = $true
    $timer.Stop()
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    [Windows.Forms.Application]::Exit()
})

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
    $remainingIndependent = @()
    foreach ($entry in @($script:IndependentProcesses)) {
        if ($entry.process.HasExited) {
            $independentExitCode = $entry.process.ExitCode
            $independentLabel = [string]$entry.label
            $entry.process.Dispose()
            if ($independentExitCode -eq 0) {
                $notifyIcon.ShowBalloonTip(1200, $trayDisplayName, "$independentLabel completed.", [Windows.Forms.ToolTipIcon]::Info)
            }
            else {
                $notifyIcon.ShowBalloonTip(1800, $trayDisplayName, "$independentLabel needs attention. Run full diagnostics for details.", [Windows.Forms.ToolTipIcon]::Warning)
            }
        }
        else { $remainingIndependent += $entry }
    }
    $script:IndependentProcesses = $remainingIndependent
    if ($null -ne $script:ControllerProcess -and $script:ControllerProcess.HasExited) {
        $exitCode = $script:ControllerProcess.ExitCode
        $completedLabel = $script:PendingLabel
        $script:ControllerProcess.Dispose()
        $script:ControllerProcess = $null
        $script:PendingLabel = $null
        $script:SecondsSinceRefresh = 0
        Update-UiFromState
        if ($exitCode -ne 0) {
            $notifyIcon.ShowBalloonTip(1800, $trayDisplayName, "$completedLabel completed with an attention state.", [Windows.Forms.ToolTipIcon]::Warning)
        }
    }
    elseif ($null -eq $script:ControllerProcess) {
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
    $timer.Stop()
    $timer.Dispose()
    if ($null -ne $script:ControllerProcess -and -not $script:ControllerProcess.HasExited) {
        $script:ControllerProcess.Dispose()
    }
    foreach ($entry in @($script:IndependentProcesses)) { $entry.process.Dispose() }
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    if ((Read-TrayPid) -eq $PID) { Remove-Item -LiteralPath $trayPidPath -Force -ErrorAction SilentlyContinue }
    if ($createdNew) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
