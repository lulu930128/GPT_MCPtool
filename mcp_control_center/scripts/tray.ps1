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
        dailyMenuContract = "component-daily-menu-v1"
        dailyMenuModelsValid = @($manifest.components | Where-Object { @(Get-McpCcTrayComponentModel -Component $_).actions.Count -lt 2 -or @(Get-McpCcTrayComponentModel -Component $_).actions.Count -gt 3 }).Count -eq 0
        frontendComponentCount = @($manifest.components | Where-Object { $null -ne (Get-McpCcTrayComponentModel -Component $_).frontend }).Count
        healthDetailExists = Test-Path -LiteralPath $healthDetailPath -PathType Leaf
        replaceExistingSupported = $true
        autoReconcile = [bool]$AutoReconcile
        healthDetailIndependent = $true
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
$script:SecondsSinceRefresh = 0
$script:Closing = $false
$script:ComponentUi = @{}

function Set-NotifyText([string]$Text) {
    if ($Text.Length -gt 63) { $Text = $Text.Substring(0, 63) }
    $notifyIcon.Text = $Text
}

function Get-StatusLabel([string]$Status) {
    return [string](Get-McpCcStatusPresentation -Status $Status).label
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
        [ValidateSet("Status", "Reconcile", "Start", "Restart", "RestartMcp", "RepairConnectivity", "RestartCore", "ShutdownRuntime", "ShowDiagnosticTray", "Doctor")][string]$Action,
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
    $startInfo.FileName = (Get-Command powershell.exe -ErrorAction Stop).Source
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
    $menuModel = Get-McpCcTrayComponentModel -Component $component
    $supportsRestartMcp = @($menuModel.actions | Where-Object { [string]$_.id -eq "restart_mcp" }).Count -eq 1
    $parent = New-Object Windows.Forms.MenuItem "$componentName - Not checked"
    $statusItem = New-Object Windows.Forms.MenuItem "Status: Not checked"
    $statusItem.Enabled = $false
    $restartMcpItem = New-Object Windows.Forms.MenuItem "Restart MCP"
    $healthItem = New-Object Windows.Forms.MenuItem "Open MCP health"
    $definition = $component
    $restartMcpItem.add_Click(({
        $choice = [Windows.Forms.MessageBox]::Show(
            "Restart the complete MCP runtime for $componentName? A stopped component will be started without replacing a healthy instance.",
            $trayDisplayName,
            [Windows.Forms.MessageBoxButtons]::YesNo,
            [Windows.Forms.MessageBoxIcon]::Warning
        )
        if ($choice -eq [Windows.Forms.DialogResult]::Yes) {
            Start-ControllerAction -Action RestartMcp -Component $componentId
        }
    }).GetNewClosure())
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
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    if ((Read-TrayPid) -eq $PID) { Remove-Item -LiteralPath $trayPidPath -Force -ErrorAction SilentlyContinue }
    if ($createdNew) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
