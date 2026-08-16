Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function New-EnglishStudyRuntimeContext {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$HubRoot,
        [string]$HostName = "127.0.0.1",
        [int]$McpPort = 8830,
        [int]$HubPort = 8831,
        [int]$ReadyTimeoutSeconds = 30
    )
    $root = (Resolve-Path -LiteralPath $ProjectRoot).Path
    $hub = (Resolve-Path -LiteralPath $HubRoot).Path
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $python = Join-Path $hub ".venv\Scripts\python.exe"
    [pscustomobject]@{
        projectRoot = $root
        hubRoot = $hub
        hostName = $HostName
        mcpPort = $McpPort
        hubPort = $HubPort
        readyTimeoutSeconds = $ReadyTimeoutSeconds
        nodePath = $node
        pythonPath = $python
        mcpEntry = Join-Path $root "dist\src\http-main.js"
        runtimeDir = Join-Path $root ".tmp"
        hubPidFile = Join-Path $root ".tmp\english-study-hub.pid"
        mcpPidFile = Join-Path $root ".tmp\english-study-mcp.pid"
        hubHealth = "http://$HostName`:$HubPort/health"
        mcpHealth = "http://$HostName`:$McpPort/health"
    }
}

function Read-EnglishStudyPid {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $raw = (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue).Trim()
    $pidValue = 0
    if (-not [int]::TryParse($raw, [ref]$pidValue) -or $pidValue -le 0) { return $null }
    return $pidValue
}

function Get-EnglishStudyListenerPid {
    param([int]$Port)
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 1) { return [int]$listeners[0].OwningProcess }
    if ($listeners.Count -gt 1) { return -1 }
    return $null
}

function Get-EnglishStudyCommandLine {
    param([int]$ProcessId)
    try { return [string](Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop).CommandLine }
    catch { return $null }
}

function Get-EnglishStudyLineage {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][int]$ExpectedAncestorProcessId
    )
    if ($ProcessId -eq $ExpectedAncestorProcessId) {
        return [pscustomobject]@{ known=$true; matches=$true; depth=0 }
    }
    $current = $ProcessId
    for ($depth = 0; $depth -lt 32; $depth++) {
        try { $process = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction Stop }
        catch { return [pscustomobject]@{ known=$false; matches=$false; depth=$null } }
        $parent = [int]$process.ParentProcessId
        if ($parent -eq $ExpectedAncestorProcessId) {
            return [pscustomobject]@{ known=$true; matches=$true; depth=($depth + 1) }
        }
        if ($parent -le 0 -or $parent -eq $current) {
            return [pscustomobject]@{ known=$true; matches=$false; depth=$null }
        }
        $current = $parent
    }
    return [pscustomobject]@{ known=$false; matches=$false; depth=$null }
}

function Get-EnglishStudyOwnedDescendants {
    param([Parameter(Mandatory = $true)][int]$RootPid)
    $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $byPid = @{}
    foreach ($process in $all) { $byPid[[int]$process.ProcessId] = $process }
    $rows = @()
    foreach ($process in $all) {
        $current = [int]$process.ProcessId
        for ($depth = 0; $depth -lt 32; $depth++) {
            if ($current -eq $RootPid) {
                $rows += [pscustomobject]@{ ProcessId=[int]$process.ProcessId; Depth=$depth }
                break
            }
            if (-not $byPid.ContainsKey($current)) { break }
            $parent = [int]$byPid[$current].ParentProcessId
            if ($parent -le 0 -or $parent -eq $current) { break }
            $current = $parent
        }
    }
    return @($rows | Sort-Object -Property @{ Expression='Depth'; Descending=$true }, @{ Expression='ProcessId'; Descending=$true })
}

function Get-EnglishStudyRoleState {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][ValidateSet("hub", "mcp")][string]$Role
    )
    $pidFile = if ($Role -eq "hub") { $Context.hubPidFile } else { $Context.mcpPidFile }
    $port = if ($Role -eq "hub") { $Context.hubPort } else { $Context.mcpPort }
    $expectedExecutable = if ($Role -eq "hub") { $Context.pythonPath } else { $Context.nodePath }
    $expectedFragments = if ($Role -eq "hub") { @("-m english_study_hub", "serve") } else { @($Context.projectRoot, "dist\src\http-main.js") }
    $managedPid = Read-EnglishStudyPid -Path $pidFile
    $listenerPid = Get-EnglishStudyListenerPid -Port $port
    if ($null -eq $managedPid) {
        return [pscustomobject]@{ role=$Role; state=$(if ($null -eq $listenerPid) { "Stopped" } else { "OwnershipMismatch" }); managedPid=$null; listenerPid=$listenerPid; relation=$(if ($null -eq $listenerPid) { $null } else { "Unknown" }) }
    }
    $process = Get-Process -Id $managedPid -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return [pscustomobject]@{ role=$Role; state=$(if ($null -eq $listenerPid) { "Stopped" } else { "OwnershipMismatch" }); managedPid=$managedPid; listenerPid=$listenerPid; relation=$(if ($null -eq $listenerPid) { $null } else { "Unknown" }) }
    }
    $path = try { [string]$process.Path } catch { "" }
    $commandLine = Get-EnglishStudyCommandLine -ProcessId $managedPid
    $pathMatches = -not [string]::IsNullOrWhiteSpace($path) -and $path.Equals($expectedExecutable, [StringComparison]::OrdinalIgnoreCase)
    $commandMatches = -not [string]::IsNullOrWhiteSpace($commandLine)
    foreach ($fragment in $expectedFragments) {
        if ($commandMatches -and $commandLine.IndexOf($fragment, [StringComparison]::OrdinalIgnoreCase) -lt 0) { $commandMatches = $false }
    }
    $lineage = if ($null -eq $listenerPid) { $null } else { Get-EnglishStudyLineage -ProcessId $listenerPid -ExpectedAncestorProcessId $managedPid }
    $listenerMatches = $null -ne $lineage -and $lineage.known -and $lineage.matches
    $state = if (-not $pathMatches -or -not $commandMatches) { "OwnershipMismatch" }
        elseif ($null -eq $listenerPid) { "Starting" }
        elseif ($listenerMatches) { "Owned" }
        else { "OwnershipMismatch" }
    [pscustomobject]@{
        role = $Role
        state = $state
        managedPid = $managedPid
        listenerPid = $listenerPid
        relation = $(if ($listenerMatches) { if ($lineage.depth -eq 0) { "Self" } else { "Descendant" } } elseif ($null -ne $listenerPid) { "Unrelated" } else { $null })
    }
}

function Test-EnglishStudyHealth {
    param([string]$Url, [string]$ExpectedService)
    try {
        $response = Invoke-RestMethod -Uri $Url -TimeoutSec 2 -ErrorAction Stop
        return $response.ok -eq $true -and [string]$response.service -eq $ExpectedService
    }
    catch { return $false }
}

function Get-EnglishStudyRuntimeStatus {
    param([Parameter(Mandatory = $true)]$Context)
    $hub = Get-EnglishStudyRoleState -Context $Context -Role hub
    $mcp = Get-EnglishStudyRoleState -Context $Context -Role mcp
    $hubHealthy = Test-EnglishStudyHealth -Url $Context.hubHealth -ExpectedService "english-study-hub"
    $mcpHealthy = Test-EnglishStudyHealth -Url $Context.mcpHealth -ExpectedService "english-study-mcp"
    $states = @($hub.state, $mcp.state)
    $status = if ($states -contains "OwnershipMismatch") { "OwnershipMismatch" }
        elseif ($hub.state -eq "Stopped" -and $mcp.state -eq "Stopped") { "Stopped" }
        elseif ($hub.state -eq "Owned" -and $mcp.state -eq "Owned" -and $hubHealthy -and $mcpHealthy) { "Ready" }
        else { "Unhealthy" }
    [pscustomobject]@{
        status = $status
        hub = [pscustomobject]@{ healthy=$hubHealthy; ownership=$hub.state; pid=$hub.managedPid; listenerPid=$hub.listenerPid; relation=$hub.relation }
        mcp = [pscustomobject]@{ healthy=$mcpHealthy; ownership=$mcp.state; pid=$mcp.managedPid; listenerPid=$mcp.listenerPid; relation=$mcp.relation }
        ownedPids = @(@($hub, $mcp) | Where-Object { $_.state -eq "Owned" } | ForEach-Object { $_.managedPid })
    }
}

function Assert-EnglishStudySourceReady {
    param([Parameter(Mandatory = $true)]$Context)
    foreach ($path in @($Context.pythonPath, (Join-Path $Context.hubRoot "pyproject.toml"), $Context.nodePath, $Context.mcpEntry)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "SOURCE_NOT_READY: Required runtime file is missing." }
    }
    $newestSource = Get-ChildItem -LiteralPath (Join-Path $Context.projectRoot "src") -Filter "*.ts" -File -Recurse | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    $artifact = Get-Item -LiteralPath $Context.mcpEntry
    if ($null -ne $newestSource -and $newestSource.LastWriteTimeUtc -gt $artifact.LastWriteTimeUtc) {
        throw "BUILD_STALE: English Study TypeScript source is newer than dist; run npm run build."
    }
}

function Start-EnglishStudyRole {
    param([Parameter(Mandatory = $true)]$Context, [Parameter(Mandatory = $true)][ValidateSet("hub", "mcp")][string]$Role)
    New-Item -ItemType Directory -Force -Path $Context.runtimeDir | Out-Null
    if ($Role -eq "hub") {
        $process = Start-Process -FilePath $Context.pythonPath -WorkingDirectory $Context.hubRoot -ArgumentList @("-m", "english_study_hub", "serve", "--host", $Context.hostName, "--port", [string]$Context.hubPort) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Context.runtimeDir "hub.stdout.log") -RedirectStandardError (Join-Path $Context.runtimeDir "hub.stderr.log") -PassThru
        Set-Content -LiteralPath $Context.hubPidFile -Value ([string]$process.Id) -Encoding ASCII
    }
    else {
        $env:ESTUDY_HUB_BASE_URL = "http://$($Context.hostName):$($Context.hubPort)"
        $env:ESTUDY_MCP_HOST = $Context.hostName
        $env:ESTUDY_MCP_PORT = [string]$Context.mcpPort
        $process = Start-Process -FilePath $Context.nodePath -WorkingDirectory $Context.projectRoot -ArgumentList @($Context.mcpEntry) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Context.runtimeDir "mcp.stdout.log") -RedirectStandardError (Join-Path $Context.runtimeDir "mcp.stderr.log") -PassThru
        Set-Content -LiteralPath $Context.mcpPidFile -Value ([string]$process.Id) -Encoding ASCII
    }
}

function Wait-EnglishStudyReady {
    param([Parameter(Mandatory = $true)]$Context)
    $deadline = [DateTime]::UtcNow.AddSeconds($Context.readyTimeoutSeconds)
    do {
        $status = Get-EnglishStudyRuntimeStatus -Context $Context
        if ($status.status -eq "Ready") { return }
        if ($status.status -eq "OwnershipMismatch") { throw "OWNERSHIP_MISMATCH: A required port is owned by an unexpected process." }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "READINESS_TIMEOUT: English Study did not become Ready within the bounded timeout."
}

function Stop-EnglishStudyRole {
    param([Parameter(Mandatory = $true)]$Context, [Parameter(Mandatory = $true)][ValidateSet("hub", "mcp")][string]$Role)
    $state = Get-EnglishStudyRoleState -Context $Context -Role $Role
    if ($state.state -eq "OwnershipMismatch") { throw "OWNERSHIP_MISMATCH: Refusing to stop an unowned $Role process." }
    $pidFile = if ($Role -eq "hub") { $Context.hubPidFile } else { $Context.mcpPidFile }
    if ($null -ne $state.managedPid -and (Get-Process -Id $state.managedPid -ErrorAction SilentlyContinue)) {
        foreach ($entry in @(Get-EnglishStudyOwnedDescendants -RootPid $state.managedPid)) {
            if ([int]$entry.ProcessId -eq $PID) { throw "OWNERSHIP_MISMATCH: Refusing to stop the lifecycle controller." }
            Stop-Process -Id ([int]$entry.ProcessId) -Force -ErrorAction SilentlyContinue
        }
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while ((Get-Process -Id $state.managedPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 100
        }
        if (Get-Process -Id $state.managedPid -ErrorAction SilentlyContinue) { throw "STOP_FAILED: $Role PID $($state.managedPid) did not exit." }
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

function Invoke-EnglishStudyLifecycleAction {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][ValidateSet("EnsureRunning", "RestartCore", "ReloadRuntime", "ShutdownRuntime")][string]$Action
    )
    if ($Action -eq "ShutdownRuntime") {
        Stop-EnglishStudyRole -Context $Context -Role mcp
        Stop-EnglishStudyRole -Context $Context -Role hub
        return
    }
    Assert-EnglishStudySourceReady -Context $Context
    $status = Get-EnglishStudyRuntimeStatus -Context $Context
    if ($status.status -eq "OwnershipMismatch") { throw "OWNERSHIP_MISMATCH: Refusing lifecycle changes while ownership is ambiguous." }
    if ($Action -in @("RestartCore", "ReloadRuntime")) {
        Stop-EnglishStudyRole -Context $Context -Role mcp
        Stop-EnglishStudyRole -Context $Context -Role hub
        $status = Get-EnglishStudyRuntimeStatus -Context $Context
    }
    if ($status.hub.ownership -ne "Owned") { Start-EnglishStudyRole -Context $Context -Role hub }
    $deadline = [DateTime]::UtcNow.AddSeconds($Context.readyTimeoutSeconds)
    while (-not (Test-EnglishStudyHealth -Url $Context.hubHealth -ExpectedService "english-study-hub")) {
        if ([DateTime]::UtcNow -ge $deadline) { throw "HUB_READINESS_TIMEOUT: English Study Hub did not become ready." }
        Start-Sleep -Milliseconds 300
    }
    $mcpState = Get-EnglishStudyRoleState -Context $Context -Role mcp
    if ($mcpState.state -ne "Owned") { Start-EnglishStudyRole -Context $Context -Role mcp }
    Wait-EnglishStudyReady -Context $Context
}

Export-ModuleMember -Function @(
    "New-EnglishStudyRuntimeContext",
    "Get-EnglishStudyRuntimeStatus",
    "Invoke-EnglishStudyLifecycleAction"
)
