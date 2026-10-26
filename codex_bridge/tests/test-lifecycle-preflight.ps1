Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
if($PSVersionTable.PSEdition-ne'Desktop'-or$PSVersionTable.PSVersion.Major-ne 5){throw 'Windows PowerShell 5.1 required'}
$root=Split-Path -Parent $PSScriptRoot
$base=Join-Path $root '.tmp'
$fixtureRoot=Join-Path $base ('lifecycle-preflight-'+[guid]::NewGuid().ToString('N'))
$fixture=Join-Path $fixtureRoot 'codex_bridge'
$utf8=New-Object Text.UTF8Encoding($false)
$passed=0
function Check($value,$message){if(-not$value){throw $message};$script:passed++}
function Write-Text($path,$value){[IO.File]::WriteAllText($path,$value,$utf8)}
$module=$null
try{
  foreach($dir in @('scripts','src','web','dist','runtime')){New-Item -ItemType Directory -Force -Path (Join-Path $fixture $dir)|Out-Null}
  Copy-Item -LiteralPath (Join-Path $root 'dist\src') -Destination (Join-Path $fixture 'dist') -Recurse
  Copy-Item -LiteralPath (Join-Path $root 'scripts\codex-bridge-runtime.psm1'),(Join-Path $root 'scripts\runtime-build-id.mjs') -Destination (Join-Path $fixture 'scripts')
  foreach($name in @('OwnedProcess.Native.cs','cooperative-shutdown-host.ps1','process-identity.ps1','cooperative-layout.ps1')){
    Copy-Item -LiteralPath (Join-Path $root "scripts\$name") -Destination (Join-Path $fixture "scripts\$name")
  }
  $nativeFixture=Join-Path $fixtureRoot 'mcp_control_center\src'
  New-Item -ItemType Directory -Force -Path $nativeFixture|Out-Null
  foreach($name in @('NormalOperator.Native.cs','RemoteSelfReload.Native.cs')){
    Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $root) "mcp_control_center\src\$name") -Destination (Join-Path $nativeFixture $name)
  }
  Copy-Item -LiteralPath (Join-Path $root 'web\codex-console.html'),(Join-Path $root 'web\self-reload.html') -Destination (Join-Path $fixture 'web')
  Write-Text (Join-Path $fixture 'package.json') '{"type":"module"}'
  Write-Text (Join-Path $fixture 'projects.json') (@{projects=@(@{id='fixture';name='Fixture';path=$fixture})}|ConvertTo-Json -Depth 4)
  Write-Text (Join-Path $fixture 'profile.yaml') 'tunnel_id: tunnel_fixture'
  Write-Text (Join-Path $fixture 'key-store.ps1') '# not executed'
  $entry=Join-Path $fixture 'dist\src\http-main.js'
  $entryTime=[DateTime]::UtcNow.AddMinutes(1)
  (Get-Item $entry).LastWriteTimeUtc=$entryTime
  $node=(Get-Command node.exe).Source
  $context=[pscustomobject]@{projectRoot=$fixture;nodePath=$node;httpEntry=$entry;expectedBuildId='fixture-build';
    projectsFile=(Join-Path $fixture 'projects.json');dataDir=(Join-Path $fixture 'NEVER-CREATE-DATA');
    hostName='127.0.0.1';port=1;codexCommand=$node;codexArgs='["app-server"]';
    tunnelClientPath=$node;tunnelProfilePath=(Join-Path $fixture 'profile.yaml');tunnelProfile='fixture';tunnelHealthPort=2;
    keyStorePath=(Join-Path $fixture 'key-store.ps1');runtimeDir=(Join-Path $fixture 'runtime');
    serverPidFile=(Join-Path $fixture 'runtime\server.pid');serverOwnerFile=(Join-Path $fixture 'runtime\server.owner.json');
    tunnelPidFile=(Join-Path $fixture 'runtime\tunnel.pid');tunnelOwnerFile=(Join-Path $fixture 'runtime\tunnel.owner.json');
    tunnelIdentity=[pscustomobject]@{status='Ready';resolvedTunnelId='tunnel_fixture'}}
  $module=Import-Module (Join-Path $fixture 'scripts\codex-bridge-runtime.psm1') -PassThru -Force
  & $module {
    param($c)
    $script:fixtureContext=$c;$script:mode='idle';$script:opens=0;$script:starts=0
    function script:Get-CbProcess {
      param($ProcessId)
      [pscustomobject]@{ProcessId=$ProcessId;ExecutablePath=$script:fixtureContext.nodePath;StartTimeUtc='2026-01-01T00:00:00.0000000Z'}
    }
    function script:Get-CbListenerState {
      param($Port)
      [pscustomobject]@{known=($script:mode-ne'unknown-owner');pids=@($(if($Port-eq 1){8123}else{8124}));errorCode='fixture'}
    }
    function script:Get-CbHealth {
      if($script:mode-eq'unknown-work'){return $null}
      if($script:mode-eq'null-work'){return [pscustomobject]@{controller='ready';jobs=[pscustomobject]@{active=$null;awaitingApproval=0}}}
      [pscustomobject]@{controller='ready';jobs=[pscustomobject]@{active=$(if($script:mode-eq'active'){1}else{0});awaitingApproval=0}}
    }
    function script:Open-CbOwnedProcess {$script:opens++;throw 'UNEXPECTED_STOP'}
    function script:Start-CbChildProcess {$script:starts++;throw 'UNEXPECTED_START'}
    foreach($role in @('server','tunnel')){
      $id=if($role-eq'server'){8123}else{8124}
      $def=Get-CbRoleDefinition $c $role
      Write-CbAtomicText $def.pidFile ([string]$id)
      Write-CbOwnerMetadata $c $role (Get-CbProcess $id)
    }
  } $context
  $before=@{};foreach($file in Get-ChildItem $context.runtimeDir){$before[$file.Name]=[IO.File]::ReadAllText($file.FullName)}
  $cases=@(
    @{name='stale';path='src\new.ts';value='// changed';code='BUILD_STALE'},
    @{name='missing-entry';path='dist\src\http-main.js';code='SERVER_ENTRY_MISSING'},
    @{name='missing-input-dir';path='src';code='BUILD_CHECK_FAILED'},
    @{name='missing-manifest';path='package.json';code='BUILD_CHECK_FAILED'},
    @{name='bad-manifest';path='package.json';value='{';code='STARTUP_PREFLIGHT_FAILED'},
    @{name='bad-allowlist';path='projects.json';value='{"projects":[]}';code='STARTUP_PREFLIGHT_FAILED'},
    @{name='bad-entry';path='dist\src\http-main.js';value='this is not javascript !';code='STARTUP_PREFLIGHT_FAILED'},
    @{name='missing-widget';path='web\codex-console.html';code='STARTUP_PREFLIGHT_FAILED'},
    @{name='missing-helper';path='scripts\runtime-build-id.mjs';code='STARTUP_PREFLIGHT_FAILED'},
    @{name='helper-error';path='scripts\runtime-build-id.mjs';value='process.exitCode=3';code='STARTUP_PREFLIGHT_FAILED'},
    @{name='helper-timeout';path='scripts\runtime-build-id.mjs';value='setInterval(()=>{},1000)';code='STARTUP_PREFLIGHT_FAILED'},
    @{name='active';code='ACTIVE_WORK_PRESENT'},
    @{name='unknown-work';code='ACTIVE_STATE_UNKNOWN'},
    @{name='null-work';code='ACTIVE_STATE_UNKNOWN'},
    @{name='unknown-owner';code='OWNERSHIP_MISMATCH'},
    @{name='idle';code='BLOCKED_GRACEFUL_SHUTDOWN_UNAVAILABLE'}
  )
  foreach($case in $cases){
    $path=$null;$backup=$null
    try{
      & $module {param($mode) $script:mode=$mode} $case.name
      if($case.ContainsKey('path')){
        $path=Join-Path $fixture $case.path
        if(Test-Path -LiteralPath $path){$backup=$path+'.saved';Move-Item -LiteralPath $path -Destination $backup}
        if($case.ContainsKey('value')){Write-Text $path $case.value}
        if($case.name-eq'stale'){(Get-Item $path).LastWriteTimeUtc=$entryTime.AddMinutes(1)}
      }
      foreach($action in @('RestartCore','ReloadRuntime')){
        $errorText='';$timer=[Diagnostics.Stopwatch]::StartNew()
        try{Invoke-CodexBridgeLifecycleAction $context $action}catch{$errorText=$_.Exception.Message}
        Check ($errorText.StartsWith($case.code+':')) ($case.name+' / '+$action+' wrong result: '+$errorText)
        Check ($timer.Elapsed.TotalSeconds-lt 16) 'preflight must be bounded'
        foreach($file in Get-ChildItem $context.runtimeDir){Check ([IO.File]::ReadAllText($file.FullName)-ceq$before[$file.Name]) 'owner/PID evidence changed'}
        $counts=& $module { @($script:opens,$script:starts) }
        Check ($counts[0]-eq 0-and$counts[1]-eq 0) 'refusal touched process lifecycle'
        Check (-not(Test-Path -LiteralPath $context.dataDir)) 'preflight opened runtime data'
      }
    }finally{
      if($path-and(Test-Path -LiteralPath $path)){Remove-Item -LiteralPath $path -Force}
      if($backup){Move-Item -LiteralPath $backup -Destination $path}
      (Get-Item $entry).LastWriteTimeUtc=$entryTime
    }
  }
  [pscustomobject]@{ok=$true;assertions=$passed;cases=$cases.Count;productionLifecycle=$true;osProcessObservations='fixture';gracefulDelivery='BLOCKED';liveTouched=$false}|ConvertTo-Json
}finally{
  if($module){Remove-Module $module}
  $resolved=[IO.Path]::GetFullPath($fixtureRoot)
  if(-not$resolved.StartsWith([IO.Path]::GetFullPath($base)+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'UNSAFE_FIXTURE_CLEANUP'}
  if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
