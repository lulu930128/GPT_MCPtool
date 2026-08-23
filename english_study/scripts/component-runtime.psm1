Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function New-EnglishStudyRuntimeContext {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$HubRoot,
        [string]$HostName = "127.0.0.1",
        [int]$McpPort = 18886,
        [int]$HubPort = 18887,
        [string]$TunnelClientPath,
        [string]$TunnelProfileDir,
        [string]$TunnelProfile = "english-study",
        [string]$TunnelHealthUrl = "http://127.0.0.1:18888",
        [string]$TunnelArguments,
        [string]$TunnelIdentity,
        [string]$KeyStorePath,
        [string]$SecretPath,
        [int]$ReadyTimeoutSeconds = 30,
        [int[]]$TunnelRecoveryDelaysSeconds = @(15, 30, 60)
    )
    $root = (Resolve-Path -LiteralPath $ProjectRoot).Path
    $hub = (Resolve-Path -LiteralPath $HubRoot).Path
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $python = Join-Path $hub ".venv\Scripts\python.exe"
    if ([string]::IsNullOrWhiteSpace($TunnelClientPath)) { $TunnelClientPath = Join-Path $root "vendor\tunnel-client\tunnel-client.exe" }
    if ([string]::IsNullOrWhiteSpace($TunnelProfileDir)) { $TunnelProfileDir = Join-Path $root ".tunnel-client" }
    if ([string]::IsNullOrWhiteSpace($KeyStorePath)) { $KeyStorePath = Join-Path $root "scripts\key-store.ps1" }
    if ([string]::IsNullOrWhiteSpace($SecretPath)) { $SecretPath = Join-Path $root ".secrets\control-plane-api-key.dpapi" }
    $tunnelUri = [Uri]$TunnelHealthUrl
    if ($HostName -notin @("127.0.0.1", "localhost", "::1", "[::1]") -or $tunnelUri.Host -notin @("127.0.0.1", "localhost", "::1", "[::1]")) {
        throw "Runtime endpoints must use loopback."
    }
    $runtimeDir = Join-Path $root ".tmp"
    if ([string]::IsNullOrWhiteSpace($TunnelIdentity)) { $TunnelIdentity = $TunnelProfile }
    if ([string]::IsNullOrWhiteSpace($TunnelArguments)) {
        $TunnelArguments = "run --profile-dir `"$([IO.Path]::GetFullPath($TunnelProfileDir))`" --profile `"$TunnelProfile`" --log.file `"$(Join-Path $runtimeDir 'tunnel-client.log')`" --pid.file `"$(Join-Path $runtimeDir 'tunnel-client.pid')`""
    }
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
        runtimeDir = $runtimeDir
        hubPidFile = Join-Path $root ".tmp\english-study-hub.pid"
        mcpPidFile = Join-Path $root ".tmp\english-study-mcp.pid"
        tunnelPidFile = Join-Path $root ".tmp\tunnel-client.pid"
        hubHealth = "http://$HostName`:$HubPort/health"
        mcpHealth = "http://$HostName`:$McpPort/health"
        tunnelClientPath = [IO.Path]::GetFullPath($TunnelClientPath)
        tunnelProfileDir = [IO.Path]::GetFullPath($TunnelProfileDir)
        tunnelProfilePath = Join-Path ([IO.Path]::GetFullPath($TunnelProfileDir)) "$TunnelProfile.yaml"
        tunnelHealthUrl = $TunnelHealthUrl.TrimEnd('/')
        tunnelHealthPort = $(if ($tunnelUri.IsDefaultPort) { 80 } else { $tunnelUri.Port })
        tunnelArguments = $TunnelArguments
        tunnelIdentity = $TunnelIdentity
        keyStorePath = [IO.Path]::GetFullPath($KeyStorePath)
        secretPath = [IO.Path]::GetFullPath($SecretPath)
        tunnelRecoveryDelaysSeconds = @($TunnelRecoveryDelaysSeconds)
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
    $netstatPath = Join-Path $env:WINDIR "System32\netstat.exe"
    if (Test-Path -LiteralPath $netstatPath -PathType Leaf) {
        $listenerPids = @()
        foreach ($line in @(& $netstatPath -ano -p TCP 2>$null)) {
            if ([string]$line -match ("^\s*TCP\s+\S+:" + $Port + "\s+\S+\s+LISTENING\s+(\d+)\s*$")) { $listenerPids += [int]$Matches[1] }
        }
        $unique = @($listenerPids | Sort-Object -Unique)
        if ($unique.Count -eq 1) { return [int]$unique[0] }
        if ($unique.Count -gt 1) { return -1 }
        return $null
    }
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

function Invoke-EnglishStudyChildProcess {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Start,
        [hashtable]$Environment = @{}
    )
    $overrides = @{}
    foreach ($name in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")) { $overrides[$name] = $null }
    $overrides["NO_PROXY"] = "127.0.0.1,localhost"
    $overrides["no_proxy"] = "127.0.0.1,localhost"
    foreach ($name in $Environment.Keys) { $overrides[[string]$name] = $Environment[$name] }
    $saved = @{}
    try {
        foreach ($name in $overrides.Keys) {
            $saved[$name] = [Environment]::GetEnvironmentVariable([string]$name, "Process")
            [Environment]::SetEnvironmentVariable([string]$name, $overrides[$name], "Process")
        }
        return (& $Start)
    }
    finally {
        foreach ($name in $overrides.Keys) { [Environment]::SetEnvironmentVariable([string]$name, $saved[$name], "Process") }
    }
}

function Get-EnglishStudyRoleState {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][ValidateSet("hub", "mcp", "tunnel")][string]$Role
    )
    $pidFile = switch ($Role) { "hub" { $Context.hubPidFile } "mcp" { $Context.mcpPidFile } default { $Context.tunnelPidFile } }
    $port = switch ($Role) { "hub" { $Context.hubPort } "mcp" { $Context.mcpPort } default { $Context.tunnelHealthPort } }
    $expectedExecutable = switch ($Role) { "hub" { $Context.pythonPath } "mcp" { $Context.nodePath } default { $Context.tunnelClientPath } }
    $expectedFragments = switch ($Role) {
        "hub" { @("-m english_study_hub", "serve") }
        "mcp" { @($Context.projectRoot, "dist\src\http-main.js") }
        default { @($Context.projectRoot, "tunnel-client", $Context.tunnelIdentity) }
    }
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

function Test-EnglishStudyTunnelReady {
    param([Parameter(Mandatory = $true)]$Context)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$($Context.tunnelHealthUrl)/readyz" -TimeoutSec 2 -ErrorAction Stop
        return ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300 -and $response.Content.Trim() -in @("ready", "ok"))
    }
    catch { return $false }
}

function Get-EnglishStudyRuntimeStatus {
    param([Parameter(Mandatory = $true)]$Context)
    $hub = Get-EnglishStudyRoleState -Context $Context -Role hub
    $mcp = Get-EnglishStudyRoleState -Context $Context -Role mcp
    $tunnel = Get-EnglishStudyRoleState -Context $Context -Role tunnel
    $hubHealthy = Test-EnglishStudyHealth -Url $Context.hubHealth -ExpectedService "english-study-hub"
    $mcpHealthy = Test-EnglishStudyHealth -Url $Context.mcpHealth -ExpectedService "english-study-mcp"
    $tunnelReady = Test-EnglishStudyTunnelReady -Context $Context
    $states = @($hub.state, $mcp.state, $tunnel.state)
    $status = if ($states -contains "OwnershipMismatch") { "OwnershipMismatch" }
        elseif ($hub.state -eq "Stopped" -and $mcp.state -eq "Stopped" -and $tunnel.state -eq "Stopped") { "Stopped" }
        elseif ($hub.state -eq "Owned" -and $mcp.state -eq "Owned" -and $tunnel.state -eq "Owned" -and $hubHealthy -and $mcpHealthy -and $tunnelReady) { "Ready" }
        elseif ($hub.state -eq "Owned" -and $mcp.state -eq "Owned" -and $hubHealthy -and $mcpHealthy) { "Degraded" }
        else { "Unhealthy" }
    [pscustomobject]@{
        status = $status
        hub = [pscustomobject]@{ healthy=$hubHealthy; ownership=$hub.state; pid=$hub.managedPid; listenerPid=$hub.listenerPid; relation=$hub.relation }
        mcp = [pscustomobject]@{ healthy=$mcpHealthy; ownership=$mcp.state; pid=$mcp.managedPid; listenerPid=$mcp.listenerPid; relation=$mcp.relation }
        tunnel = [pscustomobject]@{ ready=$tunnelReady; ownership=$tunnel.state; pid=$tunnel.managedPid; listenerPid=$tunnel.listenerPid; relation=$tunnel.relation }
        ownedPids = @(@($hub, $mcp, $tunnel) | Where-Object { $_.state -eq "Owned" } | ForEach-Object { $_.managedPid })
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
    param([Parameter(Mandatory = $true)]$Context, [Parameter(Mandatory = $true)][ValidateSet("hub", "mcp", "tunnel")][string]$Role)
    New-Item -ItemType Directory -Force -Path $Context.runtimeDir | Out-Null
    if ($Role -eq "hub") {
        $process = Invoke-EnglishStudyChildProcess -Environment @{ PYTHONUTF8 = "1" } -Start {
            Start-Process -FilePath $Context.pythonPath -WorkingDirectory $Context.hubRoot -ArgumentList @("-m", "english_study_hub", "serve", "--host", $Context.hostName, "--port", [string]$Context.hubPort) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Context.runtimeDir "hub.stdout.log") -RedirectStandardError (Join-Path $Context.runtimeDir "hub.stderr.log") -PassThru
        }
        Set-Content -LiteralPath $Context.hubPidFile -Value ([string]$process.Id) -Encoding ASCII
    }
    elseif ($Role -eq "mcp") {
        $process = Invoke-EnglishStudyChildProcess -Environment @{
            ESTUDY_HUB_BASE_URL = "http://$($Context.hostName):$($Context.hubPort)"
            ESTUDY_MCP_HOST = $Context.hostName
            ESTUDY_MCP_PORT = [string]$Context.mcpPort
        } -Start {
            Start-Process -FilePath $Context.nodePath -WorkingDirectory $Context.projectRoot -ArgumentList @($Context.mcpEntry) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Context.runtimeDir "mcp.stdout.log") -RedirectStandardError (Join-Path $Context.runtimeDir "mcp.stderr.log") -PassThru
        }
        Set-Content -LiteralPath $Context.mcpPidFile -Value ([string]$process.Id) -Encoding ASCII
    }
    else {
        if (-not (Test-EnglishStudyHealth -Url $Context.mcpHealth -ExpectedService "english-study-mcp")) { throw "MCP_NOT_READY: Tunnel start requires the MCP adapter." }
        foreach ($required in @($Context.tunnelClientPath, $Context.tunnelProfilePath, $Context.keyStorePath)) {
            if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "TUNNEL_CONFIG_MISSING: Tunnel runtime is incomplete." }
        }
        . $Context.keyStorePath
        $savedKey = [Environment]::GetEnvironmentVariable("CONTROL_PLANE_API_KEY", "Process")
        [Environment]::SetEnvironmentVariable("CONTROL_PLANE_API_KEY", $null, "Process")
        try {
            if (-not (Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $Context.projectRoot -SecretPath $Context.secretPath)) { throw "TUNNEL_KEY_MISSING: Tunnel runtime key is unavailable." }
            $decryptedKey = $env:CONTROL_PLANE_API_KEY
            $process = Invoke-EnglishStudyChildProcess -Environment @{ CONTROL_PLANE_API_KEY = $decryptedKey } -Start {
                Start-Process -FilePath $Context.tunnelClientPath -WorkingDirectory $Context.projectRoot -ArgumentList $Context.tunnelArguments -WindowStyle Hidden -PassThru
            }
        }
        finally {
            $decryptedKey = $null
            [Environment]::SetEnvironmentVariable("CONTROL_PLANE_API_KEY", $savedKey, "Process")
        }
        if ($null -eq $process) { throw "TUNNEL_START_FAILED: Tunnel process did not start." }
        Set-Content -LiteralPath $Context.tunnelPidFile -Value ([string]$process.Id) -Encoding ASCII
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
    param([Parameter(Mandatory = $true)]$Context, [Parameter(Mandatory = $true)][ValidateSet("hub", "mcp", "tunnel")][string]$Role)
    $state = Get-EnglishStudyRoleState -Context $Context -Role $Role
    if ($state.state -eq "OwnershipMismatch") { throw "OWNERSHIP_MISMATCH: Refusing to stop an unowned $Role process." }
    $pidFile = switch ($Role) { "hub" { $Context.hubPidFile } "mcp" { $Context.mcpPidFile } default { $Context.tunnelPidFile } }
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

function Wait-EnglishStudyCoreReady {
    param([Parameter(Mandatory = $true)]$Context)
    $deadline = [DateTime]::UtcNow.AddSeconds($Context.readyTimeoutSeconds)
    do {
        $hubReady = Test-EnglishStudyHealth -Url $Context.hubHealth -ExpectedService "english-study-hub"
        $mcpReady = Test-EnglishStudyHealth -Url $Context.mcpHealth -ExpectedService "english-study-mcp"
        $hub = Get-EnglishStudyRoleState -Context $Context -Role hub
        $mcp = Get-EnglishStudyRoleState -Context $Context -Role mcp
        if ($hub.state -eq "OwnershipMismatch" -or $mcp.state -eq "OwnershipMismatch") { throw "OWNERSHIP_MISMATCH: A core port is owned by an unexpected process." }
        if ($hubReady -and $mcpReady -and $hub.state -eq "Owned" -and $mcp.state -eq "Owned") { return }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "CORE_READINESS_TIMEOUT: English Study core did not become ready."
}

function Repair-EnglishStudyConnectivity {
    param([Parameter(Mandatory = $true)]$Context)
    Wait-EnglishStudyCoreReady -Context $Context
    $tunnel = Get-EnglishStudyRoleState -Context $Context -Role tunnel
    if ($tunnel.state -eq "OwnershipMismatch") { throw "OWNERSHIP_MISMATCH: Cannot repair an unowned tunnel." }
    if ($tunnel.state -eq "Owned" -and (Test-EnglishStudyTunnelReady -Context $Context)) { return }
    if ($tunnel.state -ne "Stopped") { Stop-EnglishStudyRole -Context $Context -Role tunnel }
    foreach ($delay in @($Context.tunnelRecoveryDelaysSeconds)) {
        Start-EnglishStudyRole -Context $Context -Role tunnel
        $deadline = [DateTime]::UtcNow.AddSeconds([int]$delay)
        do {
            if (Test-EnglishStudyTunnelReady -Context $Context) {
                $state = Get-EnglishStudyRoleState -Context $Context -Role tunnel
                if ($state.state -eq "Owned") { return }
                throw "OWNERSHIP_MISMATCH: Tunnel listener is not owned by the started process."
            }
            Start-Sleep -Milliseconds 300
        } while ([DateTime]::UtcNow -lt $deadline)
        Stop-EnglishStudyRole -Context $Context -Role tunnel
    }
    throw "TUNNEL_NOT_READY: Tunnel failed bounded recovery."
}

function Assert-EnglishStudyMutationPreflight {
    param([Parameter(Mandatory = $true)]$Context, [Parameter(Mandatory = $true)][string[]]$Roles)
    foreach ($role in $Roles) {
        $state = Get-EnglishStudyRoleState -Context $Context -Role $role
        if ($state.state -eq "OwnershipMismatch") { throw "OWNERSHIP_MISMATCH: Cannot mutate $role while ownership is ambiguous." }
    }
}

function Invoke-EnglishStudyLifecycleAction {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][ValidateSet("EnsureRunning", "RepairConnectivity", "RestartCore", "ReloadRuntime", "ShutdownRuntime")][string]$Action
    )
    if ($Action -eq "ShutdownRuntime") {
        Assert-EnglishStudyMutationPreflight -Context $Context -Roles @("hub", "mcp", "tunnel")
        Stop-EnglishStudyRole -Context $Context -Role tunnel
        Stop-EnglishStudyRole -Context $Context -Role mcp
        Stop-EnglishStudyRole -Context $Context -Role hub
        return
    }
    Assert-EnglishStudySourceReady -Context $Context
    $status = Get-EnglishStudyRuntimeStatus -Context $Context
    if ($status.status -eq "OwnershipMismatch") { throw "OWNERSHIP_MISMATCH: Refusing lifecycle changes while ownership is ambiguous." }
    if ($Action -eq "RepairConnectivity") { Repair-EnglishStudyConnectivity -Context $Context; return }
    if ($Action -in @("RestartCore", "ReloadRuntime")) {
        $roles = if ($Action -eq "ReloadRuntime") { @("hub", "mcp", "tunnel") } else { @("hub", "mcp") }
        Assert-EnglishStudyMutationPreflight -Context $Context -Roles $roles
        if ($Action -eq "ReloadRuntime") { Stop-EnglishStudyRole -Context $Context -Role tunnel }
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
    Wait-EnglishStudyCoreReady -Context $Context
    if ($Action -eq "RestartCore") { return }
    Repair-EnglishStudyConnectivity -Context $Context
    Wait-EnglishStudyReady -Context $Context
}

Export-ModuleMember -Function @(
    "New-EnglishStudyRuntimeContext",
    "Get-EnglishStudyRuntimeStatus",
    "Invoke-EnglishStudyLifecycleAction"
)
