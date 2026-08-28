Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$script:Utf8NoBom = New-Object Text.UTF8Encoding($false)

function Test-JsPathEqual {
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

function Write-JsAtomicText {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Value)
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

function Read-JsPidFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $parsed = 0
    if ([int]::TryParse(([IO.File]::ReadAllText($Path).Trim()), [ref]$parsed) -and $parsed -gt 0) { return $parsed }
  }
  catch { }
  return $null
}

function Remove-JsRuntimeFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

function Get-JsProcess {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    $executablePath = $null
    $startTimeUtc = $null
    try { $executablePath = [string]$process.Path } catch { $executablePath = [string]$cim.ExecutablePath }
    try { $startTimeUtc = $process.StartTime.ToUniversalTime().ToString('o') } catch { }
    return [pscustomobject]@{
      ProcessId = [int]$process.Id
      ParentProcessId = [int]$cim.ParentProcessId
      Name = [string]$cim.Name
      ExecutablePath = $executablePath
      StartTimeUtc = $startTimeUtc
      CommandLine = [string]$cim.CommandLine
    }
  }
  catch { return $null }
}

function Get-JsListenerPid {
  param([Parameter(Mandatory = $true)][int]$Port)
  $netstatPath = Join-Path $env:WINDIR 'System32\netstat.exe'
  if (Test-Path -LiteralPath $netstatPath -PathType Leaf) {
    foreach ($line in @(& $netstatPath -ano -p TCP 2>$null)) {
      if ([string]$line -match ("^\s*TCP\s+\S+:" + $Port + "\s+\S+\s+LISTENING\s+(\d+)\s*$")) {
        return [int]$matches[1]
      }
    }
    return $null
  }
  try {
    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -First 1
    if ($null -ne $connection) { return [int]$connection.OwningProcess }
  }
  catch { }
  return $null
}

function Test-JsCommandContains {
  param([string]$CommandLine, [string[]]$Fragments)
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  foreach ($fragment in @($Fragments)) {
    if ([string]::IsNullOrWhiteSpace($fragment)) { continue }
    if ($CommandLine.IndexOf($fragment, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  }
  return $true
}

function Get-JsLineage {
  param([int]$ProcessId, [int]$ExpectedAncestorProcessId)
  if ($ProcessId -eq $ExpectedAncestorProcessId) {
    return [pscustomobject]@{ known = $true; matches = $true; depth = 0 }
  }
  $current = $ProcessId
  for ($depth = 0; $depth -lt 32; $depth++) {
    $process = Get-JsProcess -ProcessId $current
    if ($null -eq $process -or $process.ParentProcessId -le 0 -or $process.ParentProcessId -eq $current) {
      return [pscustomobject]@{ known = ($null -ne $process); matches = $false; depth = $null }
    }
    if ($process.ParentProcessId -eq $ExpectedAncestorProcessId) {
      return [pscustomobject]@{ known = $true; matches = $true; depth = ($depth + 1) }
    }
    $current = [int]$process.ParentProcessId
  }
  return [pscustomobject]@{ known = $false; matches = $false; depth = $null }
}

function Wait-JsCondition {
  param([Parameter(Mandatory = $true)][scriptblock]$Condition, [int]$TimeoutSeconds = 20)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (& $Condition) { return $true }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

function Invoke-JsJsonHealth {
  param([Parameter(Mandatory = $true)][string]$Url)
  try { return Invoke-RestMethod -UseBasicParsing -Uri $Url -TimeoutSec 2 }
  catch { return $null }
}

function Get-JsExpectedBuildId {
  param($Context)
  if (-not [string]::IsNullOrWhiteSpace([string]$Context.expectedBuildId)) { return [string]$Context.expectedBuildId }
  $artifactHashes = @()
  foreach ($artifact in @($Context.mcpBuildArtifacts)) {
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) { return '' }
    $artifactHashes += (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($artifactHashes -join ''))
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try { return (-join ($sha256.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })).Substring(0, 16) }
  finally { $sha256.Dispose() }
}

function Test-JsBuildCurrent {
  param($Context)
  if (-not (Test-Path -LiteralPath $Context.mcpEntry -PathType Leaf)) { return $false }
  if (-not [string]::IsNullOrWhiteSpace([string]$Context.expectedBuildId)) { return $true }
  $sources = @(Get-ChildItem -LiteralPath (Join-Path $Context.projectRoot 'src') -Filter '*.ts' -File -Recurse -ErrorAction SilentlyContinue)
  if ($sources.Count -eq 0) { return $false }
  $latestSource = $sources | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  return (Get-Item -LiteralPath $Context.mcpEntry).LastWriteTimeUtc -ge $latestSource.LastWriteTimeUtc
}

function Test-JsHubHealth {
  param($Context)
  $health = Invoke-JsJsonHealth -Url $Context.hubHealthUrl
  return ($null -ne $health -and $health.ok -eq $true -and [string]$health.service -eq 'japanese-study-hub')
}

function Test-JsMcpHealth {
  param($Context)
  $health = Invoke-JsJsonHealth -Url $Context.mcpHealthUrl
  return (
    $null -ne $health -and $health.ok -eq $true -and
    [string]$health.service -eq 'japanese-study-mcp' -and
    [string]$health.version -eq $Context.expectedMcpVersion -and
    [string]$health.contractVersion -eq $Context.expectedContractVersion -and
    [int]$health.toolCount -eq $Context.expectedToolCount -and
    [string]$health.buildId -eq (Get-JsExpectedBuildId -Context $Context)
  )
}

function Test-JsTunnelReady {
  param($Context)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$($Context.tunnelHealthUrl)/readyz" -TimeoutSec 2
    return ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300 -and $response.Content.Trim() -in @('ready', 'ok'))
  }
  catch { return $false }
}

function Get-JsRoleDefinition {
  param($Context, [ValidateSet('hub', 'mcp', 'tunnel')][string]$Role)
  switch ($Role) {
    'hub' {
      return [pscustomobject]@{
        pidFile = $Context.hubPidFile; ownerFile = $Context.hubOwnerFile; port = $Context.hubPort
        executablePath = $Context.uvPath; identity = $Context.hubIdentity
      }
    }
    'mcp' {
      return [pscustomobject]@{
        pidFile = $Context.mcpPidFile; ownerFile = $Context.mcpOwnerFile; port = $Context.mcpPort
        executablePath = $Context.nodePath; identity = $Context.mcpIdentity
      }
    }
    default {
      return [pscustomobject]@{
        pidFile = $Context.tunnelPidFile; ownerFile = $Context.tunnelOwnerFile; port = $Context.tunnelHealthPort
        executablePath = $Context.tunnelClientPath; identity = $Context.tunnelIdentity
      }
    }
  }
}

function Test-JsProcessIdentity {
  param($Context, [ValidateSet('hub', 'mcp', 'tunnel')][string]$Role, $Process)
  $definition = Get-JsRoleDefinition -Context $Context -Role $Role
  return (
    $null -ne $Process -and
    (Test-JsPathEqual -Left $Process.ExecutablePath -Right $definition.executablePath) -and
    (Test-JsCommandContains -CommandLine $Process.CommandLine -Fragments @($definition.identity))
  )
}

function Read-JsOwnerMetadata {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json }
  catch { return $null }
}

function Test-JsOwnerMetadata {
  param($Context, [ValidateSet('hub', 'mcp', 'tunnel')][string]$Role, $Process, $Metadata)
  if ($null -eq $Process -or $null -eq $Metadata) { return $false }
  $definition = Get-JsRoleDefinition -Context $Context -Role $Role
  return (
    [int]$Metadata.pid -eq [int]$Process.ProcessId -and
    (Test-JsPathEqual -Left ([string]$Metadata.executablePath) -Right $definition.executablePath) -and
    (Test-JsPathEqual -Left $Process.ExecutablePath -Right $definition.executablePath) -and
    [string]$Metadata.startTimeUtc -eq [string]$Process.StartTimeUtc -and
    [string]$Metadata.identity -eq [string]$definition.identity -and
    (Test-JsCommandContains -CommandLine $Process.CommandLine -Fragments @($definition.identity))
  )
}

function Write-JsOwnerMetadata {
  param($Context, [ValidateSet('hub', 'mcp', 'tunnel')][string]$Role, $Process)
  $definition = Get-JsRoleDefinition -Context $Context -Role $Role
  $metadata = [ordered]@{
    schemaVersion = 1; role = $Role; pid = [int]$Process.ProcessId
    executablePath = [string]$Process.ExecutablePath; startTimeUtc = [string]$Process.StartTimeUtc
    identity = [string]$definition.identity; recordedAt = [DateTime]::UtcNow.ToString('o')
  }
  Write-JsAtomicText -Path $definition.pidFile -Value ([string]$Process.ProcessId)
  Write-JsAtomicText -Path $definition.ownerFile -Value ($metadata | ConvertTo-Json -Compress)
}

function Find-JsLegacyRootProcess {
  param($Context, [ValidateSet('hub', 'mcp', 'tunnel')][string]$Role, [int]$ListenerPid)
  $current = $ListenerPid
  for ($depth = 0; $depth -lt 16; $depth++) {
    $process = Get-JsProcess -ProcessId $current
    if ($null -eq $process) { return $null }
    if (Test-JsProcessIdentity -Context $Context -Role $Role -Process $process) { return $process }
    if ($process.ParentProcessId -le 0 -or $process.ParentProcessId -eq $current) { return $null }
    $current = [int]$process.ParentProcessId
  }
  return $null
}

function Resolve-JsRoleOwnership {
  param($Context, [ValidateSet('hub', 'mcp', 'tunnel')][string]$Role, [switch]$AdoptLegacyExactListener)
  $definition = Get-JsRoleDefinition -Context $Context -Role $Role
  $managedPid = Read-JsPidFile -Path $definition.pidFile
  $managedProcess = if ($null -eq $managedPid) { $null } else { Get-JsProcess -ProcessId $managedPid }
  $metadata = Read-JsOwnerMetadata -Path $definition.ownerFile
  $listenerPid = Get-JsListenerPid -Port $definition.port
  $listenerProcess = if ($null -eq $listenerPid) { $null } else { Get-JsProcess -ProcessId $listenerPid }

  if ($null -eq $managedProcess -and $null -ne $managedPid) {
    Remove-JsRuntimeFile -Path $definition.pidFile
    Remove-JsRuntimeFile -Path $definition.ownerFile
    $managedPid = $null
    $metadata = $null
  }

  if ($null -eq $listenerProcess -and $null -eq $managedProcess) {
    return [pscustomobject]@{ state = 'Stopped'; canMutate = $true; managedPid = $null; listenerPid = $null; relation = $null }
  }

  if ($null -ne $managedProcess -and (Test-JsOwnerMetadata -Context $Context -Role $Role -Process $managedProcess -Metadata $metadata)) {
    if ($null -eq $listenerProcess) {
      return [pscustomobject]@{ state = 'OwnedNotListening'; canMutate = $true; managedPid = [int]$managedProcess.ProcessId; listenerPid = $null; relation = $null }
    }
    $lineage = Get-JsLineage -ProcessId ([int]$listenerProcess.ProcessId) -ExpectedAncestorProcessId ([int]$managedProcess.ProcessId)
    if ($lineage.known -and $lineage.matches) {
      return [pscustomobject]@{
        state = 'OwnedReady'; canMutate = $true; managedPid = [int]$managedProcess.ProcessId
        listenerPid = [int]$listenerProcess.ProcessId; relation = $(if ([int]$lineage.depth -eq 0) { 'Self' } else { 'Descendant' })
      }
    }
    return [pscustomobject]@{ state = 'OwnershipMismatch'; canMutate = $false; managedPid = [int]$managedProcess.ProcessId; listenerPid = [int]$listenerProcess.ProcessId; relation = 'Unrelated' }
  }

  if ($AdoptLegacyExactListener -and $null -ne $listenerProcess) {
    $root = Find-JsLegacyRootProcess -Context $Context -Role $Role -ListenerPid ([int]$listenerProcess.ProcessId)
    if ($null -ne $root) {
      Write-JsOwnerMetadata -Context $Context -Role $Role -Process $root
      return Resolve-JsRoleOwnership -Context $Context -Role $Role
    }
  }

  return [pscustomobject]@{
    state = 'OwnershipMismatch'; canMutate = $false
    managedPid = if ($null -eq $managedProcess) { $null } else { [int]$managedProcess.ProcessId }
    listenerPid = if ($null -eq $listenerProcess) { $null } else { [int]$listenerProcess.ProcessId }
    relation = 'Unknown'
  }
}

function Get-JsOwnedDescendants {
  param([Parameter(Mandatory = $true)][int]$RootPid)
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $byPid = @{}
  foreach ($process in $all) { $byPid[[int]$process.ProcessId] = $process }
  $rows = @()
  foreach ($process in $all) {
    $current = [int]$process.ProcessId
    for ($depth = 0; $depth -lt 32; $depth++) {
      if ($current -eq $RootPid) {
        $rows += [pscustomobject]@{ ProcessId = [int]$process.ProcessId; Depth = $depth }
        break
      }
      if (-not $byPid.ContainsKey($current)) { break }
      $parent = [int]$byPid[$current].ParentProcessId
      if ($parent -le 0 -or $parent -eq $current) { break }
      $current = $parent
    }
  }
  return @($rows | Sort-Object -Property @{ Expression = 'Depth'; Descending = $true }, @{ Expression = 'ProcessId'; Descending = $true })
}

function Stop-JsOwnedRole {
  param($Context, [ValidateSet('hub', 'mcp', 'tunnel')][string]$Role)
  $definition = Get-JsRoleDefinition -Context $Context -Role $Role
  $ownership = Resolve-JsRoleOwnership -Context $Context -Role $Role
  if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot stop $Role while ownership is $($ownership.state)." }
  if ($ownership.state -eq 'Stopped') { return }
  $rootPid = [int]$ownership.managedPid
  foreach ($entry in @(Get-JsOwnedDescendants -RootPid $rootPid)) {
    if ([int]$entry.ProcessId -eq $PID) { throw 'OWNERSHIP_MISMATCH: Refusing to stop the lifecycle controller.' }
    Stop-Process -Id ([int]$entry.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  try { Wait-Process -Id $rootPid -Timeout 5 -ErrorAction SilentlyContinue } catch { }
  if ($null -ne (Get-JsProcess -ProcessId $rootPid)) { throw "STOP_FAILED: $Role PID $rootPid did not exit." }
  Remove-JsRuntimeFile -Path $definition.pidFile
  Remove-JsRuntimeFile -Path $definition.ownerFile
}

function Start-JsChildProcess {
  param([Parameter(Mandatory = $true)]$StartInfo, [hashtable]$Environment = @{})
  $overrides = @{}
  foreach ($name in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy')) { $overrides[$name] = $null }
  $overrides['NO_PROXY'] = '127.0.0.1,localhost'; $overrides['no_proxy'] = '127.0.0.1,localhost'
  foreach ($name in $Environment.Keys) { $overrides[[string]$name] = $Environment[$name] }
  $saved = @{}
  try {
    foreach ($name in $overrides.Keys) {
      $saved[$name] = [Environment]::GetEnvironmentVariable([string]$name, 'Process')
      [Environment]::SetEnvironmentVariable([string]$name, $overrides[$name], 'Process')
    }
    return [Diagnostics.Process]::Start($StartInfo)
  }
  finally {
    foreach ($name in $overrides.Keys) { [Environment]::SetEnvironmentVariable([string]$name, $saved[$name], 'Process') }
  }
}

function Start-JsHub {
  param($Context)
  $ownership = Resolve-JsRoleOwnership -Context $Context -Role hub
  if (Test-JsHubHealth -Context $Context) {
    if ($ownership.state -eq 'OwnedReady') { return }
    throw 'OWNERSHIP_MISMATCH: Healthy Hub is not controller-owned.'
  }
  if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot start Hub while ownership is $($ownership.state)." }
  if ($ownership.state -eq 'OwnedNotListening') { Stop-JsOwnedRole -Context $Context -Role hub }
  foreach ($required in @($Context.uvPath, $Context.hubPyproject)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'HUB_ENTRY_MISSING: Hub runtime is incomplete.' }
  }
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Context.uvPath; $startInfo.Arguments = $Context.hubArguments
  $startInfo.WorkingDirectory = $Context.hubRoot; $startInfo.UseShellExecute = $true
  $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $process = Start-JsChildProcess -StartInfo $startInfo -Environment @{ PYTHONUTF8 = '1'; JSTUDY_API_HOST = $Context.hostName; JSTUDY_API_PORT = [string]$Context.hubPort }
  if ($null -eq $process) { throw 'HUB_START_FAILED: Hub runner did not start.' }
  $started = Get-JsProcess -ProcessId $process.Id
  if ($null -eq $started) { throw 'HUB_START_FAILED: Started Hub runner is unavailable.' }
  Write-JsOwnerMetadata -Context $Context -Role hub -Process $started
  if (-not (Wait-JsCondition -TimeoutSeconds $Context.coreReadyTimeoutSeconds -Condition { Test-JsHubHealth -Context $Context })) {
    Stop-JsOwnedRole -Context $Context -Role hub
    throw 'HUB_NOT_READY: Hub failed bounded startup.'
  }
  $ready = Resolve-JsRoleOwnership -Context $Context -Role hub
  if ($ready.state -ne 'OwnedReady') { throw 'OWNERSHIP_MISMATCH: Hub listener is not a descendant of the started runner.' }
}

function Start-JsMcp {
  param($Context)
  if (-not (Test-JsHubHealth -Context $Context)) { throw 'HUB_NOT_READY: MCP start requires the Hub.' }
  $ownership = Resolve-JsRoleOwnership -Context $Context -Role mcp
  if (Test-JsMcpHealth -Context $Context) {
    if ($ownership.state -eq 'OwnedReady') { return }
    throw 'OWNERSHIP_MISMATCH: Healthy MCP adapter is not controller-owned.'
  }
  if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot start MCP while ownership is $($ownership.state)." }
  if ($ownership.state -eq 'OwnedNotListening') { Stop-JsOwnedRole -Context $Context -Role mcp }
  if (-not (Test-JsBuildCurrent -Context $Context)) { throw 'BUILD_STALE: Run npm run build before starting Japanese Study MCP.' }
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Context.nodePath; $startInfo.Arguments = "`"$($Context.mcpEntry)`""
  $startInfo.WorkingDirectory = $Context.projectRoot; $startInfo.UseShellExecute = $true
  $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $process = Start-JsChildProcess -StartInfo $startInfo -Environment @{ JSTUDY_HUB_BASE_URL = $Context.hubBaseUrl; JSTUDY_MCP_HOST = $Context.hostName; JSTUDY_MCP_PORT = [string]$Context.mcpPort }
  if ($null -eq $process) { throw 'MCP_START_FAILED: MCP adapter did not start.' }
  $started = Get-JsProcess -ProcessId $process.Id
  if ($null -eq $started) { throw 'MCP_START_FAILED: Started MCP adapter is unavailable.' }
  Write-JsOwnerMetadata -Context $Context -Role mcp -Process $started
  if (-not (Wait-JsCondition -TimeoutSeconds $Context.coreReadyTimeoutSeconds -Condition { Test-JsMcpHealth -Context $Context })) {
    Stop-JsOwnedRole -Context $Context -Role mcp
    throw 'MCP_NOT_READY: MCP adapter failed bounded startup.'
  }
}

function Start-JsTunnelOnce {
  param($Context)
  if (-not (Test-JsMcpHealth -Context $Context)) { throw 'MCP_NOT_READY: Tunnel start requires the MCP adapter.' }
  $ownership = Resolve-JsRoleOwnership -Context $Context -Role tunnel
  if (Test-JsTunnelReady -Context $Context) {
    if ($ownership.state -eq 'OwnedReady') { return }
    throw 'OWNERSHIP_MISMATCH: Ready tunnel is not controller-owned.'
  }
  if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot start tunnel while ownership is $($ownership.state)." }
  if ($ownership.state -eq 'OwnedNotListening') { Stop-JsOwnedRole -Context $Context -Role tunnel }
  foreach ($required in @($Context.tunnelClientPath, $Context.tunnelProfilePath, $Context.keyStorePath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'TUNNEL_CONFIG_MISSING: Tunnel runtime is incomplete.' }
  }
  . $Context.keyStorePath
  $savedKey = [Environment]::GetEnvironmentVariable('CONTROL_PLANE_API_KEY', 'Process')
  if (-not (Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $Context.projectRoot -SecretPath $Context.secretPath)) {
    throw 'TUNNEL_KEY_MISSING: Tunnel runtime key is unavailable.'
  }
  New-Item -ItemType Directory -Force -Path $Context.runtimeDir | Out-Null
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Context.tunnelClientPath
  $startInfo.Arguments = $Context.tunnelArguments
  $startInfo.WorkingDirectory = $Context.projectRoot; $startInfo.UseShellExecute = $true
  $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  try { $process = Start-JsChildProcess -StartInfo $startInfo -Environment @{ CONTROL_PLANE_API_KEY = $env:CONTROL_PLANE_API_KEY } }
  finally { [Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY', $savedKey, 'Process') }
  if ($null -eq $process) { throw 'TUNNEL_START_FAILED: Tunnel process did not start.' }
  $started = Get-JsProcess -ProcessId $process.Id
  if ($null -eq $started) { throw 'TUNNEL_START_FAILED: Started tunnel is unavailable.' }
  Write-JsOwnerMetadata -Context $Context -Role tunnel -Process $started
}

function Repair-JsConnectivity {
  param($Context)
  foreach ($role in @('hub', 'mcp')) {
    $ownership = Resolve-JsRoleOwnership -Context $Context -Role $role
    if ($ownership.state -ne 'OwnedReady') { throw "CORE_NOT_READY: Connectivity repair requires owned $role runtime." }
  }
  $tunnel = Resolve-JsRoleOwnership -Context $Context -Role tunnel
  if (Test-JsTunnelReady -Context $Context) {
    if ($tunnel.state -eq 'OwnedReady') { return }
    throw 'OWNERSHIP_MISMATCH: Ready tunnel is not controller-owned.'
  }
  if (-not $tunnel.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot repair tunnel while ownership is $($tunnel.state)." }
  if ($tunnel.state -eq 'OwnedNotListening') { Stop-JsOwnedRole -Context $Context -Role tunnel }
  foreach ($delay in @($Context.tunnelRecoveryDelaysSeconds)) {
    Start-JsTunnelOnce -Context $Context
    if (Wait-JsCondition -TimeoutSeconds ([int]$delay) -Condition { Test-JsTunnelReady -Context $Context }) {
      $ready = Resolve-JsRoleOwnership -Context $Context -Role tunnel
      if ($ready.state -eq 'OwnedReady') { return }
      throw 'OWNERSHIP_MISMATCH: Tunnel listener is not owned by the started process.'
    }
    Stop-JsOwnedRole -Context $Context -Role tunnel
  }
  throw 'TUNNEL_NOT_READY: Tunnel failed bounded recovery.'
}

function Assert-JsMutationPreflight {
  param($Context, [string[]]$Roles)
  foreach ($role in @($Roles)) {
    $ownership = Resolve-JsRoleOwnership -Context $Context -Role $role
    if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot mutate $role while ownership is $($ownership.state)." }
  }
}

function Invoke-JapaneseStudyLifecycleAction {
  param($Context, [ValidateSet('EnsureRunning', 'RepairConnectivity', 'RestartCore', 'ReloadRuntime', 'ShutdownRuntime')][string]$Action)
  switch ($Action) {
    'EnsureRunning' { Start-JsHub -Context $Context; Start-JsMcp -Context $Context; Repair-JsConnectivity -Context $Context }
    'RepairConnectivity' { Repair-JsConnectivity -Context $Context }
    'RestartCore' {
      Assert-JsMutationPreflight -Context $Context -Roles @('hub', 'mcp')
      Stop-JsOwnedRole -Context $Context -Role mcp; Stop-JsOwnedRole -Context $Context -Role hub
      Start-JsHub -Context $Context; Start-JsMcp -Context $Context
    }
    'ReloadRuntime' {
      Assert-JsMutationPreflight -Context $Context -Roles @('hub', 'mcp', 'tunnel')
      Stop-JsOwnedRole -Context $Context -Role tunnel; Stop-JsOwnedRole -Context $Context -Role mcp; Stop-JsOwnedRole -Context $Context -Role hub
      Start-JsHub -Context $Context; Start-JsMcp -Context $Context; Repair-JsConnectivity -Context $Context
    }
    'ShutdownRuntime' {
      Assert-JsMutationPreflight -Context $Context -Roles @('hub', 'mcp', 'tunnel')
      Stop-JsOwnedRole -Context $Context -Role tunnel; Stop-JsOwnedRole -Context $Context -Role mcp; Stop-JsOwnedRole -Context $Context -Role hub
    }
  }
}

function Get-JapaneseStudyRuntimeStatus {
  param($Context, [switch]$AdoptLegacyExactListeners)
  $hub = Resolve-JsRoleOwnership -Context $Context -Role hub -AdoptLegacyExactListener:$AdoptLegacyExactListeners
  $mcp = Resolve-JsRoleOwnership -Context $Context -Role mcp -AdoptLegacyExactListener:$AdoptLegacyExactListeners
  $tunnel = Resolve-JsRoleOwnership -Context $Context -Role tunnel -AdoptLegacyExactListener:$AdoptLegacyExactListeners
  $hubHealthy = Test-JsHubHealth -Context $Context
  $mcpHealthy = Test-JsMcpHealth -Context $Context
  $tunnelReady = Test-JsTunnelReady -Context $Context
  $ownerships = @($hub, $mcp, $tunnel)
  $status = if (@($ownerships | Where-Object { $_.state -eq 'OwnershipMismatch' }).Count -gt 0) { 'OwnershipMismatch' }
    elseif ($hubHealthy -and $mcpHealthy -and $tunnelReady -and @($ownerships | Where-Object { $_.state -ne 'OwnedReady' }).Count -eq 0) { 'Ready' }
    elseif ($hubHealthy -and $mcpHealthy -and $hub.state -eq 'OwnedReady' -and $mcp.state -eq 'OwnedReady') { 'Degraded' }
    elseif (@($ownerships | Where-Object { $_.state -ne 'Stopped' }).Count -eq 0) { 'Stopped' }
    else { 'Unhealthy' }
  $ownedPids = @($ownerships | Where-Object { $_.state -like 'Owned*' -and $null -ne $_.managedPid } | ForEach-Object { [int]$_.managedPid } | Sort-Object -Unique)
  return [pscustomobject]@{
    status = $status
    hub = [pscustomobject]@{ healthy = $hubHealthy; ownership = $hub.state; pid = $hub.managedPid; listenerPid = $hub.listenerPid; relation = $hub.relation }
    mcp = [pscustomobject]@{ healthy = $mcpHealthy; ownership = $mcp.state; pid = $mcp.managedPid; listenerPid = $mcp.listenerPid; relation = $mcp.relation }
    tunnel = [pscustomobject]@{ ready = $tunnelReady; ownership = $tunnel.state; pid = $tunnel.managedPid; listenerPid = $tunnel.listenerPid; relation = $tunnel.relation }
    ownedPids = $ownedPids
  }
}

function New-JapaneseStudyRuntimeContext {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$HubRoot = 'C:\project\japanese-study-hub', [string]$HostName = '127.0.0.1', [int]$McpPort = 18790, [int]$HubPort = 18791,
    [string]$NodePath, [string]$UvPath, [string]$HubArguments = 'run python -m japanese_study_hub.cli serve', [string]$HubIdentity = 'japanese_study_hub.cli serve',
    [string]$TunnelClientPath, [string]$TunnelProfileDir, [string]$TunnelProfile = 'japanese-study', [string]$TunnelHealthUrl = 'http://127.0.0.1:18792',
    [string]$TunnelArguments, [string]$TunnelIdentity,
    [string]$KeyStorePath, [string]$SecretPath, [string]$ExpectedBuildId,
    [string]$ExpectedMcpVersion = '1.2.1', [string]$ExpectedContractVersion = 'learning-content-v8.1', [int]$ExpectedToolCount = 34,
    [int]$CoreReadyTimeoutSeconds = 20, [int[]]$TunnelRecoveryDelaysSeconds = @(15, 30, 60)
  )
  $root = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path
  $hub = (Resolve-Path -LiteralPath $HubRoot -ErrorAction Stop).Path
  $runtimeDir = Join-Path $root '.tmp'
  if ([string]::IsNullOrWhiteSpace($NodePath)) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
  if ([string]::IsNullOrWhiteSpace($UvPath)) { $UvPath = (Get-Command uv -ErrorAction Stop).Source }
  if ([string]::IsNullOrWhiteSpace($TunnelClientPath)) { $TunnelClientPath = Join-Path $root 'vendor\tunnel-client\tunnel-client.exe' }
  if ([string]::IsNullOrWhiteSpace($TunnelProfileDir)) { $TunnelProfileDir = Join-Path $root '.tunnel-client' }
  if ([string]::IsNullOrWhiteSpace($KeyStorePath)) { $KeyStorePath = Join-Path $root 'scripts\key-store.ps1' }
  if ([string]::IsNullOrWhiteSpace($SecretPath)) { $SecretPath = Join-Path $root '.secrets\control-plane-api-key.dpapi' }
  $tunnelUri = [Uri]$TunnelHealthUrl
  if ($HostName -notin @('127.0.0.1', 'localhost', '::1', '[::1]') -or $tunnelUri.Host -notin @('127.0.0.1', 'localhost', '::1', '[::1]')) { throw 'Runtime endpoints must use loopback.' }
  if ($CoreReadyTimeoutSeconds -lt 1 -or $CoreReadyTimeoutSeconds -gt 120) { throw 'CoreReadyTimeoutSeconds must be between 1 and 120.' }
  $mcpEntry = Join-Path $root 'dist\src\http-main.js'
  $profilePath = Join-Path ([IO.Path]::GetFullPath($TunnelProfileDir)) "$TunnelProfile.yaml"
  if ([string]::IsNullOrWhiteSpace($TunnelIdentity)) { $TunnelIdentity = $TunnelProfile }
  if ([string]::IsNullOrWhiteSpace($TunnelArguments)) {
    $TunnelArguments = "run --profile-dir `"$([IO.Path]::GetFullPath($TunnelProfileDir))`" --profile `"$TunnelProfile`" --log.file `"$(Join-Path $runtimeDir 'tunnel-client.log')`" --pid.file `"$(Join-Path $runtimeDir 'tunnel-client.pid')`""
  }
  return [pscustomobject]@{
    projectRoot = $root; hubRoot = $hub; hostName = $HostName; mcpPort = $McpPort; hubPort = $HubPort
    nodePath = [IO.Path]::GetFullPath($NodePath); uvPath = [IO.Path]::GetFullPath($UvPath)
    hubArguments = $HubArguments; hubIdentity = $HubIdentity; hubPyproject = Join-Path $hub 'pyproject.toml'
    mcpEntry = $mcpEntry; mcpIdentity = [IO.Path]::GetFileName($mcpEntry)
    mcpBuildArtifacts = @('api-client.js', 'config.js', 'http-server.js', 'server.js' | ForEach-Object { Join-Path $root "dist\src\$_" })
    hubBaseUrl = "http://${HostName}:${HubPort}"; hubHealthUrl = "http://${HostName}:${HubPort}/health"; mcpHealthUrl = "http://${HostName}:${McpPort}/health"
    expectedBuildId = $ExpectedBuildId; expectedMcpVersion = $ExpectedMcpVersion; expectedContractVersion = $ExpectedContractVersion; expectedToolCount = $ExpectedToolCount
    tunnelClientPath = [IO.Path]::GetFullPath($TunnelClientPath); tunnelProfileDir = [IO.Path]::GetFullPath($TunnelProfileDir); tunnelProfilePath = $profilePath
    tunnelHealthUrl = $TunnelHealthUrl.TrimEnd('/'); tunnelHealthPort = $(if ($tunnelUri.IsDefaultPort) { 80 } else { $tunnelUri.Port }); tunnelIdentity = $TunnelIdentity
    tunnelArguments = $TunnelArguments
    runtimeDir = $runtimeDir; hubPidFile = Join-Path $runtimeDir 'japanese-study-hub-runner.pid'; hubOwnerFile = Join-Path $runtimeDir 'japanese-study-hub-runner.owner.json'
    mcpPidFile = Join-Path $runtimeDir 'japanese-study-mcp.pid'; mcpOwnerFile = Join-Path $runtimeDir 'japanese-study-mcp.owner.json'
    tunnelPidFile = Join-Path $runtimeDir 'tunnel-client.pid'; tunnelOwnerFile = Join-Path $runtimeDir 'tunnel-client.owner.json'
    actionLogFile = Join-Path $runtimeDir 'runtime-control.jsonl'; keyStorePath = [IO.Path]::GetFullPath($KeyStorePath); secretPath = [IO.Path]::GetFullPath($SecretPath)
    coreReadyTimeoutSeconds = $CoreReadyTimeoutSeconds; tunnelRecoveryDelaysSeconds = @($TunnelRecoveryDelaysSeconds)
  }
}

function Write-JapaneseStudyLifecycleEvent {
  param($Context, [string]$Action, [bool]$Ok, [string]$BeforeStatus, [string]$AfterStatus, [int[]]$OwnedPids = @(), [int]$ElapsedMs, [string]$ErrorCode, [string]$Message)
  New-Item -ItemType Directory -Force -Path $Context.runtimeDir | Out-Null
  $event = [ordered]@{
    timestamp = [DateTime]::UtcNow.ToString('o'); action = $Action; ok = $Ok
    beforeStatus = $BeforeStatus; afterStatus = $AfterStatus; ownedPids = @($OwnedPids)
    elapsedMs = $ElapsedMs; errorCode = $ErrorCode; message = $Message
  }
  [IO.File]::AppendAllText($Context.actionLogFile, (($event | ConvertTo-Json -Compress -Depth 5) + [Environment]::NewLine), $script:Utf8NoBom)
}

Export-ModuleMember -Function @(
  'New-JapaneseStudyRuntimeContext', 'Get-JapaneseStudyRuntimeStatus',
  'Invoke-JapaneseStudyLifecycleAction', 'Write-JapaneseStudyLifecycleEvent'
)
