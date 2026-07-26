param(
    [switch]$NoAutoStart,
    [switch]$ReplaceExisting,
    [switch]$SelfTest
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$TrayDisplayName = "Memory Core MCP"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$stackScript = Join-Path $PSScriptRoot "memory_core_stack.ps1"
$runtimeDir = Join-Path $projectRoot "data\runtime"
$trayPidPath = Join-Path $runtimeDir "memory-core-tray.pid"
$trayLogPath = Join-Path $runtimeDir "memory-core-tray.log"
$actionStdoutPath = Join-Path $runtimeDir "memory-core-tray-action.stdout.log"
$actionStderrPath = Join-Path $runtimeDir "memory-core-tray-action.stderr.log"
$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$backendHealthUrl = "http://127.0.0.1:8765/health"
$backendDocsUrl = "http://127.0.0.1:8765/docs"
$mcpHealthUrl = "http://127.0.0.1:8818/health"
$mcpUrl = "http://127.0.0.1:8818/mcp"
$tunnelAdminUrl = "http://127.0.0.1:8800"
$tunnelReadyUrl = "$tunnelAdminUrl/readyz"
$tunnelUiUrl = "$tunnelAdminUrl/ui"

[IO.Directory]::CreateDirectory($runtimeDir) | Out-Null

function Test-HttpEndpoint([string]$Url) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 1
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

function Read-PidFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    $processId = 0
    if (-not [int]::TryParse(([IO.File]::ReadAllText($Path).Trim()), [ref]$processId)) {
        return $null
    }
    return $processId
}

function Test-PidRunning([string]$Path) {
    $processId = Read-PidFile $Path
    if ($null -eq $processId) {
        return $false
    }
    return $null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)
}

function Write-TrayLog([string]$Message) {
    try {
        $timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffK")
        Add-Content -LiteralPath $trayLogPath -Value "$timestamp $Message" -Encoding UTF8
    }
    catch {
        # Tray logging must never terminate the controller.
    }
}

if ($SelfTest) {
    [ordered]@{
        trayDisplayName = $TrayDisplayName
        projectRoot = $projectRoot
        stackScript = $stackScript
        stackScriptExists = Test-Path -LiteralPath $stackScript
        powershellPath = $powershellPath
        powershellExists = Test-Path -LiteralPath $powershellPath
        trayPidPath = $trayPidPath
        trayPid = Read-PidFile $trayPidPath
        backendHealthy = Test-HttpEndpoint $backendHealthUrl
        mcpHealthy = Test-HttpEndpoint $mcpHealthUrl
        tunnelReady = Test-HttpEndpoint $tunnelReadyUrl
        mcpUrl = $mcpUrl
        tunnelUiUrl = $tunnelUiUrl
    } | ConvertTo-Json -Depth 4
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:ActionProcess = $null
$script:ActionName = $null
$script:Closing = $false

function Show-Message([string]$Message, [System.Windows.Forms.MessageBoxIcon]$Icon) {
    [System.Windows.Forms.MessageBox]::Show(
        $Message,
        $TrayDisplayName,
        [System.Windows.Forms.MessageBoxButtons]::OK,
        $Icon
    ) | Out-Null
}

function Show-Info([string]$Message) {
    Show-Message -Message $Message -Icon ([System.Windows.Forms.MessageBoxIcon]::Information)
}

function Show-Warning([string]$Message) {
    Show-Message -Message $Message -Icon ([System.Windows.Forms.MessageBoxIcon]::Warning)
}

function Show-Error([string]$Message) {
    Show-Message -Message $Message -Icon ([System.Windows.Forms.MessageBoxIcon]::Error)
}

function Get-ExistingTrayProcess {
    $processId = Read-PidFile $trayPidPath
    if ($null -eq $processId -or $processId -eq $PID) {
        return $null
    }

    $nativeProcess = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($null -eq $nativeProcess) {
        Remove-Item -LiteralPath $trayPidPath -ErrorAction SilentlyContinue
        return $null
    }

    $cimProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    if (
        $null -ne $cimProcess -and
        -not [string]::IsNullOrWhiteSpace($cimProcess.CommandLine) -and
        $cimProcess.CommandLine.Contains("memory_core_tray.ps1")
    ) {
        return $nativeProcess
    }

    Remove-Item -LiteralPath $trayPidPath -ErrorAction SilentlyContinue
    return $null
}

function Write-TrayPid {
    [IO.File]::WriteAllText($trayPidPath, [string]$PID, (New-Object Text.UTF8Encoding($false)))
}

function Remove-OwnTrayPid {
    if ((Read-PidFile $trayPidPath) -eq $PID) {
        Remove-Item -LiteralPath $trayPidPath -ErrorAction SilentlyContinue
    }
}

$existingTray = Get-ExistingTrayProcess
if ($null -ne $existingTray) {
    if (-not $ReplaceExisting) {
        Show-Info "Memory Core tray is already running."
        exit 0
    }
    Write-TrayLog "Replacing previous tray pid=$($existingTray.Id) without stopping services."
    Stop-Process -Id $existingTray.Id -ErrorAction Stop
    Wait-Process -Id $existingTray.Id -Timeout 3 -ErrorAction SilentlyContinue
}

Write-TrayPid
Write-TrayLog "Tray started pid=$PID."

function Set-NotifyText([string]$Text) {
    if ($Text.Length -gt 63) {
        $Text = $Text.Substring(0, 63)
    }
    $notifyIcon.Text = $Text
}

function Show-Balloon([string]$Message, [System.Windows.Forms.ToolTipIcon]$Icon) {
    $notifyIcon.ShowBalloonTip(1500, $TrayDisplayName, $Message, $Icon)
}

function Test-ActionRunning {
    return $null -ne $script:ActionProcess -and -not $script:ActionProcess.HasExited
}

function Start-StackAction([ValidateSet("Start", "Stop", "Restart")][string]$Action) {
    if (Test-ActionRunning) {
        Show-Warning "Memory Core is already running the $($script:ActionName) action."
        return $false
    }

    Remove-Item -LiteralPath $actionStdoutPath -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $actionStderrPath -ErrorAction SilentlyContinue
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$stackScript`" -Action $Action"
    try {
        $script:ActionProcess = Start-Process `
            -FilePath $powershellPath `
            -ArgumentList $arguments `
            -WorkingDirectory $projectRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $actionStdoutPath `
            -RedirectStandardError $actionStderrPath `
            -PassThru
        # Force Windows PowerShell to retain the native process handle. Without
        # this, ExitCode can remain $null even after HasExited is true.
        [void]$script:ActionProcess.Handle
        $script:ActionName = $Action
        Write-TrayLog "Started stack action=$Action pid=$($script:ActionProcess.Id)."
        Show-Balloon "$Action requested." ([System.Windows.Forms.ToolTipIcon]::Info)
        return $true
    }
    catch {
        $script:ActionProcess = $null
        $script:ActionName = $null
        Write-TrayLog "Could not start stack action=$Action error=$($_.Exception.Message)"
        Show-Error "Could not start the $Action action.`n$($_.Exception.Message)"
        return $false
    }
}

function Complete-StackAction {
    if ($null -eq $script:ActionProcess -or -not $script:ActionProcess.HasExited) {
        return
    }

    $action = $script:ActionName
    $actionProcess = $script:ActionProcess
    $exitCode = $null
    $completionError = $null
    try {
        # Windows PowerShell can leave ExitCode unset on a Start-Process object
        # until the process handle and redirected streams have been finalized.
        $actionProcess.WaitForExit()
        $actionProcess.Refresh()
        $exitCode = $actionProcess.ExitCode
    }
    catch {
        $completionError = $_.Exception.Message
    }
    finally {
        $actionProcess.Dispose()
        $script:ActionProcess = $null
        $script:ActionName = $null
    }

    if ($null -eq $exitCode) {
        Write-TrayLog "Completed stack action=$action exitCode=unavailable error=$completionError."
        Show-Error "$action completion could not be verified. See:`n$actionStdoutPath`n$actionStderrPath"
        return
    }

    Write-TrayLog "Completed stack action=$action exitCode=$exitCode."

    if ($exitCode -eq 0) {
        Show-Balloon "$action completed." ([System.Windows.Forms.ToolTipIcon]::Info)
    }
    else {
        Show-Error "$action failed. See:`n$actionStderrPath"
    }
}

function Copy-TextToClipboard([string]$Text, [string]$Label) {
    [System.Windows.Forms.Clipboard]::SetText($Text)
    Show-Balloon "$Label copied." ([System.Windows.Forms.ToolTipIcon]::Info)
}

function Open-LocalUrl([string]$Url) {
    try {
        Start-Process $Url
    }
    catch {
        Show-Error "Could not open $Url`n$($_.Exception.Message)"
    }
}

function Show-KeyStatus {
    try {
        $rawStatus = & $powershellPath -NoProfile -ExecutionPolicy Bypass -File $stackScript -Action KeyStatus 2>$null | Out-String
        if ($LASTEXITCODE -ne 0) {
            throw "KeyStatus exited with code $LASTEXITCODE."
        }
        $status = $rawStatus | ConvertFrom-Json
        $mcpStatus = if ($status.mcpClientTokenConfigured) { "Configured" } else { "Missing" }
        $reviewStatus = if ($status.mcpReviewTokenConfigured) { "Configured" } else { "Missing" }
        $tunnelStatus = if ($status.tunnelRuntimeKeyConfigured) { "Configured" } else { "Missing" }
        Show-Info "MCP client token: $mcpStatus`nMCP review token: $reviewStatus`nTunnel runtime key: $tunnelStatus`nStorage: $($status.storage)"
    }
    catch {
        Show-Error "Could not read key status.`n$($_.Exception.Message)"
    }
}

function Open-RuntimeKeyPrompt {
    if (Test-ActionRunning) {
        Show-Warning "Wait for the current stack action to finish before replacing the runtime key."
        return
    }
    try {
        $arguments = "-NoProfile -ExecutionPolicy Bypass -Sta -File `"$stackScript`" -Action SaveRuntimeKey"
        Start-Process `
            -FilePath $powershellPath `
            -ArgumentList $arguments `
            -WorkingDirectory $projectRoot `
            -WindowStyle Normal | Out-Null
    }
    catch {
        Show-Error "Could not open the secure runtime-key prompt.`n$($_.Exception.Message)"
    }
}

function Update-TrayStatus {
    Complete-StackAction

    $backendHealthy = Test-HttpEndpoint $backendHealthUrl
    $mcpHealthy = Test-HttpEndpoint $mcpHealthUrl
    $tunnelReady = Test-HttpEndpoint $tunnelReadyUrl
    $actionRunning = Test-ActionRunning

    $backendStatus = if ($backendHealthy) { "Ready" } else { "Stopped" }
    $mcpStatus = if ($mcpHealthy) { "Ready" } else { "Stopped" }
    $tunnelStatus = if ($tunnelReady) { "Ready" } else { "Stopped" }

    if ($actionRunning) {
        $statusItem.Text = "$TrayDisplayName | Action: $($script:ActionName) | API: $backendStatus | MCP: $mcpStatus | Tunnel: $tunnelStatus"
        $notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
    }
    else {
        $statusItem.Text = "$TrayDisplayName | API: $backendStatus | MCP: $mcpStatus | Tunnel: $tunnelStatus"
        if ($backendHealthy -and $mcpHealthy -and $tunnelReady) {
            $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
        }
        elseif ($backendHealthy -or $mcpHealthy -or $tunnelReady) {
            $notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
        }
        else {
            $notifyIcon.Icon = [System.Drawing.SystemIcons]::Error
        }
    }

    $allReady = $backendHealthy -and $mcpHealthy -and $tunnelReady
    $anyManaged = (Test-PidRunning (Join-Path $runtimeDir "backend.pid")) -or
        (Test-PidRunning (Join-Path $runtimeDir "mcp.pid")) -or
        (Test-PidRunning (Join-Path $runtimeDir "tunnel-client.pid"))
    $startItem.Enabled = -not $actionRunning -and -not $allReady
    $stopItem.Enabled = -not $actionRunning -and ($backendHealthy -or $mcpHealthy -or $tunnelReady -or $anyManaged)
    $restartItem.Enabled = -not $actionRunning
    $saveKeyItem.Enabled = -not $actionRunning
    $stopAndExitItem.Enabled = -not $actionRunning
    $openBackendItem.Enabled = $backendHealthy
    $openTunnelUiItem.Enabled = $tunnelReady

    Set-NotifyText "$TrayDisplayName | API:$backendStatus MCP:$mcpStatus Tunnel:$tunnelStatus"
}

function Exit-Tray([bool]$StopStack) {
    if ($script:Closing) {
        return
    }
    $script:Closing = $true
    if ($StopStack) {
        Start-StackAction "Stop" | Out-Null
    }
    $timer.Stop()
    $notifyIcon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
}

$contextMenu = New-Object System.Windows.Forms.ContextMenu
$statusItem = New-Object System.Windows.Forms.MenuItem "$TrayDisplayName | API: Checking | MCP: Checking | Tunnel: Checking"
$statusItem.Enabled = $false
$startItem = New-Object System.Windows.Forms.MenuItem "Start all"
$stopItem = New-Object System.Windows.Forms.MenuItem "Stop all"
$restartItem = New-Object System.Windows.Forms.MenuItem "Restart all"
$openBackendItem = New-Object System.Windows.Forms.MenuItem "Open backend API docs"
$openTunnelUiItem = New-Object System.Windows.Forms.MenuItem "Open tunnel UI"
$copyMcpItem = New-Object System.Windows.Forms.MenuItem "Copy local MCP URL"
$saveKeyItem = New-Object System.Windows.Forms.MenuItem "Replace tunnel runtime key..."
$keyStatusItem = New-Object System.Windows.Forms.MenuItem "Show key status"
$openRuntimeItem = New-Object System.Windows.Forms.MenuItem "Open runtime logs"
$exitItem = New-Object System.Windows.Forms.MenuItem "Exit tray (keep services running)"
$stopAndExitItem = New-Object System.Windows.Forms.MenuItem "Stop all and exit"

$startItem.add_Click({ Start-StackAction "Start" | Out-Null; Update-TrayStatus })
$stopItem.add_Click({ Start-StackAction "Stop" | Out-Null; Update-TrayStatus })
$restartItem.add_Click({ Start-StackAction "Restart" | Out-Null; Update-TrayStatus })
$openBackendItem.add_Click({ Open-LocalUrl $backendDocsUrl })
$openTunnelUiItem.add_Click({ Open-LocalUrl $tunnelUiUrl })
$copyMcpItem.add_Click({ Copy-TextToClipboard -Text $mcpUrl -Label "Local MCP URL" })
$saveKeyItem.add_Click({ Open-RuntimeKeyPrompt })
$keyStatusItem.add_Click({ Show-KeyStatus })
$openRuntimeItem.add_Click({ Start-Process explorer.exe -ArgumentList "`"$runtimeDir`"" })
$exitItem.add_Click({ Exit-Tray -StopStack $false })
$stopAndExitItem.add_Click({ Exit-Tray -StopStack $true })

$contextMenu.MenuItems.Add($statusItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($startItem) | Out-Null
$contextMenu.MenuItems.Add($stopItem) | Out-Null
$contextMenu.MenuItems.Add($restartItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($openBackendItem) | Out-Null
$contextMenu.MenuItems.Add($openTunnelUiItem) | Out-Null
$contextMenu.MenuItems.Add($copyMcpItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($saveKeyItem) | Out-Null
$contextMenu.MenuItems.Add($keyStatusItem) | Out-Null
$contextMenu.MenuItems.Add($openRuntimeItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($exitItem) | Out-Null
$contextMenu.MenuItems.Add($stopAndExitItem) | Out-Null

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.ContextMenu = $contextMenu
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
$notifyIcon.Text = "$TrayDisplayName | Checking services"
$notifyIcon.Visible = $true
$notifyIcon.add_DoubleClick({
    if (Test-HttpEndpoint $tunnelReadyUrl) {
        Open-LocalUrl $tunnelUiUrl
    }
    elseif (Test-HttpEndpoint $backendHealthUrl) {
        Open-LocalUrl $backendDocsUrl
    }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2500
$timer.add_Tick({ Update-TrayStatus })
$timer.Start()

try {
    Update-TrayStatus
    if (-not $NoAutoStart) {
        $allReady = (Test-HttpEndpoint $backendHealthUrl) -and
            (Test-HttpEndpoint $mcpHealthUrl) -and
            (Test-HttpEndpoint $tunnelReadyUrl)
        if (-not $allReady) {
            Start-StackAction "Start" | Out-Null
            Update-TrayStatus
        }
    }
    [System.Windows.Forms.Application]::Run()
}
finally {
    $timer.Stop()
    $timer.Dispose()
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    Remove-OwnTrayPid
    Write-TrayLog "Tray stopped pid=$PID."
}
