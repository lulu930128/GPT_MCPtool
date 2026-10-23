Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$script:Utf8NoBom = New-Object Text.UTF8Encoding($false)

function Test-CbPathEqual {
  param([string]$Left, [string]$Right)
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
  try { return [IO.Path]::GetFullPath($Left).TrimEnd('\').Equals([IO.Path]::GetFullPath($Right).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) }
  catch { return $false }
}

function Read-CbTunnelIdFromProfile {
  param([Parameter(Mandatory=$true)][string]$ProfilePath)
  if(-not(Test-Path -LiteralPath $ProfilePath -PathType Leaf)){return [pscustomobject]@{status='MissingProfile';value=$null;errorCode='TUNNEL_PROFILE_MISSING'}}
  try{$lines=@(Get-Content -LiteralPath $ProfilePath -Encoding UTF8 -ErrorAction Stop)}catch{return [pscustomobject]@{status='InvalidProfile';value=$null;errorCode='TUNNEL_PROFILE_INVALID'}}
  $values=@()
  foreach($line in $lines){
    if([string]$line-notmatch'^\s*tunnel_id\s*:'){continue}
    $raw=([string]$line-replace'^\s*tunnel_id\s*:\s*','').Trim()
    if($raw-match'^"([^"\r\n]+)"\s*(?:#.*)?$'){$values+=$matches[1]}
    elseif($raw-match"^'([^'\r\n]+)'\s*(?:#.*)?$"){$values+=$matches[1]}
    elseif($raw-match'^([^#\s]+)\s*(?:#.*)?$'){$values+=$matches[1]}
    else{return [pscustomobject]@{status='InvalidProfile';value=$null;errorCode='TUNNEL_PROFILE_INVALID'}}
  }
  if($values.Count-eq 0){return [pscustomobject]@{status='MissingId';value=$null;errorCode='TUNNEL_ID_MISSING'}}
  if($values.Count-ne 1){return [pscustomobject]@{status='InvalidProfile';value=$null;errorCode='TUNNEL_PROFILE_INVALID'}}
  return [pscustomobject]@{status='Present';value=[string]$values[0];errorCode=$null}
}

function Resolve-CbTunnelIdentity {
  param([string]$ExplicitTunnelId,[string]$SettingsTunnelId,[string]$EnvironmentTunnelId,[Parameter(Mandatory=$true)][string]$ProfilePath)
  $profile=Read-CbTunnelIdFromProfile -ProfilePath $ProfilePath
  $sources=@()
  foreach($candidate in @(
    [pscustomobject]@{name='explicit';value=$ExplicitTunnelId},
    [pscustomobject]@{name='settings';value=$SettingsTunnelId},
    [pscustomobject]@{name='environment';value=$EnvironmentTunnelId},
    [pscustomobject]@{name='profile';value=$(if($profile.status-eq'Present'){$profile.value}else{$null})}
  )){if(-not[string]::IsNullOrWhiteSpace([string]$candidate.value)){$sources+=$candidate}}
  $sourceNames=@($sources|ForEach-Object{[string]$_.name})
  if($profile.status-eq'InvalidProfile'){return [pscustomobject]@{status='Invalid';errorCode='TUNNEL_PROFILE_INVALID';sourceNames=$sourceNames;sourceCount=$sources.Count;resolvedTunnelId=$null}}
  foreach($source in $sources){if([string]$source.value-notmatch'^tunnel_[A-Za-z0-9_-]{1,256}$'){return [pscustomobject]@{status='Invalid';errorCode='TUNNEL_ID_INVALID';sourceNames=$sourceNames;sourceCount=$sources.Count;resolvedTunnelId=$null}}}
  if($sources.Count-eq 0){return [pscustomobject]@{status='Missing';errorCode=$(if($profile.status-eq'MissingProfile'){'TUNNEL_PROFILE_MISSING'}else{'TUNNEL_ID_MISSING'});sourceNames=@();sourceCount=0;resolvedTunnelId=$null}}
  $distinct=@($sources|ForEach-Object{[string]$_.value}|Sort-Object -Unique)
  if($distinct.Count-ne 1){return [pscustomobject]@{status='Mismatch';errorCode='TUNNEL_ID_MISMATCH';sourceNames=$sourceNames;sourceCount=$sources.Count;resolvedTunnelId=$null}}
  return [pscustomobject]@{status='Ready';errorCode=$null;sourceNames=$sourceNames;sourceCount=$sources.Count;resolvedTunnelId=[string]$distinct[0]}
}

function Get-CbTunnelIdentitySummary {
  param([Parameter(Mandatory=$true)]$Identity)
  return [pscustomobject]@{status=[string]$Identity.status;errorCode=$(if([string]::IsNullOrWhiteSpace([string]$Identity.errorCode)){$null}else{[string]$Identity.errorCode});sourceNames=@($Identity.sourceNames);sourceCount=[int]$Identity.sourceCount}
}

function Assert-CbTunnelIdentityReady {
  param([Parameter(Mandatory=$true)]$Context)
  if([string]$Context.tunnelIdentity.status-eq'Ready'){return}
  switch([string]$Context.tunnelIdentity.errorCode){
    'TUNNEL_PROFILE_MISSING'{throw 'TUNNEL_PROFILE_MISSING: Tunnel profile is missing and no other tunnel identity source is configured.'}
    'TUNNEL_PROFILE_INVALID'{throw 'TUNNEL_PROFILE_INVALID: Tunnel profile identity is malformed or duplicated.'}
    'TUNNEL_ID_INVALID'{throw 'TUNNEL_ID_INVALID: A configured tunnel identity has an invalid format.'}
    'TUNNEL_ID_MISMATCH'{throw 'TUNNEL_ID_MISMATCH: Configured tunnel identity sources disagree.'}
    default{throw 'TUNNEL_ID_MISSING: No tunnel identity is configured.'}
  }
}

function ConvertTo-CbRemoteRegistrationEvidence {
  param([int]$ExitCode,[AllowEmptyString()][string]$Output,[switch]$TimedOut,[string]$ExpectedTunnelId,[DateTimeOffset]$CheckedAtUtc=[DateTimeOffset]::UtcNow,[ValidateRange(30,3600)][int]$TtlSeconds=300)
  $status='Failed';$errorCode=$null
  if($TimedOut){$errorCode='TUNNEL_REMOTE_TIMEOUT'}
  elseif([string]::IsNullOrWhiteSpace($ExpectedTunnelId)){$errorCode='TUNNEL_ID_MISSING'}
  elseif(([string]$Output).Length-gt 65536){$errorCode='TUNNEL_REMOTE_RESPONSE_TOO_LARGE'}
  elseif($ExitCode-eq 0){
    try{
      $document=$Output|ConvertFrom-Json -ErrorAction Stop;$remoteId=$null;$candidates=@($document)
      foreach($nestedName in @('tunnel','data')){$nestedProperty=$document.PSObject.Properties[$nestedName];if($null-ne$nestedProperty-and$null-ne$nestedProperty.Value){$candidates+=$nestedProperty.Value}}
      foreach($candidate in $candidates){
        if($null-eq$candidate){continue}
        foreach($name in @('id','tunnel_id','tunnelId')){$property=$candidate.PSObject.Properties[$name];if($null-ne$property-and-not[string]::IsNullOrWhiteSpace([string]$property.Value)){$remoteId=[string]$property.Value;break}}
        if(-not[string]::IsNullOrWhiteSpace($remoteId)){break}
      }
      if([string]::IsNullOrWhiteSpace($remoteId)){$errorCode='TUNNEL_REMOTE_RESPONSE_INVALID'}
      elseif($remoteId-ne$ExpectedTunnelId){$errorCode='TUNNEL_REMOTE_ID_MISMATCH'}
      else{$status='Ready'}
    }catch{$errorCode='TUNNEL_REMOTE_RESPONSE_INVALID'}
  }
  else{
    $normalized=([string]$Output).ToLowerInvariant()
    if($normalized-match'\b401\b|unauthori[sz]ed|authentication'){$errorCode='TUNNEL_REMOTE_UNAUTHORIZED'}
    elseif($normalized-match'\b403\b|forbidden|permission denied'){$errorCode='TUNNEL_REMOTE_FORBIDDEN'}
    elseif($normalized-match'\b404\b|not found'){$errorCode='TUNNEL_REMOTE_NOT_FOUND'}
    elseif($normalized-match'timeout|timed out|connection refused|connection reset|no such host|dns|network'){$errorCode='TUNNEL_REMOTE_UNAVAILABLE'}
    else{$errorCode='TUNNEL_REMOTE_LOOKUP_FAILED'}
  }
  $checked=$CheckedAtUtc.ToUniversalTime();$validUntil=$checked.AddSeconds($TtlSeconds)
  return [pscustomobject]@{status=$status;checkedAt=$checked.ToString('o');validUntil=$validUntil.ToString('o');errorCode=$errorCode;source='codex_bridge_remote_diagnostic'}
}

function Write-CbAtomicText {
  param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][string]$Value)
  $directory=Split-Path -Parent $Path; New-Item -ItemType Directory -Force -Path $directory|Out-Null
  $temporary="$Path.tmp.${PID}.$([Guid]::NewGuid().ToString('N'))"
  try { [IO.File]::WriteAllText($temporary,$Value,$script:Utf8NoBom); Move-Item -LiteralPath $temporary -Destination $Path -Force }
  finally { if(Test-Path -LiteralPath $temporary -PathType Leaf){Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue} }
}

function Read-CbPidFile {
  param([Parameter(Mandatory=$true)][string]$Path)
  if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){return $null}
  try{$parsed=0;if([int]::TryParse(([IO.File]::ReadAllText($Path).Trim()),[ref]$parsed)-and $parsed-gt 0){return $parsed}}catch{}
  return $null
}

function Remove-CbRuntimeFile {
  param([Parameter(Mandatory=$true)][string]$Path,[int]$ExpectedPid=0)
  if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){return}
  if($ExpectedPid-gt 0){$current=Read-CbPidFile -Path $Path;if($null-ne$current-and$current-ne$ExpectedPid){return}}
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

function Get-CbProcess {
  param([Parameter(Mandatory=$true)][int]$ProcessId)
  try{
    $process=Get-Process -Id $ProcessId -ErrorAction Stop;$commandLine=$null
    try{$cim=Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop;$commandLine=[string]$cim.CommandLine}catch{}
    return [pscustomobject]@{ProcessId=[int]$process.Id;Name=[string]$process.ProcessName;ExecutablePath=try{[string]$process.Path}catch{$null};StartTimeUtc=try{$process.StartTime.ToUniversalTime().ToString('o')}catch{$null};CommandLine=$commandLine}
  }catch{return $null}
}

function Get-CbListenerState {
  param([Parameter(Mandatory=$true)][int]$Port)
  $netstatPath=if(Test-CbInstalledLayout){'C:\Windows\System32\netstat.exe'}else{Join-Path $env:WINDIR 'System32\netstat.exe'}
  try{
    $lines=@(& $netstatPath -ano -p tcp 2>$null);if($LASTEXITCODE-ne 0){throw 'netstat failed'};$pids=@()
    foreach($line in $lines){$parts=@(([string]$line).Trim()-split '\s+');if($parts.Count-lt 5-or$parts[0]-ne'TCP'-or$parts[3]-ne'LISTENING'){continue};if($parts[1]-notmatch':(\d+)$'-or[int]$matches[1]-ne$Port){continue};$parsed=0;if([int]::TryParse($parts[4],[ref]$parsed)-and$parsed-gt 0){$pids+=$parsed}}
    return [pscustomobject]@{known=$true;pids=@($pids|Sort-Object -Unique);errorCode=$null}
  }catch{return [pscustomobject]@{known=$false;pids=@();errorCode='listener_query_failed'}}
}

function Invoke-CbBuildIdHelper {
  param([Parameter(Mandatory=$true)]$Context,[switch]$StartupPreflight)
  if($null -ne $Context.PSObject.Properties['installedBinding']){
    $binding=Get-CbInstalledBinding
    if($Context.projectRoot -ine $binding.codeRoot -or $Context.nodePath -ine $binding.nodePath -or
      -not[string]::IsNullOrEmpty([string]$Context.expectedBuildId)){throw 'INSTALLED_CONTEXT_TAMPERED'}
  }
  $root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
  if(-not(Test-CbPathEqual -Left $Context.projectRoot -Right $root)){throw 'BUILD_ID_PATH_UNSAFE'}
  $helper=Join-Path $PSScriptRoot 'runtime-build-id.mjs'
  foreach($required in @(@{path=$helper;code='BUILD_ID_HELPER_MISSING'},@{path=(Join-Path $root 'dist\src\config.js');code='BUILD_ID_CONFIG_MISSING'})){
    if(-not(Test-Path -LiteralPath $required.path -PathType Leaf)){throw $required.code}
    # Refuse redirected code paths. Trust remains with the installed source/build;
    # this is not a signature or a second implementation of the build digest.
    $path=$required.path
    while($path){
      if($path.IndexOfAny([char[]]@('"',"`r","`n",[char]0))-ge 0){throw 'BUILD_ID_PATH_UNSAFE'}
      if(((Get-Item -LiteralPath $path -Force).Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'BUILD_ID_PATH_UNSAFE'}
      $path=Split-Path -Parent $path
    }
  }
  $node=[string]$Context.nodePath
  if(-not[IO.Path]::IsPathRooted($node)-or[IO.Path]::GetFileName($node)-ine'node.exe'-or-not(Test-Path -LiteralPath $node -PathType Leaf)){throw 'BUILD_ID_NODE_INVALID'}
  $startInfo=New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName=$node
  # A fixed, validated file argument, never shell source or caller-provided code.
  $startInfo.Arguments='"'+$helper+'"'
  if($StartupPreflight){$startInfo.Arguments+=' --startup-preflight'}
  $startInfo.WorkingDirectory=$root
  $startInfo.UseShellExecute=$false;$startInfo.CreateNoWindow=$true
  $startInfo.RedirectStandardOutput=$true;$startInfo.RedirectStandardError=$true
  # Do not inherit secrets or Node preload/loader options into this pure reader.
  # Retain locale selection so Node's canonical localeCompare semantics agree.
  try{$childEnvironment=$startInfo.get_EnvironmentVariables()}catch{
    # .NET Framework can encounter duplicate PATH/Path entries inherited from
    # a host. Its dictionary is then partially initialized; discard all entries.
    if($_.Exception.InnerException-isnot[ArgumentException]){throw}
    $childEnvironment=$startInfo.get_EnvironmentVariables()
  }
  $childEnvironment.Clear()
  foreach($name in @('SystemRoot','WINDIR','TEMP','TMP','LANG','LC_ALL','LC_CTYPE','LC_MESSAGES')){
    $value=[Environment]::GetEnvironmentVariable($name,[EnvironmentVariableTarget]::Process)
    if($null-ne$value){$childEnvironment[$name]=$value}
  }
  if($StartupPreflight){
    # Match the server's explicit configuration without inheriting Node loaders,
    # bearer tokens, tunnel credentials, or opening any runtime store.
    if($null-ne$Context.PSObject.Properties['installedBinding']){
      $config=Get-CbInstalledChildEnvironment $Context.installedBinding
    }else{
      foreach($name in @('USERPROFILE','LOCALAPPDATA','APPDATA','CODEX_HOME','PATH')){
        $value=[Environment]::GetEnvironmentVariable($name,'Process')
        if($null-ne$value){$childEnvironment[$name]=$value}
      }
      $config=@{CODEX_BRIDGE_PROJECT_ROOT=$Context.projectRoot;CODEX_BRIDGE_PROJECTS_FILE=$Context.projectsFile;
        CODEX_BRIDGE_DATA_DIR=$Context.dataDir;CODEX_BRIDGE_HTTP_HOST=$Context.hostName;CODEX_BRIDGE_HTTP_PORT=[string]$Context.port;
        CODEX_BRIDGE_CODEX_COMMAND=$Context.codexCommand;CODEX_BRIDGE_CODEX_ARGS=$Context.codexArgs}
    }
    foreach($entry in $config.GetEnumerator()){if(-not[string]::IsNullOrWhiteSpace([string]$entry.Value)){$childEnvironment[$entry.Key]=[string]$entry.Value}}
  }
  $process=New-Object Diagnostics.Process;$process.StartInfo=$startInfo
  try{
    if(-not$process.Start()){throw 'BUILD_ID_START_FAILED'}
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $stdoutBuffer=New-Object char[] 64;$stderrBuffer=New-Object char[] 1
    $stdoutTask=$process.StandardOutput.ReadAsync($stdoutBuffer,0,$stdoutBuffer.Length)
    $stderrTask=$process.StandardError.ReadAsync($stderrBuffer,0,$stderrBuffer.Length)
    $output='';$stdoutDone=$false;$stderrDone=$false
    while(-not($stdoutDone-and$stderrDone-and$process.HasExited)){
      if($clock.ElapsedMilliseconds-ge 10000){throw 'BUILD_ID_TIMEOUT'}
      if(-not$stderrDone-and$stderrTask.IsCompleted){
        if($stderrTask.GetAwaiter().GetResult()-gt 0){throw 'BUILD_ID_STDERR'}
        $stderrDone=$true
      }
      if(-not$stdoutDone-and$stdoutTask.IsCompleted){
        $count=$stdoutTask.GetAwaiter().GetResult()
        if($count-eq 0){$stdoutDone=$true}else{
          $output+=(-join $stdoutBuffer[0..($count-1)])
          if($output.Length-gt 18){throw 'BUILD_ID_OUTPUT_INVALID'}
          $stdoutTask=$process.StandardOutput.ReadAsync($stdoutBuffer,0,$stdoutBuffer.Length)
        }
      }
      if(-not($stdoutDone-and$stderrDone-and$process.HasExited)){Start-Sleep -Milliseconds 10}
    }
    if($process.ExitCode-ne 0){throw 'BUILD_ID_COMPUTE_FAILED'}
    if($output-cnotmatch'\A[0-9a-f]{16}\r?\n?\z'){throw 'BUILD_ID_OUTPUT_INVALID'}
    return $output.TrimEnd("`r","`n")
  }
  finally{
    # Only the helper process created above can be terminated on timeout/error.
    try{if(-not$process.HasExited){$process.Kill();[void]$process.WaitForExit(1000)}}catch{}
    $process.Dispose()
  }
}

function Get-CbExpectedBuildId {
  param([Parameter(Mandatory=$true)]$Context)
  if(-not[string]::IsNullOrWhiteSpace([string]$Context.expectedBuildId)){return [string]$Context.expectedBuildId}
  # A context belongs to one lifecycle call, including before/after status and
  # health polling. Cache failures too; the next call gets a fresh context.
  if($null-eq$Context.PSObject.Properties['buildIdCache']){
    $cache=[pscustomobject]@{value=$null;error=$null}
    try{$cache.value=Invoke-CbBuildIdHelper -Context $Context}catch{
      $errors=@{
        BUILD_ID_HELPER_MISSING='Canonical Build ID helper is missing; restore scripts/runtime-build-id.mjs.'
        BUILD_ID_CONFIG_MISSING='Canonical Build ID module is missing; run npm run build.'
        BUILD_ID_PATH_UNSAFE='Canonical Build ID paths must belong to this component without reparse points.'
        BUILD_ID_NODE_INVALID='Build ID requires the controller absolute node.exe path.'
        BUILD_ID_START_FAILED='Could not start the canonical Build ID helper.'
        BUILD_ID_TIMEOUT='Canonical Build ID helper exceeded the 10 second deadline.'
        BUILD_ID_STDERR='Canonical Build ID helper wrote to stderr; output was suppressed.'
        BUILD_ID_OUTPUT_INVALID='Canonical Build ID helper did not return one 16 character lowercase hex ID.'
        BUILD_ID_COMPUTE_FAILED='Canonical Build ID helper failed; verify the Node installation and build.'
      }
      $code=[string]$_.Exception.Message
      if(-not$errors.ContainsKey($code)){$code='BUILD_ID_COMPUTE_FAILED'}
      $cache.error=$code+': '+$errors[$code]
    }
    $Context|Add-Member -NotePropertyName buildIdCache -NotePropertyValue $cache
  }
  if($null-ne$Context.buildIdCache.error){throw $Context.buildIdCache.error}
  return [string]$Context.buildIdCache.value
}

function Test-CbBuildCurrent {
  param([Parameter(Mandatory=$true)]$Context)
  if(-not(Test-Path -LiteralPath $Context.httpEntry -PathType Leaf)){return $false}
  if($null -ne $Context.PSObject.Properties['installedBinding'] -or (Test-CbInstalledLayout)){
    # An immutable release is verified against its protected manifest/closure,
    # exact context and selected owner. Individually staged, verified artifacts
    # need not share http-main.js's timestamp. Never trust a caller's binding flag.
    Assert-CbInstalledMutationBlocked $Context
    return $true
  }
  $entryTime=(Get-Item -LiteralPath $Context.httpEntry).LastWriteTimeUtc
  try{
    $sources=@(Get-ChildItem -LiteralPath (Join-Path $Context.projectRoot 'src') -Recurse -File -ErrorAction Stop)+@(Get-ChildItem -LiteralPath (Join-Path $Context.projectRoot 'web') -Recurse -File -ErrorAction Stop)+@(Get-Item -LiteralPath (Join-Path $Context.projectRoot 'package.json') -ErrorAction Stop)
  }catch{throw 'BUILD_CHECK_FAILED: Required build inputs could not be inspected; existing processes are preserved.'}
  return @($sources|Where-Object{$_.LastWriteTimeUtc-gt$entryTime}).Count-eq 0
}

function Assert-CbCooperativeSourceAvailable {
  param($Context)
  $scripts=Join-Path $Context.projectRoot 'scripts'
  $native=Join-Path (Split-Path -Parent $Context.projectRoot) 'mcp_control_center\src'
  $installed=Test-CbInstalledLayout
  $ownedNative=if($installed){'OwnedProcess.Native.dll'}else{'OwnedProcess.Native.cs'}
  $normalNative=if($installed){'NormalOperator.Host.dll'}else{'NormalOperator.Native.cs'}
  $reloadNative=if($installed){'RemoteSelfReload.Native.dll'}else{'RemoteSelfReload.Native.cs'}
  foreach($required in @((Join-Path $scripts 'cooperative-shutdown-host.ps1'),(Join-Path $scripts 'process-identity.ps1'),
    (Join-Path $scripts $ownedNative),(Join-Path $native $normalNative),
    (Join-Path $native $reloadNative),
    (Join-Path $Context.projectRoot 'dist\src\cooperative-shutdown.js'),
    (Join-Path $Context.projectRoot 'dist\src\process-identity.js'))){
    if(-not(Test-Path -LiteralPath $required -PathType Leaf)){
      throw 'COOPERATIVE_SOURCE_INCOMPLETE: Required shutdown transport source or module is missing; preserve existing runtime.'
    }
  }
  foreach($name in @('cooperative-shutdown-host.ps1','process-identity.ps1')){
    $tokens=$null;$errors=$null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $scripts $name),[ref]$tokens,[ref]$errors)
    if($errors){throw 'COOPERATIVE_SOURCE_INVALID: Required shutdown transport script cannot be parsed; preserve existing runtime.'}
  }
}

function Assert-CbStartupPreflight {
  param($Context,[switch]$IncludeTunnel)
  Assert-CbInstalledMutationBlocked $Context
  if(-not[string]::IsNullOrWhiteSpace($env:NODE_OPTIONS)-or-not[string]::IsNullOrWhiteSpace($env:NODE_PATH)){
    throw 'STARTUP_ENV_UNVERIFIED: Node loader overrides cannot be validated by startup preflight.'
  }
  foreach($required in @($Context.nodePath,$Context.httpEntry,$Context.projectsFile)){
    if(-not(Test-Path -LiteralPath $required -PathType Leaf)){throw 'SERVER_ENTRY_MISSING: Bridge executable, entry or allowlist is missing.'}
  }
  if(-not(Test-CbBuildCurrent $Context)){throw 'BUILD_STALE: Run an operator-approved build before changing the running runtime.'}
  Assert-CbCooperativeSourceAvailable $Context
  # Always recompute: a before-status cache (including ExpectedBuildId) is not
  # authority for startability. Any helper error remains a refusal, never true.
  try{[void](Invoke-CbBuildIdHelper -Context $Context -StartupPreflight)}
  catch{throw 'STARTUP_PREFLIGHT_FAILED: Canonical startup validation failed or timed out; existing processes are preserved.'}
  if($IncludeTunnel){
    Assert-CbTunnelIdentityReady $Context
    foreach($required in @($Context.tunnelClientPath,$Context.tunnelProfilePath,$Context.keyStorePath)){
      if(-not(Test-Path -LiteralPath $required -PathType Leaf)){throw 'TUNNEL_ENTRY_MISSING: Tunnel executable, profile or credential helper is missing.'}
    }
    $identity=Resolve-CbTunnelIdentity -ExplicitTunnelId $Context.tunnelIdentity.resolvedTunnelId -ProfilePath $Context.tunnelProfilePath
    if($identity.status-ne'Ready'){throw 'TUNNEL_ID_MISMATCH: Tunnel identity changed before startup.'}
  }
}

function Assert-CbCooperativeShutdownAvailable {
  param($Context)
  $server=Resolve-CbRoleOwnership -Context $Context -Role server -ReadOnly
  if(-not$server.canMutate){throw 'OWNERSHIP_MISMATCH: Core shutdown ownership is not verified.'}
  if($server.state-ne'Stopped'){
    Assert-CbIdleForMutation $Context
    Invoke-CbCooperativeExchange -Context $Context -ProcessId ([int]$server.pid) -Action probe
  }
}

function Test-CbTcpPort {param([int]$Port,[int]$TimeoutMilliseconds=250);$client=New-Object Net.Sockets.TcpClient;try{$async=$client.BeginConnect('127.0.0.1',$Port,$null,$null);if(-not$async.AsyncWaitHandle.WaitOne($TimeoutMilliseconds,$false)){return $false};$client.EndConnect($async);return $true}catch{return $false}finally{$client.Dispose()}}

function Get-CbHealth {
  param([Parameter(Mandatory=$true)]$Context)
  if(-not(Test-CbTcpPort -Port $Context.port)){return $null}
  try{return Invoke-RestMethod -UseBasicParsing -Uri $Context.healthUrl -TimeoutSec 2}catch{return $null}
}

function Test-CbServerHealth {
  param([Parameter(Mandatory=$true)]$Context)
  $expected=Get-CbExpectedBuildId -Context $Context;$health=Get-CbHealth -Context $Context;if($null-eq$health){return $false}
  return ($health.ok-eq$true-and[string]$health.service-eq'codex-handoff-bridge'-and-not[string]::IsNullOrWhiteSpace($expected)-and[string]$health.buildId-eq$expected)
}

function Test-CbTunnelReady {
  param([Parameter(Mandatory=$true)]$Context)
  if(-not(Test-CbTcpPort -Port $Context.tunnelHealthPort)){return $false}
  try{$response=Invoke-WebRequest -UseBasicParsing -Uri "$($Context.tunnelHealthUrl)/readyz" -TimeoutSec 2;return([int]$response.StatusCode-ge 200-and[int]$response.StatusCode-lt 300-and$response.Content.Trim()-in@('ready','ok'))}catch{return $false}
}

function Assert-CbIdleForMutation {
  param([Parameter(Mandatory=$true)]$Context)
  $health=Get-CbHealth -Context $Context
  if($null-eq$health){throw 'ACTIVE_STATE_UNKNOWN: Bridge health is unavailable; refusing to stop the core.'}
  $jobsProperty=$health.PSObject.Properties['jobs']
  if($null-eq$jobsProperty-or$null-eq$jobsProperty.Value){throw 'ACTIVE_STATE_UNKNOWN: Job counters are unavailable.'}
  foreach($name in @('active','awaitingApproval')){
    $field=$jobsProperty.Value.PSObject.Properties[$name]
    if($null-eq$field-or($field.Value-isnot[int]-and$field.Value-isnot[long])-or$field.Value-lt 0){
      throw 'ACTIVE_STATE_UNKNOWN: Job counters must be known non-negative integers.'
    }
  }
  if($null -ne $Context.PSObject.Properties['installedBinding'] -or $null -ne $Context.PSObject.Properties['requireAllJobs']){
    $jobsProperty=$health.PSObject.Properties['jobs']
    if($null -eq $jobsProperty -or $null -eq $jobsProperty.Value){throw 'ACTIVE_STATE_UNKNOWN'}
    $jobs=$jobsProperty.Value;$scope=$jobs.PSObject.Properties['scope'];$activeField=$jobs.PSObject.Properties['active'];$awaitingField=$jobs.PSObject.Properties['awaitingApproval']
    if($null -eq $scope -or $scope.Value -cne 'all' -or $null -eq $activeField -or $activeField.Value -isnot [int] -or
       $null -eq $awaitingField -or $awaitingField.Value -isnot [int]){throw 'ACTIVE_STATE_UNKNOWN'}
  }
  $active=try{[int]$health.jobs.active}catch{-1};$awaiting=try{[int]$health.jobs.awaitingApproval}catch{-1};$controllerState=[string]$health.controller
  if($active-ne 0-or$awaiting-ne 0-or$controllerState-notin@('idle','ready')){throw 'ACTIVE_WORK_PRESENT: Finish or cancel active work and resolve pending approvals before changing the Bridge core.'}
}

function Get-CbRoleDefinition {param($Context,[ValidateSet('server','tunnel')][string]$Role);if($Role-eq'server'){return [pscustomobject]@{pidFile=$Context.serverPidFile;ownerFile=$Context.serverOwnerFile;port=$Context.port;executablePath=$Context.nodePath;identity=$Context.httpEntry}};return [pscustomobject]@{pidFile=$Context.tunnelPidFile;ownerFile=$Context.tunnelOwnerFile;port=$Context.tunnelHealthPort;executablePath=$Context.tunnelClientPath;identity=$Context.tunnelProfile}}

function Test-CbExecutableIdentity {
  param($Context,[ValidateSet('server','tunnel')][string]$Role,$Process)
  $definition=Get-CbRoleDefinition -Context $Context -Role $Role
  if(-not(Test-CbPathEqual -Left([string]$Process.ExecutablePath)-Right([string]$definition.executablePath))){return $false}
  if($null -ne $Context.PSObject.Properties['installedBinding']){
    try{
      $actual=Get-CbProcess ([int]$Process.ProcessId)
      if($null -eq $actual -or $actual.StartTimeUtc -cne $Process.StartTimeUtc){return $false}
      $command=if($Role -eq 'server'){'"'+$Context.nodePath+'" "'+$Context.httpEntry+'"'}else{'"'+$Context.tunnelClientPath+'" run --profile-dir "'+$Context.tunnelProfileDir+'" --profile "codex-bridge" --log.file "'+$Context.tunnelLogFile+'" --pid.file "'+$Context.tunnelPidFile+'"'}
      if($actual.CommandLine -ine $command){return $false}
      $cim=Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.ProcessId)" -ErrorAction Stop
      $sid=Invoke-CimMethod -InputObject $cim -MethodName GetOwnerSid -ErrorAction Stop
      if($sid.ReturnValue -ne 0 -or $sid.Sid -cne $Context.installedBinding.operatorSid){return $false}
    }catch{return $false}
  }
  return $true
}

function Test-CbLegacyCommandIdentity {
  param($Context,[ValidateSet('server','tunnel')][string]$Role,$Process)
  $command=[string]$Process.CommandLine;if([string]::IsNullOrWhiteSpace($command)){return $false}
  if($Role-eq'server'){return($command.IndexOf($Context.projectRoot,[StringComparison]::OrdinalIgnoreCase)-ge 0-and$command.IndexOf('dist\src\http-main.js',[StringComparison]::OrdinalIgnoreCase)-ge 0)}
  return($command.IndexOf($Context.tunnelClientPath,[StringComparison]::OrdinalIgnoreCase)-ge 0-and$command.IndexOf($Context.tunnelProfile,[StringComparison]::OrdinalIgnoreCase)-ge 0)
}

function Write-CbOwnerMetadata {param($Context,[ValidateSet('server','tunnel')][string]$Role,$Process);$definition=Get-CbRoleDefinition -Context $Context -Role $Role;$metadata=[ordered]@{schemaVersion=1;role=$Role;pid=[int]$Process.ProcessId;executablePath=[string]$Process.ExecutablePath;startTimeUtc=[string]$Process.StartTimeUtc;identity=[string]$definition.identity;recordedAt=[DateTime]::UtcNow.ToString('o')};Write-CbAtomicText -Path $definition.ownerFile -Value($metadata|ConvertTo-Json -Compress)}

function Test-CbOwnerMetadata {
  param($Context,[ValidateSet('server','tunnel')][string]$Role,$Process)
  $definition=Get-CbRoleDefinition -Context $Context -Role $Role;if(-not(Test-Path -LiteralPath $definition.ownerFile -PathType Leaf)){return $false}
  try{$metadata=[IO.File]::ReadAllText($definition.ownerFile,[Text.Encoding]::UTF8)|ConvertFrom-Json}catch{return $false}
  return([int]$metadata.schemaVersion-eq 1-and[string]$metadata.role-eq$Role-and[int]$metadata.pid-eq[int]$Process.ProcessId-and(Test-CbPathEqual -Left([string]$metadata.executablePath)-Right([string]$Process.ExecutablePath))-and-not[string]::IsNullOrWhiteSpace([string]$Process.StartTimeUtc)-and[string]$metadata.startTimeUtc-eq[string]$Process.StartTimeUtc-and[string]$metadata.identity-eq[string]$definition.identity)
}

function Test-CbRoleReady {param($Context,[ValidateSet('server','tunnel')][string]$Role);if($Role-eq'server'){return(Test-CbServerHealth -Context $Context)};return(Test-CbTunnelReady -Context $Context)}

function Resolve-CbRoleOwnership {
  param($Context,[ValidateSet('server','tunnel')][string]$Role,[switch]$AdoptLegacyExactListener,[switch]$ReadOnly)
  if($ReadOnly-and$AdoptLegacyExactListener){throw 'READONLY_ADOPTION_REJECTED: Status cannot adopt ownership.'}
  if($AdoptLegacyExactListener -and $null -ne $Context.PSObject.Properties['installedBinding']){throw 'INSTALLED_LEGACY_ADOPTION_REJECTED'}
  $definition=Get-CbRoleDefinition -Context $Context -Role $Role;$managedPid=Read-CbPidFile -Path $definition.pidFile;$managedProcess=$null
  if($null-ne$managedPid){$managedProcess=Get-CbProcess -ProcessId $managedPid;if($null-eq$managedProcess){if(-not$ReadOnly-and$null -eq $Context.PSObject.Properties['installedBinding']){Remove-CbRuntimeFile -Path $definition.pidFile -ExpectedPid $managedPid;Remove-CbRuntimeFile -Path $definition.ownerFile};$managedPid=$null}}
  $listener=Get-CbListenerState -Port $definition.port;if(-not$listener.known){return [pscustomobject]@{role=$Role;state='OwnershipUnknown';pid=$managedPid;listenerPid=$null;reason=$listener.errorCode;canMutate=$false;adopted=$false}};if($listener.pids.Count-gt 1){return [pscustomobject]@{role=$Role;state='OwnershipMismatch';pid=$managedPid;listenerPid=$null;reason='multiple_listener_owners';canMutate=$false;adopted=$false}};$listenerPid=if($listener.pids.Count-eq 1){[int]$listener.pids[0]}else{$null}
  if($null-ne$managedPid-and-not(Test-CbExecutableIdentity -Context $Context -Role $Role -Process $managedProcess)){
    # Windows may reuse a persisted pre-reboot PID for an unrelated process. If
    # the component port has no listener, removing only our PID/owner files is
    # safe; the unrelated process is never stopped. A live listener still fails
    # closed so a real port conflict cannot be hidden or taken over.
    if($null-eq$listenerPid){if(-not$ReadOnly-and$null -eq $Context.PSObject.Properties['installedBinding']){Remove-CbRuntimeFile -Path $definition.pidFile -ExpectedPid $managedPid;Remove-CbRuntimeFile -Path $definition.ownerFile};$managedPid=$null;$managedProcess=$null}
    else{return [pscustomobject]@{role=$Role;state='OwnershipMismatch';pid=$managedPid;listenerPid=$listenerPid;reason='pid_process_mismatch';canMutate=$false;adopted=$false}}
  }
  if($null-ne$managedPid){if($null-ne$listenerPid-and$listenerPid-ne$managedPid){return [pscustomobject]@{role=$Role;state='OwnershipMismatch';pid=$managedPid;listenerPid=$listenerPid;reason='managed_pid_not_listener';canMutate=$false;adopted=$false}};$metadataValid=Test-CbOwnerMetadata -Context $Context -Role $Role -Process $managedProcess;if(-not$metadataValid){if(-not$AdoptLegacyExactListener-or$null-eq$listenerPid-or-not(Test-CbRoleReady -Context $Context -Role $Role)-or-not(Test-CbLegacyCommandIdentity -Context $Context -Role $Role -Process $managedProcess)){return [pscustomobject]@{role=$Role;state='OwnershipMismatch';pid=$managedPid;listenerPid=$listenerPid;reason='owner_metadata_missing_or_stale';canMutate=$false;adopted=$false}};Write-CbOwnerMetadata -Context $Context -Role $Role -Process $managedProcess};if($null-eq$listenerPid){return [pscustomobject]@{role=$Role;state='OwnedNotListening';pid=$managedPid;listenerPid=$null;reason=$null;canMutate=$true;adopted=$false}};return [pscustomobject]@{role=$Role;state='OwnedReady';pid=$managedPid;listenerPid=$listenerPid;reason=$null;canMutate=$true;adopted=[bool]$AdoptLegacyExactListener}}
  if($null-eq$listenerPid){return [pscustomobject]@{role=$Role;state='Stopped';pid=$null;listenerPid=$null;reason=$null;canMutate=$true;adopted=$false}}
  $listenerProcess=Get-CbProcess -ProcessId $listenerPid;if($null-eq$listenerProcess-or-not(Test-CbExecutableIdentity -Context $Context -Role $Role -Process $listenerProcess)-or-not(Test-CbRoleReady -Context $Context -Role $Role)){return [pscustomobject]@{role=$Role;state='OwnershipMismatch';pid=$null;listenerPid=$listenerPid;reason='foreign_listener';canMutate=$false;adopted=$false}}
  if(-not$AdoptLegacyExactListener-or-not(Test-CbLegacyCommandIdentity -Context $Context -Role $Role -Process $listenerProcess)){return [pscustomobject]@{role=$Role;state='OwnershipMismatch';pid=$null;listenerPid=$listenerPid;reason='unmanaged_listener';canMutate=$false;adopted=$false}}
  Write-CbAtomicText -Path $definition.pidFile -Value([string]$listenerPid);Write-CbOwnerMetadata -Context $Context -Role $Role -Process $listenerProcess;return [pscustomobject]@{role=$Role;state='OwnedReady';pid=$listenerPid;listenerPid=$listenerPid;reason=$null;canMutate=$true;adopted=$true}
}

function Get-CodexBridgeRuntimeStatus {
  param([Parameter(Mandatory=$true)]$Context,[switch]$AdoptLegacyExactListeners)
  Assert-CbInstalledMutationBlocked $Context
  [void](Get-CbExpectedBuildId -Context $Context)
  $server=Resolve-CbRoleOwnership -Context $Context -Role server -ReadOnly:(-not$AdoptLegacyExactListeners) -AdoptLegacyExactListener:$AdoptLegacyExactListeners;$tunnel=Resolve-CbRoleOwnership -Context $Context -Role tunnel -ReadOnly:(-not$AdoptLegacyExactListeners) -AdoptLegacyExactListener:$AdoptLegacyExactListeners;$serverHealthy=Test-CbServerHealth -Context $Context;$tunnelReady=Test-CbTunnelReady -Context $Context;$states=@($server.state,$tunnel.state)
  $status=if(@($states|Where-Object{$_-in@('OwnershipMismatch','OwnershipUnknown')}).Count-gt 0){'OwnershipMismatch'}elseif([string]$Context.tunnelIdentity.status-ne'Ready'){'Misconfigured'}elseif(-not$serverHealthy-and$server.state-eq'Stopped'-and$tunnel.state-eq'Stopped'){'Stopped'}elseif(-not$serverHealthy){'Unhealthy'}elseif(-not$tunnelReady){'Degraded'}else{'Ready'}
  return [pscustomobject]@{canonicalBuildId=(Get-CbExpectedBuildId -Context $Context);status=$status;server=[pscustomobject]@{healthy=$serverHealthy;ownership=$server.state;pid=$server.pid;listenerPid=$server.listenerPid;adopted=$server.adopted};tunnel=[pscustomobject]@{ready=$tunnelReady;ownership=$tunnel.state;pid=$tunnel.pid;listenerPid=$tunnel.listenerPid;adopted=$tunnel.adopted};tunnelIdentity=Get-CbTunnelIdentitySummary -Identity $Context.tunnelIdentity;ownedPids=@(@($server.pid,$tunnel.pid)|Where-Object{$null-ne$_}|ForEach-Object{[int]$_}|Sort-Object -Unique)}
}

function Wait-CbCondition {param([scriptblock]$Condition,[int]$TimeoutSeconds,[int]$PollMilliseconds=250);$deadline=[DateTime]::UtcNow.AddSeconds($TimeoutSeconds);do{if(&$Condition){return $true};Start-Sleep -Milliseconds $PollMilliseconds}while([DateTime]::UtcNow-lt$deadline);return [bool](&$Condition)}

function Start-CbChildProcess {
  param($StartInfo,[hashtable]$Environment)
  $overrides=@{}
  foreach($name in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy')){$overrides[$name]=$null}
  $overrides['NO_PROXY']='127.0.0.1,localhost';$overrides['no_proxy']='127.0.0.1,localhost'
  foreach($entry in $Environment.GetEnumerator()){$overrides[[string]$entry.Key]=$entry.Value};$previous=@{}
  try{foreach($entry in $overrides.GetEnumerator()){$name=[string]$entry.Key;$previous[$name]=[Environment]::GetEnvironmentVariable($name,[EnvironmentVariableTarget]::Process);[Environment]::SetEnvironmentVariable($name,$entry.Value,[EnvironmentVariableTarget]::Process)};return [Diagnostics.Process]::Start($StartInfo)}finally{foreach($entry in $previous.GetEnumerator()){[Environment]::SetEnvironmentVariable([string]$entry.Key,$entry.Value,[EnvironmentVariableTarget]::Process)}}
}

function Start-CbInstalledChildProcess {
  param($StartInfo,[hashtable]$Environment,$Context)
  # Keep all existing executable/argument/environment/selection checks before
  # using the native launcher. Only this installed branch isolates stdio.
  Set-CbInstalledStartEnvironment $StartInfo $Environment $Context
  if(-not(Test-CbInstalledLayout)){throw 'INSTALLED_LAYOUT_REQUIRED'}
  $nativePath=Join-Path $PSScriptRoot 'OwnedProcess.Native.dll'
  if(-not('CbDetachedProcess' -as [type])){Add-Type -Path $nativePath -ErrorAction Stop}
  foreach($name in @('CbDetachedProcess','CbOwnedProcess')){
    $nativeType=$name -as [type]
    if($null -eq $nativeType -or $nativeType.Assembly.Location -ine $nativePath){throw 'INSTALLED_NATIVE_LOAD_PATH_MISMATCH'}
  }
  return [CbDetachedProcess]::Start($StartInfo)
}

function Open-CbOwnedProcess {
  param([int]$ProcessId,[switch]$QueryOnly)
  if (-not ('CbOwnedProcess' -as [type])) {
    $native=if(Test-CbInstalledLayout){'OwnedProcess.Native.dll'}else{'OwnedProcess.Native.cs'}
    Add-Type -Path (Join-Path $PSScriptRoot $native) -ErrorAction Stop
  }
  return New-Object -TypeName CbOwnedProcess -ArgumentList @($ProcessId,[bool]$QueryOnly)
}

function Initialize-CbCooperativeNative {
  param([switch]$IdentityOnly)
  # The controller and its two fixed child adapters share the same native load
  # boundary. Installed execution never compiles source into writable TEMP.
  $native=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\mcp_control_center\src'))
  $installed=Test-CbInstalledLayout
  $loads=@(@{type='McpCcNormalNative';source='NormalOperator.Native.cs';assembly='NormalOperator.Host.dll'})
  if(-not $IdentityOnly){$loads+=@{type='McpCcReloadNative';source='RemoteSelfReload.Native.cs';assembly='RemoteSelfReload.Native.dll'}}
  foreach($load in $loads){
    $path=Join-Path $native $(if($installed){$load.assembly}else{$load.source})
    if($installed){Assert-CbInstalledAuthorityPath $path}
    $type=$load.type -as [type]
    if($null -eq $type){Add-Type -Path $path -ErrorAction Stop;$type=$load.type -as [type]}
    if($null -eq $type -or ($installed -and $type.Assembly.Location -ine $path)){throw 'INSTALLED_LOADED_NATIVE_MISMATCH'}
  }
}

function Invoke-CbCooperativeExchange {
  param($Context,[int]$ProcessId,[ValidateSet('probe','shutdown')][string]$Action,$ExpectedInstance=$null)
  $pipe=$null;$core=$null;$hostProcess=$null;$sent=$false
  try {
    Initialize-CbCooperativeNative
    $core=[Diagnostics.Process]::GetProcessById($ProcessId)
    $proof=[McpCcNormalNative]::Inspect($core)
    # Shutdown must remain bound to the same query-only native handle retained
    # by Stop-CbOwnedRole, not merely another lookup of the numeric PID.
    if($Action-eq'shutdown'-and($null-eq$ExpectedInstance-or$ExpectedInstance.HasExited-or
      $ExpectedInstance.ProcessId-ne$proof.pid-or$ExpectedInstance.ExecutablePath-ine$proof.image-or
      ([DateTime]::Parse($ExpectedInstance.StartTimeUtc).ToUniversalTime().Ticks)-ne$proof.startedUtcTicks)){
      throw 'CORE_IDENTITY_REJECTED'
    }
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if($proof.sid-cne$sid-or$proof.image-ine$Context.nodePath-or$proof.elevated){throw 'CORE_IDENTITY_REJECTED'}
    $snapshot=[pscustomobject]@{ProcessId=$proof.pid;ExecutablePath=$proof.image;StartTimeUtc=$core.StartTime.ToUniversalTime().ToString('o')}
    if(-not(Test-CbOwnerMetadata -Context $Context -Role server -Process $snapshot)){throw 'CORE_IDENTITY_REJECTED'}
    $name='Cb.Core.Close.'+$ProcessId+'.'+$proof.startedUtcTicks
    $pipe=New-Object IO.Pipes.NamedPipeClientStream('.', $name,[IO.Pipes.PipeDirection]::InOut,
      [IO.Pipes.PipeOptions]::Asynchronous,[Security.Principal.TokenImpersonationLevel]::Identification)
    $pipe.Connect(1500)
    $hostId=[McpCcReloadNative]::ServerPid($pipe)
    $hostProcess=[Diagnostics.Process]::GetProcessById($hostId)
    $hostProof=[McpCcNormalNative]::Inspect($hostProcess)
    $hostInfo=Get-CimInstance Win32_Process -Filter "ProcessId=$hostId" -ErrorAction Stop
    $entry=Join-Path $PSScriptRoot 'cooperative-shutdown-host.ps1'
    if($hostInfo.ParentProcessId-ne$ProcessId-or$hostProof.sid-cne$sid-or$hostProof.session-ne$proof.session-or
      $hostProof.startedUtcTicks-lt$proof.startedUtcTicks-or$hostProof.image-ine'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'-or
      $hostInfo.CommandLine-notmatch ('(?i)-File\s+"?'+[regex]::Escape($entry)+'"?(\s|$)')-or
      $hostInfo.CommandLine-match '(?i)-(EncodedCommand|Command)\b'){throw 'IPC_SERVER_REJECTED'}
    [McpCcNormalNative]::AssertServerIdentity($pipe,$hostProcess,$hostProof)
    if(-not$pipe.WriteAsync([byte[]]@(1),0,1).Wait(3000)){throw 'IPC_UNKNOWN'}
    $readLine={param($stream,[int]$Timeout)
      $bytes=New-Object byte[] 8192;$count=0;$clock=[Diagnostics.Stopwatch]::StartNew()
      while($count-lt$bytes.Length){$read=$stream.ReadAsync($bytes,$count,1);$left=$Timeout-[int]$clock.ElapsedMilliseconds
        if($left-le 0-or-not$read.Wait($left)-or$read.Result-ne 1){throw 'IPC_UNKNOWN'}
        if($bytes[$count]-eq 10){return ([Text.Encoding]::UTF8.GetString($bytes,0,$count)|ConvertFrom-Json)};$count++}
      throw 'IPC_FRAME_LIMIT'
    }
    $hello=& $readLine $pipe 5000
    if($hello.contract-cne'bridge-cooperative-close-v1'-or$hello.pid-ne$ProcessId-or
      $hello.startedUtcTicks-cne[string]$proof.startedUtcTicks-or$hello.image-ine$proof.image-or$hello.sid-cne$sid-or
      $hello.instance-notmatch'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'-or$hello.nonce-notmatch'^[A-Za-z0-9_-]{43}$'-or
      $hostInfo.CommandLine-notmatch ('(?i)-Instance\s+"?'+[regex]::Escape($hello.instance)+'"?(\s|$)')){throw 'IPC_BINDING_REJECTED'}
    if($core.HasExited-or-not(Test-CbOwnerMetadata -Context $Context -Role server -Process $snapshot)){throw 'CORE_IDENTITY_REJECTED'}
    if($Action-eq'shutdown'-and$ExpectedInstance.HasExited){throw 'CORE_IDENTITY_REJECTED'}
    [McpCcNormalNative]::AssertServerIdentity($pipe,$hostProcess,$hostProof)
    $requestId=[Guid]::NewGuid().ToString()
    $message=@{contract=$hello.contract;instance=$hello.instance;nonce=$hello.nonce;pid=$ProcessId;
      startedUtcTicks=$hello.startedUtcTicks;image=$hello.image;action=$Action;requestId=$requestId}
    $bytes=[Text.Encoding]::UTF8.GetBytes(($message|ConvertTo-Json -Compress)+"`n")
    $sent=$true
    if(-not$pipe.WriteAsync($bytes,0,$bytes.Length).Wait(3000)){throw 'IPC_UNKNOWN'}
    $result=& $readLine $pipe 27000
    if(@($result.PSObject.Properties.Name).Count-ne 3-or$result.requestId-cne$requestId-or$result.nonce-cne$hello.nonce){throw 'IPC_BINDING_REJECTED'}
    if($result.code-eq'ACTIVE_WORK_PRESENT'){throw 'ACTIVE_WORK_PRESENT: Runtime refused shutdown; tunnel preserved.'}
    $expected=if($Action-eq'probe'){'AVAILABLE'}else{'CLOSED'}
    if($result.code-cne$expected){throw 'IPC_UNKNOWN'}
    # Exact original core exit is checked by the retained CbOwnedProcess handle.
  } catch {
    if($_.Exception.Message-like'ACTIVE_WORK_PRESENT:*'){throw}
    if($sent-and$Action-eq'shutdown'){throw 'COOPERATIVE_SHUTDOWN_UNKNOWN: Do not replay or restart; inspect the original operation locally. Tunnel preserved.'}
    throw 'BLOCKED_GRACEFUL_SHUTDOWN_UNAVAILABLE: Verified cooperative channel unavailable; core and tunnel preserved.'
  } finally {if($pipe){$pipe.Dispose()};if($hostProcess){$hostProcess.Dispose()};if($core){$core.Dispose()}}
}

function Stop-CbOwnedRole {
  param($Context,[ValidateSet('server','tunnel')][string]$Role,[switch]$RetainExitedHandle,$StoppedCoreHandle=$null)
  Assert-CbInstalledMutationBlocked $Context
  if(($RetainExitedHandle -and $Role -ne 'server') -or ($null -ne $StoppedCoreHandle -and $Role -ne 'tunnel')){throw 'CORE_STOP_EVIDENCE_REJECTED'}
  $definition=Get-CbRoleDefinition -Context $Context -Role $Role
  $ownership=Resolve-CbRoleOwnership -Context $Context -Role $Role
  if(-not $ownership.canMutate){throw "OWNERSHIP_MISMATCH: Cannot stop $Role because ownership is $($ownership.state)."}
  if($ownership.state -eq 'Stopped'){return}
  $instance=$null;$transferHandle=$false
  try {
    $instance=Open-CbOwnedProcess -ProcessId ([int]$ownership.pid) -QueryOnly:($Role-eq'server')
    if ($instance.HasExited -or
        -not (Test-CbExecutableIdentity -Context $Context -Role $Role -Process $instance) -or
        -not (Test-CbOwnerMetadata -Context $Context -Role $Role -Process $instance)) {
      throw "OWNERSHIP_MISMATCH: $Role instance changed before stop."
    }
    # Recheck listener and metadata while the validated native handle remains open.
    $current=Resolve-CbRoleOwnership -Context $Context -Role $Role
    if (-not $current.canMutate -or $current.state -eq 'Stopped' -or $current.pid -ne $instance.ProcessId -or
        -not (Test-CbOwnerMetadata -Context $Context -Role $Role -Process $instance)) {
      throw "OWNERSHIP_MISMATCH: $Role ownership changed before stop."
    }
    if($null -ne $StoppedCoreHandle){
      # Only ShutdownRuntime passes the original query-only handle after CLOSED
      # and confirmed exit. An absent PID or a JSON boolean is not this proof.
      if($StoppedCoreHandle.GetType().FullName -cne 'CbOwnedProcess' -or -not $StoppedCoreHandle.HasExited -or
        -not(Test-CbPathEqual $StoppedCoreHandle.ExecutablePath $Context.nodePath)){throw 'CORE_STOP_EVIDENCE_REJECTED'}
      $coreNow=Resolve-CbRoleOwnership -Context $Context -Role server -ReadOnly
      if(-not $coreNow.canMutate -or $coreNow.state -cne 'Stopped'){throw 'CORE_STOP_EVIDENCE_REJECTED'}
    }elseif($null -ne $Context.PSObject.Properties['installedBinding'] -or $null -ne $Context.PSObject.Properties['requireAllJobs']){
      Assert-CbIdleForMutation $Context
    }
    if($Role-eq'server'){
      Assert-CbIdleForMutation $Context
      Invoke-CbCooperativeExchange -Context $Context -ProcessId $instance.ProcessId -Action shutdown -ExpectedInstance $instance
      try{$instance.WaitForExit(5000)}catch{throw 'COOPERATIVE_SHUTDOWN_UNKNOWN: Original core did not reach confirmed exit; do not restart or replay. Tunnel preserved.'}
    }else{
      $instance.TerminateAndWait()
    }
    Remove-CbRuntimeFile -Path $definition.pidFile -ExpectedPid ([int]$instance.ProcessId)
    Remove-CbRuntimeFile -Path $definition.ownerFile
    if($RetainExitedHandle){$transferHandle=$true;return $instance}
  } finally { if ($null -ne $instance -and -not $transferHandle) { $instance.Dispose() } }
}

function Start-CbServer {
  param($Context)
  Assert-CbInstalledMutationBlocked $Context
  $ownership=Resolve-CbRoleOwnership -Context $Context -Role server -ReadOnly
  if(Test-CbServerHealth -Context $Context){if($ownership.canMutate-and$ownership.state-eq'OwnedReady'){return};throw 'OWNERSHIP_MISMATCH: Healthy Bridge server is not controller-owned.'}
  if(-not$ownership.canMutate){throw "OWNERSHIP_MISMATCH: Cannot start server while ownership is $($ownership.state)."}
  Assert-CbStartupPreflight $Context
  if($ownership.state-ne'Stopped'){Assert-CbCooperativeShutdownAvailable $Context}
  # Cleanup of stale metadata is allowed only on a mutation after readiness.
  $ownership=Resolve-CbRoleOwnership -Context $Context -Role server
  if(-not$ownership.canMutate-or$ownership.state-ne'Stopped'){throw 'OWNERSHIP_MISMATCH: Core ownership changed before start.'}
  $startInfo=New-Object Diagnostics.ProcessStartInfo;$startInfo.FileName=$Context.nodePath;$startInfo.Arguments="`"$($Context.httpEntry)`"";$startInfo.WorkingDirectory=$Context.projectRoot;$startInfo.UseShellExecute=$true;$startInfo.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
  $environment=@{CODEX_BRIDGE_PROJECT_ROOT=$Context.projectRoot;CODEX_BRIDGE_PROJECTS_FILE=$Context.projectsFile;CODEX_BRIDGE_DATA_DIR=$Context.dataDir;CODEX_BRIDGE_HTTP_HOST=$Context.hostName;CODEX_BRIDGE_HTTP_PORT=[string]$Context.port;CODEX_BRIDGE_HTTP_TOKEN=$(if([string]::IsNullOrWhiteSpace($Context.token)){$null}else{$Context.token});CODEX_BRIDGE_CODEX_COMMAND=$(if([string]::IsNullOrWhiteSpace($Context.codexCommand)){$null}else{$Context.codexCommand});CODEX_BRIDGE_CODEX_ARGS=$(if([string]::IsNullOrWhiteSpace($Context.codexArgs)){$null}else{$Context.codexArgs});CODEX_BRIDGE_EXPECTED_TEST_BUILD=$Context.expectedBuildId;CODEX_BRIDGE_TEST_ACTIVE_FLAG=$Context.testActiveFlag}
  if ($null -ne $Context.PSObject.Properties['installedBinding']) {
    $environment=Get-CbInstalledChildEnvironment $Context.installedBinding
    $environment.CODEX_BRIDGE_HTTP_TOKEN=$Context.token
    try{$process=Start-CbInstalledChildProcess $startInfo $environment $Context}finally{$environment.Clear();$startInfo.EnvironmentVariables.Clear()}
  } else {$process=Start-CbChildProcess -StartInfo $startInfo -Environment $environment}
  if($null-eq$process){throw 'SERVER_START_FAILED: Node process did not start.'};Write-CbAtomicText -Path $Context.serverPidFile -Value([string]$process.Id);$started=Get-CbProcess -ProcessId $process.Id;if($null-eq$started){throw 'SERVER_START_FAILED: Started server is unavailable.'};Write-CbOwnerMetadata -Context $Context -Role server -Process $started
  if(-not(Wait-CbCondition -TimeoutSeconds $Context.serverReadyTimeoutSeconds -Condition{Test-CbServerHealth -Context $Context})){$current=Get-CbProcess -ProcessId $process.Id;if($null-ne$current){Stop-CbOwnedRole -Context $Context -Role server};throw 'SERVER_NOT_READY: Bridge did not reach the expected build.'};$ready=Resolve-CbRoleOwnership -Context $Context -Role server;if(-not$ready.canMutate-or$ready.pid-ne$process.Id){throw 'OWNERSHIP_MISMATCH: Started server does not own the listener.'}
}

function Start-CbTunnelOnce {
  param($Context)
  Assert-CbInstalledMutationBlocked $Context
  if ($null -ne $Context.PSObject.Properties['installedBinding']) { Start-CbInstalledTunnel $Context; return }
  Assert-CbTunnelIdentityReady -Context $Context;if(-not(Test-CbServerHealth -Context $Context)){throw 'SERVER_NOT_READY: Tunnel start requires Bridge core.'};$ownership=Resolve-CbRoleOwnership -Context $Context -Role tunnel;if(Test-CbTunnelReady -Context $Context){if($ownership.canMutate-and$ownership.state-eq'OwnedReady'){return};throw 'OWNERSHIP_MISMATCH: Ready tunnel is not controller-owned.'};if(-not$ownership.canMutate){throw "OWNERSHIP_MISMATCH: Cannot start tunnel while ownership is $($ownership.state)."};if($ownership.state-eq'OwnedNotListening'){Stop-CbOwnedRole -Context $Context -Role tunnel};if(-not(Test-Path -LiteralPath $Context.tunnelClientPath -PathType Leaf)){throw 'TUNNEL_CLIENT_MISSING: tunnel-client.exe is missing.'};if(-not(Test-Path -LiteralPath $Context.tunnelProfilePath -PathType Leaf)){throw 'TUNNEL_PROFILE_MISSING: Tunnel profile is missing.'};. $Context.keyStorePath;Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $Context.projectRoot -SecretPath $Context.secretPath|Out-Null;if([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)){throw 'TUNNEL_KEY_MISSING: Control-plane key is unavailable.'};New-Item -ItemType Directory -Force -Path $Context.runtimeDir|Out-Null
  $startInfo=New-Object Diagnostics.ProcessStartInfo;$startInfo.FileName=$Context.tunnelClientPath;$startInfo.Arguments="run --profile-dir `"$($Context.tunnelProfileDir)`" --profile `"$($Context.tunnelProfile)`" --log.file `"$($Context.tunnelLogFile)`" --pid.file `"$($Context.tunnelPidFile)`"";$startInfo.WorkingDirectory=$Context.projectRoot;$startInfo.UseShellExecute=$true;$startInfo.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden;$process=Start-CbChildProcess -StartInfo $startInfo -Environment @{CONTROL_PLANE_API_KEY=$env:CONTROL_PLANE_API_KEY};if($null-eq$process){throw 'TUNNEL_START_FAILED: Tunnel process did not start.'};Write-CbAtomicText -Path $Context.tunnelPidFile -Value([string]$process.Id);$started=Get-CbProcess -ProcessId $process.Id;if($null-eq$started){throw 'TUNNEL_START_FAILED: Started tunnel is unavailable.'};Write-CbOwnerMetadata -Context $Context -Role tunnel -Process $started
}

function Repair-CbConnectivity {param($Context);$server=Resolve-CbRoleOwnership -Context $Context -Role server;if(-not(Test-CbServerHealth -Context $Context)-or-not$server.canMutate-or$server.state-ne'OwnedReady'){throw 'SERVER_NOT_READY: Connectivity repair requires an owned Bridge core.'};$tunnel=Resolve-CbRoleOwnership -Context $Context -Role tunnel;if(Test-CbTunnelReady -Context $Context){if($tunnel.canMutate-and$tunnel.state-eq'OwnedReady'){return};throw 'OWNERSHIP_MISMATCH: Ready tunnel is not controller-owned.'};if(-not$tunnel.canMutate){throw "OWNERSHIP_MISMATCH: Cannot repair tunnel while ownership is $($tunnel.state)."};if($tunnel.state-eq'OwnedNotListening'){Stop-CbOwnedRole -Context $Context -Role tunnel};foreach($delay in @($Context.tunnelRecoveryDelaysSeconds)){Start-CbTunnelOnce -Context $Context;if(Wait-CbCondition -TimeoutSeconds([int]$delay)-Condition{Test-CbTunnelReady -Context $Context}){$ready=Resolve-CbRoleOwnership -Context $Context -Role tunnel;if($ready.canMutate-and$ready.state-eq'OwnedReady'){return};throw 'OWNERSHIP_MISMATCH: Tunnel listener is not owned by the started process.'};Stop-CbOwnedRole -Context $Context -Role tunnel};throw 'TUNNEL_NOT_READY: Tunnel failed bounded recovery.'}

function Assert-CbShutdownPreflight {param($Context);foreach($role in @('tunnel','server')){$ownership=Resolve-CbRoleOwnership -Context $Context -Role $role -ReadOnly;if(-not$ownership.canMutate){throw "OWNERSHIP_MISMATCH: Cannot mutate $role while ownership is $($ownership.state)."}}}

function Invoke-CodexBridgeLifecycleAction {
  param($Context,[ValidateSet('EnsureRunning','RepairConnectivity','RestartCore','ReloadRuntime','ShutdownRuntime')][string]$Action)
  Assert-CbInstalledMutationBlocked $Context
  [void](Get-CbExpectedBuildId -Context $Context)
  switch($Action){
    'EnsureRunning'{Assert-CbTunnelIdentityReady -Context $Context;Start-CbServer -Context $Context;Repair-CbConnectivity -Context $Context}
    'RepairConnectivity'{Assert-CbTunnelIdentityReady -Context $Context;Repair-CbConnectivity -Context $Context}
    'RestartCore'{
      Assert-CbShutdownPreflight $Context
      Assert-CbStartupPreflight $Context
      Assert-CbCooperativeShutdownAvailable $Context
      Stop-CbOwnedRole -Context $Context -Role server
      Start-CbServer $Context
    }
    'ReloadRuntime'{
      Assert-CbShutdownPreflight $Context
      Assert-CbStartupPreflight $Context -IncludeTunnel
      Assert-CbCooperativeShutdownAvailable $Context
      Stop-CbOwnedRole -Context $Context -Role server
      # Keep a healthy tunnel throughout core replacement.
      Start-CbServer $Context
      Repair-CbConnectivity $Context
    }
    'ShutdownRuntime'{
      Assert-CbShutdownPreflight $Context
      Assert-CbCooperativeShutdownAvailable $Context
      $closedCore=$null
      try {
        $closedCore=Stop-CbOwnedRole -Context $Context -Role server -RetainExitedHandle
        Stop-CbOwnedRole -Context $Context -Role tunnel -StoppedCoreHandle $closedCore
      } finally {if($null -ne $closedCore){$closedCore.Dispose()}}
    }
  }
}

function Test-CbInstalledLayout {
  $manager=Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'mcp_control_center'
  if(Test-Path -LiteralPath (Join-Path $manager 'config\installed-release.json')){return $true}
  $registry=Join-Path $manager 'config\registry.json'
  if(Test-Path -LiteralPath $registry -PathType Leaf){
    # A v4 registry with a missing manifest must not silently fall back to v3.
    if((Get-Item -LiteralPath $registry).Length -gt 65536){throw 'INSTALLED_REGISTRY_LIMIT'}
    $document=Get-Content -LiteralPath $registry -Raw -Encoding UTF8 | ConvertFrom-Json
    if($document.schemaVersion -eq 4){return $true}
  }
  return $false
}

function Get-CbInstalledBinding {
  if((Get-Process -Id $PID).Path -ine 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'){throw 'INSTALLED_POWERSHELL_MISMATCH'}
  $codeRoot=Split-Path -Parent $PSScriptRoot
  if(-not(Test-CbInstalledLayout)){throw 'INSTALLED_RELEASE_REQUIRED'}
  foreach($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()){
    if([string]$entry.Key -match '^(NODE_|OPENSSL_)' -and -not[string]::IsNullOrEmpty([string]$entry.Value)){throw 'INSTALLED_ENV_OVERRIDE_REJECTED'}
  }
  foreach($name in @('NODE_OPTIONS','NODE_PATH','NODE_REPL_EXTERNAL_MODULE','OPENSSL_CONF','OPENSSL_MODULES',
      'CODEX_BRIDGE_CODEX_COMMAND','CODEX_BRIDGE_CODEX_ARGS','CODEX_BRIDGE_NODE_PATH','CODEX_BRIDGE_TUNNEL_CLIENT_PATH',
      'CODEX_BRIDGE_KEY_STORE_PATH','CODEX_BRIDGE_EXPECTED_TEST_BUILD','CODEX_BRIDGE_TEST_ACTIVE_FLAG')){
    if(-not[string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name,'Process'))){throw 'INSTALLED_ENV_OVERRIDE_REJECTED'}
  }
  $modulePath=Join-Path (Split-Path -Parent $codeRoot) 'mcp_control_center\src\McpControlCenter.InstalledRelease.psm1'
  # Always the sibling of the physically loaded controller, never ProjectRoot/configRoot.
  Assert-CbInstalledAuthorityPath $modulePath
  $module=Import-Module $modulePath -PassThru -ErrorAction Stop
  return & $module {param($root) Get-McpCcInstalledBridgeBinding $root} $codeRoot
}

function Assert-CbInstalledAuthorityPath([string]$Path) {
  # Bootstrap before importing the shared verifier. Do not execute an unverified sibling
  # merely to ask that sibling whether it is protected.
  $trusted=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $write=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  $cursor=$Path;$first=$true
  while($cursor){
    if((Get-Item -LiteralPath $cursor -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'INSTALLED_REPARSE_REJECTED'}
    $acl=Get-Acl -LiteralPath $cursor -ErrorAction Stop
    if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted){throw 'PROTECTED_OWNER_REQUIRED'}
    $raw=New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All))
    if($null -eq $raw.DiscretionaryAcl){throw 'PROTECTED_DACL_REQUIRED'}
    foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
      if (-not $first -and ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
      $mask=if ($cursor -eq [IO.Path]::GetPathRoot($cursor)) { $write -band (-bnot 6) } else { $write }
      if($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Value -notin $trusted -and ($ace.FileSystemRights -band $mask)){throw 'PROTECTED_WRITE_REJECTED'}
    }
    $first=$false;$cursor=Split-Path -Parent $cursor
  }
}

function New-CbInstalledRuntimeContext {
  param($Binding=(Get-CbInstalledBinding))
  $runtimeDir=$binding.runtimeRoot
  return [pscustomobject]@{installedBinding=$binding;projectRoot=$binding.codeRoot;configRoot=$binding.configRoot;
    hostName='127.0.0.1';port=18828;projectsFile=$binding.projectsFile;dataDir=$binding.dataDir;token=$(if($binding.activationReady){$env:CODEX_BRIDGE_HTTP_TOKEN}else{$null});
    codexCommand=$binding.nodePath;codexArgs=(@($binding.codexLauncher,'app-server')|ConvertTo-Json -Compress);
    nodePath=$binding.nodePath;httpEntry=(Join-Path $binding.codeRoot 'dist\src\http-main.js');healthUrl='http://127.0.0.1:18828/health';
    tunnelClientPath=$binding.tunnelClientPath;tunnelProfileDir=$binding.tunnelProfileDir;tunnelProfile='codex-bridge';
    tunnelProfilePath=(Join-Path $binding.tunnelProfileDir 'codex-bridge.yaml');
    tunnelIdentity=$(if($binding.activationReady){Resolve-CbTunnelIdentity -ProfilePath (Join-Path $binding.tunnelProfileDir 'codex-bridge.yaml')}else{[pscustomobject]@{status='Unverified';errorCode='INSTALLED_LIFECYCLE_BINDINGS_REQUIRED'}});
    tunnelHealthUrl='http://127.0.0.1:18829';tunnelHealthPort=18829;runtimeDir=$runtimeDir;
    serverPidFile=(Join-Path $runtimeDir 'codex-bridge-http-server.pid');serverOwnerFile=(Join-Path $runtimeDir 'codex-bridge-http-server.owner.json');
    tunnelPidFile=(Join-Path $runtimeDir 'tunnel-client.pid');tunnelOwnerFile=(Join-Path $runtimeDir 'tunnel-client.owner.json');
    tunnelLogFile=(Join-Path $runtimeDir 'tunnel-client.log');actionLogFile=(Join-Path $runtimeDir 'runtime-control.jsonl');
    keyStorePath=$binding.keyStorePath;secretPath=$binding.secretPath;expectedBuildId=$null;testActiveFlag=$null;
    # Installed activation and cooperative-channel verification precede HTTP
    # admission; a cold start can exceed the source runtime's 20-second budget.
    serverReadyTimeoutSeconds=60;tunnelRecoveryDelaysSeconds=@(15,30,60)}
}

function Assert-CbInstalledMutationBlocked($Context) {
  if($null -ne $Context.PSObject.Properties['installedBinding'] -or (Test-CbInstalledLayout)){
    $binding=Get-CbInstalledBinding
    if (-not $binding.activationReady) { throw 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED' }
    $expected=New-CbInstalledRuntimeContext -Binding $binding
    foreach($property in $expected.PSObject.Properties){
      $actual=$Context.PSObject.Properties[$property.Name]
      if ($null -eq $actual -or ($actual.Value|ConvertTo-Json -Compress -Depth 6) -cne ($property.Value|ConvertTo-Json -Compress -Depth 6)) { throw 'INSTALLED_CONTEXT_TAMPERED' }
    }
    # Never accept a caller-supplied canonical digest cache as installed authority.
    if($null -ne $Context.PSObject.Properties['buildIdCache']){$Context.PSObject.Properties.Remove('buildIdCache')}
    Assert-McpCcInstalledSelection $binding
  }
}

function Get-CbInstalledChildEnvironment($Binding) {
  return @{SystemRoot=$Binding.windowsRoot;WINDIR=$Binding.windowsRoot;USERPROFILE=$Binding.userProfile;
    LOCALAPPDATA=$Binding.localAppData;APPDATA=(Join-Path $Binding.userProfile 'AppData\Roaming');
    TEMP=(Join-Path $Binding.localAppData 'Temp');TMP=(Join-Path $Binding.localAppData 'Temp');CODEX_HOME=$Binding.codexHome;
    PATH=((Split-Path -Parent $Binding.nodePath)+';'+(Join-Path $Binding.windowsRoot 'System32'));
    PSModulePath=(Join-Path $Binding.windowsRoot 'System32\WindowsPowerShell\v1.0\Modules')}
}
function Set-CbInstalledStartEnvironment($StartInfo,[hashtable]$Environment,$Context) {
  Assert-CbInstalledMutationBlocked $Context
  if($StartInfo.FileName -ine $Context.nodePath -and $StartInfo.FileName -ine $Context.tunnelClientPath){throw 'INSTALLED_EXECUTABLE_MISMATCH'}
  $server=$StartInfo.FileName -ieq $Context.nodePath
  $expectedArgs=if($server){'"'+$Context.httpEntry+'"'}else{'run --profile-dir "'+$Context.tunnelProfileDir+'" --profile "codex-bridge" --log.file "'+$Context.tunnelLogFile+'" --pid.file "'+$Context.tunnelPidFile+'"'}
  if($StartInfo.Arguments -cne $expectedArgs){throw 'INSTALLED_ARGUMENT_OVERRIDE_REJECTED'}
  $base=Get-CbInstalledChildEnvironment $Context.installedBinding
  $secretName=if($server){'CODEX_BRIDGE_HTTP_TOKEN'}else{'CONTROL_PLANE_API_KEY'}
  foreach($key in $Environment.Keys){
    if($key -cne $secretName -and (-not $base.ContainsKey($key) -or $Environment[$key] -cne $base[$key])){throw 'INSTALLED_ENV_OVERRIDE_REJECTED'}
  }
  if($server -and $Environment[$secretName] -cne $Context.token){throw 'INSTALLED_HTTP_AUTH_MISMATCH'}
  $StartInfo.UseShellExecute=$false;$StartInfo.CreateNoWindow=$true
  # Windows DLL lookup must not include a writable runtime working directory.
  # Every writable path is already absolute in the bound context/environment.
  $StartInfo.WorkingDirectory=$Context.projectRoot
  try{$childEnvironment=$StartInfo.get_EnvironmentVariables()}catch{
    if($_.Exception.InnerException -isnot [ArgumentException]){throw}
    $childEnvironment=$StartInfo.get_EnvironmentVariables()
  }
  $childEnvironment.Clear()
  foreach($entry in $Environment.GetEnumerator()){if($null -ne $entry.Value){$childEnvironment[$entry.Key]=[string]$entry.Value}}
}
function Start-CbInstalledTunnel($Context) {
  Assert-CbTunnelIdentityReady $Context
  if(-not(Test-CbServerHealth $Context)){throw 'SERVER_NOT_READY'}
  $owner=Resolve-CbRoleOwnership $Context tunnel
  if(-not $owner.canMutate){throw 'OWNERSHIP_MISMATCH'}
  if($owner.state -eq 'OwnedReady' -and (Test-CbTunnelReady $Context)){return}
  if($owner.state -ne 'Stopped'){throw 'INSTALLED_TUNNEL_NOT_STOPPED'}
  $environment=Get-CbInstalledChildEnvironment $Context.installedBinding
  $previous=[Environment]::GetEnvironmentVariable('CONTROL_PLANE_API_KEY','Process')
  $credentialGuard=$null
  try {
    if($Context.installedBinding.contract -cin @('codex-bridge-installed-binding-v2','codex-bridge-installed-binding-v3','codex-bridge-installed-binding-v4')){
      $release=Read-McpCcInstalledRelease (Join-Path $Context.installedBinding.releaseRoot 'mcp_control_center')
      # Hold the same ciphertext against writes/replacement through the existing
      # key-store read. Control Center never reads/decrypts the credential.
      $credentialGuard=[IO.File]::Open($Context.secretPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
      $digest=[Security.Cryptography.SHA256]::Create()
      try{$hash=([BitConverter]::ToString($digest.ComputeHash($credentialGuard))).Replace('-','').ToLowerInvariant()}finally{$digest.Dispose()}
      if($hash -cne $release.deployment.credentialSha256){throw 'INSTALLED_DEPLOYMENT_CHANGED'}
    }
    # The existing key-store's ambient shortcut is deliberately unavailable in installed mode.
    [Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY',$null,'Process')
    . $Context.keyStorePath
    Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $Context.configRoot -SecretPath $Context.secretPath | Out-Null
    if([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)){throw 'TUNNEL_KEY_MISSING'}
    $environment.CONTROL_PLANE_API_KEY=$env:CONTROL_PLANE_API_KEY
  } finally { if($credentialGuard){$credentialGuard.Dispose()};[Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY',$previous,'Process') }
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=$Context.tunnelClientPath
  $info.Arguments='run --profile-dir "'+$Context.tunnelProfileDir+'" --profile "codex-bridge" --log.file "'+$Context.tunnelLogFile+'" --pid.file "'+$Context.tunnelPidFile+'"'
  try {
    $process=Start-CbInstalledChildProcess $info $environment $Context
  } finally { $environment.Clear();$info.EnvironmentVariables.Clear() }
  if($null -eq $process){throw 'TUNNEL_START_FAILED'}
  Write-CbAtomicText $Context.tunnelPidFile ([string]$process.Id)
  $started=Get-CbProcess $process.Id
  if($null -eq $started){throw 'TUNNEL_START_FAILED'}
  Write-CbOwnerMetadata $Context tunnel $started
}

function New-CodexBridgeRuntimeContext {
  param([Parameter(Mandatory=$true)][string]$ProjectRoot,[string]$HostName='127.0.0.1',[int]$Port=18828,[string]$ProjectsFile,[string]$DataDir,[string]$Token,[string]$CodexCommand,[string]$CodexArgs,[string]$NodePath,[string]$TunnelClientPath,[string]$TunnelProfileDir,[string]$TunnelProfile='codex-bridge',[string]$ExplicitTunnelId,[string]$SettingsTunnelId,[string]$EnvironmentTunnelId,[string]$TunnelHealthUrl='http://127.0.0.1:18829',[string]$KeyStorePath='C:\GPT_MCPtool\project_reading\scripts\key-store.ps1',[string]$SecretPath='C:\GPT_MCPtool\project_reading\.secrets\control-plane-api-key.dpapi',[string]$ExpectedBuildId,[string]$TestActiveFlag,[int]$ServerReadyTimeoutSeconds=20,[int[]]$TunnelRecoveryDelaysSeconds=@(15,30,60))
  if(Test-CbInstalledLayout){
    if(-not(Test-CbPathEqual $ProjectRoot (Split-Path -Parent $PSScriptRoot)) -or @($PSBoundParameters.Keys|Where-Object{$_ -ne 'ProjectRoot'}).Count -gt 0){throw 'INSTALLED_CALLER_OVERRIDE_REJECTED'}
    return New-CbInstalledRuntimeContext
  }
  if([string]::IsNullOrWhiteSpace($DataDir)){
    $DataDir=Join-Path $ProjectRoot '.local\runtime'
    if((Test-Path -LiteralPath 'C:\CodexBridge') -and -not(Test-Path -LiteralPath $DataDir)){throw 'RUNTIME_MIGRATION_REQUIRED'}
  }
  $root=(Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path;$runtimeDir=Join-Path $root '.tmp';if([string]::IsNullOrWhiteSpace($ProjectsFile)){$ProjectsFile=Join-Path $root '.local\projects.json'};if([string]::IsNullOrWhiteSpace($NodePath)){$ownerPath=Join-Path $runtimeDir 'codex-bridge-http-server.owner.json';$recorded=$null;if(Test-Path -LiteralPath $ownerPath -PathType Leaf){try{$owner=[IO.File]::ReadAllText($ownerPath,[Text.Encoding]::UTF8)|ConvertFrom-Json;$candidate=[string]$owner.executablePath;if(Test-Path -LiteralPath $candidate -PathType Leaf){$recorded=$candidate}}catch{}};$NodePath=if([string]::IsNullOrWhiteSpace($recorded)){(Get-Command node -ErrorAction Stop).Source}else{$recorded}};if([string]::IsNullOrWhiteSpace($TunnelClientPath)){$TunnelClientPath=Join-Path(Split-Path -Parent $root)'project_reading\vendor\tunnel-client\tunnel-client.exe'};if([string]::IsNullOrWhiteSpace($TunnelProfileDir)){$TunnelProfileDir=Join-Path $root '.tunnel-client'};$healthUri=[Uri]$TunnelHealthUrl;if($HostName-notin@('127.0.0.1','localhost','::1','[::1]')-or$healthUri.Host-notin@('127.0.0.1','localhost','::1','[::1]')){throw 'Runtime endpoints must use loopback.'};if($ServerReadyTimeoutSeconds-lt 1-or$ServerReadyTimeoutSeconds-gt 120){throw 'ServerReadyTimeoutSeconds must be between 1 and 120.'};if(@($TunnelRecoveryDelaysSeconds).Count-lt 1-or@($TunnelRecoveryDelaysSeconds).Count-gt 5-or@($TunnelRecoveryDelaysSeconds|Where-Object{$_-lt 1-or$_-gt 120}).Count-gt 0){throw 'TunnelRecoveryDelaysSeconds must contain 1-5 bounded values.'}
  $profileDir=[IO.Path]::GetFullPath($TunnelProfileDir);$profilePath=Join-Path $profileDir "$TunnelProfile.yaml";$tunnelIdentity=Resolve-CbTunnelIdentity -ExplicitTunnelId $ExplicitTunnelId -SettingsTunnelId $SettingsTunnelId -EnvironmentTunnelId $EnvironmentTunnelId -ProfilePath $profilePath
  return [pscustomobject]@{projectRoot=$root;hostName=$HostName;port=$Port;projectsFile=[IO.Path]::GetFullPath($ProjectsFile);dataDir=[IO.Path]::GetFullPath($DataDir);token=$Token;codexCommand=$CodexCommand;codexArgs=$CodexArgs;nodePath=[IO.Path]::GetFullPath($NodePath);httpEntry=Join-Path $root 'dist\src\http-main.js';healthUrl="http://${HostName}:${Port}/health";tunnelClientPath=[IO.Path]::GetFullPath($TunnelClientPath);tunnelProfileDir=$profileDir;tunnelProfile=$TunnelProfile;tunnelProfilePath=$profilePath;tunnelIdentity=$tunnelIdentity;tunnelHealthUrl=$TunnelHealthUrl.TrimEnd('/');tunnelHealthPort=$(if($healthUri.IsDefaultPort){80}else{$healthUri.Port});runtimeDir=$runtimeDir;serverPidFile=Join-Path $runtimeDir 'codex-bridge-http-server.pid';serverOwnerFile=Join-Path $runtimeDir 'codex-bridge-http-server.owner.json';tunnelPidFile=Join-Path $runtimeDir 'tunnel-client.pid';tunnelOwnerFile=Join-Path $runtimeDir 'tunnel-client.owner.json';tunnelLogFile=Join-Path $runtimeDir 'tunnel-client.log';actionLogFile=Join-Path $runtimeDir 'runtime-control.jsonl';keyStorePath=[IO.Path]::GetFullPath($KeyStorePath);secretPath=$SecretPath;expectedBuildId=$ExpectedBuildId;testActiveFlag=$TestActiveFlag;serverReadyTimeoutSeconds=$ServerReadyTimeoutSeconds;tunnelRecoveryDelaysSeconds=@($TunnelRecoveryDelaysSeconds)}
}

function Write-CodexBridgeLifecycleEvent {param($Context,[string]$Action,[bool]$Ok,[string]$BeforeStatus,[string]$AfterStatus,[int[]]$OwnedPids=@(),[int]$ElapsedMs,[string]$ErrorCode,[string]$Message);Assert-CbInstalledMutationBlocked $Context;New-Item -ItemType Directory -Force -Path $Context.runtimeDir|Out-Null;$event=[ordered]@{timestamp=[DateTime]::UtcNow.ToString('o');action=$Action;ok=$Ok;beforeStatus=$BeforeStatus;afterStatus=$AfterStatus;ownedPids=@($OwnedPids);elapsedMs=$ElapsedMs;errorCode=$ErrorCode;message=$Message};[IO.File]::AppendAllText($Context.actionLogFile,(($event|ConvertTo-Json -Compress -Depth 5)+[Environment]::NewLine),$script:Utf8NoBom)}

Export-ModuleMember -Function @('New-CodexBridgeRuntimeContext','Get-CodexBridgeRuntimeStatus','Invoke-CodexBridgeLifecycleAction','Write-CodexBridgeLifecycleEvent','Resolve-CbTunnelIdentity','Get-CbTunnelIdentitySummary','Assert-CbTunnelIdentityReady','ConvertTo-CbRemoteRegistrationEvidence')
