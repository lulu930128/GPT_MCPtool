Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$script:Utf8NoBom = New-Object Text.UTF8Encoding($false)

function Test-PaosPathEqual {
  param([string]$Left, [string]$Right)
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
  try {
    return [IO.Path]::GetFullPath($Left).TrimEnd('\').Equals(
      [IO.Path]::GetFullPath($Right).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase
    )
  }
  catch { return $false }
}

function Write-PaosAtomicText {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Value)
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary = "$Path.tmp.${PID}.$([Guid]::NewGuid().ToString('N'))"
  try {
    [IO.File]::WriteAllText($temporary, $Value, $script:Utf8NoBom)
    Move-Item -LiteralPath $temporary -Destination $Path -Force
  }
  finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
  }
}

function Read-PaosPidFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $parsed = 0
    if ([int]::TryParse(([IO.File]::ReadAllText($Path).Trim()), [ref]$parsed) -and $parsed -gt 0) { return $parsed }
  }
  catch { }
  return $null
}

function Remove-PaosRuntimeFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

function Get-PaosProcess {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    $executablePath = $null
    $startTimeUtc = $null
    try { $executablePath = [string]$process.Path } catch { $executablePath = [string]$cim.ExecutablePath }
    try { $startTimeUtc = $process.StartTime.ToUniversalTime().ToString('o') } catch { }
    return [pscustomobject]@{
      ProcessId = [int]$process.Id; ParentProcessId = [int]$cim.ParentProcessId; Name = [string]$cim.Name
      ExecutablePath = $executablePath; StartTimeUtc = $startTimeUtc; CommandLine = [string]$cim.CommandLine
    }
  }
  catch { return $null }
}

function Get-PaosListenerPid {
  param([Parameter(Mandatory = $true)][int]$Port)
  $netstatPath = Join-Path $env:WINDIR 'System32\netstat.exe'
  if (Test-Path -LiteralPath $netstatPath -PathType Leaf) {
    foreach ($line in @(& $netstatPath -ano -p TCP 2>$null)) {
      if ([string]$line -match ("^\s*TCP\s+\S+:" + $Port + "\s+\S+\s+LISTENING\s+(\d+)\s*$")) { return [int]$matches[1] }
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

function Test-PaosCommandContains {
  param([string]$CommandLine, [string[]]$Fragments)
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  foreach ($fragment in @($Fragments)) {
    if ([string]::IsNullOrWhiteSpace($fragment)) { continue }
    if ($CommandLine.IndexOf($fragment, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  }
  return $true
}

function Get-PaosLineage {
  param([int]$ProcessId, [int]$ExpectedAncestorProcessId)
  if ($ProcessId -eq $ExpectedAncestorProcessId) { return [pscustomobject]@{ known = $true; matches = $true; depth = 0 } }
  $current = $ProcessId
  for ($depth = 0; $depth -lt 32; $depth++) {
    $process = Get-PaosProcess -ProcessId $current
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

function Wait-PaosCondition {
  param([Parameter(Mandatory = $true)][scriptblock]$Condition, [int]$TimeoutSeconds = 20)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (& $Condition) { return $true }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

function Invoke-PaosJsonHealth {
  param([Parameter(Mandatory = $true)][string]$Url)
  try { return Invoke-RestMethod -UseBasicParsing -Uri $Url -TimeoutSec 2 }
  catch { return $null }
}

function Get-PaosExpectedBuildId {
  param($Context)
  if (-not [string]::IsNullOrWhiteSpace([string]$Context.expectedBuildId)) { return [string]$Context.expectedBuildId }
  if (-not (Test-Path -LiteralPath $Context.pythonPath -PathType Leaf)) { return '' }
  try {
    $value = & $Context.pythonPath -m personal_asset_os.cli build-id 2>$null
    if ($LASTEXITCODE -ne 0) { return '' }
    return ([string]$value).Trim()
  }
  catch { return '' }
}

function Test-PaosServerHealthy {
  param($Context)
  $health = Invoke-PaosJsonHealth -Url $Context.healthUrl
  $ready = Invoke-PaosJsonHealth -Url $Context.readyUrl
  return (
    $null -ne $health -and $health.ok -eq $true -and [string]$health.service -eq 'personal-asset-os' -and
    [string]$health.database -eq 'ready' -and [string]$health.buildId -eq (Get-PaosExpectedBuildId -Context $Context) -and
    $null -ne $ready -and $ready.ready -eq $true -and $ready.databaseReady -eq $true -and $ready.frontendReady -eq $true -and
    [string]$ready.buildId -eq (Get-PaosExpectedBuildId -Context $Context)
  )
}

function Test-PaosTunnelReady {
  param($Context)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$($Context.tunnelHealthUrl)/readyz" -TimeoutSec 2
    return ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300 -and $response.Content.Trim() -in @('ready', 'ok'))
  }
  catch { return $false }
}

function Get-PaosRoleDefinition {
  param($Context, [ValidateSet('server', 'tunnel')][string]$Role)
  if ($Role -eq 'server') {
    return [pscustomobject]@{ pidFile = $Context.serverPidFile; ownerFile = $Context.serverOwnerFile; port = $Context.port; executablePath = $Context.pythonPath; identity = $Context.serverIdentity }
  }
  return [pscustomobject]@{ pidFile = $Context.tunnelPidFile; ownerFile = $Context.tunnelOwnerFile; port = $Context.tunnelHealthPort; executablePath = $Context.tunnelClientPath; identity = $Context.tunnelIdentity }
}

function Test-PaosProcessIdentity {
  param($Context, [ValidateSet('server', 'tunnel')][string]$Role, $Process)
  $definition = Get-PaosRoleDefinition -Context $Context -Role $Role
  return ($null -ne $Process -and (Test-PaosPathEqual $Process.ExecutablePath $definition.executablePath) -and (Test-PaosCommandContains $Process.CommandLine @($definition.identity)))
}

function Read-PaosOwnerMetadata {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json }
  catch { return $null }
}

function Test-PaosOwnerMetadata {
  param($Context, [ValidateSet('server', 'tunnel')][string]$Role, $Process, $Metadata)
  if ($null -eq $Process -or $null -eq $Metadata) { return $false }
  $definition = Get-PaosRoleDefinition -Context $Context -Role $Role
  return (
    [int]$Metadata.pid -eq [int]$Process.ProcessId -and
    (Test-PaosPathEqual ([string]$Metadata.executablePath) $definition.executablePath) -and
    (Test-PaosPathEqual $Process.ExecutablePath $definition.executablePath) -and
    [string]$Metadata.startTimeUtc -eq [string]$Process.StartTimeUtc -and
    [string]$Metadata.identity -eq [string]$definition.identity -and
    (Test-PaosCommandContains $Process.CommandLine @($definition.identity))
  )
}

function Write-PaosOwnerMetadata {
  param($Context, [ValidateSet('server', 'tunnel')][string]$Role, $Process)
  $definition = Get-PaosRoleDefinition -Context $Context -Role $Role
  $metadata = [ordered]@{
    schemaVersion = 1; role = $Role; pid = [int]$Process.ProcessId; executablePath = [string]$Process.ExecutablePath
    startTimeUtc = [string]$Process.StartTimeUtc; identity = [string]$definition.identity; recordedAt = [DateTime]::UtcNow.ToString('o')
  }
  Write-PaosAtomicText -Path $definition.pidFile -Value ([string]$Process.ProcessId)
  Write-PaosAtomicText -Path $definition.ownerFile -Value ($metadata | ConvertTo-Json -Compress)
}

function Find-PaosLegacyRootProcess {
  param($Context, [ValidateSet('server', 'tunnel')][string]$Role, [int]$ListenerPid)
  $current = $ListenerPid
  for ($depth = 0; $depth -lt 16; $depth++) {
    $process = Get-PaosProcess -ProcessId $current
    if ($null -eq $process) { return $null }
    if (Test-PaosProcessIdentity -Context $Context -Role $Role -Process $process) { return $process }
    if ($process.ParentProcessId -le 0 -or $process.ParentProcessId -eq $current) { return $null }
    $current = [int]$process.ParentProcessId
  }
  return $null
}

function Resolve-PaosRoleOwnership {
  param($Context, [ValidateSet('server', 'tunnel')][string]$Role, [switch]$AdoptLegacyExactListener)
  $definition = Get-PaosRoleDefinition -Context $Context -Role $Role
  $managedPid = Read-PaosPidFile -Path $definition.pidFile
  $managedProcess = if ($null -eq $managedPid) { $null } else { Get-PaosProcess -ProcessId $managedPid }
  $metadata = Read-PaosOwnerMetadata -Path $definition.ownerFile
  $listenerPid = Get-PaosListenerPid -Port $definition.port
  $listenerProcess = if ($null -eq $listenerPid) { $null } else { Get-PaosProcess -ProcessId $listenerPid }

  if ($null -eq $managedProcess -and $null -ne $managedPid) {
    Remove-PaosRuntimeFile -Path $definition.pidFile
    Remove-PaosRuntimeFile -Path $definition.ownerFile
    $managedPid = $null; $metadata = $null
  }
  if ($null -eq $listenerProcess -and $null -eq $managedProcess) {
    return [pscustomobject]@{ state = 'Stopped'; canMutate = $true; managedPid = $null; listenerPid = $null; relation = $null }
  }
  if ($null -ne $managedProcess -and (Test-PaosOwnerMetadata -Context $Context -Role $Role -Process $managedProcess -Metadata $metadata)) {
    if ($null -eq $listenerProcess) {
      return [pscustomobject]@{ state = 'OwnedNotListening'; canMutate = $true; managedPid = [int]$managedProcess.ProcessId; listenerPid = $null; relation = $null }
    }
    $lineage = Get-PaosLineage -ProcessId ([int]$listenerProcess.ProcessId) -ExpectedAncestorProcessId ([int]$managedProcess.ProcessId)
    if ($lineage.known -and $lineage.matches) {
      return [pscustomobject]@{
        state = 'OwnedReady'; canMutate = $true; managedPid = [int]$managedProcess.ProcessId; listenerPid = [int]$listenerProcess.ProcessId
        relation = $(if ([int]$lineage.depth -eq 0) { 'Self' } else { 'Descendant' })
      }
    }
    return [pscustomobject]@{ state = 'OwnershipMismatch'; canMutate = $false; managedPid = [int]$managedProcess.ProcessId; listenerPid = [int]$listenerProcess.ProcessId; relation = 'Unrelated' }
  }
  if ($AdoptLegacyExactListener -and $null -ne $listenerProcess) {
    $root = Find-PaosLegacyRootProcess -Context $Context -Role $Role -ListenerPid ([int]$listenerProcess.ProcessId)
    if ($null -ne $root) {
      Write-PaosOwnerMetadata -Context $Context -Role $Role -Process $root
      return Resolve-PaosRoleOwnership -Context $Context -Role $Role
    }
  }
  return [pscustomobject]@{
    state = 'OwnershipMismatch'; canMutate = $false
    managedPid = if ($null -eq $managedProcess) { $null } else { [int]$managedProcess.ProcessId }
    listenerPid = if ($null -eq $listenerProcess) { $null } else { [int]$listenerProcess.ProcessId }
    relation = 'Unknown'
  }
}

function Get-PaosOwnedDescendants {
  param([Parameter(Mandatory = $true)][int]$RootPid)
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $byPid = @{}
  foreach ($process in $all) { $byPid[[int]$process.ProcessId] = $process }
  $rows = @()
  foreach ($process in $all) {
    $current = [int]$process.ProcessId
    for ($depth = 0; $depth -lt 32; $depth++) {
      if ($current -eq $RootPid) { $rows += [pscustomobject]@{ ProcessId = [int]$process.ProcessId; Depth = $depth }; break }
      if (-not $byPid.ContainsKey($current)) { break }
      $parent = [int]$byPid[$current].ParentProcessId
      if ($parent -le 0 -or $parent -eq $current) { break }
      $current = $parent
    }
  }
  return @($rows | Sort-Object -Property @{ Expression = 'Depth'; Descending = $true }, @{ Expression = 'ProcessId'; Descending = $true })
}

function Stop-PaosOwnedRole {
  param($Context, [ValidateSet('server', 'tunnel')][string]$Role)
  $definition = Get-PaosRoleDefinition -Context $Context -Role $Role
  $ownership = Resolve-PaosRoleOwnership -Context $Context -Role $Role
  if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot stop $Role while ownership is $($ownership.state)." }
  if ($ownership.state -eq 'Stopped') { return }
  $rootPid = [int]$ownership.managedPid
  foreach ($entry in @(Get-PaosOwnedDescendants -RootPid $rootPid)) {
    if ([int]$entry.ProcessId -eq $PID) { throw 'OWNERSHIP_MISMATCH: Refusing to stop the lifecycle controller.' }
    Stop-Process -Id ([int]$entry.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  try { Wait-Process -Id $rootPid -Timeout 5 -ErrorAction SilentlyContinue } catch { }
  if ($null -ne (Get-PaosProcess -ProcessId $rootPid)) { throw "STOP_FAILED: $Role PID $rootPid did not exit." }
  Remove-PaosRuntimeFile -Path $definition.pidFile
  Remove-PaosRuntimeFile -Path $definition.ownerFile
}

function Start-PaosChildProcess {
  param([Parameter(Mandatory = $true)]$StartInfo, [hashtable]$Environment = @{})
  $saved = @{}
  try {
    foreach ($name in $Environment.Keys) {
      $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
      [Environment]::SetEnvironmentVariable($name, [string]$Environment[$name], 'Process')
    }
    return [Diagnostics.Process]::Start($StartInfo)
  }
  finally {
    foreach ($name in $Environment.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
  }
}

function Start-PaosServer {
  param($Context)
  $ownership = Resolve-PaosRoleOwnership -Context $Context -Role server
  if (Test-PaosServerHealthy -Context $Context) {
    if ($ownership.state -eq 'OwnedReady') { return }
    throw 'OWNERSHIP_MISMATCH: Healthy Personal Asset OS server is not controller-owned.'
  }
  if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot start server while ownership is $($ownership.state)." }
  if ($ownership.state -eq 'OwnedNotListening') { Stop-PaosOwnedRole -Context $Context -Role server }
  foreach ($required in @($Context.pythonPath, $Context.frontendIndex)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'SERVER_ENTRY_MISSING: Personal Asset OS runtime is incomplete.' }
  }
  if ([string]::IsNullOrWhiteSpace((Get-PaosExpectedBuildId -Context $Context))) { throw 'BUILD_ID_UNAVAILABLE: Personal Asset OS build identity is unavailable.' }
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Context.pythonPath; $startInfo.Arguments = $Context.serverArguments
  $startInfo.WorkingDirectory = $Context.projectRoot; $startInfo.UseShellExecute = $false; $startInfo.CreateNoWindow = $true
  $process = Start-PaosChildProcess -StartInfo $startInfo -Environment @{ PYTHONUTF8 = '1' }
  if ($null -eq $process) { throw 'SERVER_START_FAILED: Personal Asset OS server did not start.' }
  $started = Get-PaosProcess -ProcessId $process.Id
  if ($null -eq $started) { throw 'SERVER_START_FAILED: Started Personal Asset OS runner is unavailable.' }
  Write-PaosOwnerMetadata -Context $Context -Role server -Process $started
  if (-not (Wait-PaosCondition -TimeoutSeconds $Context.coreReadyTimeoutSeconds -Condition { Test-PaosServerHealthy -Context $Context })) {
    Stop-PaosOwnedRole -Context $Context -Role server
    throw 'SERVER_NOT_READY: Personal Asset OS failed bounded startup.'
  }
  $ready = Resolve-PaosRoleOwnership -Context $Context -Role server
  if ($ready.state -ne 'OwnedReady') { throw 'OWNERSHIP_MISMATCH: Server listener is not a descendant of the started runner.' }
}

function Start-PaosTunnelOnce {
  param($Context)
  if (-not (Test-PaosServerHealthy -Context $Context)) { throw 'SERVER_NOT_READY: Tunnel start requires Personal Asset OS.' }
  $ownership = Resolve-PaosRoleOwnership -Context $Context -Role tunnel
  if (Test-PaosTunnelReady -Context $Context) {
    if ($ownership.state -eq 'OwnedReady') { return }
    throw 'OWNERSHIP_MISMATCH: Ready tunnel is not controller-owned.'
  }
  if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot start tunnel while ownership is $($ownership.state)." }
  if ($ownership.state -eq 'OwnedNotListening') { Stop-PaosOwnedRole -Context $Context -Role tunnel }
  foreach ($required in @($Context.tunnelClientPath, $Context.tunnelProfilePath, $Context.localEnvScript)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'TUNNEL_CONFIG_MISSING: Tunnel runtime is incomplete.' }
  }
  $savedKey = [Environment]::GetEnvironmentVariable('CONTROL_PLANE_API_KEY', 'Process')
  $savedOrg = [Environment]::GetEnvironmentVariable('CONTROL_PLANE_ORGANIZATION_ID', 'Process')
  try {
    . $Context.localEnvScript
    if (-not (Set-ControlPlaneApiKeyFromLocalEnv -ProjectRoot $Context.projectRoot)) { throw 'TUNNEL_KEY_MISSING: Tunnel API key is unavailable.' }
    if (-not (Set-ControlPlaneOrganizationIdFromLocalEnv -ProjectRoot $Context.projectRoot)) { throw 'TUNNEL_ORGANIZATION_MISSING: Tunnel organization id is unavailable.' }
    New-Item -ItemType Directory -Force -Path $Context.runtimeDir | Out-Null
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Context.tunnelClientPath; $startInfo.Arguments = $Context.tunnelArguments
    $startInfo.WorkingDirectory = $Context.projectRoot; $startInfo.UseShellExecute = $false; $startInfo.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($startInfo)
  }
  finally {
    [Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY', $savedKey, 'Process')
    [Environment]::SetEnvironmentVariable('CONTROL_PLANE_ORGANIZATION_ID', $savedOrg, 'Process')
  }
  if ($null -eq $process) { throw 'TUNNEL_START_FAILED: Tunnel process did not start.' }
  $started = Get-PaosProcess -ProcessId $process.Id
  if ($null -eq $started) { throw 'TUNNEL_START_FAILED: Started tunnel is unavailable.' }
  Write-PaosOwnerMetadata -Context $Context -Role tunnel -Process $started
}

function Repair-PaosConnectivity {
  param($Context)
  $server = Resolve-PaosRoleOwnership -Context $Context -Role server
  if ($server.state -ne 'OwnedReady' -or -not (Test-PaosServerHealthy -Context $Context)) { throw 'CORE_NOT_READY: Connectivity repair requires an owned ready server.' }
  $tunnel = Resolve-PaosRoleOwnership -Context $Context -Role tunnel
  if (Test-PaosTunnelReady -Context $Context) {
    if ($tunnel.state -eq 'OwnedReady') { return }
    throw 'OWNERSHIP_MISMATCH: Ready tunnel is not controller-owned.'
  }
  if (-not $tunnel.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot repair tunnel while ownership is $($tunnel.state)." }
  if ($tunnel.state -eq 'OwnedNotListening') { Stop-PaosOwnedRole -Context $Context -Role tunnel }
  foreach ($delay in @($Context.tunnelRecoveryDelaysSeconds)) {
    Start-PaosTunnelOnce -Context $Context
    if (Wait-PaosCondition -TimeoutSeconds ([int]$delay) -Condition { Test-PaosTunnelReady -Context $Context }) {
      $ready = Resolve-PaosRoleOwnership -Context $Context -Role tunnel
      if ($ready.state -eq 'OwnedReady') { return }
      throw 'OWNERSHIP_MISMATCH: Tunnel listener is not owned by the started process.'
    }
    Stop-PaosOwnedRole -Context $Context -Role tunnel
  }
  throw 'TUNNEL_NOT_READY: Tunnel failed bounded recovery.'
}

function Assert-PaosMutationPreflight {
  param($Context, [string[]]$Roles)
  foreach ($role in @($Roles)) {
    $ownership = Resolve-PaosRoleOwnership -Context $Context -Role $role
    if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot mutate $role while ownership is $($ownership.state)." }
  }
}

function Invoke-PersonalAssetOsLifecycleAction {
  param($Context, [ValidateSet('EnsureRunning', 'RepairConnectivity', 'RestartCore', 'ReloadRuntime', 'ShutdownRuntime')][string]$Action)
  switch ($Action) {
    'EnsureRunning' { Start-PaosServer -Context $Context; Repair-PaosConnectivity -Context $Context }
    'RepairConnectivity' { Repair-PaosConnectivity -Context $Context }
    'RestartCore' {
      Assert-PaosMutationPreflight -Context $Context -Roles @('server')
      Stop-PaosOwnedRole -Context $Context -Role server
      Start-PaosServer -Context $Context
    }
    'ReloadRuntime' {
      Assert-PaosMutationPreflight -Context $Context -Roles @('server', 'tunnel')
      Stop-PaosOwnedRole -Context $Context -Role tunnel
      Stop-PaosOwnedRole -Context $Context -Role server
      Start-PaosServer -Context $Context
      Repair-PaosConnectivity -Context $Context
    }
    'ShutdownRuntime' {
      Assert-PaosMutationPreflight -Context $Context -Roles @('server', 'tunnel')
      Stop-PaosOwnedRole -Context $Context -Role tunnel
      Stop-PaosOwnedRole -Context $Context -Role server
    }
  }
}

function Get-PersonalAssetOsRuntimeStatus {
  param($Context, [switch]$AdoptLegacyExactListeners)
  $server = Resolve-PaosRoleOwnership -Context $Context -Role server -AdoptLegacyExactListener:$AdoptLegacyExactListeners
  $tunnel = Resolve-PaosRoleOwnership -Context $Context -Role tunnel -AdoptLegacyExactListener:$AdoptLegacyExactListeners
  $serverHealthy = Test-PaosServerHealthy -Context $Context
  $tunnelReady = Test-PaosTunnelReady -Context $Context
  $ownerships = @($server, $tunnel)
  $status = if (@($ownerships | Where-Object { $_.state -eq 'OwnershipMismatch' }).Count -gt 0) { 'OwnershipMismatch' }
    elseif ($serverHealthy -and $tunnelReady -and @($ownerships | Where-Object { $_.state -ne 'OwnedReady' }).Count -eq 0) { 'Ready' }
    elseif ($serverHealthy -and $server.state -eq 'OwnedReady') { 'Degraded' }
    elseif (@($ownerships | Where-Object { $_.state -ne 'Stopped' }).Count -eq 0) { 'Stopped' }
    else { 'Unhealthy' }
  $ownedPids = @($ownerships | Where-Object { $_.state -like 'Owned*' -and $null -ne $_.managedPid } | ForEach-Object { [int]$_.managedPid } | Sort-Object -Unique)
  return [pscustomobject]@{
    status = $status
    server = [pscustomobject]@{ healthy = $serverHealthy; ownership = $server.state; pid = $server.managedPid; listenerPid = $server.listenerPid; relation = $server.relation }
    tunnel = [pscustomobject]@{ ready = $tunnelReady; ownership = $tunnel.state; pid = $tunnel.managedPid; listenerPid = $tunnel.listenerPid; relation = $tunnel.relation }
    ownedPids = $ownedPids
  }
}

function New-PersonalAssetOsRuntimeContext {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$HostName = '127.0.0.1', [int]$Port = 8876, [string]$DataDir,
    [string]$PythonPath, [string]$ServerArguments, [string]$ServerIdentity = 'personal_asset_os.cli serve',
    [string]$TunnelClientPath, [string]$TunnelProfileDir, [string]$TunnelProfile = 'personal-asset-os',
    [string]$TunnelHealthUrl = 'http://127.0.0.1:8877', [string]$TunnelArguments, [string]$TunnelIdentity,
    [string]$LocalEnvScript, [string]$ExpectedBuildId,
    [int]$CoreReadyTimeoutSeconds = 30, [int[]]$TunnelRecoveryDelaysSeconds = @(15, 30, 60)
  )
  $root = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path
  $runtimeDir = Join-Path $root '.tmp'
  if ([string]::IsNullOrWhiteSpace($PythonPath)) { $PythonPath = Join-Path $root '.venv\Scripts\python.exe' }
  if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = if ([string]::IsNullOrWhiteSpace($env:PAOS_DATA_DIR)) { Join-Path $env:LOCALAPPDATA 'PersonalAssetOS' } else { $env:PAOS_DATA_DIR }
  }
  if ([string]::IsNullOrWhiteSpace($TunnelClientPath)) { $TunnelClientPath = Join-Path $root 'vendor\tunnel-client\tunnel-client.exe' }
  if ([string]::IsNullOrWhiteSpace($TunnelProfileDir)) { $TunnelProfileDir = Join-Path $root '.tunnel-client' }
  if ([string]::IsNullOrWhiteSpace($LocalEnvScript)) { $LocalEnvScript = Join-Path $root 'scripts\local-env.ps1' }
  $tunnelUri = [Uri]$TunnelHealthUrl
  if ($HostName -notin @('127.0.0.1', 'localhost', '::1', '[::1]') -or $tunnelUri.Host -notin @('127.0.0.1', 'localhost', '::1', '[::1]')) { throw 'Runtime endpoints must use loopback.' }
  if ($CoreReadyTimeoutSeconds -lt 1 -or $CoreReadyTimeoutSeconds -gt 120) { throw 'CoreReadyTimeoutSeconds must be between 1 and 120.' }
  if ([string]::IsNullOrWhiteSpace($ServerArguments)) {
    $ServerArguments = "-m personal_asset_os.cli serve --host $HostName --port $Port --data-dir `"$([IO.Path]::GetFullPath($DataDir))`""
  }
  if ([string]::IsNullOrWhiteSpace($TunnelIdentity)) { $TunnelIdentity = $TunnelProfile }
  $profileDir = [IO.Path]::GetFullPath($TunnelProfileDir)
  if ([string]::IsNullOrWhiteSpace($TunnelArguments)) {
    $TunnelArguments = "run --profile-dir `"$profileDir`" --profile `"$TunnelProfile`" --log.file `"$(Join-Path $runtimeDir 'tunnel-client.log')`" --pid.file `"$(Join-Path $runtimeDir 'tunnel-client.pid')`""
  }
  return [pscustomobject]@{
    projectRoot = $root; hostName = $HostName; port = $Port; dataDir = [IO.Path]::GetFullPath($DataDir)
    pythonPath = [IO.Path]::GetFullPath($PythonPath); serverArguments = $ServerArguments; serverIdentity = $ServerIdentity
    frontendIndex = Join-Path $root 'frontend\dist\index.html'; healthUrl = "http://${HostName}:${Port}/api/health"; readyUrl = "http://${HostName}:${Port}/api/readyz"
    expectedBuildId = $ExpectedBuildId
    tunnelClientPath = [IO.Path]::GetFullPath($TunnelClientPath); tunnelProfileDir = $profileDir; tunnelProfilePath = Join-Path $profileDir "$TunnelProfile.yaml"
    tunnelHealthUrl = $TunnelHealthUrl.TrimEnd('/'); tunnelHealthPort = $(if ($tunnelUri.IsDefaultPort) { 80 } else { $tunnelUri.Port })
    tunnelIdentity = $TunnelIdentity; tunnelArguments = $TunnelArguments; localEnvScript = [IO.Path]::GetFullPath($LocalEnvScript)
    runtimeDir = $runtimeDir; serverPidFile = Join-Path $runtimeDir 'personal-asset-os-server.pid'; serverOwnerFile = Join-Path $runtimeDir 'personal-asset-os-server.owner.json'
    tunnelPidFile = Join-Path $runtimeDir 'tunnel-client.pid'; tunnelOwnerFile = Join-Path $runtimeDir 'tunnel-client.owner.json'
    actionLogFile = Join-Path $runtimeDir 'runtime-control.jsonl'; coreReadyTimeoutSeconds = $CoreReadyTimeoutSeconds
    tunnelRecoveryDelaysSeconds = @($TunnelRecoveryDelaysSeconds)
  }
}

function Write-PersonalAssetOsLifecycleEvent {
  param($Context, [string]$Action, [bool]$Ok, [string]$BeforeStatus, [string]$AfterStatus, [int[]]$OwnedPids = @(), [int]$ElapsedMs, [string]$ErrorCode, [string]$Message)
  New-Item -ItemType Directory -Force -Path $Context.runtimeDir | Out-Null
  $event = [ordered]@{
    timestamp = [DateTime]::UtcNow.ToString('o'); action = $Action; ok = $Ok; beforeStatus = $BeforeStatus; afterStatus = $AfterStatus
    ownedPids = @($OwnedPids); elapsedMs = $ElapsedMs; errorCode = $ErrorCode; message = $Message
  }
  [IO.File]::AppendAllText($Context.actionLogFile, (($event | ConvertTo-Json -Compress -Depth 5) + [Environment]::NewLine), $script:Utf8NoBom)
}

Export-ModuleMember -Function @(
  'New-PersonalAssetOsRuntimeContext', 'Get-PersonalAssetOsRuntimeStatus',
  'Invoke-PersonalAssetOsLifecycleAction', 'Write-PersonalAssetOsLifecycleEvent'
)
