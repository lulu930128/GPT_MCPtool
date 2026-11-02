param()
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $repoRoot 'project_reading/scripts/component-update-common.ps1')
$fixtureBase=Join-Path $repoRoot ('.local\p2-omi-fixtures\'+[guid]::NewGuid().ToString('N').Substring(0,8))
[void][IO.Directory]::CreateDirectory($fixtureBase)
$powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script:checks=0
function Assert-Equal($Actual,$Expected,[string]$Label) {
  if($Actual -cne $Expected){throw "ASSERT_FAILED: $Label expected=$Expected actual=$Actual"}
  $script:checks++
}
function New-Fixture([string]$Name,[string]$Mode='normal') {
  $base=Join-Path $fixtureBase $Name
  $root=Join-Path $base 'OMI_search'
  [void][IO.Directory]::CreateDirectory((Join-Path $root 'scripts'))
  [void][IO.Directory]::CreateDirectory((Join-Path $root 'control-center'))
  [void][IO.Directory]::CreateDirectory((Join-Path $root 'ui\tw-market-dashboard\scripts'))
  [void][IO.Directory]::CreateDirectory((Join-Path $root 'ui\tw-market-dashboard\dist'))
  [void][IO.Directory]::CreateDirectory((Join-Path $base 'project_reading\scripts'))
  [void][IO.Directory]::CreateDirectory((Join-Path $base 'codex_bridge\scripts'))
  Copy-Item -LiteralPath (Join-Path $repoRoot 'codex_bridge\scripts\DailyLifecycle.Native.cs') -Destination (Join-Path $base 'codex_bridge\scripts\DailyLifecycle.Native.cs')
  Copy-Item -LiteralPath (Join-Path $repoRoot 'OMI_search\scripts\update-from-source.ps1') -Destination (Join-Path $root 'scripts\update-from-source.ps1')
  $paths=@('http_server.py','server.py','launcher_transport.py','pyproject.toml','uv.lock','public_contract_snapshot.json','tw_market_dashboard_contract_snapshot.json','scripts/runtime-control.ps1','scripts/update-from-source.ps1','ui/tw-market-dashboard/scripts/build.mjs','control-center/update.json')
  foreach($path in $paths){if($path -notin @('scripts/update-from-source.ps1','control-center/update.json')){[IO.File]::WriteAllText((Join-Path $root $path),"fixture-$path",[Text.UTF8Encoding]::new($false))}}
  [IO.File]::WriteAllText((Join-Path $root 'ui\tw-market-dashboard\dist\index.html'),'old-widget',[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $root 'fixture-mode.txt'),$Mode,[Text.UTF8Encoding]::new($false))
  @{schemaVersion=1;componentId='omi_search';owner='component_controller';entrypoint='scripts/update-from-source.ps1';sourcePaths=$paths}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $root 'control-center\update.json') -Encoding UTF8
  $common=Get-Content -LiteralPath (Join-Path $repoRoot 'project_reading\scripts\component-update-common.ps1') -Raw -Encoding UTF8
  $seams=@'

# Isolated external-boundary fixtures only. Production helper has no test switch.
$script:fixtureRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\OMI_search'))
function Invoke-ComponentUpdateProcess {
  param([string]$Executable,[string]$Arguments,[string]$WorkingDirectory,[int]$TimeoutMs=120000,[switch]$Json,[switch]$Lifecycle,[string]$ChildJournalRoot)
  $mode=[IO.File]::ReadAllText((Join-Path $script:fixtureRoot 'fixture-mode.txt'))
  $eventPath=Join-Path $script:fixtureRoot 'calls.txt'
  if($Arguments -eq 'sync --frozen --check --offline'){
    [IO.File]::AppendAllText($eventPath,"check`n")
    if($mode -eq 'dependencies-fail'){throw 'UPDATE_CHILD_FAILED'}
    return @{exitCode=0}
  }
  if($Arguments -match '--output-dir "([^"]+)"'){
    $out=$matches[1];[void][IO.Directory]::CreateDirectory($out)
    [IO.File]::WriteAllText((Join-Path $out 'index.html'),'new-widget',[Text.UTF8Encoding]::new($false))
    [IO.File]::AppendAllText($eventPath,"build`n")
    return @{exitCode=0}
  }
  if($Arguments -match '-Action ReloadRuntime$'){
    if(-not $Lifecycle){throw 'LIFECYCLE_OWNERSHIP_REQUIRED'}
    [IO.File]::AppendAllText($eventPath,"reload`n")
    if($mode -in @('reload-timeout','old-loaded')){throw 'UPDATE_LIFECYCLE_RESULT_UNCERTAIN'}
    return @{ok=$true}
  }
  if($Arguments -match '-Action Status$'){
    [IO.File]::AppendAllText($eventPath,"status`n")
    return @{ok=$true;after=@{status='Ready';server=@{ownership='OwnedReady'};tunnel=@{ownership='OwnedReady'}}}
  }
  throw 'UNEXPECTED_PROCESS_CALL'
}
function Invoke-RestMethod {
  param([switch]$UseBasicParsing,[string]$Uri,[int]$TimeoutSec)
  if($Uri -cne 'http://127.0.0.1:18797/health'){throw 'UNEXPECTED_NETWORK_CALL'}
  $reload=Get-ChildItem -LiteralPath (Join-Path $script:fixtureRoot '.local\source-updates') -Filter reload-dispatched.json -Recurse | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if(-not $reload){
    $names=@('http_server.py','server.py','launcher_transport.py','pyproject.toml','uv.lock','public_contract_snapshot.json','tw_market_dashboard_contract_snapshot.json','ui/tw-market-dashboard/dist/index.html')
    $hashes=@(foreach($name in $names){(Get-FileHash -LiteralPath (Join-Path $script:fixtureRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant()})
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$oldBuild=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($hashes -join ''))))).Replace('-','').ToLowerInvariant().Substring(0,16)}finally{$sha.Dispose()}
    return @{ok=$true;service='omi-search-http-mcp';version='1.2.0';buildId=$oldBuild}
  }
  $pin=Read-ComponentUpdateJson (Join-Path $reload.DirectoryName 'candidate.json')
  $mode=[IO.File]::ReadAllText((Join-Path $script:fixtureRoot 'fixture-mode.txt'))
  $loadedBuild=if($mode -eq 'wrong-loaded-build'){'stale-build'}elseif($mode -eq 'old-loaded'){$pin.previousIdentity.buildId}else{$pin.expectedBuildId}
  return @{ok=$true;service='omi-search-http-mcp';version='1.2.0';buildId=$loadedBuild}
}
function Assert-ComponentUpdateChildrenStopped {
  param([string]$Root)
  if([IO.File]::ReadAllText((Join-Path $script:fixtureRoot 'fixture-mode.txt')) -eq 'children-active'){throw 'UPDATE_FINITE_CHILD_STILL_ACTIVE'}
  [IO.File]::AppendAllText((Join-Path $script:fixtureRoot 'calls.txt'),"children-checked`n")
}
$script:fixtureWriteJson=${function:Write-ComponentUpdateJson}
function Write-ComponentUpdateJson {
  param([string]$Path,$Value)
  $mode=[IO.File]::ReadAllText((Join-Path $script:fixtureRoot 'fixture-mode.txt'))
  $leaf=Split-Path -Leaf $Path
  if($mode -eq 'crash-after-publication' -and $leaf -eq 'reload-dispatched.json'){[Environment]::Exit(72)}
  & $script:fixtureWriteJson -Path $Path -Value $Value
  if($mode -eq 'crash-after-intent' -and $leaf -eq 'request.json'){[Environment]::Exit(73)}
  if($mode -eq 'response-lost' -and $leaf -eq 'result.json'){[Environment]::Exit(74)}
}
'@
  [IO.File]::WriteAllText((Join-Path $base 'project_reading\scripts\component-update-common.ps1'),$common+$seams,[Text.UTF8Encoding]::new($false))
  return $root
}
function Invoke-Fixture([string]$Root,[string]$Action,[string]$RequestId='',[string]$VersionId='',[string]$Digest='') {
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=$powershell
  $info.Arguments='-NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $Root 'scripts\update-from-source.ps1')+'" -Action '+$Action
  if($RequestId){$info.Arguments+=' -RequestId '+$RequestId+' -VersionId '+$VersionId+' -ExpectedSourceDigest '+$Digest}
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $p=New-Object Diagnostics.Process;$p.StartInfo=$info
  try{
    [void]$p.Start();$out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync()
    if(-not $p.WaitForExit(20000)){throw 'FIXTURE_TIMEOUT'}
    $result=if([string]::IsNullOrWhiteSpace($out.Result)){$null}else{$out.Result|ConvertFrom-Json}
    return @{exitCode=$p.ExitCode;result=$result}
  }finally{$p.Dispose()}
}

$root=New-Fixture 'normal'
$preview=Invoke-Fixture $root 'Preview'
Assert-Equal $preview.exitCode 0 'preview succeeds'
Assert-Equal $preview.result.code 'SOURCE_OBSERVED' 'preview code'
Assert-Equal (Test-Path -LiteralPath (Join-Path $root '.local')) $false 'preview makes no journal'
$id=[guid]::NewGuid().ToString('D');$digest=$preview.result.sourceDigest
$accepted=Invoke-Fixture $root 'Update' $id 'omi-fixture-1' $digest
Assert-Equal $accepted.exitCode 0 'update exit'
Assert-Equal $accepted.result.phase 'ACCEPTED' 'update acceptance'
Assert-Equal $accepted.result.preparedBuildId $accepted.result.observedBuildId 'prepared equals loaded'
Assert-Equal $accepted.result.observedVersion '1.2.0' 'app version independent from version label'
Assert-Equal ([IO.File]::ReadAllText((Join-Path $root 'ui\tw-market-dashboard\dist\index.html'))) 'new-widget' 'new output published'
Assert-Equal ([IO.File]::ReadAllText((Join-Path $root ('.local\source-updates\'+$id+'\rollback-index.html')))) 'old-widget' 'rollback bytes retained'
$calls=[IO.File]::ReadAllText((Join-Path $root 'calls.txt'))
$replay=Invoke-Fixture $root 'Update' $id 'omi-fixture-1' $digest
Assert-Equal $replay.result.phase 'ACCEPTED' 'successful replay returns original'
Assert-Equal ([IO.File]::ReadAllText((Join-Path $root 'calls.txt'))) $calls 'replay performs no child action'
$conflict=Invoke-Fixture $root 'Update' $id 'other-version' $digest
Assert-Equal $conflict.result.code 'REQUEST_CONFLICT' 'same id rejects conflicting version'
Assert-Equal ((Invoke-Fixture $root 'Recover' $id 'omi-fixture-1' $digest).result.phase) 'ACCEPTED' 'conflict preserves original success'
[IO.File]::AppendAllText((Join-Path $root 'http_server.py'),'changed')
$drift=Invoke-Fixture $root 'Update' ([guid]::NewGuid().ToString('D')) 'omi-fixture-2' $digest
Assert-Equal $drift.result.code 'SOURCE_CONTENT_CHANGED' 'preview drift rejected before build'
$newDigest=(Invoke-Fixture $root 'Preview').result.sourceDigest
$sameVersion=Invoke-Fixture $root 'Update' ([guid]::NewGuid().ToString('D')) 'omi-fixture-1' $newDigest
Assert-Equal $sameVersion.result.code 'VERSION_CONTENT_CHANGED_USE_NEW_ID' 'immutable version cannot be reused with new content'
Assert-Equal ([IO.File]::ReadAllText((Join-Path $root 'calls.txt'))) $calls 'drift and conflict run no child'

$root=New-Fixture 'dependencies' 'dependencies-fail';$id=[guid]::NewGuid().ToString('D');$digest=(Invoke-Fixture $root 'Preview').result.sourceDigest
$rejected=Invoke-Fixture $root 'Update' $id 'deps-1' $digest
Assert-Equal $rejected.result.phase 'REJECTED' 'dependency rejection terminal'
Assert-Equal $rejected.result.code 'DEPENDENCY_PREPARATION_REQUIRED' 'dependency preparation explicit'
Assert-Equal ([IO.File]::ReadAllText((Join-Path $root 'calls.txt'))) "check`n" 'dependency check never rebuilds or reloads'

$root=New-Fixture 'recovery' 'reload-timeout';$id=[guid]::NewGuid().ToString('D');$digest=(Invoke-Fixture $root 'Preview').result.sourceDigest
$uncertain=Invoke-Fixture $root 'Update' $id 'recovery-1' $digest
Assert-Equal $uncertain.result.phase 'RECOVERY_REQUIRED' 'reload timeout uncertain'
$retry=Invoke-Fixture $root 'Update' $id 'recovery-1' $digest
Assert-Equal $retry.result.phase 'RECOVERY_REQUIRED' 'repeat does not redispatch'
$newRequest=Invoke-Fixture $root 'Update' ([guid]::NewGuid().ToString('D')) 'recovery-2' $digest
Assert-Equal $newRequest.result.code 'UPDATE_RECOVERY_REQUIRED_USE_ORIGINAL_REQUEST' 'new id cannot bypass unresolved dispatch'
Assert-Equal $newRequest.result.blockedByOperationId $id.Replace('-','') 'blocked original operation remains traceable'
[IO.File]::WriteAllText((Join-Path $root 'fixture-mode.txt'),'wrong-loaded-build')
$stale=Invoke-Fixture $root 'Recover' $id 'recovery-1' $digest
Assert-Equal $stale.result.code 'LOADED_IDENTITY_NOT_ACCEPTED' 'wrong loaded build rejected'
Assert-Equal $stale.result.phase 'RECOVERY_REQUIRED' 'stale loaded evidence remains unresolved'
[IO.File]::WriteAllText((Join-Path $root 'fixture-mode.txt'),'normal')
[IO.File]::AppendAllText((Join-Path $root 'http_server.py'),'source edited after original reload')
$preparedSource=Join-Path $root ('.local\source-updates\'+$id+'\source\http_server.py')
$preparedBytes=[IO.File]::ReadAllBytes($preparedSource)
[IO.File]::AppendAllText($preparedSource,'altered retained snapshot')
$alteredCandidate=Invoke-Fixture $root 'Recover' $id 'recovery-1' $digest
Assert-Equal $alteredCandidate.result.code 'CANDIDATE_CONTENT_CHANGED' 'retained source identity is still enforced'
Assert-Equal $alteredCandidate.result.phase 'RECOVERY_REQUIRED' 'altered retained artifact cannot accept recovery'
[IO.File]::WriteAllBytes($preparedSource,$preparedBytes)
$recovered=Invoke-Fixture $root 'Recover' $id 'recovery-1' $digest
Assert-Equal $recovered.result.phase 'ACCEPTED' 'recovery verifies original loaded identity after editable source drift'
$calls=[IO.File]::ReadAllLines((Join-Path $root 'calls.txt'))
Assert-Equal @($calls|Where-Object{$_ -eq 'reload'}).Count 1 'exactly one reload after timeout and recovery'
Assert-Equal @($calls|Where-Object{$_ -eq 'build'}).Count 1 'exactly one build after timeout and recovery'
$nextPreview=Invoke-Fixture $root 'Preview'
Assert-Equal ($nextPreview.result.sourceDigest -cne $digest) $true 'next preview reports new editable source digest'
$nextUpdate=Invoke-Fixture $root 'Update' ([guid]::NewGuid().ToString('D')) 'recovery-2' $nextPreview.result.sourceDigest
Assert-Equal $nextUpdate.result.phase 'ACCEPTED' 'original terminal recovery permits subsequent changed-source update'

foreach($fault in @('crash-after-intent','crash-after-publication')){
  $root=New-Fixture $fault $fault;$id=[guid]::NewGuid().ToString('D');$digest=(Invoke-Fixture $root 'Preview').result.sourceDigest
  $crashed=Invoke-Fixture $root 'Update' $id 'fault-1' $digest
  Assert-Equal ($crashed.exitCode -in @(72,73)) $true 'fault terminates the original owner'
  if($fault -eq 'crash-after-publication'){
    Assert-Equal ([IO.File]::ReadAllText((Join-Path $root 'ui\tw-market-dashboard\dist\index.html'))) 'new-widget' 'fault occurs after publication'
    [IO.File]::WriteAllText((Join-Path $root 'fixture-mode.txt'),'normal')
    [IO.File]::WriteAllText((Join-Path $root 'ui\tw-market-dashboard\dist\index.html'),'unrelated-output')
    $foreign=Invoke-Fixture $root 'Recover' $id 'fault-1' $digest
    Assert-Equal $foreign.result.code 'RECOVERY_OUTPUT_IDENTITY_MISMATCH' 'recovery rejects unrelated output'
    Assert-Equal ([IO.File]::ReadAllText((Join-Path $root 'ui\tw-market-dashboard\dist\index.html'))) 'unrelated-output' 'foreign output retained byte for byte'
    [IO.File]::WriteAllText((Join-Path $root 'ui\tw-market-dashboard\dist\index.html'),'new-widget')
  }else{
    $requestPath=Join-Path $root ('.local\source-updates\'+$id+'\request.json')
    $original=[IO.File]::ReadAllText($requestPath)
    $request=$original|ConvertFrom-Json
    $request.updater=@{processId=$PID;startTimeUtcTicks=([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString());executable=$powershell}
    [IO.File]::WriteAllText($requestPath,($request|ConvertTo-Json -Depth 8))
    $liveOwner=Invoke-Fixture $root 'Recover' $id 'fault-1' $digest
    Assert-Equal $liveOwner.result.code 'ORIGINAL_UPDATE_OWNER_STILL_ACTIVE' 'live original creation identity blocks recovery'
    Assert-Equal $liveOwner.result.phase 'RECOVERY_REQUIRED' 'live owner refusal never ends original request'
    Assert-Equal (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $requestPath) 'result.json')) $false 'live owner refusal has no terminal result'
    [IO.File]::WriteAllText($requestPath,$original)
  }
  [IO.File]::WriteAllText((Join-Path $root 'fixture-mode.txt'),'children-active')
  $active=Invoke-Fixture $root 'Recover' $id 'fault-1' $digest
  Assert-Equal $active.result.phase 'RECOVERY_REQUIRED' 'unproven child stop cannot terminate request'
  Assert-Equal $active.result.code 'UPDATE_FINITE_CHILD_STILL_ACTIVE' 'active child refusal explicit'
  [IO.File]::WriteAllText((Join-Path $root 'fixture-mode.txt'),'normal')
  $notApplied=Invoke-Fixture $root 'Recover' $id 'fault-1' $digest
  Assert-Equal $notApplied.result.phase 'REJECTED' 'proven pre-reload recovery becomes terminal'
  Assert-Equal $notApplied.result.code 'UPDATE_NOT_APPLIED' 'request identifies not applied'
  Assert-Equal ([IO.File]::ReadAllText((Join-Path $root 'ui\tw-market-dashboard\dist\index.html'))) 'old-widget' 'original widget restored or retained'
  $callLines=[IO.File]::ReadAllLines((Join-Path $root 'calls.txt'))
  Assert-Equal @($callLines|Where-Object{$_ -eq 'reload'}).Count 0 'pre-reload recovery never dispatches reload'
  if($fault -eq 'crash-after-publication'){
    Assert-Equal ([IO.File]::ReadAllText((Join-Path $root ('.local\source-updates\'+$id+'\rollback-index.html')))) 'old-widget' 'original backup remains immutable'
    Assert-Equal ([IO.File]::ReadAllText((Join-Path $root ('.local\source-updates\'+$id+'\stage\index.html')))) 'new-widget' 'candidate survives recovery'
  }
  $next=Invoke-Fixture $root 'Update' ([guid]::NewGuid().ToString('D')) 'fault-2' $digest
  Assert-Equal $next.result.phase 'ACCEPTED' 'terminal recovery allows next immutable version'
}

$root=New-Fixture 'response-lost' 'response-lost';$id=[guid]::NewGuid().ToString('D');$digest=(Invoke-Fixture $root 'Preview').result.sourceDigest
$lost=Invoke-Fixture $root 'Update' $id 'lost-1' $digest
Assert-Equal $lost.exitCode 74 'response lost after terminal result publication'
$calls=[IO.File]::ReadAllText((Join-Path $root 'calls.txt'))
$observed=Invoke-Fixture $root 'Recover' $id 'lost-1' $digest
Assert-Equal $observed.result.phase 'ACCEPTED' 'lost response recovers original terminal receipt'
Assert-Equal ([IO.File]::ReadAllText((Join-Path $root 'calls.txt'))) $calls 'lost response recovery performs no work'

foreach($mode in @('old-restored','old-source-changed')){
  $root=New-Fixture $mode 'old-loaded';$id=[guid]::NewGuid().ToString('D');$digest=(Invoke-Fixture $root 'Preview').result.sourceDigest
  $unknown=Invoke-Fixture $root Update $id 'old-1' $digest
  Assert-Equal $unknown.result.phase 'RECOVERY_REQUIRED' 'old loaded fault remains uncertain before Recover'
  if($mode -eq 'old-source-changed'){[IO.File]::AppendAllText((Join-Path $root 'server.py'),'source changed')}
  $result=Invoke-Fixture $root Recover $id 'old-1' $digest
  if($mode -eq 'old-source-changed'){
    Assert-Equal $result.result.code 'OLD_LOADED_SOURCE_UNVERIFIED' 'old Python build alone cannot prove changed source rolled back'
    Assert-Equal $result.result.phase 'RECOVERY_REQUIRED' 'changed Python source keeps original operation unresolved'
  }else{
    Assert-Equal $result.result.phase 'REJECTED' 'verified old widget and source terminalize original operation'
    Assert-Equal $result.result.code 'UPDATE_ROLLED_BACK' 'rollback explicit'
    Assert-Equal $result.result.operationId $id.Replace('-','') 'original operation retained'
    Assert-Equal ([IO.File]::ReadAllText((Join-Path $root 'ui/tw-market-dashboard/dist/index.html'))) 'old-widget' 'old widget restored'
    Assert-Equal ((Invoke-Fixture $root Recover $id 'old-1' $digest).result.code) 'UPDATE_ROLLED_BACK' 'rollback terminal replay'
    [IO.File]::WriteAllText((Join-Path $root 'fixture-mode.txt'),'normal')
    Assert-Equal ((Invoke-Fixture $root Update ([guid]::NewGuid().ToString('D')) 'old-2' $digest).result.phase) 'ACCEPTED' 'next update admitted after rollback'
  }
  Assert-Equal @([IO.File]::ReadAllLines((Join-Path $root 'calls.txt'))|Where-Object{$_ -eq 'reload'}).Count $(if($mode -eq 'old-restored'){2}else{1}) 'Recover never resends original Reload'
}
$root=New-Fixture 'capacity';$id=[guid]::NewGuid().ToString('D');$digest=(Invoke-Fixture $root Preview).result.sourceDigest
$accepted=Invoke-Fixture $root Update $id 'capacity-1' $digest
Assert-Equal $accepted.result.phase 'ACCEPTED' 'capacity fixture initial acceptance'
$operationRoot=Join-Path $root ('.local/source-updates/'+$id)
for($i=0;$i -lt 260;$i++){
  $historyId=[guid]::NewGuid().ToString('D');$historyRoot=Join-Path $root ('.local/source-updates/'+$historyId)
  $request=Read-ComponentUpdateJson (Join-Path $operationRoot 'request.json');$request.requestId=$historyId
  $result=Read-ComponentUpdateJson (Join-Path $operationRoot 'result.json');$result.operationId=$historyId.Replace('-','')
  Write-ComponentUpdateJson (Join-Path $historyRoot 'request.json') $request
  Write-ComponentUpdateJson (Join-Path $historyRoot 'result.json') $result
}
$calls=[IO.File]::ReadAllText((Join-Path $root 'calls.txt'))
Assert-Equal ((Invoke-Fixture $root Update $historyId 'capacity-1' $digest).result.phase) 'ACCEPTED' '260+ terminal request index supports replay'
Assert-Equal ([IO.File]::ReadAllText((Join-Path $root 'calls.txt'))) $calls 'historical ID does not dispatch again'
Assert-Equal ((Invoke-Fixture $root Update ([guid]::NewGuid().ToString('D')) 'capacity-2' $digest).result.phase) 'ACCEPTED' 'terminal history never consumes active capacity'
Assert-Equal (Test-Path -LiteralPath (Join-Path $operationRoot 'rollback-index.html')) $true 'original rollback pin retained'

[pscustomobject]@{status='PASS';checks=$script:checks;evidence='ISOLATED_FIXTURE';fixtureRoot=$fixtureBase;liveMutation=$false}|ConvertTo-Json -Compress
