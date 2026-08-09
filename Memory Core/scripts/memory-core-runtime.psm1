Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$script:Utf8NoBom = New-Object Text.UTF8Encoding($false)

function Get-McJsonDocument {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { throw 'STACK_OUTPUT_INVALID: Memory Core stack returned no status document.' }
    $start = $Text.IndexOf('{')
    $end = $Text.LastIndexOf('}')
    if ($start -lt 0 -or $end -lt $start) { throw 'STACK_OUTPUT_INVALID: Memory Core stack returned malformed status.' }
    try { return $Text.Substring($start, $end - $start + 1) | ConvertFrom-Json }
    catch { throw 'STACK_OUTPUT_INVALID: Memory Core stack returned malformed status.' }
}

function Invoke-McStackAction {
    param($Context, [ValidateSet('Status', 'Start', 'StartTunnel', 'RestartCore', 'Restart', 'Stop')][string]$Action)
    if (-not (Test-Path -LiteralPath $Context.stackScript -PathType Leaf)) { throw 'STACK_SCRIPT_MISSING: Memory Core stack script is unavailable.' }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Context.powershellPath
    $startInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$($Context.stackScript)`" -Action $Action -BackendPort $($Context.backendPort)"
    $startInfo.WorkingDirectory = $Context.projectRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) { throw 'STACK_ACTION_FAILED: Memory Core stack action did not start.' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($Context.actionTimeoutSeconds * 1000)) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        throw 'STACK_ACTION_TIMEOUT: Memory Core stack action exceeded its bounded timeout.'
    }
    $stdout = $stdoutTask.Result
    $null = $stderrTask.Result
    if ($process.ExitCode -ne 0) { throw 'STACK_ACTION_FAILED: Memory Core stack action failed; inspect component runtime logs.' }
    return Get-McJsonDocument -Text $stdout
}

function Get-McFirstPid {
    param($Values)
    $items = @($Values)
    if ($items.Count -eq 0 -or $null -eq $items[0]) { return $null }
    return [int]$items[0]
}

function Get-McOwnershipState {
    param([string]$PidState, $ManagedPid, $ListenerPid)
    if ($PidState -eq 'owned' -and $null -ne $ManagedPid) {
        return $(if ($null -eq $ListenerPid) { 'OwnedNotListening' } else { 'OwnedReady' })
    }
    if ($PidState -in @('missing', 'stale_missing_process') -and $null -eq $ListenerPid) { return 'Stopped' }
    return 'OwnershipMismatch'
}

function Get-McRelation {
    param($ManagedPid, $ListenerPid, [string]$Ownership)
    if ($Ownership -ne 'OwnedReady' -or $null -eq $ManagedPid -or $null -eq $ListenerPid) { return $null }
    return $(if ([int]$ManagedPid -eq [int]$ListenerPid) { 'Self' } else { 'Descendant' })
}

function ConvertTo-MemoryCoreRuntimeStatus {
    param($Document)
    if ($null -eq $Document.backend -or $null -eq $Document.mcp -or $null -eq $Document.tunnel) {
        throw 'STACK_OUTPUT_INVALID: Memory Core stack status is incomplete.'
    }
    $backendListener = Get-McFirstPid $Document.backend.listenerPids
    $mcpListener = Get-McFirstPid $Document.mcp.listenerPids
    $tunnelListener = Get-McFirstPid $Document.tunnel.listenerPids
    $backendOwnership = Get-McOwnershipState ([string]$Document.backend.pidState) $Document.backend.pid $backendListener
    $mcpOwnership = Get-McOwnershipState ([string]$Document.mcp.pidState) $Document.mcp.pid $mcpListener
    $tunnelOwnership = Get-McOwnershipState ([string]$Document.tunnel.pidState) $Document.tunnel.pid $tunnelListener
    $ownerships = @($backendOwnership, $mcpOwnership, $tunnelOwnership)
    $backendHealthy = [bool]$Document.backend.healthy
    $mcpHealthy = [bool]$Document.mcp.healthy
    $tunnelReady = [bool]$Document.tunnel.ready
    $status = if ('OwnershipMismatch' -in $ownerships) { 'OwnershipMismatch' }
        elseif ($backendHealthy -and $mcpHealthy -and $tunnelReady -and @($ownerships | Where-Object { $_ -ne 'OwnedReady' }).Count -eq 0) { 'Ready' }
        elseif ($backendHealthy -and $mcpHealthy -and $backendOwnership -eq 'OwnedReady' -and $mcpOwnership -eq 'OwnedReady') { 'Degraded' }
        elseif (@($ownerships | Where-Object { $_ -ne 'Stopped' }).Count -eq 0) { 'Stopped' }
        else { 'Unhealthy' }
    $ownedPids = @(
        @($Document.backend.pid, $Document.mcp.pid, $Document.tunnel.pid) |
            Where-Object { $null -ne $_ } | ForEach-Object { [int]$_ } | Sort-Object -Unique
    )
    return [pscustomobject]@{
        status = $status
        backend = [pscustomobject]@{ healthy = $backendHealthy; ownership = $backendOwnership; pid = $Document.backend.pid; listenerPid = $backendListener; relation = Get-McRelation $Document.backend.pid $backendListener $backendOwnership }
        mcp = [pscustomobject]@{ healthy = $mcpHealthy; ownership = $mcpOwnership; pid = $Document.mcp.pid; listenerPid = $mcpListener; relation = Get-McRelation $Document.mcp.pid $mcpListener $mcpOwnership }
        tunnel = [pscustomobject]@{ ready = $tunnelReady; ownership = $tunnelOwnership; pid = $Document.tunnel.pid; listenerPid = $tunnelListener; relation = Get-McRelation $Document.tunnel.pid $tunnelListener $tunnelOwnership }
        ownedPids = $ownedPids
    }
}

function Get-MemoryCoreRuntimeStatus {
    param($Context)
    return ConvertTo-MemoryCoreRuntimeStatus -Document (Invoke-McStackAction -Context $Context -Action Status)
}

function Assert-McCanMutate {
    param($Status, [string[]]$Roles)
    foreach ($role in @($Roles)) {
        if ([string]$Status.$role.ownership -eq 'OwnershipMismatch') {
            throw "OWNERSHIP_MISMATCH: Cannot mutate Memory Core $role while ownership is unverified."
        }
    }
}

function Invoke-MemoryCoreLifecycleAction {
    param($Context, [ValidateSet('EnsureRunning', 'RepairConnectivity', 'RestartCore', 'ReloadRuntime', 'ShutdownRuntime')][string]$Action)
    $before = Get-MemoryCoreRuntimeStatus -Context $Context
    switch ($Action) {
        'EnsureRunning' {
            if ($before.status -eq 'Ready') { return }
            Assert-McCanMutate -Status $before -Roles @('backend', 'mcp', 'tunnel')
            $null = Invoke-McStackAction -Context $Context -Action Start
        }
        'RepairConnectivity' {
            Assert-McCanMutate -Status $before -Roles @('backend', 'mcp', 'tunnel')
            if (-not ($before.backend.healthy -and $before.mcp.healthy -and $before.backend.ownership -eq 'OwnedReady' -and $before.mcp.ownership -eq 'OwnedReady')) {
                throw 'CORE_NOT_READY: Connectivity repair requires owned stable backend and MCP roles.'
            }
            if ($before.tunnel.ready -and $before.tunnel.ownership -eq 'OwnedReady') { return }
            $null = Invoke-McStackAction -Context $Context -Action StartTunnel
        }
        'RestartCore' {
            Assert-McCanMutate -Status $before -Roles @('backend', 'mcp')
            $null = Invoke-McStackAction -Context $Context -Action RestartCore
        }
        'ReloadRuntime' {
            Assert-McCanMutate -Status $before -Roles @('backend', 'mcp', 'tunnel')
            $null = Invoke-McStackAction -Context $Context -Action Restart
        }
        'ShutdownRuntime' {
            Assert-McCanMutate -Status $before -Roles @('backend', 'mcp', 'tunnel')
            $null = Invoke-McStackAction -Context $Context -Action Stop
        }
    }
}

function New-MemoryCoreRuntimeContext {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [string]$StackScript, [int]$BackendPort = 18765,
        [string]$PowershellPath, [int]$ActionTimeoutSeconds = 170
    )
    $root = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path
    if ([string]::IsNullOrWhiteSpace($StackScript)) { $StackScript = Join-Path $root 'scripts\memory_core_stack.ps1' }
    if ([string]::IsNullOrWhiteSpace($PowershellPath)) { $PowershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
    if ($BackendPort -lt 1 -or $BackendPort -gt 65535) { throw 'BackendPort must be between 1 and 65535.' }
    if ($ActionTimeoutSeconds -lt 5 -or $ActionTimeoutSeconds -gt 300) { throw 'ActionTimeoutSeconds must be between 5 and 300.' }
    $runtimeDir = Join-Path $root '.tmp'
    return [pscustomobject]@{
        projectRoot = $root; stackScript = [IO.Path]::GetFullPath($StackScript); backendPort = $BackendPort
        powershellPath = [IO.Path]::GetFullPath($PowershellPath); actionTimeoutSeconds = $ActionTimeoutSeconds
        runtimeDir = $runtimeDir; actionLogFile = Join-Path $runtimeDir 'runtime-control.jsonl'
    }
}

function Write-MemoryCoreLifecycleEvent {
    param($Context, [string]$Action, [bool]$Ok, [string]$BeforeStatus, [string]$AfterStatus, [int[]]$OwnedPids = @(), [int]$ElapsedMs, [string]$ErrorCode, [string]$Message)
    New-Item -ItemType Directory -Force -Path $Context.runtimeDir | Out-Null
    $event = [ordered]@{ timestamp = [DateTime]::UtcNow.ToString('o'); action = $Action; ok = $Ok; beforeStatus = $BeforeStatus; afterStatus = $AfterStatus; ownedPids = @($OwnedPids); elapsedMs = $ElapsedMs; errorCode = $ErrorCode; message = $Message }
    [IO.File]::AppendAllText($Context.actionLogFile, (($event | ConvertTo-Json -Compress -Depth 5) + [Environment]::NewLine), $script:Utf8NoBom)
}

Export-ModuleMember -Function @(
    'New-MemoryCoreRuntimeContext', 'Get-MemoryCoreRuntimeStatus',
    'Invoke-MemoryCoreLifecycleAction', 'Write-MemoryCoreLifecycleEvent'
)
