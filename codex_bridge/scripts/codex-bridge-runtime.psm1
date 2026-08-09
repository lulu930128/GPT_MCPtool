Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$script:Utf8NoBom = New-Object Text.UTF8Encoding($false)

function Test-CbPathEqual {
  param([string]$Left, [string]$Right)
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
  try { return [IO.Path]::GetFullPath($Left).TrimEnd('\').Equals([IO.Path]::GetFullPath($Right).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) }
  catch { return $false }
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
  $netstatPath=Join-Path $env:WINDIR 'System32\netstat.exe'
  try{
    $lines=@(& $netstatPath -ano -p tcp 2>$null);if($LASTEXITCODE-ne 0){throw 'netstat failed'};$pids=@()
    foreach($line in $lines){$parts=@(([string]$line).Trim()-split '\s+');if($parts.Count-lt 5-or$parts[0]-ne'TCP'-or$parts[3]-ne'LISTENING'){continue};if($parts[1]-notmatch':(\d+)$'-or[int]$matches[1]-ne$Port){continue};$parsed=0;if([int]::TryParse($parts[4],[ref]$parsed)-and$parsed-gt 0){$pids+=$parsed}}
    return [pscustomobject]@{known=$true;pids=@($pids|Sort-Object -Unique);errorCode=$null}
  }catch{return [pscustomobject]@{known=$false;pids=@();errorCode='listener_query_failed'}}
}

function Add-CbHashBytes {
  param([Parameter(Mandatory=$true)]$Hash,[Parameter(Mandatory=$true)][byte[]]$Bytes)
  if($Bytes.Length-gt 0){[void]$Hash.TransformBlock($Bytes,0,$Bytes.Length,$Bytes,0)}
}

function Add-CbHashPath {
  param([Parameter(Mandatory=$true)]$Hash,[Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][string]$Base)
  if(Test-Path -LiteralPath $Path -PathType Container){foreach($child in @(Get-ChildItem -LiteralPath $Path -Force|Sort-Object Name)){Add-CbHashPath -Hash $Hash -Path $child.FullName -Base $Base};return}
  if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){return}
  $relative=[IO.Path]::GetFullPath($Path).Substring([IO.Path]::GetFullPath($Base).Length).Replace('\','/')
  Add-CbHashBytes -Hash $Hash -Bytes ([Text.Encoding]::UTF8.GetBytes($relative))
  Add-CbHashBytes -Hash $Hash -Bytes ([IO.File]::ReadAllBytes($Path))
}

function Get-CbExpectedBuildId {
  param([Parameter(Mandatory=$true)]$Context)
  if(-not[string]::IsNullOrWhiteSpace([string]$Context.expectedBuildId)){return [string]$Context.expectedBuildId}
  $sha=[Security.Cryptography.SHA256]::Create()
  try{foreach($candidate in @((Join-Path $Context.projectRoot 'package.json'),(Join-Path $Context.projectRoot 'dist\src'),(Join-Path $Context.projectRoot 'web'))){Add-CbHashPath -Hash $sha -Path $candidate -Base $Context.projectRoot};[void]$sha.TransformFinalBlock(@(),0,0);return (-join($sha.Hash|ForEach-Object{$_.ToString('x2')})).Substring(0,16)}
  finally{$sha.Dispose()}
}

function Test-CbBuildCurrent {
  param([Parameter(Mandatory=$true)]$Context)
  if(-not(Test-Path -LiteralPath $Context.httpEntry -PathType Leaf)){return $false};$entryTime=(Get-Item -LiteralPath $Context.httpEntry).LastWriteTimeUtc
  $sources=@(Get-ChildItem -LiteralPath (Join-Path $Context.projectRoot 'src') -Recurse -File -ErrorAction SilentlyContinue)+@(Get-ChildItem -LiteralPath (Join-Path $Context.projectRoot 'web') -Recurse -File -ErrorAction SilentlyContinue)+@(Get-Item -LiteralPath (Join-Path $Context.projectRoot 'package.json') -ErrorAction SilentlyContinue)
  return @($sources|Where-Object{$_.LastWriteTimeUtc-gt$entryTime}).Count-eq 0
}

function Test-CbTcpPort {param([int]$Port,[int]$TimeoutMilliseconds=250);$client=New-Object Net.Sockets.TcpClient;try{$async=$client.BeginConnect('127.0.0.1',$Port,$null,$null);if(-not$async.AsyncWaitHandle.WaitOne($TimeoutMilliseconds,$false)){return $false};$client.EndConnect($async);return $true}catch{return $false}finally{$client.Dispose()}}

function Get-CbHealth {
  param([Parameter(Mandatory=$true)]$Context)
  if(-not(Test-CbTcpPort -Port $Context.port)){return $null}
  try{return Invoke-RestMethod -UseBasicParsing -Uri $Context.healthUrl -TimeoutSec 2}catch{return $null}
}

function Test-CbServerHealth {
  param([Parameter(Mandatory=$true)]$Context)
  $health=Get-CbHealth -Context $Context;if($null-eq$health){return $false};$expected=Get-CbExpectedBuildId -Context $Context
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
  $active=try{[int]$health.jobs.active}catch{-1};$awaiting=try{[int]$health.jobs.awaitingApproval}catch{-1};$controllerState=[string]$health.controller
  if($active-ne 0-or$awaiting-ne 0-or$controllerState-notin@('idle','ready')){throw 'ACTIVE_WORK_PRESENT: Finish or cancel active work and resolve pending approvals before changing the Bridge core.'}
}

function Get-CbRoleDefinition {param($Context,[ValidateSet('server','tunnel')][string]$Role);if($Role-eq'server'){return [pscustomobject]@{pidFile=$Context.serverPidFile;ownerFile=$Context.serverOwnerFile;port=$Context.port;executablePath=$Context.nodePath;identity=$Context.httpEntry}};return [pscustomobject]@{pidFile=$Context.tunnelPidFile;ownerFile=$Context.tunnelOwnerFile;port=$Context.tunnelHealthPort;executablePath=$Context.tunnelClientPath;identity=$Context.tunnelProfile}}

function Test-CbExecutableIdentity {param($Context,[ValidateSet('server','tunnel')][string]$Role,$Process);$definition=Get-CbRoleDefinition -Context $Context -Role $Role;return(Test-CbPathEqual -Left([string]$Process.ExecutablePath)-Right([string]$definition.executablePath))}

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
  param($Context,[ValidateSet('server','tunnel')][string]$Role,[switch]$AdoptLegacyExactListener)
  $definition=Get-CbRoleDefinition -Context $Context -Role $Role;$managedPid=Read-CbPidFile -Path $definition.pidFile;$managedProcess=$null
  if($null-ne$managedPid){$managedProcess=Get-CbProcess -ProcessId $managedPid;if($null-eq$managedProcess){Remove-CbRuntimeFile -Path $definition.pidFile -ExpectedPid $managedPid;Remove-CbRuntimeFile -Path $definition.ownerFile;$managedPid=$null}elseif(-not(Test-CbExecutableIdentity -Context $Context -Role $Role -Process $managedProcess)){return [pscustomobject]@{role=$Role;state='OwnershipMismatch';pid=$managedPid;listenerPid=$null;reason='pid_process_mismatch';canMutate=$false;adopted=$false}}}
  $listener=Get-CbListenerState -Port $definition.port;if(-not$listener.known){return [pscustomobject]@{role=$Role;state='OwnershipUnknown';pid=$managedPid;listenerPid=$null;reason=$listener.errorCode;canMutate=$false;adopted=$false}};if($listener.pids.Count-gt 1){return [pscustomobject]@{role=$Role;state='OwnershipMismatch';pid=$managedPid;listenerPid=$null;reason='multiple_listener_owners';canMutate=$false;adopted=$false}};$listenerPid=if($listener.pids.Count-eq 1){[int]$listener.pids[0]}else{$null}
  if($null-ne$managedPid){if($null-ne$listenerPid-and$listenerPid-ne$managedPid){return [pscustomobject]@{role=$Role;state='OwnershipMismatch';pid=$managedPid;listenerPid=$listenerPid;reason='managed_pid_not_listener';canMutate=$false;adopted=$false}};$metadataValid=Test-CbOwnerMetadata -Context $Context -Role $Role -Process $managedProcess;if(-not$metadataValid){if(-not$AdoptLegacyExactListener-or$null-eq$listenerPid-or-not(Test-CbRoleReady -Context $Context -Role $Role)-or-not(Test-CbLegacyCommandIdentity -Context $Context -Role $Role -Process $managedProcess)){return [pscustomobject]@{role=$Role;state='OwnershipMismatch';pid=$managedPid;listenerPid=$listenerPid;reason='owner_metadata_missing_or_stale';canMutate=$false;adopted=$false}};Write-CbOwnerMetadata -Context $Context -Role $Role -Process $managedProcess};if($null-eq$listenerPid){return [pscustomobject]@{role=$Role;state='OwnedNotListening';pid=$managedPid;listenerPid=$null;reason=$null;canMutate=$true;adopted=$false}};return [pscustomobject]@{role=$Role;state='OwnedReady';pid=$managedPid;listenerPid=$listenerPid;reason=$null;canMutate=$true;adopted=[bool]$AdoptLegacyExactListener}}
  if($null-eq$listenerPid){return [pscustomobject]@{role=$Role;state='Stopped';pid=$null;listenerPid=$null;reason=$null;canMutate=$true;adopted=$false}}
  $listenerProcess=Get-CbProcess -ProcessId $listenerPid;if($null-eq$listenerProcess-or-not(Test-CbExecutableIdentity -Context $Context -Role $Role -Process $listenerProcess)-or-not(Test-CbRoleReady -Context $Context -Role $Role)){return [pscustomobject]@{role=$Role;state='OwnershipMismatch';pid=$null;listenerPid=$listenerPid;reason='foreign_listener';canMutate=$false;adopted=$false}}
  if(-not$AdoptLegacyExactListener-or-not(Test-CbLegacyCommandIdentity -Context $Context -Role $Role -Process $listenerProcess)){return [pscustomobject]@{role=$Role;state='OwnershipMismatch';pid=$null;listenerPid=$listenerPid;reason='unmanaged_listener';canMutate=$false;adopted=$false}}
  Write-CbAtomicText -Path $definition.pidFile -Value([string]$listenerPid);Write-CbOwnerMetadata -Context $Context -Role $Role -Process $listenerProcess;return [pscustomobject]@{role=$Role;state='OwnedReady';pid=$listenerPid;listenerPid=$listenerPid;reason=$null;canMutate=$true;adopted=$true}
}

function Get-CodexBridgeRuntimeStatus {
  param([Parameter(Mandatory=$true)]$Context,[switch]$AdoptLegacyExactListeners)
  $server=Resolve-CbRoleOwnership -Context $Context -Role server -AdoptLegacyExactListener:$AdoptLegacyExactListeners;$tunnel=Resolve-CbRoleOwnership -Context $Context -Role tunnel -AdoptLegacyExactListener:$AdoptLegacyExactListeners;$serverHealthy=Test-CbServerHealth -Context $Context;$tunnelReady=Test-CbTunnelReady -Context $Context;$states=@($server.state,$tunnel.state)
  $status=if(@($states|Where-Object{$_-in@('OwnershipMismatch','OwnershipUnknown')}).Count-gt 0){'OwnershipMismatch'}elseif(-not$serverHealthy-and$server.state-eq'Stopped'-and$tunnel.state-eq'Stopped'){'Stopped'}elseif(-not$serverHealthy){'Unhealthy'}elseif(-not$tunnelReady){'Degraded'}else{'Ready'}
  return [pscustomobject]@{status=$status;server=[pscustomobject]@{healthy=$serverHealthy;ownership=$server.state;pid=$server.pid;listenerPid=$server.listenerPid;adopted=$server.adopted};tunnel=[pscustomobject]@{ready=$tunnelReady;ownership=$tunnel.state;pid=$tunnel.pid;listenerPid=$tunnel.listenerPid;adopted=$tunnel.adopted};ownedPids=@(@($server.pid,$tunnel.pid)|Where-Object{$null-ne$_}|ForEach-Object{[int]$_}|Sort-Object -Unique)}
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

function Stop-CbOwnedRole {
  param($Context,[ValidateSet('server','tunnel')][string]$Role)
  $definition=Get-CbRoleDefinition -Context $Context -Role $Role;$ownership=Resolve-CbRoleOwnership -Context $Context -Role $Role;if(-not$ownership.canMutate){throw "OWNERSHIP_MISMATCH: Cannot stop $Role because ownership is $($ownership.state)."};if($ownership.state-eq'Stopped'){return};$process=Get-CbProcess -ProcessId([int]$ownership.pid);if($null-eq$process-or-not(Test-CbExecutableIdentity -Context $Context -Role $Role -Process $process)-or-not(Test-CbOwnerMetadata -Context $Context -Role $Role -Process $process)){throw "OWNERSHIP_MISMATCH: $Role PID changed before stop."};Stop-Process -Id([int]$ownership.pid)-Force -ErrorAction Stop;$deadline=[DateTime]::UtcNow.AddSeconds(5);while((Get-Process -Id([int]$ownership.pid)-ErrorAction SilentlyContinue)-and[DateTime]::UtcNow-lt$deadline){Start-Sleep -Milliseconds 100};if(Get-Process -Id([int]$ownership.pid)-ErrorAction SilentlyContinue){throw "STOP_TIMEOUT: $Role did not exit."};Remove-CbRuntimeFile -Path $definition.pidFile -ExpectedPid([int]$ownership.pid);Remove-CbRuntimeFile -Path $definition.ownerFile
}

function Start-CbServer {
  param($Context)
  $ownership=Resolve-CbRoleOwnership -Context $Context -Role server;if(Test-CbServerHealth -Context $Context){if($ownership.canMutate-and$ownership.state-eq'OwnedReady'){return};throw 'OWNERSHIP_MISMATCH: Healthy Bridge server is not controller-owned.'};if(-not$ownership.canMutate){throw "OWNERSHIP_MISMATCH: Cannot start server while ownership is $($ownership.state)."};if($ownership.state-eq'OwnedNotListening'){Stop-CbOwnedRole -Context $Context -Role server};foreach($required in @($Context.nodePath,$Context.httpEntry,$Context.projectsFile)){if(-not(Test-Path -LiteralPath $required -PathType Leaf)){throw 'SERVER_ENTRY_MISSING: Bridge build or allowlist is incomplete.'}};if(-not(Test-CbBuildCurrent -Context $Context)){throw 'BUILD_STALE: Run npm run build before starting Codex Bridge.'}
  $startInfo=New-Object Diagnostics.ProcessStartInfo;$startInfo.FileName=$Context.nodePath;$startInfo.Arguments="`"$($Context.httpEntry)`"";$startInfo.WorkingDirectory=$Context.projectRoot;$startInfo.UseShellExecute=$true;$startInfo.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
  $environment=@{CODEX_BRIDGE_PROJECT_ROOT=$Context.projectRoot;CODEX_BRIDGE_PROJECTS_FILE=$Context.projectsFile;CODEX_BRIDGE_DATA_DIR=$Context.dataDir;CODEX_BRIDGE_HTTP_HOST=$Context.hostName;CODEX_BRIDGE_HTTP_PORT=[string]$Context.port;CODEX_BRIDGE_HTTP_TOKEN=$(if([string]::IsNullOrWhiteSpace($Context.token)){$null}else{$Context.token});CODEX_BRIDGE_CODEX_COMMAND=$(if([string]::IsNullOrWhiteSpace($Context.codexCommand)){$null}else{$Context.codexCommand});CODEX_BRIDGE_CODEX_ARGS=$(if([string]::IsNullOrWhiteSpace($Context.codexArgs)){$null}else{$Context.codexArgs});CODEX_BRIDGE_EXPECTED_TEST_BUILD=$Context.expectedBuildId;CODEX_BRIDGE_TEST_ACTIVE_FLAG=$Context.testActiveFlag}
  $process=Start-CbChildProcess -StartInfo $startInfo -Environment $environment;if($null-eq$process){throw 'SERVER_START_FAILED: Node process did not start.'};Write-CbAtomicText -Path $Context.serverPidFile -Value([string]$process.Id);$started=Get-CbProcess -ProcessId $process.Id;if($null-eq$started){throw 'SERVER_START_FAILED: Started server is unavailable.'};Write-CbOwnerMetadata -Context $Context -Role server -Process $started
  if(-not(Wait-CbCondition -TimeoutSeconds $Context.serverReadyTimeoutSeconds -Condition{Test-CbServerHealth -Context $Context})){$current=Get-CbProcess -ProcessId $process.Id;if($null-ne$current-and(Test-CbExecutableIdentity -Context $Context -Role server -Process $current)-and(Test-CbOwnerMetadata -Context $Context -Role server -Process $current)){Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue};Remove-CbRuntimeFile -Path $Context.serverPidFile -ExpectedPid $process.Id;Remove-CbRuntimeFile -Path $Context.serverOwnerFile;throw 'SERVER_NOT_READY: Bridge did not reach the expected build.'};$ready=Resolve-CbRoleOwnership -Context $Context -Role server;if(-not$ready.canMutate-or$ready.pid-ne$process.Id){throw 'OWNERSHIP_MISMATCH: Started server does not own the listener.'}
}

function Start-CbTunnelOnce {
  param($Context)
  if(-not(Test-CbServerHealth -Context $Context)){throw 'SERVER_NOT_READY: Tunnel start requires Bridge core.'};$ownership=Resolve-CbRoleOwnership -Context $Context -Role tunnel;if(Test-CbTunnelReady -Context $Context){if($ownership.canMutate-and$ownership.state-eq'OwnedReady'){return};throw 'OWNERSHIP_MISMATCH: Ready tunnel is not controller-owned.'};if(-not$ownership.canMutate){throw "OWNERSHIP_MISMATCH: Cannot start tunnel while ownership is $($ownership.state)."};if($ownership.state-eq'OwnedNotListening'){Stop-CbOwnedRole -Context $Context -Role tunnel};if(-not(Test-Path -LiteralPath $Context.tunnelClientPath -PathType Leaf)){throw 'TUNNEL_CLIENT_MISSING: tunnel-client.exe is missing.'};if(-not(Test-Path -LiteralPath $Context.tunnelProfilePath -PathType Leaf)){throw 'TUNNEL_PROFILE_MISSING: Tunnel profile is missing.'};. $Context.keyStorePath;Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $Context.projectRoot -SecretPath $Context.secretPath|Out-Null;if([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)){throw 'TUNNEL_KEY_MISSING: Control-plane key is unavailable.'};New-Item -ItemType Directory -Force -Path $Context.runtimeDir|Out-Null
  $startInfo=New-Object Diagnostics.ProcessStartInfo;$startInfo.FileName=$Context.tunnelClientPath;$startInfo.Arguments="run --profile-dir `"$($Context.tunnelProfileDir)`" --profile `"$($Context.tunnelProfile)`" --log.file `"$($Context.tunnelLogFile)`" --pid.file `"$($Context.tunnelPidFile)`"";$startInfo.WorkingDirectory=$Context.projectRoot;$startInfo.UseShellExecute=$true;$startInfo.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden;$process=Start-CbChildProcess -StartInfo $startInfo -Environment @{CONTROL_PLANE_API_KEY=$env:CONTROL_PLANE_API_KEY};if($null-eq$process){throw 'TUNNEL_START_FAILED: Tunnel process did not start.'};Write-CbAtomicText -Path $Context.tunnelPidFile -Value([string]$process.Id);$started=Get-CbProcess -ProcessId $process.Id;if($null-eq$started){throw 'TUNNEL_START_FAILED: Started tunnel is unavailable.'};Write-CbOwnerMetadata -Context $Context -Role tunnel -Process $started
}

function Repair-CbConnectivity {param($Context);$server=Resolve-CbRoleOwnership -Context $Context -Role server;if(-not(Test-CbServerHealth -Context $Context)-or-not$server.canMutate-or$server.state-ne'OwnedReady'){throw 'SERVER_NOT_READY: Connectivity repair requires an owned Bridge core.'};$tunnel=Resolve-CbRoleOwnership -Context $Context -Role tunnel;if(Test-CbTunnelReady -Context $Context){if($tunnel.canMutate-and$tunnel.state-eq'OwnedReady'){return};throw 'OWNERSHIP_MISMATCH: Ready tunnel is not controller-owned.'};if(-not$tunnel.canMutate){throw "OWNERSHIP_MISMATCH: Cannot repair tunnel while ownership is $($tunnel.state)."};if($tunnel.state-eq'OwnedNotListening'){Stop-CbOwnedRole -Context $Context -Role tunnel};foreach($delay in @($Context.tunnelRecoveryDelaysSeconds)){Start-CbTunnelOnce -Context $Context;if(Wait-CbCondition -TimeoutSeconds([int]$delay)-Condition{Test-CbTunnelReady -Context $Context}){$ready=Resolve-CbRoleOwnership -Context $Context -Role tunnel;if($ready.canMutate-and$ready.state-eq'OwnedReady'){return};throw 'OWNERSHIP_MISMATCH: Tunnel listener is not owned by the started process.'};Stop-CbOwnedRole -Context $Context -Role tunnel};throw 'TUNNEL_NOT_READY: Tunnel failed bounded recovery.'}

function Assert-CbShutdownPreflight {param($Context);foreach($role in @('tunnel','server')){$ownership=Resolve-CbRoleOwnership -Context $Context -Role $role;if(-not$ownership.canMutate){throw "OWNERSHIP_MISMATCH: Cannot mutate $role while ownership is $($ownership.state)."}}}

function Invoke-CodexBridgeLifecycleAction {
  param($Context,[ValidateSet('EnsureRunning','RepairConnectivity','RestartCore','ReloadRuntime','ShutdownRuntime')][string]$Action)
  switch($Action){
    'EnsureRunning'{Start-CbServer -Context $Context;Repair-CbConnectivity -Context $Context}
    'RepairConnectivity'{Repair-CbConnectivity -Context $Context}
    'RestartCore'{$server=Resolve-CbRoleOwnership -Context $Context -Role server;if(-not$server.canMutate){throw "OWNERSHIP_MISMATCH: Cannot restart core while ownership is $($server.state)."};if($server.state-ne'Stopped'){Assert-CbIdleForMutation -Context $Context;Stop-CbOwnedRole -Context $Context -Role server};Start-CbServer -Context $Context}
    'ReloadRuntime'{Assert-CbShutdownPreflight -Context $Context;$server=Resolve-CbRoleOwnership -Context $Context -Role server;if($server.state-ne'Stopped'){Assert-CbIdleForMutation -Context $Context};Stop-CbOwnedRole -Context $Context -Role tunnel;Stop-CbOwnedRole -Context $Context -Role server;Start-CbServer -Context $Context;Repair-CbConnectivity -Context $Context}
    'ShutdownRuntime'{Assert-CbShutdownPreflight -Context $Context;$server=Resolve-CbRoleOwnership -Context $Context -Role server;if($server.state-ne'Stopped'){Assert-CbIdleForMutation -Context $Context};Stop-CbOwnedRole -Context $Context -Role tunnel;Stop-CbOwnedRole -Context $Context -Role server}
  }
}

function New-CodexBridgeRuntimeContext {
  param([Parameter(Mandatory=$true)][string]$ProjectRoot,[string]$HostName='127.0.0.1',[int]$Port=8828,[string]$ProjectsFile,[string]$DataDir='C:\CodexBridge',[string]$Token,[string]$CodexCommand,[string]$CodexArgs,[string]$NodePath,[string]$TunnelClientPath,[string]$TunnelProfileDir,[string]$TunnelProfile='codex-bridge',[string]$TunnelHealthUrl='http://127.0.0.1:8829',[string]$KeyStorePath='C:\GPT_MCPtool\project_reading\scripts\key-store.ps1',[string]$SecretPath='C:\GPT_MCPtool\project_reading\.secrets\control-plane-api-key.dpapi',[string]$ExpectedBuildId,[string]$TestActiveFlag,[int]$ServerReadyTimeoutSeconds=20,[int[]]$TunnelRecoveryDelaysSeconds=@(15,30,60))
  $root=(Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path;$runtimeDir=Join-Path $root '.tmp';if([string]::IsNullOrWhiteSpace($ProjectsFile)){$ProjectsFile=Join-Path $root '.local\projects.json'};if([string]::IsNullOrWhiteSpace($NodePath)){$ownerPath=Join-Path $runtimeDir 'codex-bridge-http-server.owner.json';$recorded=$null;if(Test-Path -LiteralPath $ownerPath -PathType Leaf){try{$owner=[IO.File]::ReadAllText($ownerPath,[Text.Encoding]::UTF8)|ConvertFrom-Json;$candidate=[string]$owner.executablePath;if(Test-Path -LiteralPath $candidate -PathType Leaf){$recorded=$candidate}}catch{}};$NodePath=if([string]::IsNullOrWhiteSpace($recorded)){(Get-Command node -ErrorAction Stop).Source}else{$recorded}};if([string]::IsNullOrWhiteSpace($TunnelClientPath)){$TunnelClientPath=Join-Path(Split-Path -Parent $root)'project_reading\vendor\tunnel-client\tunnel-client.exe'};if([string]::IsNullOrWhiteSpace($TunnelProfileDir)){$TunnelProfileDir=Join-Path $root '.tunnel-client'};$healthUri=[Uri]$TunnelHealthUrl;if($HostName-notin@('127.0.0.1','localhost','::1','[::1]')-or$healthUri.Host-notin@('127.0.0.1','localhost','::1','[::1]')){throw 'Runtime endpoints must use loopback.'};if($ServerReadyTimeoutSeconds-lt 1-or$ServerReadyTimeoutSeconds-gt 120){throw 'ServerReadyTimeoutSeconds must be between 1 and 120.'};if(@($TunnelRecoveryDelaysSeconds).Count-lt 1-or@($TunnelRecoveryDelaysSeconds).Count-gt 5-or@($TunnelRecoveryDelaysSeconds|Where-Object{$_-lt 1-or$_-gt 120}).Count-gt 0){throw 'TunnelRecoveryDelaysSeconds must contain 1-5 bounded values.'}
  return [pscustomobject]@{projectRoot=$root;hostName=$HostName;port=$Port;projectsFile=[IO.Path]::GetFullPath($ProjectsFile);dataDir=[IO.Path]::GetFullPath($DataDir);token=$Token;codexCommand=$CodexCommand;codexArgs=$CodexArgs;nodePath=[IO.Path]::GetFullPath($NodePath);httpEntry=Join-Path $root 'dist\src\http-main.js';healthUrl="http://${HostName}:${Port}/health";tunnelClientPath=[IO.Path]::GetFullPath($TunnelClientPath);tunnelProfileDir=[IO.Path]::GetFullPath($TunnelProfileDir);tunnelProfile=$TunnelProfile;tunnelProfilePath=Join-Path([IO.Path]::GetFullPath($TunnelProfileDir))"$TunnelProfile.yaml";tunnelHealthUrl=$TunnelHealthUrl.TrimEnd('/');tunnelHealthPort=$(if($healthUri.IsDefaultPort){80}else{$healthUri.Port});runtimeDir=$runtimeDir;serverPidFile=Join-Path $runtimeDir 'codex-bridge-http-server.pid';serverOwnerFile=Join-Path $runtimeDir 'codex-bridge-http-server.owner.json';tunnelPidFile=Join-Path $runtimeDir 'tunnel-client.pid';tunnelOwnerFile=Join-Path $runtimeDir 'tunnel-client.owner.json';tunnelLogFile=Join-Path $runtimeDir 'tunnel-client.log';actionLogFile=Join-Path $runtimeDir 'runtime-control.jsonl';keyStorePath=[IO.Path]::GetFullPath($KeyStorePath);secretPath=$SecretPath;expectedBuildId=$ExpectedBuildId;testActiveFlag=$TestActiveFlag;serverReadyTimeoutSeconds=$ServerReadyTimeoutSeconds;tunnelRecoveryDelaysSeconds=@($TunnelRecoveryDelaysSeconds)}
}

function Write-CodexBridgeLifecycleEvent {param($Context,[string]$Action,[bool]$Ok,[string]$BeforeStatus,[string]$AfterStatus,[int[]]$OwnedPids=@(),[int]$ElapsedMs,[string]$ErrorCode,[string]$Message);New-Item -ItemType Directory -Force -Path $Context.runtimeDir|Out-Null;$event=[ordered]@{timestamp=[DateTime]::UtcNow.ToString('o');action=$Action;ok=$Ok;beforeStatus=$BeforeStatus;afterStatus=$AfterStatus;ownedPids=@($OwnedPids);elapsedMs=$ElapsedMs;errorCode=$ErrorCode;message=$Message};[IO.File]::AppendAllText($Context.actionLogFile,(($event|ConvertTo-Json -Compress -Depth 5)+[Environment]::NewLine),$script:Utf8NoBom)}

Export-ModuleMember -Function @('New-CodexBridgeRuntimeContext','Get-CodexBridgeRuntimeStatus','Invoke-CodexBridgeLifecycleAction','Write-CodexBridgeLifecycleEvent')
