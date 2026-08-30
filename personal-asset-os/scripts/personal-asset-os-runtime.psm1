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

function Read-PaosRuntimeFileSnapshot {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [pscustomobject]@{ exists=$false; raw=$null } }
  try { return [pscustomobject]@{ exists=$true; raw=[IO.File]::ReadAllText($Path) } }
  catch { return [pscustomobject]@{ exists=$true; raw=$null } }
}

function Remove-PaosRuntimeFileSnapshot {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Snapshot)
  if (-not [bool]$Snapshot.exists) { return $true }
  if ($null -eq $Snapshot.raw) { return $false }
  try {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $true }
    if ([IO.File]::ReadAllText($Path) -cne [string]$Snapshot.raw) { return $false }
    Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    return $true
  }
  catch { return $false }
}

function Remove-PaosStaleOwnershipPair {
  param($Definition, $PidSnapshot, $OwnerSnapshot)
  foreach ($entry in @(@{ path=$Definition.pidFile; snapshot=$PidSnapshot }, @{ path=$Definition.ownerFile; snapshot=$OwnerSnapshot })) {
    if ([bool]$entry.snapshot.exists) {
      if ($null -eq $entry.snapshot.raw -or -not (Test-Path -LiteralPath $entry.path -PathType Leaf) -or [IO.File]::ReadAllText($entry.path) -cne [string]$entry.snapshot.raw) { return $false }
    }
    elseif (Test-Path -LiteralPath $entry.path -PathType Leaf) { return $false }
  }
  if (-not (Remove-PaosRuntimeFileSnapshot -Path $Definition.ownerFile -Snapshot $OwnerSnapshot)) { return $false }
  return (Remove-PaosRuntimeFileSnapshot -Path $Definition.pidFile -Snapshot $PidSnapshot)
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

function Get-PaosProcessInspection {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  try { $nativeProcess = Get-Process -Id $ProcessId -ErrorAction Stop }
  catch {
    $missing = $_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound
    return [pscustomobject]@{ state=$(if ($missing) { 'MissingConfirmed' } else { 'Unknown' }); process=$null }
  }
  $executablePath = $null
  $startTimeUtc = $null
  try { $executablePath = [string]$nativeProcess.Path } catch { }
  try { $startTimeUtc = $nativeProcess.StartTime.ToUniversalTime().ToString('o') } catch { }
  $cim = $null
  try { $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop } catch { }
  if ([string]::IsNullOrWhiteSpace($executablePath) -and $null -ne $cim) { $executablePath = [string]$cim.ExecutablePath }
  return [pscustomobject]@{
    state='Present'
    process=[pscustomobject]@{
      ProcessId=[int]$nativeProcess.Id
      ParentProcessId=$(if ($null -eq $cim) { $null } else { [int]$cim.ParentProcessId })
      Name=$(if ($null -eq $cim) { [string]$nativeProcess.Name } else { [string]$cim.Name })
      ExecutablePath=$executablePath
      StartTimeUtc=$startTimeUtc
      CommandLine=$(if ($null -eq $cim) { $null } else { [string]$cim.CommandLine })
    }
  }
}

function Get-PaosTerminationBinding {
  param([Parameter(Mandatory = $true)]$ExpectedProcess)
  $nativeProcess = $null
  try {
    $nativeProcess = Get-Process -Id ([int]$ExpectedProcess.ProcessId) -ErrorAction Stop
    $null = $nativeProcess.Handle
    if ($nativeProcess.HasExited) {
      $nativeProcess.Dispose()
      return [pscustomobject]@{ state='MissingConfirmed'; process=$null; nativeProcess=$null }
    }
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$ExpectedProcess.ProcessId)" -ErrorAction Stop
    $process = [pscustomobject]@{
      ProcessId=[int]$nativeProcess.Id; ParentProcessId=[int]$cim.ParentProcessId; Name=[string]$cim.Name
      ExecutablePath=[string]$nativeProcess.Path; StartTimeUtc=$nativeProcess.StartTime.ToUniversalTime().ToString('o')
      CommandLine=[string]$cim.CommandLine
    }
    $matches = (
      [int]$process.ProcessId -eq [int]$ExpectedProcess.ProcessId -and
      [int]$process.ParentProcessId -eq [int]$ExpectedProcess.ParentProcessId -and
      (Test-PaosPathEqual $process.ExecutablePath $ExpectedProcess.ExecutablePath) -and
      -not [string]::IsNullOrWhiteSpace([string]$process.StartTimeUtc) -and
      [string]$process.StartTimeUtc -eq [string]$ExpectedProcess.StartTimeUtc
    )
    if (-not $matches) {
      $nativeProcess.Dispose()
      return [pscustomobject]@{ state='OwnershipChanged'; process=$process; nativeProcess=$null }
    }
    return [pscustomobject]@{ state='Present'; process=$process; nativeProcess=$nativeProcess }
  }
  catch {
    if ($null -ne $nativeProcess) { try { $nativeProcess.Dispose() } catch { } }
    $missing = $_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound
    return [pscustomobject]@{ state=$(if ($missing) { 'MissingConfirmed' } else { 'Unknown' }); process=$null; nativeProcess=$null }
  }
}

function Get-PaosListenerState {
  param([Parameter(Mandatory = $true)][int]$Port)
  $netstatPath = Join-Path $env:WINDIR 'System32\netstat.exe'
  if (-not (Test-Path -LiteralPath $netstatPath -PathType Leaf)) {
    return [pscustomobject]@{ known=$false; pids=@(); errorCode='listener_query_unavailable' }
  }
  try {
    $pids = @()
    $lines = @(& $netstatPath -ano -p TCP 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'netstat failed' }
    foreach ($line in $lines) {
      if ([string]$line -match ("^\s*TCP\s+\S+:" + $Port + "\s+\S+\s+LISTENING\s+(\d+)\s*$")) { $pids += [int]$matches[1] }
    }
    return [pscustomobject]@{ known=$true; pids=@($pids | Sort-Object -Unique); errorCode=$null }
  }
  catch { return [pscustomobject]@{ known=$false; pids=@(); errorCode='listener_query_failed' } }
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
  foreach ($name in @('schemaVersion','role','pid','executablePath','startTimeUtc','identity')) {
    if ($null -eq $Metadata.PSObject.Properties[$name]) { return $false }
  }
  $definition = Get-PaosRoleDefinition -Context $Context -Role $Role
  return (
    [int]$Metadata.schemaVersion -eq 1 -and
    [string]$Metadata.role -eq $Role -and
    [int]$Metadata.pid -eq [int]$Process.ProcessId -and
    (Test-PaosPathEqual ([string]$Metadata.executablePath) $definition.executablePath) -and
    (Test-PaosPathEqual $Process.ExecutablePath $definition.executablePath) -and
    -not [string]::IsNullOrWhiteSpace([string]$Process.StartTimeUtc) -and
    [string]$Metadata.startTimeUtc -eq [string]$Process.StartTimeUtc -and
    [string]$Metadata.identity -eq [string]$definition.identity -and
    (
      [string]::IsNullOrWhiteSpace([string]$Process.CommandLine) -or
      (Test-PaosCommandContains $Process.CommandLine @($definition.identity))
    )
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
  $pidSnapshot = Read-PaosRuntimeFileSnapshot -Path $definition.pidFile
  $ownerSnapshot = Read-PaosRuntimeFileSnapshot -Path $definition.ownerFile
  $managedPid = Read-PaosPidFile -Path $definition.pidFile
  $metadata = Read-PaosOwnerMetadata -Path $definition.ownerFile
  $managedInspection = if ($null -eq $managedPid) { $null } else { Get-PaosProcessInspection -ProcessId $managedPid }
  $listener = Get-PaosListenerState -Port $definition.port
  if (-not $listener.known) {
    return [pscustomobject]@{ state='OwnershipUnknown'; canMutate=$false; managedPid=$managedPid; listenerPid=$null; relation='Unknown'; reason=$listener.errorCode }
  }
  if ($listener.pids.Count -gt 1) {
    return [pscustomobject]@{ state='OwnershipMismatch'; canMutate=$false; managedPid=$managedPid; listenerPid=$null; relation='Multiple'; reason='multiple_listener_owners' }
  }
  $listenerPid = if ($listener.pids.Count -eq 1) { [int]$listener.pids[0] } else { $null }
  $listenerInspection = if ($null -eq $listenerPid) { $null } else { Get-PaosProcessInspection -ProcessId $listenerPid }
  if ($null -ne $listenerInspection -and $listenerInspection.state -ne 'Present') {
    return [pscustomobject]@{ state='OwnershipUnknown'; canMutate=$false; managedPid=$managedPid; listenerPid=$listenerPid; relation='Unknown'; reason='listener_process_inspection_failed' }
  }
  $listenerProcess = if ($null -eq $listenerInspection) { $null } else { $listenerInspection.process }

  if ($pidSnapshot.exists -and $null -eq $managedPid) {
    if ($null -ne $listenerPid) {
      return [pscustomobject]@{ state='OwnershipMismatch'; canMutate=$false; managedPid=$null; listenerPid=$listenerPid; relation='Unknown'; reason='invalid_pid_file_with_listener' }
    }
    if (-not (Remove-PaosStaleOwnershipPair -Definition $definition -PidSnapshot $pidSnapshot -OwnerSnapshot $ownerSnapshot)) {
      return [pscustomobject]@{ state='OwnershipUnknown'; canMutate=$false; managedPid=$null; listenerPid=$null; relation='Unknown'; reason='stale_metadata_changed_during_cleanup' }
    }
  }

  if ($null -ne $managedPid) {
    if ($managedInspection.state -eq 'Unknown') {
      return [pscustomobject]@{ state='OwnershipUnknown'; canMutate=$false; managedPid=$managedPid; listenerPid=$listenerPid; relation='Unknown'; reason='managed_process_inspection_failed' }
    }
    if ($managedInspection.state -eq 'MissingConfirmed') {
      if ($null -ne $listenerPid) {
        return [pscustomobject]@{ state='OwnershipMismatch'; canMutate=$false; managedPid=$managedPid; listenerPid=$listenerPid; relation='Unknown'; reason='stale_pid_with_listener' }
      }
      if (-not (Remove-PaosStaleOwnershipPair -Definition $definition -PidSnapshot $pidSnapshot -OwnerSnapshot $ownerSnapshot)) {
        return [pscustomobject]@{ state='OwnershipUnknown'; canMutate=$false; managedPid=$managedPid; listenerPid=$null; relation='Unknown'; reason='stale_metadata_changed_during_cleanup' }
      }
      $managedPid = $null
    }
  }
  $managedProcess = if ($null -eq $managedPid) { $null } else { $managedInspection.process }

  if ($null -ne $managedProcess) {
    if ([string]::IsNullOrWhiteSpace([string]$managedProcess.ExecutablePath) -or
        [string]::IsNullOrWhiteSpace([string]$managedProcess.StartTimeUtc)) {
      return [pscustomobject]@{ state='OwnershipUnknown'; canMutate=$false; managedPid=$managedPid; listenerPid=$listenerPid; relation='Unknown'; reason='managed_process_identity_incomplete' }
    }
    $executableMatches = Test-PaosPathEqual $managedProcess.ExecutablePath $definition.executablePath
    $commandKnown = -not [string]::IsNullOrWhiteSpace([string]$managedProcess.CommandLine)
    $commandMatches = $commandKnown -and (Test-PaosCommandContains $managedProcess.CommandLine @($definition.identity))
    $metadataComplete = Test-PaosOwnerMetadata -Context $Context -Role $Role -Process $managedProcess -Metadata $metadata
    $metadataHasInstance = (
      $null -ne $metadata -and
      $null -ne $metadata.PSObject.Properties['pid'] -and
      $null -ne $metadata.PSObject.Properties['executablePath'] -and
      $null -ne $metadata.PSObject.Properties['startTimeUtc'] -and
      [int]$metadata.pid -eq $managedPid
    )
    $positiveMismatch = -not $executableMatches -or ($commandKnown -and -not $commandMatches) -or ($metadataHasInstance -and (
      -not (Test-PaosPathEqual ([string]$metadata.executablePath) ([string]$managedProcess.ExecutablePath)) -or
      [string]$metadata.startTimeUtc -ne [string]$managedProcess.StartTimeUtc
    ))
    if ($positiveMismatch) {
      if ($null -ne $listenerPid) {
        return [pscustomobject]@{ state='OwnershipMismatch'; canMutate=$false; managedPid=$managedPid; listenerPid=$listenerPid; relation='Unknown'; reason='pid_process_mismatch' }
      }
      if (-not (Remove-PaosStaleOwnershipPair -Definition $definition -PidSnapshot $pidSnapshot -OwnerSnapshot $ownerSnapshot)) {
        return [pscustomobject]@{ state='OwnershipUnknown'; canMutate=$false; managedPid=$managedPid; listenerPid=$null; relation='Unknown'; reason='stale_metadata_changed_during_cleanup' }
      }
      $managedPid = $null
      $managedProcess = $null
    }
    elseif (-not $metadataComplete) {
      if ($AdoptLegacyExactListener -and $null -ne $listenerProcess) {
        $root = Find-PaosLegacyRootProcess -Context $Context -Role $Role -ListenerPid ([int]$listenerProcess.ProcessId)
        if ($null -ne $root -and [int]$root.ProcessId -eq $managedPid) {
          Write-PaosOwnerMetadata -Context $Context -Role $Role -Process $root
          return Resolve-PaosRoleOwnership -Context $Context -Role $Role
        }
      }
      return [pscustomobject]@{ state='OwnershipUnknown'; canMutate=$false; managedPid=$managedPid; listenerPid=$listenerPid; relation='Unknown'; reason='owner_metadata_unavailable_or_incoherent' }
    }
  }

  if ($null -eq $listenerProcess -and $null -eq $managedProcess) {
    return [pscustomobject]@{ state='Stopped'; canMutate=$true; managedPid=$null; listenerPid=$null; relation=$null }
  }
  if ($null -ne $managedProcess -and (Test-PaosOwnerMetadata -Context $Context -Role $Role -Process $managedProcess -Metadata $metadata)) {
    if ($null -eq $listenerProcess) {
      return [pscustomobject]@{ state='OwnedNotListening'; canMutate=$true; managedPid=[int]$managedProcess.ProcessId; listenerPid=$null; relation=$null }
    }
    $lineage = Get-PaosLineage -ProcessId ([int]$listenerProcess.ProcessId) -ExpectedAncestorProcessId ([int]$managedProcess.ProcessId)
    if (-not $lineage.known) {
      return [pscustomobject]@{ state='OwnershipUnknown'; canMutate=$false; managedPid=[int]$managedProcess.ProcessId; listenerPid=[int]$listenerProcess.ProcessId; relation='Unknown'; reason='listener_lineage_unavailable' }
    }
    if ($lineage.matches) {
      return [pscustomobject]@{ state='OwnedReady'; canMutate=$true; managedPid=[int]$managedProcess.ProcessId; listenerPid=[int]$listenerProcess.ProcessId; relation=$(if ([int]$lineage.depth -eq 0) { 'Self' } else { 'Descendant' }) }
    }
    return [pscustomobject]@{ state='OwnershipMismatch'; canMutate=$false; managedPid=[int]$managedProcess.ProcessId; listenerPid=[int]$listenerProcess.ProcessId; relation='Unrelated' }
  }
  if ($AdoptLegacyExactListener -and $null -ne $listenerProcess) {
    $root = Find-PaosLegacyRootProcess -Context $Context -Role $Role -ListenerPid ([int]$listenerProcess.ProcessId)
    if ($null -ne $root) {
      Write-PaosOwnerMetadata -Context $Context -Role $Role -Process $root
      return Resolve-PaosRoleOwnership -Context $Context -Role $Role
    }
  }
  return [pscustomobject]@{ state='OwnershipMismatch'; canMutate=$false; managedPid=$(if ($null -eq $managedProcess) { $null } else { [int]$managedProcess.ProcessId }); listenerPid=$(if ($null -eq $listenerProcess) { $null } else { [int]$listenerProcess.ProcessId }); relation='Unknown' }
}

function Get-PaosOwnedDescendants {
  param([Parameter(Mandatory = $true)][int]$RootPid)
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $byPid = @{}
  foreach ($process in $all) { $byPid[[int]$process.ProcessId] = $process }
  $candidates = @()
  foreach ($process in $all) {
    $current = [int]$process.ProcessId
    for ($depth = 0; $depth -lt 32; $depth++) {
      if ($current -eq $RootPid) { $candidates += [pscustomobject]@{ ProcessId = [int]$process.ProcessId; Depth = $depth }; break }
      if (-not $byPid.ContainsKey($current)) { break }
      $parent = [int]$byPid[$current].ParentProcessId
      if ($parent -le 0 -or $parent -eq $current) { break }
      $current = $parent
    }
  }
  $rows = @()
  foreach ($candidate in $candidates) {
    $inspection = Get-PaosProcessInspection -ProcessId ([int]$candidate.ProcessId)
    if ($inspection.state -eq 'MissingConfirmed') { continue }
    if ($inspection.state -ne 'Present' -or $null -eq $inspection.process -or
        $null -eq $inspection.process.ParentProcessId -or
        [string]::IsNullOrWhiteSpace([string]$inspection.process.ExecutablePath) -or
        [string]::IsNullOrWhiteSpace([string]$inspection.process.StartTimeUtc)) {
      throw 'OWNERSHIP_UNKNOWN: Descendant process identity is unavailable.'
    }
    $rows += [pscustomobject]@{
      ProcessId=[int]$inspection.process.ProcessId; ParentProcessId=[int]$inspection.process.ParentProcessId
      ExecutablePath=[string]$inspection.process.ExecutablePath; StartTimeUtc=[string]$inspection.process.StartTimeUtc
      Depth=[int]$candidate.Depth
    }
  }
  return @($rows | Sort-Object -Property @{ Expression = 'Depth'; Descending = $true }, @{ Expression = 'ProcessId'; Descending = $true })
}

function Stop-PaosOwnedRole {
  param($Context, [ValidateSet('server', 'tunnel')][string]$Role)
  $definition = Get-PaosRoleDefinition -Context $Context -Role $Role
  $pidSnapshot = Read-PaosRuntimeFileSnapshot -Path $definition.pidFile
  $ownerSnapshot = Read-PaosRuntimeFileSnapshot -Path $definition.ownerFile
  $ownership = Resolve-PaosRoleOwnership -Context $Context -Role $Role
  if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot stop $Role while ownership is $($ownership.state)." }
  if ($ownership.state -eq 'Stopped') { return }
  $rootPid = [int]$ownership.managedPid
  $snapshots = @(Get-PaosOwnedDescendants -RootPid $rootPid)
  $snapshotByPid = @{}; foreach ($entry in $snapshots) { $snapshotByPid[[int]$entry.ProcessId] = $entry }
  if (-not $snapshotByPid.ContainsKey($rootPid)) { throw 'OWNERSHIP_CHANGED: Managed root disappeared before stop.' }
  try { $ownerMetadata = [string]$ownerSnapshot.raw | ConvertFrom-Json }
  catch { throw 'OWNERSHIP_UNKNOWN: Owner metadata became unavailable before stop.' }
  $bindings = @(); $bindingByPid = @{}
  try {
    foreach ($entry in @($snapshots | Sort-Object Depth, ProcessId)) {
      if ([int]$entry.ProcessId -eq $PID) { throw 'OWNERSHIP_MISMATCH: Refusing to stop the lifecycle controller.' }
      $binding = Get-PaosTerminationBinding -ExpectedProcess $entry
      if ($binding.state -eq 'MissingConfirmed') { continue }
      if ($binding.state -ne 'Present') { throw "OWNERSHIP_CHANGED: PID $($entry.ProcessId) changed before stop." }
      $bindings += [pscustomobject]@{ snapshot=$entry; nativeProcess=$binding.nativeProcess; process=$binding.process }
      $bindingByPid[[int]$entry.ProcessId] = $bindings[-1]
    }
    if (-not $bindingByPid.ContainsKey($rootPid) -or
        -not (Test-PaosOwnerMetadata -Context $Context -Role $Role -Process $bindingByPid[$rootPid].process -Metadata $ownerMetadata)) {
      throw 'OWNERSHIP_CHANGED: Managed root identity changed before stop.'
    }
    if ([IO.File]::ReadAllText($definition.ownerFile) -cne [string]$ownerSnapshot.raw) { throw 'OWNERSHIP_CHANGED: Owner metadata changed before stop.' }
    foreach ($binding in $bindings) {
      $currentPid = [int]$binding.snapshot.ProcessId
      if ($currentPid -eq $rootPid) { continue }
      for ($depth = 0; $depth -lt 32 -and $currentPid -ne $rootPid; $depth++) {
        if (-not $snapshotByPid.ContainsKey($currentPid) -or -not $bindingByPid.ContainsKey($currentPid)) { throw 'OWNERSHIP_CHANGED: Descendant lineage changed before stop.' }
        $currentPid = [int]$snapshotByPid[$currentPid].ParentProcessId
      }
      if ($currentPid -ne $rootPid) { throw 'OWNERSHIP_CHANGED: Descendant no longer belongs to the verified root.' }
    }
    foreach ($binding in @($bindings | Sort-Object @{ Expression={ [int]$_.snapshot.Depth }; Descending=$true }, @{ Expression={ [int]$_.snapshot.ProcessId }; Descending=$true })) {
      if (-not $binding.nativeProcess.HasExited) { $binding.nativeProcess.Kill() }
      if (-not $binding.nativeProcess.WaitForExit(5000)) { throw "STOP_FAILED: PID $($binding.snapshot.ProcessId) did not exit." }
    }
  }
  finally {
    foreach ($binding in $bindings) { if ($null -ne $binding.nativeProcess) { $binding.nativeProcess.Dispose() } }
  }
  if (-not (Remove-PaosStaleOwnershipPair -Definition $definition -PidSnapshot $pidSnapshot -OwnerSnapshot $ownerSnapshot)) {
    throw 'OWNERSHIP_CHANGED: Runtime metadata changed before cleanup.'
  }
}

function Start-PaosChildProcess {
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
  $startInfo.WorkingDirectory = $Context.projectRoot; $startInfo.UseShellExecute = $true; $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $process = Start-PaosChildProcess -StartInfo $startInfo -Environment @{ PYTHONUTF8 = '1' }
  if ($null -eq $process) { throw 'SERVER_START_FAILED: Personal Asset OS server did not start.' }
  $startedInspection = Get-PaosProcessInspection -ProcessId $process.Id
  $started = $startedInspection.process
  if ($startedInspection.state -ne 'Present' -or $null -eq $started) { throw 'SERVER_START_FAILED: Started Personal Asset OS runner is unavailable.' }
  Write-PaosOwnerMetadata -Context $Context -Role server -Process $started
  if (-not (Wait-PaosCondition -TimeoutSeconds $Context.coreReadyTimeoutSeconds -Condition { Test-PaosServerHealthy -Context $Context })) {
    Stop-PaosOwnedRole -Context $Context -Role server
    throw 'SERVER_NOT_READY: Personal Asset OS failed bounded startup.'
  }
  $ready = Resolve-PaosRoleOwnership -Context $Context -Role server
  if ($ready.state -ne 'OwnedReady') { throw "OWNERSHIP_MISMATCH: Server listener is not a descendant of the started runner (state=$($ready.state), reason=$($ready.reason), managedPid=$($ready.managedPid), listenerPid=$($ready.listenerPid))." }
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
    $startInfo.WorkingDirectory = $Context.projectRoot; $startInfo.UseShellExecute = $true; $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $process = Start-PaosChildProcess -StartInfo $startInfo -Environment @{
      CONTROL_PLANE_API_KEY = $env:CONTROL_PLANE_API_KEY
      CONTROL_PLANE_ORGANIZATION_ID = $env:CONTROL_PLANE_ORGANIZATION_ID
    }
  }
  finally {
    [Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY', $savedKey, 'Process')
    [Environment]::SetEnvironmentVariable('CONTROL_PLANE_ORGANIZATION_ID', $savedOrg, 'Process')
  }
  if ($null -eq $process) { throw 'TUNNEL_START_FAILED: Tunnel process did not start.' }
  $startedInspection = Get-PaosProcessInspection -ProcessId $process.Id
  $started = $startedInspection.process
  if ($startedInspection.state -ne 'Present' -or $null -eq $started) { throw 'TUNNEL_START_FAILED: Started tunnel is unavailable.' }
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
  $status = if (@($ownerships | Where-Object { $_.state -eq 'OwnershipUnknown' }).Count -gt 0) { 'OwnershipUnknown' }
    elseif (@($ownerships | Where-Object { $_.state -eq 'OwnershipMismatch' }).Count -gt 0) { 'OwnershipMismatch' }
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
    [string]$HostName = '127.0.0.1', [int]$Port = 18876, [string]$DataDir,
    [string]$PythonPath, [string]$ServerArguments, [string]$ServerIdentity = 'personal_asset_os.cli serve',
    [string]$TunnelClientPath, [string]$TunnelProfileDir, [string]$TunnelProfile = 'personal-asset-os',
    [string]$TunnelHealthUrl = 'http://127.0.0.1:18877', [string]$TunnelArguments, [string]$TunnelIdentity,
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
