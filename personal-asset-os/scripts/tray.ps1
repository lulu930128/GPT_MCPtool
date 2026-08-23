param(
    [string]$ProjectRoot,
    [string]$HostName = "127.0.0.1",
    [int]$Port = 18876,
    [string]$DataDir = $env:PAOS_DATA_DIR,
    [string]$TunnelClientPath,
    [string]$TunnelProfileDir,
    [string]$TunnelProfile = "personal-asset-os",
    [string]$TunnelId = $env:PAOS_TUNNEL_ID,
    [string]$TunnelHealthUrl = "http://127.0.0.1:18877",
    [switch]$NoAutoStart,
    [switch]$AutoStartTunnel,
    [switch]$DiagnosticOnly,
    [switch]$ReplaceExisting,
    [switch]$SelfTest
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$TrayDisplayName = $(if ($DiagnosticOnly) { "Personal Asset OS Diagnostics" } else { "Personal Asset OS MCP" })
$TrayMenuContract = "unified-always-on-v2"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
$ComponentDescriptorPath = Join-Path $ProjectRoot "control-center\component.json"
$V3ControllerActive = $false
if (Test-Path -LiteralPath $ComponentDescriptorPath -PathType Leaf) {
    try {
        $ComponentDescriptor = [IO.File]::ReadAllText($ComponentDescriptorPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
        $V3ControllerActive = [string]$ComponentDescriptor.runtimeMode -eq "component-controller"
    }
    catch { throw "Invalid Personal Asset OS control-center descriptor." }
}
if (-not $SelfTest -and -not $DiagnosticOnly -and $V3ControllerActive) {
    throw "LEGACY_TRAY_DISABLED: Use MCP Control Center or the diagnostic launcher. Restore a legacy-tray descriptor only for rollback."
}
. (Join-Path $PSScriptRoot "local-env.ps1")

if ([string]::IsNullOrWhiteSpace($TunnelClientPath)) {
    $TunnelClientPath = Join-Path $ProjectRoot "vendor\tunnel-client\tunnel-client.exe"
}
if ([string]::IsNullOrWhiteSpace($TunnelProfileDir)) {
    $TunnelProfileDir = Join-Path $ProjectRoot ".tunnel-client"
}
if ([string]::IsNullOrWhiteSpace($TunnelId)) {
    $TunnelId = Get-LocalEnvValue -ProjectRoot $ProjectRoot -Name "PAOS_TUNNEL_ID"
}
$TunnelAutoStartEnabled = $true

$PythonPath = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$FrontendIndex = Join-Path $ProjectRoot "frontend\dist\index.html"
$AppUrl = "http://${HostName}:${Port}/"
$McpUrl = "http://${HostName}:${Port}/mcp/"
$HealthUrl = "http://${HostName}:${Port}/api/health"
$ReadyUrl = "http://${HostName}:${Port}/api/readyz"
$TunnelUiUrl = "$($TunnelHealthUrl.TrimEnd('/'))/ui"
$TunnelProfilePath = Join-Path $TunnelProfileDir "$TunnelProfile.yaml"
$TunnelTmpDir = Join-Path $ProjectRoot ".tmp"
$TunnelLogFile = Join-Path $TunnelTmpDir "tunnel-client.log"
$TunnelPidFile = Join-Path $TunnelTmpDir "tunnel-client.pid"
$DefaultLocalRoot = Join-Path $env:LOCALAPPDATA "PersonalAssetOS"
$ResolvedDataDir = if ([string]::IsNullOrWhiteSpace($DataDir)) { $DefaultLocalRoot } else { $DataDir }
$BackupDir = Join-Path $ResolvedDataDir "backups"
$RuntimeDir = Join-Path $ResolvedDataDir "runtime"
$TrayPidFile = Join-Path $RuntimeDir "tray.pid"
$ControllerPath = Join-Path $PSScriptRoot "runtime-control.ps1"

function Get-ExpectedBuildId {
    if (-not (Test-Path -LiteralPath $PythonPath)) { return $null }
    try {
        $value = & $PythonPath -m personal_asset_os.cli build-id 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return ([string]$value).Trim()
    }
    catch { return $null }
}

function Get-Health {
    try { return Invoke-RestMethod -UseBasicParsing -Uri $HealthUrl -TimeoutSec 2 }
    catch { return $null }
}

function Get-Readiness {
    try { return Invoke-RestMethod -UseBasicParsing -Uri $ReadyUrl -TimeoutSec 2 }
    catch { return $null }
}

function Test-TunnelReady {
    try {
        Invoke-RestMethod -UseBasicParsing -Uri "$($TunnelHealthUrl.TrimEnd('/'))/readyz" -TimeoutSec 2 | Out-Null
        return $true
    }
    catch { return $false }
}

function Test-ExactServerProcess([object]$ProcessInfo) {
    if ($null -eq $ProcessInfo -or [string]::IsNullOrWhiteSpace([string]$ProcessInfo.CommandLine)) {
        return $false
    }
    $executable = [string]$ProcessInfo.ExecutablePath
    $commandLine = [string]$ProcessInfo.CommandLine
    return (
        $executable.Equals($PythonPath, [StringComparison]::OrdinalIgnoreCase) -and
        $commandLine.IndexOf("personal_asset_os.cli", [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $commandLine -match '(?i)(?:^|\s)serve(?:\s|$)'
    )
}

function Test-ExactTunnelProcess([object]$ProcessInfo) {
    if ($null -eq $ProcessInfo -or [string]::IsNullOrWhiteSpace([string]$ProcessInfo.CommandLine)) {
        return $false
    }
    $executable = [string]$ProcessInfo.ExecutablePath
    $commandLine = [string]$ProcessInfo.CommandLine
    return (
        $executable.Equals($TunnelClientPath, [StringComparison]::OrdinalIgnoreCase) -and
        $commandLine.IndexOf($TunnelProfileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $commandLine -match ('(?i)--profile\s+"?' + [Regex]::Escape($TunnelProfile) + '"?(?:\s|$)')
    )
}

function Test-ExactTrayProcess([object]$ProcessInfo) {
    if ($null -eq $ProcessInfo -or [string]::IsNullOrWhiteSpace([string]$ProcessInfo.CommandLine)) {
        return $false
    }
    return (
        [string]$ProcessInfo.Name -in @("powershell.exe", "pwsh.exe") -and
        [string]$ProcessInfo.CommandLine -match (
            '(?i)(?:^|\s)-File\s+"?' + [Regex]::Escape($PSCommandPath) + '"?(?:\s|$)'
        )
    )
}

function Stop-ExistingRuntime {
    param([switch]$TrayOnly)
    $processes = @(
        Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object { $_.ProcessId -ne $PID -and -not [string]::IsNullOrWhiteSpace($_.CommandLine) }
    )
    $targets = @()
    foreach ($process in $processes) {
        if (-not $TrayOnly -and (Test-ExactTunnelProcess $process)) {
            $targets += [pscustomobject]@{ ProcessId = [int]$process.ProcessId; Role = "Tunnel"; Priority = 10 }
        }
        elseif (-not $TrayOnly -and (Test-ExactServerProcess $process)) {
            $targets += [pscustomobject]@{ ProcessId = [int]$process.ProcessId; Role = "Server"; Priority = 20 }
        }
        elseif (Test-ExactTrayProcess $process) {
            $isDiagnostic = [string]$process.CommandLine -match '(?i)(?:^|\s)-DiagnosticOnly(?:\s|$)'
            if ([bool]$DiagnosticOnly -ne [bool]$isDiagnostic) { continue }
            $targets += [pscustomobject]@{ ProcessId = [int]$process.ProcessId; Role = "Tray"; Priority = 30 }
        }
    }
    foreach ($target in @($targets | Sort-Object Priority, ProcessId)) {
        try {
            Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
            Wait-Process -Id $target.ProcessId -Timeout 4 -ErrorAction SilentlyContinue
        }
        catch {
            if (Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue) {
                throw "Could not replace Personal Asset OS $($target.Role) PID $($target.ProcessId): $($_.Exception.Message)"
            }
        }
    }
    if ($targets.Count -gt 0) { Start-Sleep -Milliseconds 700 }
}

if ($SelfTest) {
    [pscustomobject]@{
        trayDisplayName = $TrayDisplayName
        trayMenuContract = $TrayMenuContract
        projectRoot = $ProjectRoot
        pythonPath = $PythonPath
        pythonExists = Test-Path -LiteralPath $PythonPath
        frontendIndex = $FrontendIndex
        frontendExists = Test-Path -LiteralPath $FrontendIndex
        appUrl = $AppUrl
        mcpUrl = $McpUrl
        healthUrl = $HealthUrl
        readyUrl = $ReadyUrl
        formalDataDirConfigured = -not [string]::IsNullOrWhiteSpace($ResolvedDataDir)
        formalDataPathExposed = $false
        expectedBuildId = Get-ExpectedBuildId
        tunnelClientPath = $TunnelClientPath
        tunnelClientExists = Test-Path -LiteralPath $TunnelClientPath
        tunnelProfilePath = $TunnelProfilePath
        tunnelProfileExists = Test-Path -LiteralPath $TunnelProfilePath
        tunnelIdConfigured = -not [string]::IsNullOrWhiteSpace($TunnelId)
        controlPlaneKeyConfigured = Set-ControlPlaneApiKeyFromLocalEnv -ProjectRoot $ProjectRoot
        controlPlaneOrganizationConfigured = Set-ControlPlaneOrganizationIdFromLocalEnv -ProjectRoot $ProjectRoot
        tunnelHealthUrl = $TunnelHealthUrl
        autoStartTunnel = $TunnelAutoStartEnabled
        autoStartServer = $true
        externalApiConfigured = -not [string]::IsNullOrWhiteSpace((Get-LocalEnvValue -ProjectRoot $ProjectRoot -Name "OPENAI_API_KEY"))
        replaceExistingSupported = $true
        lifecycleDelegated = [bool]$DiagnosticOnly
        ownsRuntimeProcesses = -not [bool]$DiagnosticOnly
        diagnosticOnlySupported = $true
        legacyRuntimeTrayBlocked = $V3ControllerActive
        diagnosticOnly = [bool]$DiagnosticOnly
        exitUiStopsRuntime = -not [bool]$DiagnosticOnly
        controllerPath = $ControllerPath
        controllerExists = Test-Path -LiteralPath $ControllerPath -PathType Leaf
        loopbackOnly = ($HostName -in @("127.0.0.1", "localhost", "::1"))
        credentialValuesExposed = $false
    } | ConvertTo-Json -Depth 4
    exit 0
}

if ($HostName -notin @("127.0.0.1", "localhost", "::1")) {
    throw "Personal Asset OS tray refuses non-loopback host: $HostName"
}
if ($ReplaceExisting) { Stop-ExistingRuntime -TrayOnly:$DiagnosticOnly }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$createdNew = $false
$mutexName = $(if ($DiagnosticOnly) { "Local\PersonalAssetOsDiagnosticTray" } else { "Local\PersonalAssetOsTray" })
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) {
    [System.Windows.Forms.MessageBox]::Show(
        "Personal Asset OS MCP is already running in the system tray.",
        $TrayDisplayName,
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
    $mutex.Dispose()
    exit 0
}

if (-not $DiagnosticOnly) {
    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
    Set-Content -LiteralPath $TrayPidFile -Value $PID -Encoding ASCII
}
$script:ServerProcess = $null
$script:TunnelProcess = $null
$script:Closing = $false

function Set-NotifyText([string]$Text) {
    if ($Text.Length -gt 63) { $Text = $Text.Substring(0, 63) }
    $notifyIcon.Text = $Text
}

function Show-Message([string]$Message, [System.Windows.Forms.MessageBoxIcon]$Icon) {
    [System.Windows.Forms.MessageBox]::Show(
        $Message,
        $TrayDisplayName,
        [System.Windows.Forms.MessageBoxButtons]::OK,
        $Icon
    ) | Out-Null
}

function Show-Warning([string]$Message) { Show-Message $Message ([System.Windows.Forms.MessageBoxIcon]::Warning) }
function Show-Error([string]$Message) { Show-Message $Message ([System.Windows.Forms.MessageBoxIcon]::Error) }
function Show-Balloon([string]$Message, [System.Windows.Forms.ToolTipIcon]$Icon) {
    $notifyIcon.ShowBalloonTip(1400, $TrayDisplayName, $Message, $Icon)
}

function Test-OwnedServerRunning {
    return ($null -ne $script:ServerProcess -and -not $script:ServerProcess.HasExited)
}

function Test-OwnedTunnelRunning {
    return ($null -ne $script:TunnelProcess -and -not $script:TunnelProcess.HasExited)
}

function Start-Server {
    $health = Get-Health
    if ((Test-OwnedServerRunning) -or $null -ne $health) { return }
    if (-not (Test-Path -LiteralPath $PythonPath)) {
        Show-Warning "Missing $PythonPath`nRun scripts\bootstrap.ps1 first."
        return
    }
    if (-not (Test-Path -LiteralPath $FrontendIndex)) {
        Show-Warning "Dashboard is not built.`nRun npm ci and npm run build in $ProjectRoot\frontend."
        return
    }
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $PythonPath
    $startInfo.Arguments = "-m personal_asset_os.cli serve --host $HostName --port $Port --data-dir `"$ResolvedDataDir`""
    $startInfo.WorkingDirectory = $ProjectRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    try {
        $script:ServerProcess = [System.Diagnostics.Process]::Start($startInfo)
        Show-Balloon "Server starting on $AppUrl" ([System.Windows.Forms.ToolTipIcon]::Info)
    }
    catch { Show-Error "Could not start Personal Asset OS.`n$($_.Exception.Message)" }
}

function Stop-Server {
    if (-not (Test-OwnedServerRunning)) { return }
    try {
        $script:ServerProcess.Kill()
        $script:ServerProcess.WaitForExit(5000) | Out-Null
    }
    catch {
        if (-not $script:ServerProcess.HasExited) {
            Show-Error "Could not stop owned server PID $($script:ServerProcess.Id)."
        }
    }
    finally { $script:ServerProcess = $null }
}

function Restart-Server {
    Stop-Server
    Start-Sleep -Milliseconds 400
    Start-Server
}

function Start-TunnelClient {
    if ((Test-OwnedTunnelRunning) -or (Test-TunnelReady)) { return }
    if (-not (Test-Path -LiteralPath $TunnelClientPath)) {
        Show-Warning "Missing tunnel-client.exe at $TunnelClientPath"
        return
    }
    if (-not (Test-Path -LiteralPath $TunnelProfilePath)) {
        Show-Warning "Missing tunnel profile.`nRun scripts\tunnel.ps1 -Action Init first."
        return
    }
    if (-not (Set-ControlPlaneApiKeyFromLocalEnv -ProjectRoot $ProjectRoot)) {
        Show-Warning "OPENAI_API_KEY is not configured in the local .env file."
        return
    }
    if (-not (Set-ControlPlaneOrganizationIdFromLocalEnv -ProjectRoot $ProjectRoot)) {
        Show-Warning "CONTROL_PLANE_ORGANIZATION_ID is not configured in the local .env file."
        return
    }
    if ($null -eq (Get-Health)) {
        Start-Server
        Start-Sleep -Milliseconds 900
    }
    New-Item -ItemType Directory -Force -Path $TunnelTmpDir | Out-Null
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $TunnelClientPath
    $startInfo.Arguments = "run --profile-dir `"$TunnelProfileDir`" --profile `"$TunnelProfile`" --log.file `"$TunnelLogFile`" --pid.file `"$TunnelPidFile`""
    $startInfo.WorkingDirectory = $ProjectRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    try {
        $script:TunnelProcess = [System.Diagnostics.Process]::Start($startInfo)
        Show-Balloon "Secure MCP tunnel starting" ([System.Windows.Forms.ToolTipIcon]::Info)
    }
    catch { Show-Error "Could not start tunnel-client.`n$($_.Exception.Message)" }
}

function Stop-TunnelClient {
    if (-not (Test-OwnedTunnelRunning)) { return }
    try {
        $script:TunnelProcess.Kill()
        $script:TunnelProcess.WaitForExit(5000) | Out-Null
    }
    catch {
        if (-not $script:TunnelProcess.HasExited) {
            Show-Error "Could not stop owned tunnel PID $($script:TunnelProcess.Id)."
        }
    }
    finally { $script:TunnelProcess = $null }
}

function Open-LocalUrl([string]$Url) {
    try { Start-Process $Url } catch { Show-Error "Could not open $Url`n$($_.Exception.Message)" }
}

function Copy-Text([string]$Text, [string]$Label) {
    [System.Windows.Forms.Clipboard]::SetText($Text)
    Show-Balloon "Copied $Label" ([System.Windows.Forms.ToolTipIcon]::Info)
}

function Create-VerifiedBackup {
    if ($null -eq (Get-Health)) {
        Show-Warning "Server is not ready. Start it before creating a backup."
        return
    }
    try {
        $result = Invoke-RestMethod -UseBasicParsing -Method Post -Uri "${AppUrl}api/backups" -ContentType "application/json" -Body "{}" -TimeoutSec 30
        Show-Balloon "Verified backup created: $([IO.Path]::GetFileName([string]$result.backup_path))" ([System.Windows.Forms.ToolTipIcon]::Info)
    }
    catch { Show-Error "Backup failed.`n$($_.Exception.Message)" }
}

function Invoke-ControllerReload {
    if (-not (Test-Path -LiteralPath $ControllerPath -PathType Leaf)) { Show-Error "Runtime controller is missing."; return $false }
    try {
        $output = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ControllerPath -Action ReloadRuntime -ProjectRoot $ProjectRoot 2>&1)
        $exitCode = $LASTEXITCODE
        $result = ($output -join [Environment]::NewLine) | ConvertFrom-Json
        if ($exitCode -ne 0 -or $result.ok -ne $true) {
            Show-Error "Runtime reload failed.`n$($result.errorCode): $($result.message)"
            return $false
        }
        return $true
    }
    catch { Show-Error "Runtime reload failed. Open runtime logs for details."; return $false }
}

function Update-TrayStatus {
    if ($script:Closing) { return }
    $serverOwned = Test-OwnedServerRunning
    $tunnelOwned = Test-OwnedTunnelRunning
    $health = Get-Health
    $readiness = Get-Readiness
    $expectedBuildId = Get-ExpectedBuildId
    $healthOk = ($null -ne $health -and $health.ok -eq $true)
    $buildMatch = ($healthOk -and -not [string]::IsNullOrWhiteSpace($expectedBuildId) -and [string]$health.buildId -eq $expectedBuildId)
    $dataReady = ($null -ne $readiness -and $readiness.ready -eq $true)
    $tunnelReady = Test-TunnelReady

    if ($serverOwned -and $healthOk -and $buildMatch) { $serverStatus = "Running" }
    elseif ($serverOwned -and -not $healthOk) { $serverStatus = "Starting" }
    elseif ($healthOk -and $buildMatch) { $serverStatus = "Running external" }
    elseif ($healthOk) { $serverStatus = "Stale build" }
    else { $serverStatus = "Stopped" }

    if ($tunnelOwned -and $tunnelReady) { $tunnelStatus = "Ready" }
    elseif ($tunnelOwned) { $tunnelStatus = "Starting" }
    elseif ($tunnelReady) { $tunnelStatus = "Ready external" }
    else { $tunnelStatus = "Stopped" }

    $restartItem.Enabled = $true
    $openTunnelUiItem.Enabled = $tunnelOwned -or $tunnelReady
    $openDashboardItem.Enabled = $healthOk
    $openQuickCaptureItem.Enabled = $healthOk
    $backupItem.Enabled = $healthOk -and $dataReady
    $openHealthItem.Enabled = $healthOk

    if ($healthOk -and $buildMatch -and $dataReady -and $tunnelReady) {
        $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
    }
    elseif ($serverOwned -or $healthOk -or $tunnelOwned) {
        $notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
    }
    else { $notifyIcon.Icon = [System.Drawing.SystemIcons]::Error }

    $statusItem.Text = "$TrayDisplayName | Server: $serverStatus | Tunnel: $tunnelStatus"
    Set-NotifyText "$TrayDisplayName | $serverStatus / $tunnelStatus"
}

function Remove-OwnPidFile {
    try {
        if ((Test-Path -LiteralPath $TrayPidFile) -and (Get-Content -LiteralPath $TrayPidFile -Raw).Trim() -eq [string]$PID) {
            Remove-Item -LiteralPath $TrayPidFile -Force
        }
    }
    catch { }
}

function Exit-Tray([bool]$StopRuntime) {
    if ($StopRuntime) {
        $choice = [System.Windows.Forms.MessageBox]::Show(
            "Exit will stop the MCP server, tunnel, and tray. Continue?",
            $TrayDisplayName,
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        )
        if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    }
    $script:Closing = $true
    $timer.Stop()
    if ($StopRuntime) {
        try {
            Stop-TunnelClient
            Stop-Server
            Stop-ExistingRuntime
        }
        catch {
            $script:Closing = $false
            $timer.Start()
            Show-Error "Could not fully stop Personal Asset OS: $($_.Exception.Message)"
            return
        }
    }
    Remove-OwnPidFile
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    $mutex.ReleaseMutex()
    $mutex.Dispose()
    [System.Windows.Forms.Application]::Exit()
}

$contextMenu = New-Object System.Windows.Forms.ContextMenu
$statusItem = New-Object System.Windows.Forms.MenuItem "$TrayDisplayName | Server: Checking | Tunnel: Checking"
$statusItem.Enabled = $false
$restartItem = New-Object System.Windows.Forms.MenuItem $(if ($DiagnosticOnly) { "Reload managed runtime" } else { "Restart MCP server" })
$openTunnelUiItem = New-Object System.Windows.Forms.MenuItem "Open tunnel UI"
$openDashboardItem = New-Object System.Windows.Forms.MenuItem "Open dashboard"
$backupItem = New-Object System.Windows.Forms.MenuItem "Create verified backup"
$copyAppItem = New-Object System.Windows.Forms.MenuItem "Copy app URL"
$copyMcpItem = New-Object System.Windows.Forms.MenuItem "Copy MCP URL"
$copyTunnelIdItem = New-Object System.Windows.Forms.MenuItem "Copy tunnel ID"
$copyTunnelIdItem.Enabled = -not [string]::IsNullOrWhiteSpace($TunnelId)
$copyHealthItem = New-Object System.Windows.Forms.MenuItem "Copy health URL"
$openHealthItem = New-Object System.Windows.Forms.MenuItem "Open MCP health"
$openRuntimeItem = New-Object System.Windows.Forms.MenuItem "Open runtime logs"
$openDataItem = New-Object System.Windows.Forms.MenuItem "Open data folder"
$openBackupItem = New-Object System.Windows.Forms.MenuItem "Open backup folder"
$exitItem = New-Object System.Windows.Forms.MenuItem $(if ($DiagnosticOnly) { "Exit diagnostic tray only" } else { "Exit" })

$restartItem.add_Click({ if ($DiagnosticOnly) { Invoke-ControllerReload | Out-Null } else { Restart-Server }; Update-TrayStatus })
$openTunnelUiItem.add_Click({ Open-LocalUrl $TunnelUiUrl })
$openDashboardItem.add_Click({ Open-LocalUrl $AppUrl })
$backupItem.add_Click({ Create-VerifiedBackup })
$copyAppItem.add_Click({ Copy-Text $AppUrl "app URL" })
$copyMcpItem.add_Click({ Copy-Text $McpUrl "MCP URL" })
$copyTunnelIdItem.add_Click({ Copy-Text $TunnelId "tunnel ID" })
$copyHealthItem.add_Click({ Copy-Text $HealthUrl "health URL" })
$openHealthItem.add_Click({ Open-LocalUrl $HealthUrl })
$openRuntimeItem.add_Click({ New-Item -ItemType Directory -Force -Path $TunnelTmpDir | Out-Null; Start-Process explorer.exe -ArgumentList $TunnelTmpDir })
$openDataItem.add_Click({ New-Item -ItemType Directory -Force -Path $ResolvedDataDir | Out-Null; Start-Process explorer.exe -ArgumentList $ResolvedDataDir })
$openBackupItem.add_Click({ New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null; Start-Process explorer.exe -ArgumentList $BackupDir })
$exitItem.add_Click({ Exit-Tray (-not [bool]$DiagnosticOnly) })

$contextMenu.MenuItems.Add($statusItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($restartItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($copyMcpItem) | Out-Null
$contextMenu.MenuItems.Add($copyHealthItem) | Out-Null
$contextMenu.MenuItems.Add($copyTunnelIdItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($openHealthItem) | Out-Null
$contextMenu.MenuItems.Add($openTunnelUiItem) | Out-Null
$contextMenu.MenuItems.Add($openRuntimeItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($openDashboardItem) | Out-Null
$contextMenu.MenuItems.Add($backupItem) | Out-Null
$contextMenu.MenuItems.Add($copyAppItem) | Out-Null
$contextMenu.MenuItems.Add($openDataItem) | Out-Null
$contextMenu.MenuItems.Add($openBackupItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($exitItem) | Out-Null

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.ContextMenu = $contextMenu
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
$notifyIcon.Text = "$TrayDisplayName | Starting"
$notifyIcon.Visible = $true
$notifyIcon.add_DoubleClick({ Open-LocalUrl $AppUrl })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2500
$timer.add_Tick({ Update-TrayStatus })
$timer.Start()

if (-not $DiagnosticOnly -and -not $NoAutoStart) {
    Start-Server
    Start-TunnelClient
}
Update-TrayStatus
try { [System.Windows.Forms.Application]::Run() }
finally {
    if (-not $script:Closing) { Remove-OwnPidFile }
}
