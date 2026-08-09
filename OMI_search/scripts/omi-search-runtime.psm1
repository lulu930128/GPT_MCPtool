Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$script:Utf8NoBom = New-Object Text.UTF8Encoding($false)

function Test-OmiPathEqual {
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

function Write-OmiAtomicText {
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

function Read-OmiPidFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $parsed = 0
    if ([int]::TryParse(([IO.File]::ReadAllText($Path).Trim()), [ref]$parsed) -and $parsed -gt 0) { return $parsed }
  }
  catch { }
  return $null
}

function Remove-OmiRuntimeFile {
  param([Parameter(Mandatory = $true)][string]$Path, [int]$ExpectedPid = 0)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
  if ($ExpectedPid -gt 0) {
    $current = Read-OmiPidFile -Path $Path
    if ($null -ne $current -and $current -ne $ExpectedPid) { return }
  }
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

function Get-OmiProcess {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    $executablePath = $null
    $startTimeUtc = $null
    $commandLine = $null
    try { $executablePath = [string]$process.Path } catch { }
    try { $startTimeUtc = $process.StartTime.ToUniversalTime().ToString("o") } catch { }
    try {
      $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
      $commandLine = [string]$cim.CommandLine
    }
    catch { }
    return [pscustomobject]@{
      ProcessId = [int]$process.Id
      Name = [string]$process.ProcessName
      ExecutablePath = $executablePath
      StartTimeUtc = $startTimeUtc
      CommandLine = $commandLine
    }
  }
  catch { return $null }
}

function Get-OmiListenerState {
  param([Parameter(Mandatory = $true)][int]$Port)
  $netstatPath = Join-Path $env:WINDIR "System32\netstat.exe"
  if (-not (Test-Path -LiteralPath $netstatPath -PathType Leaf)) {
    return [pscustomobject]@{ known = $false; pids = @(); errorCode = "listener_query_failed" }
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
    return [pscustomobject]@{ known = $true; pids = @($pids | Sort-Object -Unique); errorCode = $null }
  }
  catch { return [pscustomobject]@{ known = $false; pids = @(); errorCode = "listener_query_failed" } }
}

function Get-OmiExpectedSourceBuildId {
  param([Parameter(Mandatory = $true)]$Context)
  $hashes = @()
  foreach ($artifact in @($Context.httpEntry, $Context.serverEntry, $Context.contractSnapshot)) {
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) { return "" }
    $hashes += (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($hashes -join ""))
    return (-join ($sha256.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") })).Substring(0, 16)
  }
  finally { $sha256.Dispose() }
}

function Test-OmiTcpPort {
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

function Get-OmiServerHealth {
  param([Parameter(Mandatory = $true)]$Context)
  if (-not (Test-OmiTcpPort -Port $Context.port)) { return $null }
  try { return Invoke-RestMethod -UseBasicParsing -Uri $Context.healthUrl -TimeoutSec 2 }
  catch { return $null }
}

function Test-OmiServerHealth {
  param([Parameter(Mandatory = $true)]$Context)
  $health = Get-OmiServerHealth -Context $Context
  if ($null -eq $health) { return $false }
  $expectedBuildId = Get-OmiExpectedSourceBuildId -Context $Context
  return (
    $health.ok -eq $true -and
    [string]$health.service -eq "omi-search-http-mcp" -and
    -not [string]::IsNullOrWhiteSpace($expectedBuildId) -and
    [string]$health.buildId -eq $expectedBuildId
  )
}

function Test-OmiTunnelReady {
  param([Parameter(Mandatory = $true)]$Context)
  if (-not (Test-OmiTcpPort -Port $Context.tunnelHealthPort)) { return $false }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$($Context.tunnelHealthUrl)/readyz" -TimeoutSec 2
    return ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300 -and $response.Content.Trim() -in @("ready", "ok"))
  }
  catch { return $false }
}

function Test-OmiUpstreamReady {
  param([Parameter(Mandatory = $true)]$Context)
  if (-not (Test-OmiServerHealth -Context $Context)) { return $false }
  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri $Context.upstreamHealthUrl -TimeoutSec 2
    return ($health.ok -eq $true -and [string]$health.status -eq "ready")
  }
  catch { return $false }
}

function Get-OmiRoleDefinition {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("server", "tunnel")][string]$Role
  )
  if ($Role -eq "server") {
    return [pscustomobject]@{
      pidFile = $Context.serverPidFile
      ownerFile = $Context.serverOwnerFile
      port = $Context.port
      executablePath = $Context.pythonPath
      identity = $Context.httpEntry
    }
  }
  return [pscustomobject]@{
    pidFile = $Context.tunnelPidFile
    ownerFile = $Context.tunnelOwnerFile
    port = $Context.tunnelHealthPort
    executablePath = $Context.tunnelClientPath
    identity = $Context.tunnelProfile
  }
}

function Test-OmiExecutableIdentity {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("server", "tunnel")][string]$Role,
    [Parameter(Mandatory = $true)]$Process
  )
  $definition = Get-OmiRoleDefinition -Context $Context -Role $Role
  return (Test-OmiPathEqual -Left ([string]$Process.ExecutablePath) -Right ([string]$definition.executablePath))
}

function Test-OmiLegacyCommandIdentity {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("server", "tunnel")][string]$Role,
    [Parameter(Mandatory = $true)]$Process
  )
  $commandLine = [string]$Process.CommandLine
  if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }
  if ($Role -eq "server") {
    return (
      $commandLine.IndexOf($Context.projectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $commandLine.IndexOf("http_server.py", [StringComparison]::OrdinalIgnoreCase) -ge 0
    )
  }
  return (
    $commandLine.IndexOf($Context.tunnelClientPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $commandLine.IndexOf($Context.tunnelProfile, [StringComparison]::OrdinalIgnoreCase) -ge 0
  )
}

function Write-OmiOwnerMetadata {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("server", "tunnel")][string]$Role,
    [Parameter(Mandatory = $true)]$Process
  )
  $definition = Get-OmiRoleDefinition -Context $Context -Role $Role
  $metadata = [ordered]@{
    schemaVersion = 1
    role = $Role
    pid = [int]$Process.ProcessId
    executablePath = [string]$Process.ExecutablePath
    startTimeUtc = [string]$Process.StartTimeUtc
    identity = [string]$definition.identity
    recordedAt = [DateTime]::UtcNow.ToString("o")
  }
  Write-OmiAtomicText -Path $definition.ownerFile -Value ($metadata | ConvertTo-Json -Compress)
}

function Test-OmiOwnerMetadata {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("server", "tunnel")][string]$Role,
    [Parameter(Mandatory = $true)]$Process
  )
  $definition = Get-OmiRoleDefinition -Context $Context -Role $Role
  if (-not (Test-Path -LiteralPath $definition.ownerFile -PathType Leaf)) { return $false }
  try { $metadata = [IO.File]::ReadAllText($definition.ownerFile, [Text.Encoding]::UTF8) | ConvertFrom-Json }
  catch { return $false }
  return (
    [int]$metadata.schemaVersion -eq 1 -and
    [string]$metadata.role -eq $Role -and
    [int]$metadata.pid -eq [int]$Process.ProcessId -and
    (Test-OmiPathEqual -Left ([string]$metadata.executablePath) -Right ([string]$Process.ExecutablePath)) -and
    -not [string]::IsNullOrWhiteSpace([string]$Process.StartTimeUtc) -and
    [string]$metadata.startTimeUtc -eq [string]$Process.StartTimeUtc -and
    [string]$metadata.identity -eq [string]$definition.identity
  )
}

function Test-OmiRoleReady {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("server", "tunnel")][string]$Role
  )
  if ($Role -eq "server") { return (Test-OmiServerHealth -Context $Context) }
  return (Test-OmiTunnelReady -Context $Context)
}

function Resolve-OmiRoleOwnership {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("server", "tunnel")][string]$Role,
    [switch]$AdoptLegacyExactListener
  )
  $definition = Get-OmiRoleDefinition -Context $Context -Role $Role
  $managedPid = Read-OmiPidFile -Path $definition.pidFile
  $managedProcess = $null
  if ($null -ne $managedPid) {
    $managedProcess = Get-OmiProcess -ProcessId $managedPid
    if ($null -eq $managedProcess) {
      Remove-OmiRuntimeFile -Path $definition.pidFile -ExpectedPid $managedPid
      Remove-OmiRuntimeFile -Path $definition.ownerFile
      $managedPid = $null
    }
    elseif (-not (Test-OmiExecutableIdentity -Context $Context -Role $Role -Process $managedProcess)) {
      return [pscustomobject]@{ role=$Role; state="OwnershipMismatch"; pid=$managedPid; listenerPid=$null; reason="pid_process_mismatch"; canMutate=$false; adopted=$false }
    }
  }

  $listener = Get-OmiListenerState -Port $definition.port
  if (-not $listener.known) {
    return [pscustomobject]@{ role=$Role; state="OwnershipUnknown"; pid=$managedPid; listenerPid=$null; reason=$listener.errorCode; canMutate=$false; adopted=$false }
  }
  if ($listener.pids.Count -gt 1) {
    return [pscustomobject]@{ role=$Role; state="OwnershipMismatch"; pid=$managedPid; listenerPid=$null; reason="multiple_listener_owners"; canMutate=$false; adopted=$false }
  }
  $listenerPid = if ($listener.pids.Count -eq 1) { [int]$listener.pids[0] } else { $null }

  if ($null -ne $managedPid) {
    if ($null -ne $listenerPid -and $listenerPid -ne $managedPid) {
      return [pscustomobject]@{ role=$Role; state="OwnershipMismatch"; pid=$managedPid; listenerPid=$listenerPid; reason="managed_pid_not_listener"; canMutate=$false; adopted=$false }
    }
    $metadataValid = Test-OmiOwnerMetadata -Context $Context -Role $Role -Process $managedProcess
    if (-not $metadataValid) {
      if (-not $AdoptLegacyExactListener -or
          $null -eq $listenerPid -or
          -not (Test-OmiRoleReady -Context $Context -Role $Role) -or
          -not (Test-OmiLegacyCommandIdentity -Context $Context -Role $Role -Process $managedProcess)) {
        return [pscustomobject]@{ role=$Role; state="OwnershipMismatch"; pid=$managedPid; listenerPid=$listenerPid; reason="owner_metadata_missing_or_stale"; canMutate=$false; adopted=$false }
      }
      Write-OmiOwnerMetadata -Context $Context -Role $Role -Process $managedProcess
      $metadataValid = $true
    }
    if ($null -eq $listenerPid) {
      return [pscustomobject]@{ role=$Role; state="OwnedNotListening"; pid=$managedPid; listenerPid=$null; reason=$null; canMutate=$true; adopted=$false }
    }
    return [pscustomobject]@{ role=$Role; state="OwnedReady"; pid=$managedPid; listenerPid=$listenerPid; reason=$null; canMutate=$true; adopted=[bool]$AdoptLegacyExactListener }
  }

  if ($null -eq $listenerPid) {
    return [pscustomobject]@{ role=$Role; state="Stopped"; pid=$null; listenerPid=$null; reason=$null; canMutate=$true; adopted=$false }
  }
  $listenerProcess = Get-OmiProcess -ProcessId $listenerPid
  if ($null -eq $listenerProcess -or
      -not (Test-OmiExecutableIdentity -Context $Context -Role $Role -Process $listenerProcess) -or
      -not (Test-OmiRoleReady -Context $Context -Role $Role)) {
    return [pscustomobject]@{ role=$Role; state="OwnershipMismatch"; pid=$null; listenerPid=$listenerPid; reason="foreign_listener"; canMutate=$false; adopted=$false }
  }
  if (-not $AdoptLegacyExactListener -or -not (Test-OmiLegacyCommandIdentity -Context $Context -Role $Role -Process $listenerProcess)) {
    return [pscustomobject]@{ role=$Role; state="OwnershipMismatch"; pid=$null; listenerPid=$listenerPid; reason="unmanaged_listener"; canMutate=$false; adopted=$false }
  }
  Write-OmiAtomicText -Path $definition.pidFile -Value ([string]$listenerPid)
  Write-OmiOwnerMetadata -Context $Context -Role $Role -Process $listenerProcess
  return [pscustomobject]@{ role=$Role; state="OwnedReady"; pid=$listenerPid; listenerPid=$listenerPid; reason=$null; canMutate=$true; adopted=$true }
}

function Get-OmiSearchRuntimeStatus {
  param([Parameter(Mandatory = $true)]$Context, [switch]$AdoptLegacyExactListeners)
  $serverOwner = Resolve-OmiRoleOwnership -Context $Context -Role server -AdoptLegacyExactListener:$AdoptLegacyExactListeners
  $tunnelOwner = Resolve-OmiRoleOwnership -Context $Context -Role tunnel -AdoptLegacyExactListener:$AdoptLegacyExactListeners
  $serverHealthy = Test-OmiServerHealth -Context $Context
  $tunnelReady = Test-OmiTunnelReady -Context $Context
  $upstreamReady = Test-OmiUpstreamReady -Context $Context
  $ownerStates = @($serverOwner.state, $tunnelOwner.state)
  $status = if (@($ownerStates | Where-Object { $_ -in @("OwnershipMismatch", "OwnershipUnknown") }).Count -gt 0) {
    "OwnershipMismatch"
  }
  elseif (-not $serverHealthy -and $serverOwner.state -eq "Stopped" -and $tunnelOwner.state -eq "Stopped") { "Stopped" }
  elseif (-not $serverHealthy) { "Unhealthy" }
  elseif (-not $tunnelReady) { "Degraded" }
  elseif (-not $upstreamReady) { "BlockedUpstream" }
  else { "Ready" }
  return [pscustomobject]@{
    status = $status
    server = [pscustomobject]@{ healthy=$serverHealthy; ownership=$serverOwner.state; pid=$serverOwner.pid; listenerPid=$serverOwner.listenerPid; adopted=$serverOwner.adopted }
    tunnel = [pscustomobject]@{ ready=$tunnelReady; ownership=$tunnelOwner.state; pid=$tunnelOwner.pid; listenerPid=$tunnelOwner.listenerPid; adopted=$tunnelOwner.adopted }
    dependency = [pscustomobject]@{ ready=$upstreamReady; owned=$false }
    ownedPids = @(@($serverOwner.pid, $tunnelOwner.pid) | Where-Object { $null -ne $_ } | ForEach-Object { [int]$_ } | Sort-Object -Unique)
  }
}

function Wait-OmiCondition {
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

function Start-OmiChildProcess {
  param(
    [Parameter(Mandatory = $true)]$StartInfo,
    [Parameter(Mandatory = $true)][hashtable]$Environment
  )
  $overrides = @{}
  foreach ($name in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")) { $overrides[$name] = $null }
  $overrides["NO_PROXY"] = "127.0.0.1,localhost"
  $overrides["no_proxy"] = "127.0.0.1,localhost"
  foreach ($entry in $Environment.GetEnumerator()) { $overrides[[string]$entry.Key] = $entry.Value }
  $previous = @{}
  try {
    foreach ($entry in $overrides.GetEnumerator()) {
      $name = [string]$entry.Key
      $previous[$name] = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)
      [Environment]::SetEnvironmentVariable($name, $entry.Value, [EnvironmentVariableTarget]::Process)
    }
    return [Diagnostics.Process]::Start($StartInfo)
  }
  finally {
    foreach ($entry in $previous.GetEnumerator()) {
      [Environment]::SetEnvironmentVariable([string]$entry.Key, $entry.Value, [EnvironmentVariableTarget]::Process)
    }
  }
}

function Test-OmiBackendUrl {
  param([string]$BaseUrl)
  if ([string]::IsNullOrWhiteSpace($BaseUrl)) { return $false }
  try {
    $uri = [Uri]$BaseUrl
    if ($uri.Scheme -ne "http" -or $uri.Host -notin @("127.0.0.1", "localhost", "::1", "[::1]")) { return $false }
    $health = Invoke-RestMethod -UseBasicParsing -Uri "$($BaseUrl.TrimEnd('/'))/api/system/health" -TimeoutSec 2
    return ($health.status -eq "ok" -and $health.app_name -eq "Open Market Intelligence")
  }
  catch { return $false }
}

function Get-OmiLauncherBackendCandidates {
  $launcherRoot = "C:\project\Open Market Intelligence\logs\launcher"
  if (-not (Test-Path -LiteralPath $launcherRoot -PathType Container)) { return @() }
  $candidates = New-Object Collections.Generic.List[string]
  foreach ($file in @(Get-ChildItem -LiteralPath $launcherRoot -Recurse -File -Filter "launcher.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 5)) {
    try { $lines = Get-Content -LiteralPath $file.FullName -Encoding UTF8 -Tail 200 -ErrorAction Stop }
    catch { continue }
    for ($index = $lines.Count - 1; $index -ge 0; $index--) {
      foreach ($pattern in @("selected=(http://127\.0\.0\.1:\d+)", "Starting backend .* on (http://127\.0\.0\.1:\d+)")) {
        if ($lines[$index] -match $pattern) {
          $candidate = $matches[1].TrimEnd('/')
          if (-not $candidates.Contains($candidate)) { $candidates.Add($candidate) | Out-Null }
        }
      }
    }
  }
  return @($candidates)
}

function Resolve-OmiBackendUrl {
  param([Parameter(Mandatory = $true)]$Context)
  $candidates = New-Object Collections.Generic.List[string]
  $rawCandidates = if ($Context.strictOmiApiBaseUrl) {
    @($Context.preferredOmiApiBaseUrl)
  }
  else {
    @($Context.preferredOmiApiBaseUrl, $env:OMI_SEARCH_API_BASE_URL) + @(Get-OmiLauncherBackendCandidates) + @("http://127.0.0.1:8400", "http://127.0.0.1:8560")
  }
  foreach ($candidate in $rawCandidates) {
    $normalized = ([string]$candidate).Trim().TrimEnd('/')
    if (-not [string]::IsNullOrWhiteSpace($normalized) -and -not $candidates.Contains($normalized)) { $candidates.Add($normalized) | Out-Null }
  }
  foreach ($candidate in $candidates) {
    if (Test-OmiBackendUrl -BaseUrl $candidate) { return $candidate }
  }
  return ([string]$Context.preferredOmiApiBaseUrl).Trim().TrimEnd('/')
}

function Stop-OmiOwnedRole {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("server", "tunnel")][string]$Role
  )
  $definition = Get-OmiRoleDefinition -Context $Context -Role $Role
  $ownership = Resolve-OmiRoleOwnership -Context $Context -Role $Role
  if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot stop $Role because ownership is $($ownership.state)." }
  if ($ownership.state -eq "Stopped") { return }
  $process = Get-OmiProcess -ProcessId ([int]$ownership.pid)
  if ($null -eq $process -or -not (Test-OmiExecutableIdentity -Context $Context -Role $Role -Process $process) -or -not (Test-OmiOwnerMetadata -Context $Context -Role $Role -Process $process)) {
    throw "OWNERSHIP_MISMATCH: $Role PID changed before stop."
  }
  Stop-Process -Id ([int]$ownership.pid) -Force -ErrorAction Stop
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ((Get-Process -Id ([int]$ownership.pid) -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (Get-Process -Id ([int]$ownership.pid) -ErrorAction SilentlyContinue) { throw "STOP_TIMEOUT: $Role did not exit." }
  Remove-OmiRuntimeFile -Path $definition.pidFile -ExpectedPid ([int]$ownership.pid)
  Remove-OmiRuntimeFile -Path $definition.ownerFile
}

function Start-OmiServer {
  param([Parameter(Mandatory = $true)]$Context)
  $ownership = Resolve-OmiRoleOwnership -Context $Context -Role server
  if (Test-OmiServerHealth -Context $Context) {
    if ($ownership.canMutate -and $ownership.state -eq "OwnedReady") { return }
    throw "OWNERSHIP_MISMATCH: Healthy adapter server is not controller-owned."
  }
  if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot start server while ownership is $($ownership.state)." }
  if ($ownership.state -eq "OwnedNotListening") { Stop-OmiOwnedRole -Context $Context -Role server }
  foreach ($required in @($Context.pythonPath, $Context.httpEntry, $Context.serverEntry, $Context.contractSnapshot)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "SERVER_ENTRY_MISSING: Adapter source is incomplete." }
  }
  $resolvedBackend = Resolve-OmiBackendUrl -Context $Context
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Context.pythonPath
  $startInfo.Arguments = "-B `"$($Context.httpEntry)`" --host $($Context.hostName) --port $($Context.port)"
  $startInfo.WorkingDirectory = $Context.projectRoot
  $startInfo.UseShellExecute = $true
  $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $serverEnvironment = @{
    OMI_SEARCH_API_BASE_URL = $resolvedBackend
    OMI_SEARCH_MCP_HTTP_HOST = $Context.hostName
    OMI_SEARCH_MCP_HTTP_PORT = [string]$Context.port
    OMI_SEARCH_MCP_HTTP_TOKEN = $(if ([string]::IsNullOrWhiteSpace($Context.token)) { $null } else { $Context.token })
  }
  $process = Start-OmiChildProcess -StartInfo $startInfo -Environment $serverEnvironment
  if ($null -eq $process) { throw "SERVER_START_FAILED: Python process did not start." }
  Write-OmiAtomicText -Path $Context.serverPidFile -Value ([string]$process.Id)
  $started = Get-OmiProcess -ProcessId $process.Id
  if ($null -eq $started) { throw "SERVER_START_FAILED: Started process is unavailable." }
  Write-OmiOwnerMetadata -Context $Context -Role server -Process $started
  if (-not (Wait-OmiCondition -TimeoutSeconds $Context.serverReadyTimeoutSeconds -Condition { Test-OmiServerHealth -Context $Context })) {
    $current = Get-OmiProcess -ProcessId $process.Id
    if ($null -ne $current -and (Test-OmiExecutableIdentity -Context $Context -Role server -Process $current) -and (Test-OmiOwnerMetadata -Context $Context -Role server -Process $current)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-OmiRuntimeFile -Path $Context.serverPidFile -ExpectedPid $process.Id
    Remove-OmiRuntimeFile -Path $Context.serverOwnerFile
    throw "SERVER_NOT_READY: Adapter did not reach its expected source build."
  }
  $readyOwner = Resolve-OmiRoleOwnership -Context $Context -Role server
  if (-not $readyOwner.canMutate -or $readyOwner.pid -ne $process.Id) { throw "OWNERSHIP_MISMATCH: Started server does not own the listener." }
}

function Start-OmiTunnelOnce {
  param([Parameter(Mandatory = $true)]$Context)
  if (-not (Test-OmiServerHealth -Context $Context)) { throw "SERVER_NOT_READY: Tunnel start requires the adapter core." }
  $ownership = Resolve-OmiRoleOwnership -Context $Context -Role tunnel
  if (Test-OmiTunnelReady -Context $Context) {
    if ($ownership.canMutate -and $ownership.state -eq "OwnedReady") { return }
    throw "OWNERSHIP_MISMATCH: Ready tunnel is not controller-owned."
  }
  if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot start tunnel while ownership is $($ownership.state)." }
  if ($ownership.state -eq "OwnedNotListening") { Stop-OmiOwnedRole -Context $Context -Role tunnel }
  if (-not (Test-Path -LiteralPath $Context.tunnelClientPath -PathType Leaf)) { throw "TUNNEL_CLIENT_MISSING: tunnel-client.exe is missing." }
  if (-not (Test-Path -LiteralPath $Context.tunnelProfilePath -PathType Leaf)) { throw "TUNNEL_PROFILE_MISSING: Tunnel profile is missing." }
  . $Context.keyStorePath
  Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $Context.projectRoot -SecretPath $Context.secretPath | Out-Null
  if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) { throw "TUNNEL_KEY_MISSING: Save the control-plane API key in the component UI." }
  New-Item -ItemType Directory -Force -Path $Context.runtimeDir | Out-Null
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Context.tunnelClientPath
  $startInfo.Arguments = "run --profile-dir `"$($Context.tunnelProfileDir)`" --profile `"$($Context.tunnelProfile)`" --log.file `"$($Context.tunnelLogFile)`" --pid.file `"$($Context.tunnelPidFile)`""
  $startInfo.WorkingDirectory = $Context.projectRoot
  $startInfo.UseShellExecute = $true
  $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $process = Start-OmiChildProcess -StartInfo $startInfo -Environment @{ CONTROL_PLANE_API_KEY = $env:CONTROL_PLANE_API_KEY }
  if ($null -eq $process) { throw "TUNNEL_START_FAILED: Tunnel process did not start." }
  Write-OmiAtomicText -Path $Context.tunnelPidFile -Value ([string]$process.Id)
  $started = Get-OmiProcess -ProcessId $process.Id
  if ($null -eq $started) { throw "TUNNEL_START_FAILED: Started tunnel is unavailable." }
  Write-OmiOwnerMetadata -Context $Context -Role tunnel -Process $started
}

function Repair-OmiConnectivity {
  param([Parameter(Mandatory = $true)]$Context)
  $server = Resolve-OmiRoleOwnership -Context $Context -Role server
  if (-not (Test-OmiServerHealth -Context $Context) -or -not $server.canMutate -or $server.state -ne "OwnedReady") {
    throw "SERVER_NOT_READY: Connectivity repair requires an owned adapter core."
  }
  $tunnel = Resolve-OmiRoleOwnership -Context $Context -Role tunnel
  if (Test-OmiTunnelReady -Context $Context) {
    if ($tunnel.canMutate -and $tunnel.state -eq "OwnedReady") { return }
    throw "OWNERSHIP_MISMATCH: Ready tunnel is not controller-owned."
  }
  if (-not $tunnel.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot repair tunnel while ownership is $($tunnel.state)." }
  if ($tunnel.state -eq "OwnedNotListening") { Stop-OmiOwnedRole -Context $Context -Role tunnel }
  foreach ($delaySeconds in @($Context.tunnelRecoveryDelaysSeconds)) {
    Start-OmiTunnelOnce -Context $Context
    if (Wait-OmiCondition -TimeoutSeconds ([int]$delaySeconds) -Condition { Test-OmiTunnelReady -Context $Context }) {
      $readyOwner = Resolve-OmiRoleOwnership -Context $Context -Role tunnel
      if ($readyOwner.canMutate -and $readyOwner.state -eq "OwnedReady") { return }
      throw "OWNERSHIP_MISMATCH: Tunnel listener is not owned by the started process."
    }
    Stop-OmiOwnedRole -Context $Context -Role tunnel
  }
  throw "TUNNEL_NOT_READY: Tunnel failed bounded recovery."
}

function Assert-OmiShutdownPreflight {
  param([Parameter(Mandatory = $true)]$Context)
  foreach ($role in @("tunnel", "server")) {
    $ownership = Resolve-OmiRoleOwnership -Context $Context -Role $role
    if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot mutate $role while ownership is $($ownership.state)." }
  }
}

function Invoke-OmiSearchLifecycleAction {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("EnsureRunning", "RepairConnectivity", "RestartCore", "ReloadRuntime", "ShutdownRuntime")][string]$Action
  )
  switch ($Action) {
    "EnsureRunning" { Start-OmiServer -Context $Context; Repair-OmiConnectivity -Context $Context }
    "RepairConnectivity" { Repair-OmiConnectivity -Context $Context }
    "RestartCore" {
      $server = Resolve-OmiRoleOwnership -Context $Context -Role server
      if (-not $server.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot restart core while ownership is $($server.state)." }
      if ($server.state -ne "Stopped") { Stop-OmiOwnedRole -Context $Context -Role server }
      Start-OmiServer -Context $Context
    }
    "ReloadRuntime" {
      Assert-OmiShutdownPreflight -Context $Context
      Stop-OmiOwnedRole -Context $Context -Role tunnel
      Stop-OmiOwnedRole -Context $Context -Role server
      Start-OmiServer -Context $Context
      Repair-OmiConnectivity -Context $Context
    }
    "ShutdownRuntime" {
      Assert-OmiShutdownPreflight -Context $Context
      Stop-OmiOwnedRole -Context $Context -Role tunnel
      Stop-OmiOwnedRole -Context $Context -Role server
    }
  }
}

function New-OmiSearchRuntimeContext {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$HostName = "127.0.0.1",
    [int]$Port = 8797,
    [string]$OmiApiBaseUrl = "http://127.0.0.1:8400",
    [switch]$StrictOmiApiBaseUrl,
    [string]$Token,
    [string]$PythonPath,
    [string]$TunnelClientPath = "C:\GPT_MCPtool\project_reading\vendor\tunnel-client\tunnel-client.exe",
    [string]$TunnelProfileDir,
    [string]$TunnelProfile = "omi-search",
    [string]$TunnelHealthUrl = "http://127.0.0.1:8799",
    [string]$KeyStorePath = "C:\GPT_MCPtool\project_reading\scripts\key-store.ps1",
    [string]$SecretPath,
    [int]$ServerReadyTimeoutSeconds = 20,
    [int[]]$TunnelRecoveryDelaysSeconds = @(15, 30, 60)
  )
  $resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path
  $runtimeDir = Join-Path $resolvedRoot ".tmp"
  if ([string]::IsNullOrWhiteSpace($PythonPath)) {
    $recordedPythonPath = $null
    $serverOwnerPath = Join-Path $runtimeDir "omi-search-http-server.owner.json"
    if (Test-Path -LiteralPath $serverOwnerPath -PathType Leaf) {
      try {
        $serverOwner = [IO.File]::ReadAllText($serverOwnerPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
        $candidate = [string]$serverOwner.executablePath
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $recordedPythonPath = $candidate }
      }
      catch { }
    }
    $PythonPath = if ([string]::IsNullOrWhiteSpace($recordedPythonPath)) { (Get-Command python -ErrorAction Stop).Source } else { $recordedPythonPath }
  }
  if ([string]::IsNullOrWhiteSpace($TunnelProfileDir)) { $TunnelProfileDir = Join-Path $resolvedRoot ".tunnel-client" }
  $healthUri = [Uri]$TunnelHealthUrl
  if ($HostName -notin @("127.0.0.1", "localhost", "::1", "[::1]") -or $healthUri.Host -notin @("127.0.0.1", "localhost", "::1", "[::1]")) {
    throw "Runtime endpoints must use loopback."
  }
  if ($ServerReadyTimeoutSeconds -lt 1 -or $ServerReadyTimeoutSeconds -gt 120) { throw "ServerReadyTimeoutSeconds must be between 1 and 120." }
  if (@($TunnelRecoveryDelaysSeconds).Count -lt 1 -or @($TunnelRecoveryDelaysSeconds).Count -gt 5 -or @($TunnelRecoveryDelaysSeconds | Where-Object { $_ -lt 1 -or $_ -gt 120 }).Count -gt 0) {
    throw "TunnelRecoveryDelaysSeconds must contain 1-5 values between 1 and 120."
  }
  return [pscustomobject]@{
    projectRoot = $resolvedRoot
    hostName = $HostName
    port = $Port
    preferredOmiApiBaseUrl = $OmiApiBaseUrl
    strictOmiApiBaseUrl = [bool]$StrictOmiApiBaseUrl
    token = $Token
    pythonPath = [IO.Path]::GetFullPath($PythonPath)
    httpEntry = Join-Path $resolvedRoot "http_server.py"
    serverEntry = Join-Path $resolvedRoot "server.py"
    contractSnapshot = Join-Path $resolvedRoot "public_contract_snapshot.json"
    healthUrl = "http://${HostName}:${Port}/health"
    upstreamHealthUrl = "http://${HostName}:${Port}/upstream-health"
    tunnelClientPath = [IO.Path]::GetFullPath($TunnelClientPath)
    tunnelProfileDir = [IO.Path]::GetFullPath($TunnelProfileDir)
    tunnelProfile = $TunnelProfile
    tunnelProfilePath = Join-Path ([IO.Path]::GetFullPath($TunnelProfileDir)) "$TunnelProfile.yaml"
    tunnelHealthUrl = $TunnelHealthUrl.TrimEnd('/')
    tunnelHealthPort = $(if ($healthUri.IsDefaultPort) { 80 } else { $healthUri.Port })
    runtimeDir = $runtimeDir
    serverPidFile = Join-Path $runtimeDir "omi-search-http-server.pid"
    serverOwnerFile = Join-Path $runtimeDir "omi-search-http-server.owner.json"
    tunnelPidFile = Join-Path $runtimeDir "tunnel-client.pid"
    tunnelOwnerFile = Join-Path $runtimeDir "tunnel-client.owner.json"
    tunnelLogFile = Join-Path $runtimeDir "tunnel-client.log"
    actionLogFile = Join-Path $runtimeDir "runtime-control.jsonl"
    keyStorePath = [IO.Path]::GetFullPath($KeyStorePath)
    secretPath = $SecretPath
    serverReadyTimeoutSeconds = $ServerReadyTimeoutSeconds
    tunnelRecoveryDelaysSeconds = @($TunnelRecoveryDelaysSeconds)
  }
}

function Write-OmiSearchLifecycleEvent {
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
  "New-OmiSearchRuntimeContext",
  "Get-OmiSearchRuntimeStatus",
  "Invoke-OmiSearchLifecycleAction",
  "Write-OmiSearchLifecycleEvent"
)
