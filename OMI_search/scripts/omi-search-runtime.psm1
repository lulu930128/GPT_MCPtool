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

function Test-OmiStartTimeEqual {
  param([string]$Left, [string]$Right)
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
  $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  $leftTime = [DateTimeOffset]::MinValue
  $rightTime = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse($Left, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$leftTime)) { return $false }
  if (-not [DateTimeOffset]::TryParse($Right, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$rightTime)) { return $false }
  return ([Math]::Abs(($leftTime - $rightTime).TotalSeconds) -lt 1.0)
}

function Test-OmiStartTimeWithinWindow {
  param([string]$Candidate, [string]$NotBefore, [int]$MaximumSeconds = 15)
  if ([string]::IsNullOrWhiteSpace($Candidate) -or [string]::IsNullOrWhiteSpace($NotBefore)) { return $false }
  $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  $candidateTime = [DateTimeOffset]::MinValue
  $notBeforeTime = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse($Candidate, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$candidateTime)) { return $false }
  if (-not [DateTimeOffset]::TryParse($NotBefore, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$notBeforeTime)) { return $false }
  $delta = ($candidateTime - $notBeforeTime).TotalSeconds
  return ($delta -ge -1.0 -and $delta -le $MaximumSeconds)
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

function Read-OmiRuntimeFileSnapshot {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [pscustomobject]@{ exists=$false; raw=$null } }
  try { return [pscustomobject]@{ exists=$true; raw=[IO.File]::ReadAllText($Path) } }
  catch { return [pscustomobject]@{ exists=$true; raw=$null } }
}

function Remove-OmiRuntimeFileSnapshot {
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

function Remove-OmiStaleOwnershipPair {
  param($Definition, $PidSnapshot, $OwnerSnapshot)
  foreach ($entry in @(@{ path=$Definition.pidFile; snapshot=$PidSnapshot }, @{ path=$Definition.ownerFile; snapshot=$OwnerSnapshot })) {
    if ([bool]$entry.snapshot.exists) {
      if ($null -eq $entry.snapshot.raw -or -not (Test-Path -LiteralPath $entry.path -PathType Leaf) -or [IO.File]::ReadAllText($entry.path) -cne [string]$entry.snapshot.raw) { return $false }
    }
    elseif (Test-Path -LiteralPath $entry.path -PathType Leaf) { return $false }
  }
  if (-not (Remove-OmiRuntimeFileSnapshot -Path $Definition.ownerFile -Snapshot $OwnerSnapshot)) { return $false }
  return (Remove-OmiRuntimeFileSnapshot -Path $Definition.pidFile -Snapshot $PidSnapshot)
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
    $parentProcessId = $null
    try { $executablePath = [string]$process.Path } catch { }
    try { $startTimeUtc = $process.StartTime.ToUniversalTime().ToString("o") } catch { }
    try {
      $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
      $commandLine = [string]$cim.CommandLine
      $parentProcessId = [int]$cim.ParentProcessId
    }
    catch { }
    return [pscustomobject]@{
      ProcessId = [int]$process.Id
      Name = [string]$process.ProcessName
      ExecutablePath = $executablePath
      StartTimeUtc = $startTimeUtc
      CommandLine = $commandLine
      ParentProcessId = $parentProcessId
    }
  }
  catch { return $null }
}

function Get-OmiProcessInspection {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    $details = Get-OmiProcess -ProcessId $ProcessId
    if ($null -eq $details) { return [pscustomobject]@{ state="Unknown"; process=$null } }
    return [pscustomobject]@{ state="Present"; process=$details }
  }
  catch {
    $missing = $_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound
    return [pscustomobject]@{ state=$(if ($missing) { "MissingConfirmed" } else { "Unknown" }); process=$null }
  }
}

function Get-OmiTerminationBinding {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $nativeProcess = $null
  try {
    $nativeProcess = Get-Process -Id $ProcessId -ErrorAction Stop
    $null = $nativeProcess.Handle
    if ($nativeProcess.HasExited) {
      $nativeProcess.Dispose()
      return [pscustomobject]@{ state="MissingConfirmed"; process=$null; nativeProcess=$null }
    }
    $executablePath = [string]$nativeProcess.Path
    $startTimeUtc = $nativeProcess.StartTime.ToUniversalTime().ToString("o")
    if ([string]::IsNullOrWhiteSpace($executablePath) -or [string]::IsNullOrWhiteSpace($startTimeUtc)) { throw "Process identity is incomplete." }
    return [pscustomobject]@{
      state="Present"
      process=[pscustomobject]@{
        ProcessId=[int]$nativeProcess.Id; Name=[string]$nativeProcess.ProcessName
        ExecutablePath=$executablePath; StartTimeUtc=$startTimeUtc
        CommandLine=$null; ParentProcessId=$null
      }
      nativeProcess=$nativeProcess
    }
  }
  catch {
    if ($null -ne $nativeProcess) { try { $nativeProcess.Dispose() } catch { } }
    $missing = $_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound
    return [pscustomobject]@{ state=$(if ($missing) { "MissingConfirmed" } else { "Unknown" }); process=$null; nativeProcess=$null }
  }
}

function Stop-OmiBoundProcess {
  param([Parameter(Mandatory = $true)]$Binding, [int]$TimeoutMilliseconds = 5000)
  try {
    if ($Binding.state -ne "Present" -or $null -eq $Binding.nativeProcess) { throw "OWNERSHIP_CHANGED: Process binding is unavailable." }
    if (-not $Binding.nativeProcess.HasExited) { $Binding.nativeProcess.Kill() }
    if (-not $Binding.nativeProcess.WaitForExit($TimeoutMilliseconds)) { throw "STOP_TIMEOUT: Bound process did not exit." }
  }
  finally { if ($null -ne $Binding.nativeProcess) { $Binding.nativeProcess.Dispose() } }
}

function Read-OmiOwnerMetadataSnapshot {
  param([Parameter(Mandatory = $true)][string]$Path)
  $snapshot = Read-OmiRuntimeFileSnapshot -Path $Path
  if (-not $snapshot.exists) { return [pscustomobject]@{ file=$snapshot; state="Missing"; metadata=$null } }
  if ($null -eq $snapshot.raw) { return [pscustomobject]@{ file=$snapshot; state="Unknown"; metadata=$null } }
  try { return [pscustomobject]@{ file=$snapshot; state="Parsed"; metadata=$snapshot.raw | ConvertFrom-Json } }
  catch { return [pscustomobject]@{ file=$snapshot; state="Malformed"; metadata=$null } }
}

function Test-OmiOwnerMetadataComplete {
  param($Metadata)
  if ($null -eq $Metadata) { return $false }
  foreach ($name in @("schemaVersion", "role", "pid", "executablePath", "startTimeUtc", "identity")) {
    if ($null -eq $Metadata.PSObject.Properties[$name]) { return $false }
  }
  return (
    [int]$Metadata.schemaVersion -eq 1 -and
    -not [string]::IsNullOrWhiteSpace([string]$Metadata.role) -and
    [int]$Metadata.pid -gt 0 -and
    -not [string]::IsNullOrWhiteSpace([string]$Metadata.executablePath) -and
    -not [string]::IsNullOrWhiteSpace([string]$Metadata.startTimeUtc) -and
    -not [string]::IsNullOrWhiteSpace([string]$Metadata.identity)
  )
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
  foreach ($artifact in @($Context.sourceBuildArtifacts)) {
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

function Test-OmiManagedServerLineage {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)]$Process,
    [int]$RequiredLauncherPid = 0,
    [string]$RequiredLauncherStartTimeUtc = ""
  )
  $listenerCommandKnown = -not [string]::IsNullOrWhiteSpace([string]$Process.CommandLine)
  $listenerHasExactCommand = $listenerCommandKnown -and (Test-OmiLegacyCommandIdentity -Context $Context -Role server -Process $Process)
  $current = $Process
  for ($depth = 0; $depth -lt 6 -and $null -ne $current; $depth++) {
    $isManagedLauncher = (
      (Test-OmiPathEqual -Left ([string]$current.ExecutablePath) -Right ([string]$Context.pythonPath)) -and
      (Test-OmiLegacyCommandIdentity -Context $Context -Role server -Process $current)
    )
    if ($isManagedLauncher -and ($RequiredLauncherPid -le 0 -or [int]$current.ProcessId -eq $RequiredLauncherPid)) {
      return $true
    }
    if ($RequiredLauncherPid -gt 0 -and [int]$current.ProcessId -eq $RequiredLauncherPid) {
      return $false
    }
    if ($null -eq $current.ParentProcessId -or [int]$current.ParentProcessId -le 0) { break }
    $current = Get-OmiProcess -ProcessId ([int]$current.ParentProcessId)
  }
  if ($RequiredLauncherPid -gt 0 -and (-not $listenerCommandKnown -or $listenerHasExactCommand) -and
      [IO.Path]::GetFileName([string]$Process.ExecutablePath) -in @("python.exe", "pythonw.exe") -and
      (Test-OmiStartTimeWithinWindow -Candidate ([string]$Process.StartTimeUtc) -NotBefore $RequiredLauncherStartTimeUtc)) {
    # Windows venv shims may hand the server to the base interpreter and exit
    # before the listener is inspected. The listener is accepted only inside
    # this just-started window. If Windows exposes a command line it must match;
    # otherwise the caller also requires the exact build health before adoption.
    return $true
  }
  return $false
}

function Test-OmiExecutableIdentity {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)][ValidateSet("server", "tunnel")][string]$Role,
    [Parameter(Mandatory = $true)]$Process
  )
  $definition = Get-OmiRoleDefinition -Context $Context -Role $Role
  if (Test-OmiPathEqual -Left ([string]$Process.ExecutablePath) -Right ([string]$definition.executablePath)) {
    return $true
  }
  if ($Role -ne "server") { return $false }
  if (Test-OmiManagedServerLineage -Context $Context -Process $Process) { return $true }
  $leafName = [IO.Path]::GetFileName([string]$Process.ExecutablePath)
  return (
    $leafName -in @("python.exe", "pythonw.exe") -and
    (Test-OmiOwnerMetadata -Context $Context -Role server -Process $Process) -and
    ([string]::IsNullOrWhiteSpace([string]$Process.CommandLine) -or
      (Test-OmiLegacyCommandIdentity -Context $Context -Role server -Process $Process))
  )
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
  if (-not (Test-OmiOwnerMetadataComplete -Metadata $metadata)) { return $false }
  $startTimeMatches = if ($Role -eq "server") {
    Test-OmiStartTimeEqual -Left ([string]$metadata.startTimeUtc) -Right ([string]$Process.StartTimeUtc)
  } else {
    [string]$metadata.startTimeUtc -eq [string]$Process.StartTimeUtc
  }
  return (
    [int]$metadata.schemaVersion -eq 1 -and
    [string]$metadata.role -eq $Role -and
    [int]$metadata.pid -eq [int]$Process.ProcessId -and
    (Test-OmiPathEqual -Left ([string]$metadata.executablePath) -Right ([string]$Process.ExecutablePath)) -and
    -not [string]::IsNullOrWhiteSpace([string]$Process.StartTimeUtc) -and
    $startTimeMatches -and
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
  $pidSnapshot = Read-OmiRuntimeFileSnapshot -Path $definition.pidFile
  $ownerInspection = Read-OmiOwnerMetadataSnapshot -Path $definition.ownerFile
  $managedPid = Read-OmiPidFile -Path $definition.pidFile
  $processInspection = if ($null -eq $managedPid) { $null } else { Get-OmiProcessInspection -ProcessId $managedPid }
  $listener = Get-OmiListenerState -Port $definition.port
  if (-not $listener.known) {
    return [pscustomobject]@{ role=$Role; state="OwnershipUnknown"; pid=$managedPid; listenerPid=$null; reason=$listener.errorCode; canMutate=$false; adopted=$false }
  }
  if ($listener.pids.Count -gt 1) {
    return [pscustomobject]@{ role=$Role; state="OwnershipMismatch"; pid=$managedPid; listenerPid=$null; reason="multiple_listener_owners"; canMutate=$false; adopted=$false }
  }
  $listenerPid = if ($listener.pids.Count -eq 1) { [int]$listener.pids[0] } else { $null }

  if ($pidSnapshot.exists -and $null -eq $managedPid) {
    if ($null -ne $listenerPid) {
      return [pscustomobject]@{ role=$Role; state="OwnershipMismatch"; pid=$null; listenerPid=$listenerPid; reason="invalid_pid_file_with_listener"; canMutate=$false; adopted=$false }
    }
    if (-not (Remove-OmiStaleOwnershipPair -Definition $definition -PidSnapshot $pidSnapshot -OwnerSnapshot $ownerInspection.file)) {
      return [pscustomobject]@{ role=$Role; state="OwnershipUnknown"; pid=$null; listenerPid=$null; reason="stale_metadata_changed_during_cleanup"; canMutate=$false; adopted=$false }
    }
  }

  if ($null -ne $managedPid) {
    if ($processInspection.state -eq "Unknown") {
      return [pscustomobject]@{ role=$Role; state="OwnershipUnknown"; pid=$managedPid; listenerPid=$listenerPid; reason="process_inspection_failed"; canMutate=$false; adopted=$false }
    }
    if ($processInspection.state -eq "MissingConfirmed") {
      if ($null -ne $listenerPid) {
        return [pscustomobject]@{ role=$Role; state="OwnershipMismatch"; pid=$managedPid; listenerPid=$listenerPid; reason="stale_pid_with_listener"; canMutate=$false; adopted=$false }
      }
      if (-not (Remove-OmiStaleOwnershipPair -Definition $definition -PidSnapshot $pidSnapshot -OwnerSnapshot $ownerInspection.file)) {
        return [pscustomobject]@{ role=$Role; state="OwnershipUnknown"; pid=$managedPid; listenerPid=$null; reason="stale_metadata_changed_during_cleanup"; canMutate=$false; adopted=$false }
      }
      $managedPid = $null
    }
  }

  $managedProcess = if ($null -ne $managedPid) { $processInspection.process } else { $null }
  if ($null -ne $managedProcess) {
    if ([string]::IsNullOrWhiteSpace([string]$managedProcess.ExecutablePath) -or [string]::IsNullOrWhiteSpace([string]$managedProcess.StartTimeUtc)) {
      return [pscustomobject]@{ role=$Role; state="OwnershipUnknown"; pid=$managedPid; listenerPid=$listenerPid; reason="process_identity_unavailable"; canMutate=$false; adopted=$false }
    }
    $metadataComplete = $ownerInspection.state -eq "Parsed" -and (Test-OmiOwnerMetadataComplete -Metadata $ownerInspection.metadata)
    $sameRecordedPid = $metadataComplete -and [int]$ownerInspection.metadata.pid -eq $managedPid
    $instanceMismatch = (
      -not (Test-OmiExecutableIdentity -Context $Context -Role $Role -Process $managedProcess) -or
      ($sameRecordedPid -and (
        -not (Test-OmiPathEqual -Left ([string]$ownerInspection.metadata.executablePath) -Right ([string]$managedProcess.ExecutablePath)) -or
        -not (Test-OmiStartTimeEqual -Left ([string]$ownerInspection.metadata.startTimeUtc) -Right ([string]$managedProcess.StartTimeUtc))
      ))
    )
    if ($instanceMismatch) {
      if ($null -ne $listenerPid) {
        return [pscustomobject]@{ role=$Role; state="OwnershipMismatch"; pid=$managedPid; listenerPid=$listenerPid; reason="pid_process_mismatch"; canMutate=$false; adopted=$false }
      }
      if (-not (Remove-OmiStaleOwnershipPair -Definition $definition -PidSnapshot $pidSnapshot -OwnerSnapshot $ownerInspection.file)) {
        return [pscustomobject]@{ role=$Role; state="OwnershipUnknown"; pid=$managedPid; listenerPid=$null; reason="stale_metadata_changed_during_cleanup"; canMutate=$false; adopted=$false }
      }
      $managedPid = $null
      $managedProcess = $null
    }
    elseif (-not $metadataComplete -or -not $sameRecordedPid) {
      if ($AdoptLegacyExactListener -and $null -ne $listenerPid -and $listenerPid -eq $managedPid -and
          (Test-OmiRoleReady -Context $Context -Role $Role) -and
          (Test-OmiLegacyCommandIdentity -Context $Context -Role $Role -Process $managedProcess)) {
        Write-OmiOwnerMetadata -Context $Context -Role $Role -Process $managedProcess
        $ownerInspection = Read-OmiOwnerMetadataSnapshot -Path $definition.ownerFile
      }
      else {
        return [pscustomobject]@{ role=$Role; state="OwnershipUnknown"; pid=$managedPid; listenerPid=$listenerPid; reason="owner_metadata_unavailable_or_incoherent"; canMutate=$false; adopted=$false }
      }
    }
  }

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
  $status = if ($ownerStates -contains "OwnershipUnknown") {
    "OwnershipUnknown"
  }
  elseif ($ownerStates -contains "OwnershipMismatch") {
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
  $pidSnapshot = Read-OmiRuntimeFileSnapshot -Path $definition.pidFile
  $ownerSnapshot = Read-OmiRuntimeFileSnapshot -Path $definition.ownerFile
  $ownership = Resolve-OmiRoleOwnership -Context $Context -Role $Role
  if (-not $ownership.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot stop $Role because ownership is $($ownership.state)." }
  if ($ownership.state -eq "Stopped") { return }
  $binding = Get-OmiTerminationBinding -ProcessId ([int]$ownership.pid)
  if ($binding.state -ne "Present" -or
      -not (Test-OmiExecutableIdentity -Context $Context -Role $Role -Process $binding.process) -or
      -not (Test-OmiOwnerMetadata -Context $Context -Role $Role -Process $binding.process)) {
    if ($null -ne $binding.nativeProcess) { $binding.nativeProcess.Dispose() }
    throw "OWNERSHIP_CHANGED: $Role process instance changed before stop."
  }
  Stop-OmiBoundProcess -Binding $binding
  if (-not (Remove-OmiStaleOwnershipPair -Definition $definition -PidSnapshot $pidSnapshot -OwnerSnapshot $ownerSnapshot)) {
    throw "OWNERSHIP_CHANGED: Runtime metadata changed before cleanup."
  }
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
  foreach ($required in @($Context.pythonPath) + @($Context.sourceBuildArtifacts)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "SERVER_ENTRY_MISSING: Adapter source is incomplete." }
  }
  $dependencyProbe = & $Context.pythonPath -B -c "import importlib.metadata; assert importlib.metadata.version('mcp') == '2.1.1'; import uvicorn" 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "SERVER_DEPENDENCY_MISMATCH: Locked MCP runtime is unavailable. $dependencyProbe"
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
  $startedPidSnapshot = Read-OmiRuntimeFileSnapshot -Path $Context.serverPidFile
  $startedOwnerSnapshot = Read-OmiRuntimeFileSnapshot -Path $Context.serverOwnerFile
  if (-not (Wait-OmiCondition -TimeoutSeconds $Context.serverReadyTimeoutSeconds -Condition { Test-OmiServerHealth -Context $Context })) {
    try {
      $null = $process.Handle
      if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(5000) }
    }
    catch { }
    $definition = Get-OmiRoleDefinition -Context $Context -Role server
    $null = Remove-OmiStaleOwnershipPair -Definition $definition -PidSnapshot $startedPidSnapshot -OwnerSnapshot $startedOwnerSnapshot
    throw "SERVER_NOT_READY: Adapter did not reach its expected source build."
  }
  $listener = Get-OmiListenerState -Port $Context.port
  if (-not $listener.known -or $listener.pids.Count -ne 1) {
    throw "OWNERSHIP_MISMATCH: Started server listener ownership is ambiguous."
  }
  $listenerPid = [int]$listener.pids[0]
  if ($listenerPid -ne $process.Id) {
    $listenerProcess = Get-OmiProcess -ProcessId $listenerPid
    if ($null -eq $listenerProcess) {
      throw "OWNERSHIP_MISMATCH: Started server listener process is unavailable."
    }
    if (-not (Test-OmiManagedServerLineage -Context $Context -Process $listenerProcess -RequiredLauncherPid $process.Id -RequiredLauncherStartTimeUtc $started.StartTimeUtc)) {
      $diagnostic = [ordered]@{
        listenerPid = $listenerPid
        listenerExecutable = [IO.Path]::GetFileName([string]$listenerProcess.ExecutablePath)
        listenerCommandKnown = -not [string]::IsNullOrWhiteSpace([string]$listenerProcess.CommandLine)
        listenerParentPid = $listenerProcess.ParentProcessId
        listenerStartTimeUtc = $listenerProcess.StartTimeUtc
        launcherPid = $process.Id
        launcherStartTimeUtc = $started.StartTimeUtc
      } | ConvertTo-Json -Compress
      throw "OWNERSHIP_MISMATCH: Started server listener executable is outside the managed Python lineage. $diagnostic"
    }
    Write-OmiAtomicText -Path $Context.serverPidFile -Value ([string]$listenerPid)
    Write-OmiOwnerMetadata -Context $Context -Role server -Process $listenerProcess
  }
  $readyOwner = Resolve-OmiRoleOwnership -Context $Context -Role server
  if (-not $readyOwner.canMutate -or $readyOwner.pid -ne $listenerPid) { throw "OWNERSHIP_MISMATCH: Started server does not own the listener." }
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
    [int]$Port = 18797,
    [string]$OmiApiBaseUrl = "http://127.0.0.1:8400",
    [switch]$StrictOmiApiBaseUrl,
    [string]$Token,
    [string]$PythonPath,
    [string]$TunnelClientPath = "C:\GPT_MCPtool\project_reading\vendor\tunnel-client\tunnel-client.exe",
    [string]$TunnelProfileDir,
    [string]$TunnelProfile = "omi-search",
    [string]$TunnelHealthUrl = "http://127.0.0.1:18799",
    [string]$KeyStorePath = "C:\GPT_MCPtool\project_reading\scripts\key-store.ps1",
    [string]$SecretPath,
    [int]$ServerReadyTimeoutSeconds = 20,
    [int[]]$TunnelRecoveryDelaysSeconds = @(15, 30, 60)
  )
  $resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path
  $runtimeDir = Join-Path $resolvedRoot ".tmp"
  if ([string]::IsNullOrWhiteSpace($PythonPath)) {
    $managedPythonPath = Join-Path $resolvedRoot ".venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $managedPythonPath -PathType Leaf)) {
      throw "MANAGED_PYTHON_MISSING: Run 'uv sync --frozen' in $resolvedRoot before starting OMI Search."
    }
    $PythonPath = $managedPythonPath
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
    dashboardContractSnapshot = Join-Path $resolvedRoot "tw_market_dashboard_contract_snapshot.json"
    widgetBundle = Join-Path $resolvedRoot "ui\tw-market-dashboard\dist\index.html"
    sourceBuildArtifacts = @(
      (Join-Path $resolvedRoot "http_server.py")
      (Join-Path $resolvedRoot "server.py")
      (Join-Path $resolvedRoot "pyproject.toml")
      (Join-Path $resolvedRoot "uv.lock")
      (Join-Path $resolvedRoot "public_contract_snapshot.json")
      (Join-Path $resolvedRoot "tw_market_dashboard_contract_snapshot.json")
      (Join-Path $resolvedRoot "ui\tw-market-dashboard\dist\index.html")
    )
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
