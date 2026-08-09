Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$script:Utf8NoBom = New-Object Text.UTF8Encoding($false)

function Test-PrPathEqual {
  param([string]$Left, [string]$Right)
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
  try {
    return [IO.Path]::GetFullPath($Left).TrimEnd('\').Equals(
      [IO.Path]::GetFullPath($Right).TrimEnd('\'),
      [StringComparison]::OrdinalIgnoreCase
    )
  }
  catch { return $false }
}

function Write-PrAtomicText {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Value
  )
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary = "$Path.tmp.${PID}.$([Guid]::NewGuid().ToString('N'))"
  try {
    [IO.File]::WriteAllText($temporary, $Value, $script:Utf8NoBom)
    Move-Item -LiteralPath $temporary -Destination $Path -Force
  }
  finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
  }
}

function Read-PrPidFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $text = (Get-Content -LiteralPath $Path -Encoding UTF8 -Raw).Trim()
    $parsed = 0
    if ([int]::TryParse($text, [ref]$parsed) -and $parsed -gt 0) { return $parsed }
  }
  catch { }
  return $null
}

function Remove-PrPidFile {
  param([Parameter(Mandatory = $true)][string]$Path, [int]$ExpectedPid = 0)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
  if ($ExpectedPid -gt 0) {
    $current = Read-PrPidFile -Path $Path
    if ($null -ne $current -and $current -ne $ExpectedPid) { return }
  }
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

function Get-PrProcess {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    $executablePath = $null
    $startTimeUtc = $null
    try { $executablePath = [string]$process.Path } catch { }
    try { $startTimeUtc = $process.StartTime.ToUniversalTime().ToString("o") } catch { }
    return [pscustomobject]@{
      ProcessId = [int]$process.Id
      Name = [string]$process.ProcessName
      ExecutablePath = $executablePath
      StartTimeUtc = $startTimeUtc
    }
  }
  catch {
    return $null
  }
}

function Get-PrListenerState {
  param([Parameter(Mandatory = $true)][int]$Port)
  $netstatPath = Join-Path $env:WINDIR "System32\netstat.exe"
  if (-not (Test-Path -LiteralPath $netstatPath -PathType Leaf)) {
    return [pscustomobject]@{ known = $false; pids = @(); error = "LISTENER_QUERY_FAILED" }
  }
  try {
    $lines = @(& $netstatPath -ano -p tcp 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "netstat failed" }
    $pids = @()
    foreach ($line in $lines) {
      $parts = @(([string]$line).Trim() -split '\s+')
      if ($parts.Count -lt 5 -or $parts[0] -ne "TCP" -or $parts[3] -ne "LISTENING") { continue }
      if ($parts[1] -notmatch ':(\d+)$' -or [int]$matches[1] -ne $Port) { continue }
      $parsedPid = 0
      if ([int]::TryParse($parts[4], [ref]$parsedPid) -and $parsedPid -gt 0) { $pids += $parsedPid }
    }
    return [pscustomobject]@{ known = $true; pids = @($pids | Sort-Object -Unique) }
  }
  catch {
    return [pscustomobject]@{ known = $false; pids = @(); error = "LISTENER_QUERY_FAILED" }
  }
}

function Test-PrOwnedProcess {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("server", "tunnel")][string]$Role,
    [Parameter(Mandatory = $true)]$Process
  )
  $executablePath = [string]$Process.ExecutablePath
  if ([string]::IsNullOrWhiteSpace($executablePath)) { return $false }
  if ($Role -eq "server") {
    return (Test-PrPathEqual -Left $executablePath -Right $Context.nodePath)
  }
  return (Test-PrPathEqual -Left $executablePath -Right $Context.tunnelClientPath)
}

function Get-PrRoleDefinition {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("server", "tunnel")][string]$Role
  )
  if ($Role -eq "server") {
    return [pscustomobject]@{ pidFile = $Context.serverPidFile; ownerFile = $Context.serverOwnerFile; port = $Context.port; identity = $Context.httpEntry }
  }
  return [pscustomobject]@{ pidFile = $Context.tunnelPidFile; ownerFile = $Context.tunnelOwnerFile; port = $Context.tunnelHealthPort; identity = $Context.tunnelProfile }
}

function Write-PrOwnerMetadata {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("server", "tunnel")][string]$Role,
    [Parameter(Mandatory = $true)]$Process
  )
  $definition = Get-PrRoleDefinition -Context $Context -Role $Role
  $metadata = [ordered]@{
    schemaVersion = 1
    role = $Role
    pid = [int]$Process.ProcessId
    executablePath = [string]$Process.ExecutablePath
    startTimeUtc = [string]$Process.StartTimeUtc
    identity = [string]$definition.identity
    recordedAt = [DateTime]::UtcNow.ToString("o")
  }
  Write-PrAtomicText -Path $definition.ownerFile -Value ($metadata | ConvertTo-Json -Compress)
}

function Test-PrOwnerMetadata {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("server", "tunnel")][string]$Role,
    [Parameter(Mandatory = $true)]$Process
  )
  $definition = Get-PrRoleDefinition -Context $Context -Role $Role
  if (-not (Test-Path -LiteralPath $definition.ownerFile -PathType Leaf)) { return $false }
  try { $metadata = Get-Content -LiteralPath $definition.ownerFile -Encoding UTF8 -Raw | ConvertFrom-Json }
  catch { return $false }
  return (
    [int]$metadata.schemaVersion -eq 1 -and
    [string]$metadata.role -eq $Role -and
    [int]$metadata.pid -eq [int]$Process.ProcessId -and
    (Test-PrPathEqual -Left ([string]$metadata.executablePath) -Right ([string]$Process.ExecutablePath)) -and
    -not [string]::IsNullOrWhiteSpace([string]$Process.StartTimeUtc) -and
    [string]$metadata.startTimeUtc -eq [string]$Process.StartTimeUtc -and
    [string]$metadata.identity -eq [string]$definition.identity
  )
}

function Test-PrRoleIdentityReady {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("server", "tunnel")][string]$Role
  )
  if ($Role -eq "server") { return (Test-PrServerHealth -Context $Context) }
  return (Test-PrTunnelReady -Context $Context)
}

function Resolve-PrRoleOwnership {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("server", "tunnel")][string]$Role,
    [switch]$AdoptExactListener
  )
  $definition = Get-PrRoleDefinition -Context $Context -Role $Role
  $managedPid = Read-PrPidFile -Path $definition.pidFile
  if ($null -ne $managedPid) {
    $managedProcess = Get-PrProcess -ProcessId $managedPid
    if ($null -eq $managedProcess) {
      Remove-PrPidFile -Path $definition.pidFile -ExpectedPid $managedPid
      Remove-PrPidFile -Path $definition.ownerFile
      $managedPid = $null
    }
    elseif (-not (Test-PrOwnedProcess -Context $Context -Role $Role -Process $managedProcess)) {
      return [pscustomobject]@{
        role = $Role; state = "OwnershipMismatch"; pid = $managedPid; listenerPid = $null
        reason = "PID_FILE_PROCESS_MISMATCH"; canMutate = $false; adopted = $false
      }
    }
  }

  $listener = Get-PrListenerState -Port $definition.port
  if (-not $listener.known) {
    return [pscustomobject]@{
      role = $Role; state = "OwnershipUnknown"; pid = $managedPid; listenerPid = $null
      reason = "LISTENER_QUERY_FAILED"; canMutate = $false; adopted = $false
    }
  }
  if ($listener.pids.Count -gt 1) {
    return [pscustomobject]@{
      role = $Role; state = "OwnershipMismatch"; pid = $managedPid; listenerPid = $null
      reason = "MULTIPLE_LISTENER_OWNERS"; canMutate = $false; adopted = $false
    }
  }
  $listenerPid = if ($listener.pids.Count -eq 1) { [int]$listener.pids[0] } else { $null }

  if ($null -ne $managedPid) {
    if ($null -ne $listenerPid -and $listenerPid -ne $managedPid) {
      return [pscustomobject]@{
        role = $Role; state = "OwnershipMismatch"; pid = $managedPid; listenerPid = $listenerPid
        reason = "MANAGED_PID_DOES_NOT_OWN_LISTENER"; canMutate = $false; adopted = $false
      }
    }
    if ($null -eq $listenerPid) {
      if (-not (Test-PrOwnerMetadata -Context $Context -Role $Role -Process $managedProcess)) {
        return [pscustomobject]@{
          role = $Role; state = "OwnershipMismatch"; pid = $managedPid; listenerPid = $null
          reason = "OWNER_METADATA_MISSING_OR_STALE"; canMutate = $false; adopted = $false
        }
      }
      return [pscustomobject]@{
        role = $Role; state = "OwnedNotListening"; pid = $managedPid; listenerPid = $null
        reason = $null; canMutate = $true; adopted = $false
      }
    }
    if (-not (Test-PrOwnerMetadata -Context $Context -Role $Role -Process $managedProcess)) {
      if (-not (Test-PrRoleIdentityReady -Context $Context -Role $Role)) {
        return [pscustomobject]@{
          role = $Role; state = "OwnershipMismatch"; pid = $managedPid; listenerPid = $listenerPid
          reason = "IDENTITY_NOT_READY_FOR_ADOPTION"; canMutate = $false; adopted = $false
        }
      }
      Write-PrOwnerMetadata -Context $Context -Role $Role -Process $managedProcess
    }
    return [pscustomobject]@{
      role = $Role; state = "OwnedReady"; pid = $managedPid; listenerPid = $listenerPid
      reason = $null; canMutate = $true; adopted = $false
    }
  }

  if ($null -eq $listenerPid) {
    return [pscustomobject]@{
      role = $Role; state = "Stopped"; pid = $null; listenerPid = $null
      reason = $null; canMutate = $true; adopted = $false
    }
  }
  $listenerProcess = Get-PrProcess -ProcessId $listenerPid
  if (
    $null -ne $listenerProcess -and
    (Test-PrOwnedProcess -Context $Context -Role $Role -Process $listenerProcess) -and
    (Test-PrRoleIdentityReady -Context $Context -Role $Role)
  ) {
    if ($AdoptExactListener) {
      Write-PrAtomicText -Path $definition.pidFile -Value ([string]$listenerPid)
      Write-PrOwnerMetadata -Context $Context -Role $Role -Process $listenerProcess
    }
    return [pscustomobject]@{
      role = $Role; state = "OwnedReady"; pid = $listenerPid; listenerPid = $listenerPid
      reason = $null; canMutate = $true; adopted = [bool]$AdoptExactListener
    }
  }
  return [pscustomobject]@{
    role = $Role; state = "OwnershipMismatch"; pid = $null; listenerPid = $listenerPid
    reason = "FOREIGN_LISTENER"; canMutate = $false; adopted = $false
  }
}

function Test-PrTcpPort {
  param([Parameter(Mandatory = $true)][int]$Port, [int]$TimeoutMilliseconds = 250)
  $client = New-Object Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) { return $false }
    $client.EndConnect($async)
    return $true
  }
  catch { return $false }
  finally { $client.Dispose() }
}

function Test-PrServerHealth {
  param([Parameter(Mandatory = $true)]$Context)
  if (-not (Test-PrTcpPort -Port $Context.port)) { return $false }
  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri $Context.healthUrl -TimeoutSec 2
    return (
      $health.ok -eq $true -and
      [string]$health.service -eq "gpt-project-workspace-mcp"
    )
  }
  catch { return $false }
}

function Test-PrTunnelReady {
  param([Parameter(Mandatory = $true)]$Context)
  if (-not (Test-PrTcpPort -Port $Context.tunnelHealthPort)) { return $false }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$($Context.tunnelHealthUrl.TrimEnd('/'))/readyz" -TimeoutSec 2
    return ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300)
  }
  catch { return $false }
}

function Get-PrRuntimeStatus {
  param([Parameter(Mandatory = $true)]$Context, [switch]$AdoptExactListeners)
  $serverOwner = Resolve-PrRoleOwnership -Context $Context -Role server -AdoptExactListener:$AdoptExactListeners
  $tunnelOwner = Resolve-PrRoleOwnership -Context $Context -Role tunnel -AdoptExactListener:$AdoptExactListeners
  $serverHealthy = Test-PrServerHealth -Context $Context
  $tunnelReady = Test-PrTunnelReady -Context $Context
  $ownerStates = @($serverOwner.state, $tunnelOwner.state)
  $status = if (@($ownerStates | Where-Object { $_ -in @("OwnershipMismatch", "OwnershipUnknown") }).Count -gt 0) {
    "OwnershipMismatch"
  }
  elseif ($serverHealthy -and $tunnelReady) { "Ready" }
  elseif ($serverOwner.state -eq "Stopped" -and $tunnelOwner.state -eq "Stopped" -and -not $serverHealthy -and -not $tunnelReady) { "Stopped" }
  elseif ($serverHealthy) { "Degraded" }
  else { "Unhealthy" }
  $ownedPids = @(@($serverOwner.pid, $tunnelOwner.pid) | Where-Object { $null -ne $_ } | ForEach-Object { [int]$_ } | Sort-Object -Unique)
  return [pscustomobject]@{
    status = $status
    server = [pscustomobject]@{
      healthy = $serverHealthy
      ownership = $serverOwner.state
      pid = $serverOwner.pid
      listenerPid = $serverOwner.listenerPid
    }
    tunnel = [pscustomobject]@{
      ready = $tunnelReady
      ownership = $tunnelOwner.state
      pid = $tunnelOwner.pid
      listenerPid = $tunnelOwner.listenerPid
    }
    ownedPids = $ownedPids
  }
}

function Wait-PrCondition {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Condition,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [int]$PollMilliseconds = 250
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (& $Condition) { return $true }
    Start-Sleep -Milliseconds $PollMilliseconds
  } while ([DateTime]::UtcNow -lt $deadline)
  return [bool](& $Condition)
}

function Set-PrServerEnvironment {
  param([Parameter(Mandatory = $true)]$Context)
  if ([string]::IsNullOrWhiteSpace($Context.workspaceRoots)) {
    $env:WORKSPACE_MCP_ROOT = $Context.workspaceRoot
    Remove-Item Env:\WORKSPACE_MCP_ROOTS -ErrorAction SilentlyContinue
    Remove-Item Env:\WORKSPACE_MCP_DEFAULT_ROOT -ErrorAction SilentlyContinue
    Remove-Item Env:\WORKSPACE_MCP_ROOT_DENY_DIRS -ErrorAction SilentlyContinue
  }
  else {
    $env:WORKSPACE_MCP_ROOTS = $Context.workspaceRoots
    $env:WORKSPACE_MCP_DEFAULT_ROOT = $Context.defaultWorkspaceRoot
    $env:WORKSPACE_MCP_ROOT_DENY_DIRS = $Context.workspaceRootDenyDirs
    Remove-Item Env:\WORKSPACE_MCP_ROOT -ErrorAction SilentlyContinue
  }
  if ([string]::IsNullOrWhiteSpace($Context.assetScopes)) {
    Remove-Item Env:\WORKSPACE_MCP_ASSET_SCOPES -ErrorAction SilentlyContinue
  }
  else { $env:WORKSPACE_MCP_ASSET_SCOPES = $Context.assetScopes }
  $env:WORKSPACE_MCP_HTTP_HOST = $Context.hostName
  $env:WORKSPACE_MCP_HTTP_PORT = [string]$Context.port
  if ([string]::IsNullOrWhiteSpace($Context.token)) {
    Remove-Item Env:\WORKSPACE_MCP_HTTP_TOKEN -ErrorAction SilentlyContinue
  }
  else { $env:WORKSPACE_MCP_HTTP_TOKEN = $Context.token }
}

function Stop-PrOwnedRole {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("server", "tunnel")][string]$Role
  )
  $definition = Get-PrRoleDefinition -Context $Context -Role $Role
  $ownership = Resolve-PrRoleOwnership -Context $Context -Role $Role -AdoptExactListener
  if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot stop $Role because ownership is $($ownership.state)." }
  if ($ownership.state -eq "Stopped") { return }
  $process = Get-PrProcess -ProcessId ([int]$ownership.pid)
  if ($null -eq $process -or -not (Test-PrOwnedProcess -Context $Context -Role $Role -Process $process)) {
    throw "OWNERSHIP_MISMATCH: $Role PID changed before stop."
  }
  Stop-Process -Id ([int]$ownership.pid) -Force -ErrorAction Stop
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ((Get-Process -Id ([int]$ownership.pid) -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  if (Get-Process -Id ([int]$ownership.pid) -ErrorAction SilentlyContinue) {
    throw "STOP_TIMEOUT: $Role PID $($ownership.pid) did not exit."
  }
  Remove-PrPidFile -Path $definition.pidFile -ExpectedPid ([int]$ownership.pid)
  Remove-PrPidFile -Path $definition.ownerFile
}

function Start-PrServer {
  param([Parameter(Mandatory = $true)]$Context)
  $ownership = Resolve-PrRoleOwnership -Context $Context -Role server -AdoptExactListener
  $healthy = Test-PrServerHealth -Context $Context
  if ($healthy) {
    if ($ownership.canMutate -and $ownership.state -eq "OwnedReady") { return }
    throw "OWNERSHIP_MISMATCH: Healthy server is not owned by Project Reading."
  }
  if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot start server while ownership is $($ownership.state)." }
  if ($ownership.state -in @("OwnedReady", "OwnedNotListening")) { Stop-PrOwnedRole -Context $Context -Role server }
  if (-not (Test-Path -LiteralPath $Context.httpEntry -PathType Leaf)) { throw "SERVER_ENTRY_MISSING: Build output is missing." }
  if (-not (Test-Path -LiteralPath $Context.nodePath -PathType Leaf)) { throw "NODE_MISSING: Node executable is missing." }
  Set-PrServerEnvironment -Context $Context
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Context.nodePath
  $startInfo.Arguments = "`"$($Context.httpEntry)`""
  $startInfo.WorkingDirectory = $Context.projectRoot
  $startInfo.UseShellExecute = $true
  $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $process = [Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) { throw "SERVER_START_FAILED: Node process did not start." }
  Write-PrAtomicText -Path $Context.serverPidFile -Value ([string]$process.Id)
  $startedProcess = Get-PrProcess -ProcessId $process.Id
  if ($null -eq $startedProcess) { throw "SERVER_START_FAILED: Started server process is unavailable." }
  Write-PrOwnerMetadata -Context $Context -Role server -Process $startedProcess
  if (-not (Wait-PrCondition -TimeoutSeconds $Context.serverReadyTimeoutSeconds -Condition { Test-PrServerHealth -Context $Context })) {
    $current = Get-PrProcess -ProcessId $process.Id
    if ($null -ne $current -and (Test-PrOwnedProcess -Context $Context -Role server -Process $current)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-PrPidFile -Path $Context.serverPidFile -ExpectedPid $process.Id
    throw "SERVER_NOT_READY: Server did not become healthy within $($Context.serverReadyTimeoutSeconds) seconds."
  }
  $adopted = Resolve-PrRoleOwnership -Context $Context -Role server -AdoptExactListener
  if (-not $adopted.canMutate -or $adopted.pid -ne $process.Id) {
    throw "OWNERSHIP_MISMATCH: Started server does not own the expected listener."
  }
}

function Start-PrTunnelOnce {
  param([Parameter(Mandatory = $true)]$Context)
  if (-not (Test-PrServerHealth -Context $Context)) { throw "SERVER_NOT_READY: Tunnel start requires a healthy MCP server." }
  $ownership = Resolve-PrRoleOwnership -Context $Context -Role tunnel -AdoptExactListener
  if (Test-PrTunnelReady -Context $Context) {
    if ($ownership.canMutate -and $ownership.state -eq "OwnedReady") { return }
    throw "OWNERSHIP_MISMATCH: Ready tunnel is not owned by Project Reading."
  }
  if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot start tunnel while ownership is $($ownership.state)." }
  if ($ownership.state -in @("OwnedReady", "OwnedNotListening")) { Stop-PrOwnedRole -Context $Context -Role tunnel }
  if (-not (Test-Path -LiteralPath $Context.tunnelClientPath -PathType Leaf)) { throw "TUNNEL_CLIENT_MISSING: tunnel-client.exe is missing." }
  if (-not (Test-Path -LiteralPath $Context.tunnelProfilePath -PathType Leaf)) { throw "TUNNEL_PROFILE_MISSING: Tunnel profile is missing." }
  . $Context.keyStorePath
  Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $Context.projectRoot -SecretPath $Context.secretPath | Out-Null
  if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) { throw "TUNNEL_KEY_MISSING: Save the control-plane API key before starting the tunnel." }
  New-Item -ItemType Directory -Force -Path $Context.runtimeDir | Out-Null
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Context.tunnelClientPath
  $startInfo.Arguments = "run --profile-dir `"$($Context.tunnelProfileDir)`" --profile `"$($Context.tunnelProfile)`" --log.file `"$($Context.tunnelLogFile)`" --pid.file `"$($Context.tunnelPidFile)`""
  $startInfo.WorkingDirectory = $Context.projectRoot
  $startInfo.UseShellExecute = $true
  $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $process = [Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) { throw "TUNNEL_START_FAILED: Tunnel process did not start." }
  Write-PrAtomicText -Path $Context.tunnelPidFile -Value ([string]$process.Id)
  $startedProcess = Get-PrProcess -ProcessId $process.Id
  if ($null -eq $startedProcess) { throw "TUNNEL_START_FAILED: Started tunnel process is unavailable." }
  Write-PrOwnerMetadata -Context $Context -Role tunnel -Process $startedProcess
}

function Repair-PrConnectivity {
  param([Parameter(Mandatory = $true)]$Context)
  $server = Resolve-PrRoleOwnership -Context $Context -Role server -AdoptExactListener
  if (-not (Test-PrServerHealth -Context $Context) -or -not $server.canMutate -or $server.state -ne "OwnedReady") {
    throw "SERVER_NOT_READY: Connectivity repair requires a healthy owned MCP server."
  }
  $tunnel = Resolve-PrRoleOwnership -Context $Context -Role tunnel -AdoptExactListener
  if (Test-PrTunnelReady -Context $Context) {
    if ($tunnel.canMutate -and $tunnel.state -eq "OwnedReady") { return }
    throw "OWNERSHIP_MISMATCH: Ready tunnel is not owned by Project Reading."
  }
  if (-not $tunnel.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot repair tunnel while ownership is $($tunnel.state)." }
  if ($tunnel.state -in @("OwnedReady", "OwnedNotListening")) { Stop-PrOwnedRole -Context $Context -Role tunnel }

  foreach ($delaySeconds in @($Context.tunnelRecoveryDelaysSeconds)) {
    Start-PrTunnelOnce -Context $Context
    if (Wait-PrCondition -TimeoutSeconds ([int]$delaySeconds) -Condition { Test-PrTunnelReady -Context $Context }) {
      $readyOwner = Resolve-PrRoleOwnership -Context $Context -Role tunnel -AdoptExactListener
      if ($readyOwner.canMutate -and $readyOwner.state -eq "OwnedReady") { return }
      throw "OWNERSHIP_MISMATCH: Tunnel readiness listener is not owned by the started process."
    }
    Stop-PrOwnedRole -Context $Context -Role tunnel
  }
  throw "TUNNEL_NOT_READY: Tunnel failed bounded 15/30/60-style recovery."
}

function Assert-PrShutdownPreflight {
  param([Parameter(Mandatory = $true)]$Context)
  foreach ($role in @("tunnel", "server")) {
    $ownership = Resolve-PrRoleOwnership -Context $Context -Role $role -AdoptExactListener
    if (-not $ownership.canMutate) {
      throw "OWNERSHIP_MISMATCH: Cannot mutate $role while ownership is $($ownership.state)."
    }
  }
}

function Invoke-PrLifecycleAction {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("EnsureRunning", "RepairConnectivity", "RestartCore", "ReloadRuntime", "ShutdownRuntime")][string]$Action
  )
  switch ($Action) {
    "EnsureRunning" {
      Start-PrServer -Context $Context
      Repair-PrConnectivity -Context $Context
    }
    "RepairConnectivity" { Repair-PrConnectivity -Context $Context }
    "RestartCore" {
      $server = Resolve-PrRoleOwnership -Context $Context -Role server -AdoptExactListener
      if (-not $server.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot restart core while ownership is $($server.state)." }
      if ($server.state -ne "Stopped") { Stop-PrOwnedRole -Context $Context -Role server }
      Start-PrServer -Context $Context
    }
    "ReloadRuntime" {
      Assert-PrShutdownPreflight -Context $Context
      Stop-PrOwnedRole -Context $Context -Role tunnel
      Stop-PrOwnedRole -Context $Context -Role server
      Start-PrServer -Context $Context
      Repair-PrConnectivity -Context $Context
    }
    "ShutdownRuntime" {
      Assert-PrShutdownPreflight -Context $Context
      Stop-PrOwnedRole -Context $Context -Role tunnel
      Stop-PrOwnedRole -Context $Context -Role server
    }
  }
}

function New-PrRuntimeContext {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$WorkspaceRoot = "C:\project",
    [string]$WorkspaceRoots,
    [string]$DefaultWorkspaceRoot = "projects",
    [string]$WorkspaceRootDenyDirs,
    [string]$AssetScopes,
    [string]$HostName = "127.0.0.1",
    [int]$Port = 8787,
    [string]$Token,
    [string]$NodePath,
    [string]$TunnelClientPath,
    [string]$TunnelProfileDir,
    [string]$TunnelProfile = "project-workspace",
    [string]$TunnelHealthUrl = "http://127.0.0.1:8788",
    [string]$SecretPath,
    [int]$ServerReadyTimeoutSeconds = 20,
    [int[]]$TunnelRecoveryDelaysSeconds = @(15, 30, 60)
  )
  $resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path
  if ([string]::IsNullOrWhiteSpace($NodePath)) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
  if ([string]::IsNullOrWhiteSpace($TunnelClientPath)) { $TunnelClientPath = Join-Path $resolvedRoot "vendor\tunnel-client\tunnel-client.exe" }
  if ([string]::IsNullOrWhiteSpace($TunnelProfileDir)) { $TunnelProfileDir = Join-Path $resolvedRoot ".tunnel-client" }
  $tunnelUri = [Uri]$TunnelHealthUrl
  if ($tunnelUri.Host -notin @("127.0.0.1", "localhost", "::1", "[::1]")) { throw "TunnelHealthUrl must use loopback." }
  if ($ServerReadyTimeoutSeconds -lt 1 -or $ServerReadyTimeoutSeconds -gt 120) { throw "ServerReadyTimeoutSeconds must be between 1 and 120." }
  if (@($TunnelRecoveryDelaysSeconds).Count -lt 1 -or @($TunnelRecoveryDelaysSeconds).Count -gt 5 -or @($TunnelRecoveryDelaysSeconds | Where-Object { $_ -lt 1 -or $_ -gt 120 }).Count -gt 0) {
    throw "TunnelRecoveryDelaysSeconds must contain 1-5 values between 1 and 120."
  }
  $runtimeDir = Join-Path $resolvedRoot ".tmp"
  return [pscustomobject]@{
    projectRoot = $resolvedRoot
    workspaceRoot = $WorkspaceRoot
    workspaceRoots = $WorkspaceRoots
    defaultWorkspaceRoot = $DefaultWorkspaceRoot
    workspaceRootDenyDirs = $WorkspaceRootDenyDirs
    assetScopes = $AssetScopes
    hostName = $HostName
    port = $Port
    token = $Token
    nodePath = [IO.Path]::GetFullPath($NodePath)
    httpEntry = Join-Path $resolvedRoot "dist\src\http-main.js"
    mcpUrl = "http://${HostName}:${Port}/mcp"
    healthUrl = "http://${HostName}:${Port}/health"
    tunnelClientPath = [IO.Path]::GetFullPath($TunnelClientPath)
    tunnelProfileDir = [IO.Path]::GetFullPath($TunnelProfileDir)
    tunnelProfile = $TunnelProfile
    tunnelProfilePath = Join-Path ([IO.Path]::GetFullPath($TunnelProfileDir)) "$TunnelProfile.yaml"
    tunnelHealthUrl = $TunnelHealthUrl.TrimEnd('/')
    tunnelHealthPort = $(if ($tunnelUri.IsDefaultPort) { 80 } else { $tunnelUri.Port })
    runtimeDir = $runtimeDir
    serverPidFile = Join-Path $runtimeDir "project-reading-server.pid"
    serverOwnerFile = Join-Path $runtimeDir "project-reading-server.owner.json"
    tunnelPidFile = Join-Path $runtimeDir "tunnel-client.pid"
    tunnelOwnerFile = Join-Path $runtimeDir "tunnel-client.owner.json"
    tunnelLogFile = Join-Path $runtimeDir "tunnel-client.log"
    actionLogFile = Join-Path $runtimeDir "runtime-control.jsonl"
    keyStorePath = Join-Path $resolvedRoot "scripts\key-store.ps1"
    secretPath = $SecretPath
    serverReadyTimeoutSeconds = $ServerReadyTimeoutSeconds
    tunnelRecoveryDelaysSeconds = @($TunnelRecoveryDelaysSeconds)
  }
}

function Write-PrLifecycleEvent {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][string]$Action,
    [Parameter(Mandatory = $true)][bool]$Ok,
    [string]$BeforeStatus,
    [string]$AfterStatus,
    [int[]]$OwnedPids = @(),
    [int]$ElapsedMs,
    [string]$ErrorCode,
    [string]$Message
  )
  New-Item -ItemType Directory -Force -Path $Context.runtimeDir | Out-Null
  $event = [ordered]@{
    timestamp = [DateTime]::UtcNow.ToString("o")
    action = $Action
    ok = $Ok
    beforeStatus = $BeforeStatus
    afterStatus = $AfterStatus
    ownedPids = @($OwnedPids)
    elapsedMs = $ElapsedMs
    errorCode = $ErrorCode
    message = $Message
  }
  [IO.File]::AppendAllText($Context.actionLogFile, (($event | ConvertTo-Json -Compress -Depth 5) + [Environment]::NewLine), $script:Utf8NoBom)
}

Export-ModuleMember -Function @(
  "New-PrRuntimeContext",
  "Get-PrRuntimeStatus",
  "Invoke-PrLifecycleAction",
  "Write-PrLifecycleEvent"
)
