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

function Read-JsRuntimeFileSnapshot {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [pscustomobject]@{ exists=$false; raw=$null } }
  try { return [pscustomobject]@{ exists=$true; raw=[IO.File]::ReadAllText($Path) } }
  catch { return [pscustomobject]@{ exists=$true; raw=$null } }
}

function Remove-JsRuntimeFileSnapshot {
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

function Remove-JsStaleOwnershipPair {
  param($Definition, $PidSnapshot, $OwnerSnapshot)
  foreach ($entry in @(@{ path=$Definition.pidFile; snapshot=$PidSnapshot }, @{ path=$Definition.ownerFile; snapshot=$OwnerSnapshot })) {
    if ([bool]$entry.snapshot.exists) {
      if ($null -eq $entry.snapshot.raw -or -not (Test-Path -LiteralPath $entry.path -PathType Leaf) -or [IO.File]::ReadAllText($entry.path) -cne [string]$entry.snapshot.raw) { return $false }
    }
    elseif (Test-Path -LiteralPath $entry.path -PathType Leaf) { return $false }
  }
  if (-not (Remove-JsRuntimeFileSnapshot -Path $Definition.ownerFile -Snapshot $OwnerSnapshot)) { return $false }
  return (Remove-JsRuntimeFileSnapshot -Path $Definition.pidFile -Snapshot $PidSnapshot)
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

function Get-JsProcessInspection {
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
  if ([string]::IsNullOrWhiteSpace($executablePath) -and $null -ne $cim) {
    $executablePath = [string]$cim.ExecutablePath
  }
  $process = [pscustomobject]@{
    ProcessId = [int]$nativeProcess.Id
    ParentProcessId = $(if ($null -eq $cim) { $null } else { [int]$cim.ParentProcessId })
    Name = $(if ($null -eq $cim) { [string]$nativeProcess.Name } else { [string]$cim.Name })
    ExecutablePath = $executablePath
    StartTimeUtc = $startTimeUtc
    CommandLine = $(if ($null -eq $cim) { $null } else { [string]$cim.CommandLine })
  }
  return [pscustomobject]@{ state='Present'; process=$process }
}

function Get-JsTerminationBinding {
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
      (Test-JsPathEqual -Left $process.ExecutablePath -Right $ExpectedProcess.ExecutablePath) -and
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

function Get-JsListenerState {
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
      if ([string]$line -match ("^\s*TCP\s+\S+:" + $Port + "\s+\S+\s+LISTENING\s+(\d+)\s*$")) {
        $pids += [int]$matches[1]
      }
    }
    return [pscustomobject]@{ known=$true; pids=@($pids | Sort-Object -Unique); errorCode=$null }
  }
  catch { return [pscustomobject]@{ known=$false; pids=@(); errorCode='listener_query_failed' } }
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
  foreach ($name in @('schemaVersion','role','pid','executablePath','startTimeUtc','identity')) {
    if ($null -eq $Metadata.PSObject.Properties[$name]) { return $false }
  }
  $definition = Get-JsRoleDefinition -Context $Context -Role $Role
  return (
    [int]$Metadata.schemaVersion -eq 1 -and
    [string]$Metadata.role -eq $Role -and
    [int]$Metadata.pid -eq [int]$Process.ProcessId -and
    (Test-JsPathEqual -Left ([string]$Metadata.executablePath) -Right $definition.executablePath) -and
    (Test-JsPathEqual -Left $Process.ExecutablePath -Right $definition.executablePath) -and
    -not [string]::IsNullOrWhiteSpace([string]$Process.StartTimeUtc) -and
    [string]$Metadata.startTimeUtc -eq [string]$Process.StartTimeUtc -and
    [string]$Metadata.identity -eq [string]$definition.identity -and
    (
      [string]::IsNullOrWhiteSpace([string]$Process.CommandLine) -or
      (Test-JsCommandContains -CommandLine $Process.CommandLine -Fragments @($definition.identity))
    )
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
  $pidSnapshot = Read-JsRuntimeFileSnapshot -Path $definition.pidFile
  $ownerSnapshot = Read-JsRuntimeFileSnapshot -Path $definition.ownerFile
  $managedPid = Read-JsPidFile -Path $definition.pidFile
  $metadata = Read-JsOwnerMetadata -Path $definition.ownerFile
  $managedInspection = if ($null -eq $managedPid) { $null } else { Get-JsProcessInspection -ProcessId $managedPid }
  $listener = Get-JsListenerState -Port $definition.port
  if (-not $listener.known) {
    return [pscustomobject]@{ state='OwnershipUnknown'; canMutate=$false; managedPid=$managedPid; listenerPid=$null; relation='Unknown'; reason=$listener.errorCode }
  }
  if ($listener.pids.Count -gt 1) {
    return [pscustomobject]@{ state='OwnershipMismatch'; canMutate=$false; managedPid=$managedPid; listenerPid=$null; relation='Multiple'; reason='multiple_listener_owners' }
  }
  $listenerPid = if ($listener.pids.Count -eq 1) { [int]$listener.pids[0] } else { $null }
  $listenerInspection = if ($null -eq $listenerPid) { $null } else { Get-JsProcessInspection -ProcessId $listenerPid }
  if ($null -ne $listenerInspection -and $listenerInspection.state -ne 'Present') {
    return [pscustomobject]@{ state='OwnershipUnknown'; canMutate=$false; managedPid=$managedPid; listenerPid=$listenerPid; relation='Unknown'; reason='listener_process_inspection_failed' }
  }
  $listenerProcess = if ($null -eq $listenerInspection) { $null } else { $listenerInspection.process }

  if ($pidSnapshot.exists -and $null -eq $managedPid) {
    if ($null -ne $listenerPid) {
      return [pscustomobject]@{ state='OwnershipMismatch'; canMutate=$false; managedPid=$null; listenerPid=$listenerPid; relation='Unknown'; reason='invalid_pid_file_with_listener' }
    }
    if (-not (Remove-JsStaleOwnershipPair -Definition $definition -PidSnapshot $pidSnapshot -OwnerSnapshot $ownerSnapshot)) {
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
      if (-not (Remove-JsStaleOwnershipPair -Definition $definition -PidSnapshot $pidSnapshot -OwnerSnapshot $ownerSnapshot)) {
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
    $executableMatches = Test-JsPathEqual -Left $managedProcess.ExecutablePath -Right $definition.executablePath
    $commandKnown = -not [string]::IsNullOrWhiteSpace([string]$managedProcess.CommandLine)
    $commandMatches = $commandKnown -and (Test-JsCommandContains -CommandLine $managedProcess.CommandLine -Fragments @($definition.identity))
    $metadataComplete = Test-JsOwnerMetadata -Context $Context -Role $Role -Process $managedProcess -Metadata $metadata
    $metadataHasInstance = (
      $null -ne $metadata -and
      $null -ne $metadata.PSObject.Properties['pid'] -and
      $null -ne $metadata.PSObject.Properties['executablePath'] -and
      $null -ne $metadata.PSObject.Properties['startTimeUtc'] -and
      [int]$metadata.pid -eq $managedPid
    )
    $positiveMismatch = -not $executableMatches -or ($commandKnown -and -not $commandMatches) -or ($metadataHasInstance -and (
      -not (Test-JsPathEqual -Left ([string]$metadata.executablePath) -Right ([string]$managedProcess.ExecutablePath)) -or
      [string]$metadata.startTimeUtc -ne [string]$managedProcess.StartTimeUtc
    ))
    if ($positiveMismatch) {
      if ($null -ne $listenerPid) {
        return [pscustomobject]@{ state='OwnershipMismatch'; canMutate=$false; managedPid=$managedPid; listenerPid=$listenerPid; relation='Unknown'; reason='pid_process_mismatch' }
      }
      if (-not (Remove-JsStaleOwnershipPair -Definition $definition -PidSnapshot $pidSnapshot -OwnerSnapshot $ownerSnapshot)) {
        return [pscustomobject]@{ state='OwnershipUnknown'; canMutate=$false; managedPid=$managedPid; listenerPid=$null; relation='Unknown'; reason='stale_metadata_changed_during_cleanup' }
      }
      $managedPid = $null
      $managedProcess = $null
    }
    elseif (-not $metadataComplete) {
      if ($AdoptLegacyExactListener -and $null -ne $listenerProcess) {
        $root = Find-JsLegacyRootProcess -Context $Context -Role $Role -ListenerPid ([int]$listenerProcess.ProcessId)
        if ($null -ne $root -and [int]$root.ProcessId -eq $managedPid) {
          Write-JsOwnerMetadata -Context $Context -Role $Role -Process $root
          return Resolve-JsRoleOwnership -Context $Context -Role $Role
        }
      }
      return [pscustomobject]@{ state='OwnershipUnknown'; canMutate=$false; managedPid=$managedPid; listenerPid=$listenerPid; relation='Unknown'; reason='owner_metadata_unavailable_or_incoherent' }
    }
  }

  if ($null -eq $listenerProcess -and $null -eq $managedProcess) {
    return [pscustomobject]@{ state = 'Stopped'; canMutate = $true; managedPid = $null; listenerPid = $null; relation = $null }
  }

  if ($null -ne $managedProcess -and (Test-JsOwnerMetadata -Context $Context -Role $Role -Process $managedProcess -Metadata $metadata)) {
    if ($null -eq $listenerProcess) {
      return [pscustomobject]@{ state = 'OwnedNotListening'; canMutate = $true; managedPid = [int]$managedProcess.ProcessId; listenerPid = $null; relation = $null }
    }
    $lineage = Get-JsLineage -ProcessId ([int]$listenerProcess.ProcessId) -ExpectedAncestorProcessId ([int]$managedProcess.ProcessId)
    if (-not $lineage.known) {
      return [pscustomobject]@{ state = 'OwnershipUnknown'; canMutate = $false; managedPid = [int]$managedProcess.ProcessId; listenerPid = [int]$listenerProcess.ProcessId; relation = 'Unknown'; reason = 'listener_lineage_unavailable' }
    }
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
  $candidates = @()
  foreach ($process in $all) {
    $current = [int]$process.ProcessId
    for ($depth = 0; $depth -lt 32; $depth++) {
      if ($current -eq $RootPid) {
        $candidates += [pscustomobject]@{ ProcessId = [int]$process.ProcessId; Depth = $depth }
        break
      }
      if (-not $byPid.ContainsKey($current)) { break }
      $parent = [int]$byPid[$current].ParentProcessId
      if ($parent -le 0 -or $parent -eq $current) { break }
      $current = $parent
    }
  }
  $rows = @()
  foreach ($candidate in $candidates) {
    $inspection = Get-JsProcessInspection -ProcessId ([int]$candidate.ProcessId)
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

function Stop-JsOwnedRole {
  param($Context, [ValidateSet('hub', 'mcp', 'tunnel')][string]$Role)
  $definition = Get-JsRoleDefinition -Context $Context -Role $Role
  $pidSnapshot = Read-JsRuntimeFileSnapshot -Path $definition.pidFile
  $ownerSnapshot = Read-JsRuntimeFileSnapshot -Path $definition.ownerFile
  $ownership = Resolve-JsRoleOwnership -Context $Context -Role $Role
  if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot stop $Role while ownership is $($ownership.state)." }
  if ($ownership.state -eq 'Stopped') { return }
  $rootPid = [int]$ownership.managedPid
  $snapshots = @(Get-JsOwnedDescendants -RootPid $rootPid)
  $snapshotByPid = @{}; foreach ($entry in $snapshots) { $snapshotByPid[[int]$entry.ProcessId] = $entry }
  if (-not $snapshotByPid.ContainsKey($rootPid)) { throw 'OWNERSHIP_CHANGED: Managed root disappeared before stop.' }
  try { $ownerMetadata = [string]$ownerSnapshot.raw | ConvertFrom-Json }
  catch { throw 'OWNERSHIP_UNKNOWN: Owner metadata became unavailable before stop.' }
  $bindings = @(); $bindingByPid = @{}
  try {
    foreach ($entry in @($snapshots | Sort-Object Depth, ProcessId)) {
      if ([int]$entry.ProcessId -eq $PID) { throw 'OWNERSHIP_MISMATCH: Refusing to stop the lifecycle controller.' }
      $binding = Get-JsTerminationBinding -ExpectedProcess $entry
      if ($binding.state -eq 'MissingConfirmed') { continue }
      if ($binding.state -ne 'Present') { throw "OWNERSHIP_CHANGED: PID $($entry.ProcessId) changed before stop." }
      $bindings += [pscustomobject]@{ snapshot=$entry; nativeProcess=$binding.nativeProcess; process=$binding.process }
      $bindingByPid[[int]$entry.ProcessId] = $bindings[-1]
    }
    if (-not $bindingByPid.ContainsKey($rootPid) -or
        -not (Test-JsOwnerMetadata -Context $Context -Role $Role -Process $bindingByPid[$rootPid].process -Metadata $ownerMetadata)) {
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
  if (-not (Remove-JsStaleOwnershipPair -Definition $definition -PidSnapshot $pidSnapshot -OwnerSnapshot $ownerSnapshot)) {
    throw 'OWNERSHIP_CHANGED: Runtime metadata changed before cleanup.'
  }
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
  $startedInspection = Get-JsProcessInspection -ProcessId $process.Id
  $started = $startedInspection.process
  if ($startedInspection.state -ne 'Present' -or $null -eq $started) { throw 'HUB_START_FAILED: Started Hub runner is unavailable.' }
  Write-JsOwnerMetadata -Context $Context -Role hub -Process $started
  if (-not (Wait-JsCondition -TimeoutSeconds $Context.coreReadyTimeoutSeconds -Condition { Test-JsHubHealth -Context $Context })) {
    Stop-JsOwnedRole -Context $Context -Role hub
    throw 'HUB_NOT_READY: Hub failed bounded startup.'
  }
  $ready = Resolve-JsRoleOwnership -Context $Context -Role hub
  if ($ready.state -ne 'OwnedReady') { throw "OWNERSHIP_MISMATCH: Hub listener is not a descendant of the started runner (state=$($ready.state), reason=$($ready.reason), managedPid=$($ready.managedPid), listenerPid=$($ready.listenerPid))." }
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
  $startedInspection = Get-JsProcessInspection -ProcessId $process.Id
  $started = $startedInspection.process
  if ($startedInspection.state -ne 'Present' -or $null -eq $started) { throw 'MCP_START_FAILED: Started MCP adapter is unavailable.' }
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
  $startedInspection = Get-JsProcessInspection -ProcessId $process.Id
  $started = $startedInspection.process
  if ($startedInspection.state -ne 'Present' -or $null -eq $started) { throw 'TUNNEL_START_FAILED: Started tunnel is unavailable.' }
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
  $status = if (@($ownerships | Where-Object { $_.state -eq 'OwnershipUnknown' }).Count -gt 0) { 'OwnershipUnknown' }
    elseif (@($ownerships | Where-Object { $_.state -eq 'OwnershipMismatch' }).Count -gt 0) { 'OwnershipMismatch' }
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
