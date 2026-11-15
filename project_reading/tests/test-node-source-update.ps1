Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\scripts\node-source-update.ps1')
$script:assertions=0
function Assert-Update($Condition,[string]$Message) {
    if(-not $Condition){throw ('ASSERT: '+$Message)}
    $script:assertions++
}
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('mcp-node-update-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
function New-Fixture([string]$Name) {
    $root=Join-Path $testRoot $Name
    [void][IO.Directory]::CreateDirectory((Join-Path $root 'src'))
    [IO.File]::WriteAllText((Join-Path $root 'src\main.ts'),'source v1')
    Write-ComponentUpdateJson -Path (Join-Path $root 'dist\identity.json') -Value @{version='1.0';buildId='1111111111111111'}
    return $root
}
$script:builds=0; $script:reloads=0; $script:loaded=$null; $script:failReload=$false; $script:drift=$false
$build={param($stageDist)
    $script:builds++
    Write-ComponentUpdateJson -Path (Join-Path $stageDist 'identity.json') -Value @{version='1.1';buildId='2222222222222222'}
    if($script:drift){[IO.File]::WriteAllText((Join-Path $fixtureRoot 'src\main.ts'),'drift while building')}
}
$identity={param($distRoot) Read-ComponentUpdateJson (Join-Path $distRoot 'identity.json')}
$reload={
    $script:reloads++
    if($script:failReload){throw 'UPDATE_CHILD_TIMEOUT_CHECK_ORIGINAL_OPERATION'}
    $script:loaded=[pscustomobject]@{ready=$true;version='1.1';buildId='2222222222222222'}
}
$observe={return $script:loaded}
function Invoke-Fixture([string]$Action,[string]$Id,[string]$Version,[string]$Digest) {
    Invoke-NodeSourceUpdate -ComponentRoot $fixtureRoot -ComponentId 'fixture' -SourcePaths @('src') -Action $Action -RequestId $Id -VersionId $Version -ExpectedSourceDigest $Digest -Build $build -Identity $identity -Reload $reload -Observe $observe -Preflight { [pscustomobject]@{allowed=$true} }
}
try {
    $fixtureRoot=New-Fixture 'normal'
    $preview=Invoke-Fixture Preview '' '' ''
    Assert-Update ($preview.code -eq 'SOURCE_OBSERVED' -and $script:builds -eq 0 -and $script:reloads -eq 0) 'preview is source-only'
    $requestId=[guid]::NewGuid().ToString('D')
    $accepted=Invoke-Fixture Update $requestId 'v1' $preview.sourceDigest
    Assert-Update ($accepted.phase -eq 'ACCEPTED' -and $accepted.ready) ('normal update accepted: '+$accepted.code)
    Assert-Update ($accepted.preparedBuildId -eq $accepted.observedBuildId -and $accepted.observedBuildId -eq '2222222222222222') 'prepared and loaded identity agree'
    Assert-Update ((Read-ComponentUpdateJson (Join-Path $accepted.rollback.artifactRoot 'identity.json')).buildId -eq '1111111111111111') 'rollback preserves previous dist'
    Assert-Update ((Read-ComponentUpdateJson (Join-Path $fixtureRoot ('.local\source-updates\'+$requestId+'\stage\dist\identity.json'))).buildId -eq '2222222222222222') 'immutable staged artifact remains'
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'src\main.ts'),'later source')
    $duplicate=Invoke-Fixture Update $requestId 'v1' $preview.sourceDigest
    Assert-Update ($duplicate.phase -eq 'ACCEPTED' -and $script:builds -eq 1 -and $script:reloads -eq 1) 'same request returns original acceptance despite later source edits'
    $conflict=Invoke-Fixture Update $requestId 'different' $preview.sourceDigest
    Assert-Update ($conflict.code -eq 'UPDATE_REQUEST_CONFLICT' -and $script:reloads -eq 1) 'same id parameter conflict rejected'
    $stale=Invoke-Fixture Update ([guid]::NewGuid().ToString('D')) 'v2' $preview.sourceDigest
    Assert-Update ($stale.code -eq 'UPDATE_SOURCE_CHANGED_USE_NEW_VERSION' -and $script:builds -eq 1) 'stale preview stops before build'

    $fixtureRoot=New-Fixture 'uncertain'
    $script:failReload=$true; $script:loaded=$null
    $preview=Invoke-Fixture Preview '' '' ''; $requestId=[guid]::NewGuid().ToString('D')
    $uncertain=Invoke-Fixture Update $requestId 'v1' $preview.sourceDigest
    Assert-Update ($uncertain.phase -eq 'RECOVERY_REQUIRED' -and $uncertain.code -eq 'UPDATE_CHILD_TIMEOUT_CHECK_ORIGINAL_OPERATION') 'uncertain owner result preserves operation'
    $beforeReloads=$script:reloads
    $unverified=Invoke-Fixture Recover $requestId 'v1' $preview.sourceDigest
    Assert-Update ($unverified.code -eq 'UPDATE_LOADED_IDENTITY_UNVERIFIED' -and $script:reloads -eq $beforeReloads) 'recovery does not repeat unknown reload'
    $blocked=Invoke-Fixture Update ([guid]::NewGuid().ToString('D')) 'v2' $preview.sourceDigest
    Assert-Update ($blocked.code -eq 'UPDATE_PRIOR_OPERATION_RECOVERY_REQUIRED') 'another id cannot bypass unfinished operation'
    $script:loaded=[pscustomobject]@{ready=$true;version='1.1';buildId='2222222222222222'}
    $recovered=Invoke-Fixture Recover $requestId 'v1' $preview.sourceDigest
    Assert-Update ($recovered.phase -eq 'ACCEPTED' -and $recovered.code -eq 'UPDATE_RECOVERED' -and $script:reloads -eq $beforeReloads) 'recovery accepts only original prepared and loaded identity'

    foreach($mode in @('old-loaded','old-artifact-restored','third-version','wrong-old-artifact','prepare-only-old','paos-old')) {
        $fixtureRoot=New-Fixture $mode
        $script:loaded=[pscustomobject]@{ready=$true;version='1.0';buildId='1111111111111111'}
        $script:failReload=$true
        $preview=Invoke-Fixture Preview '' '' ''; $requestId=[guid]::NewGuid().ToString('D')
        if($mode -eq 'wrong-old-artifact'){[IO.File]::WriteAllText((Join-Path $fixtureRoot 'dist/identity.json'),'{"version":"1.0","buildId":"3333333333333333"}')}
        if($mode -in @('prepare-only-old','paos-old')){
            $args=@{ComponentRoot=$fixtureRoot;ComponentId='fixture';SourcePaths=@('src');RequestId=$requestId;VersionId='v1';ExpectedSourceDigest=$preview.sourceDigest;PrepareOnly=$true;Build={};Identity={param($unused) [pscustomobject]@{version='1.1';buildId='2222222222222222'}};Reload=$reload;Observe=$observe;Preflight={[pscustomobject]@{allowed=$true}}}
            if($mode -eq 'paos-old'){$args.ComponentId='personal_asset_os';$args.PrepareOnly=$false;$args.Build=$build;$args.Identity=$identity}
            $unknown=Invoke-NodeSourceUpdate @args -Action Update
            $recovery=Invoke-NodeSourceUpdate @args -Action Recover
            Assert-Update ($unknown.phase -eq 'RECOVERY_REQUIRED' -and $recovery.code -eq 'UPDATE_OLD_LOADED_SOURCE_UNVERIFIED') 'PrepareOnly old loaded identity cannot prove source rollback'
            continue
        }
        $unknown=Invoke-Fixture Update $requestId 'v1' $preview.sourceDigest
        $reloadsBefore=$script:reloads
        if($mode -eq 'third-version'){$script:loaded=[pscustomobject]@{ready=$true;version='other';buildId='3333333333333333'}}
        if($mode -eq 'old-artifact-restored'){
            $op=Join-Path $fixtureRoot ('.local/source-updates/'+$requestId)
            Restore-NodeUpdateUnappliedArtifact (Join-Path $fixtureRoot 'dist') $op (Read-ComponentUpdateJson (Join-Path $op 'prepared.json'))
        }
        $recovery=Invoke-Fixture Recover $requestId 'v1' $preview.sourceDigest
        Assert-Update ($script:reloads -eq $reloadsBefore) ($mode+' recovery never repeats Reload')
        if($mode -eq 'wrong-old-artifact'){
            Assert-Update ($recovery.phase -eq 'RECOVERY_REQUIRED' -and $recovery.code -eq 'UPDATE_OLD_ARTIFACT_IDENTITY_UNVERIFIED') 'old loaded build cannot certify a different rollback artifact'
        }elseif($mode -eq 'third-version'){
            Assert-Update ($recovery.phase -eq 'RECOVERY_REQUIRED' -and $recovery.code -eq 'UPDATE_LOADED_IDENTITY_UNVERIFIED') 'unexpected third build stays unknown'
        }else{
            Assert-Update ($recovery.phase -eq 'REJECTED' -and $recovery.code -eq 'UPDATE_ROLLED_BACK' -and $recovery.requestId -eq $requestId) ($mode+' original ID terminal')
            Assert-Update ((Read-ComponentUpdateJson (Join-Path $fixtureRoot 'dist/identity.json')).buildId -eq '1111111111111111') 'confirmed old loaded build and artifact restored'
            Assert-Update ((Invoke-Fixture Recover $requestId 'v1' $preview.sourceDigest).code -eq 'UPDATE_ROLLED_BACK') 'rollback replay is terminal'
            $script:failReload=$false
            Assert-Update ((Invoke-Fixture Update ([guid]::NewGuid().ToString('D')) 'v2' $preview.sourceDigest).phase -eq 'ACCEPTED') 'rollback permits subsequent new version'
        }
    }

    $beforeReloads=$script:reloads
    $fixtureRoot=New-Fixture 'drift'; $script:failReload=$false; $script:drift=$true
    $preview=Invoke-Fixture Preview '' '' ''; $requestId=[guid]::NewGuid().ToString('D')
    $drift=Invoke-Fixture Update $requestId 'v1' $preview.sourceDigest
    Assert-Update ($drift.code -eq 'UPDATE_SOURCE_CHANGED_DURING_BUILD' -and $script:reloads -eq $beforeReloads) 'source drift cannot reach reload'
    Assert-Update ((Read-ComponentUpdateJson (Join-Path $fixtureRoot 'dist\identity.json')).buildId -eq '1111111111111111') 'failed build preserves old dist'
    $buildCount=$script:builds
    Assert-Update ((Invoke-Fixture Update $requestId 'v1' $preview.sourceDigest).code -eq $drift.code -and $script:builds -eq $buildCount) 'rejected build retry returns original failure'

    $fixtureRoot=New-Fixture 'preflight'; $script:drift=$false
    $preview=Invoke-Fixture Preview '' '' ''
    $denied=Invoke-NodeSourceUpdate -ComponentRoot $fixtureRoot -ComponentId fixture -SourcePaths @('src') -Action Update -RequestId ([guid]::NewGuid().ToString('D')) -VersionId v1 -ExpectedSourceDigest $preview.sourceDigest -Build $build -Identity $identity -Reload $reload -Observe $observe -Preflight { [pscustomobject]@{allowed=$false;code='OWNER_REJECTED'} }
    Assert-Update ($denied.code -eq 'OWNER_REJECTED' -and $script:reloads -eq $beforeReloads) 'owner rejection stops before promotion or reload'
    Assert-Update ((Read-ComponentUpdateJson (Join-Path $fixtureRoot 'dist\identity.json')).buildId -eq '1111111111111111') 'owner rejection preserves original dist'
    $fixtureRoot=New-Fixture 'nested'; $preview=Invoke-Fixture Preview '' '' ''
    $nested=Invoke-NodeSourceUpdate -ComponentRoot $fixtureRoot -ComponentId fixture -SourcePaths @('src') -Action Update -RequestId ([guid]::NewGuid().ToString('D')) -VersionId v1 -ExpectedSourceDigest $preview.sourceDigest -ArtifactRelative 'frontend/dist' -Build $build -Identity $identity -Reload $reload -Observe $observe -Preflight { [pscustomobject]@{allowed=$true} }
    Assert-Update ($nested.phase -eq 'ACCEPTED' -and (Test-Path -LiteralPath (Join-Path $fixtureRoot 'frontend\dist\identity.json'))) 'nested frontend artifact adoption works'
    Assert-Update ((Read-ComponentUpdateJson (Join-Path $fixtureRoot 'dist\identity.json')).buildId -eq '1111111111111111') 'nested artifact leaves unrelated root dist intact'
    $fixtureRoot=New-Fixture 'prepare-only'; $preview=Invoke-Fixture Preview '' '' ''
    $preparedOnly=Invoke-NodeSourceUpdate -ComponentRoot $fixtureRoot -ComponentId fixture -SourcePaths @('src') -Action Update -RequestId ([guid]::NewGuid().ToString('D')) -VersionId v1 -ExpectedSourceDigest $preview.sourceDigest -PrepareOnly -ArtifactRelative 'unused-artifact' -Build {} -Identity {param($unused) [pscustomobject]@{version='1.1';buildId='2222222222222222'}} -Reload $reload -Observe $observe -Preflight { [pscustomobject]@{allowed=$true} }
    Assert-Update ($preparedOnly.phase -eq 'ACCEPTED' -and -not (Test-Path -LiteralPath (Join-Path $fixtureRoot 'unused-artifact'))) 'prepare-only reload creates no compiled artifact root'
    $rejectedPath=Invoke-NodeSourceUpdate -ComponentRoot $fixtureRoot -ComponentId fixture -SourcePaths @('src') -Action Preview -ArtifactRelative '../outside' -Build $build -Identity $identity -Reload $reload -Observe $observe
    Assert-Update ($rejectedPath.code -eq 'UPDATE_ARTIFACT_PATH_REJECTED') 'artifact traversal is rejected'

    $child=Join-Path $testRoot 'nonjson.ps1'; [IO.File]::WriteAllText($child,"Write-Output 'not JSON'; exit 9")
    $failed=$false
    try { Invoke-ComponentUpdateProcess -Executable (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Arguments ('-NoProfile -NonInteractive -File "'+$child+'"') -WorkingDirectory $testRoot -Json | Out-Null }
    catch { $failed=($_.Exception.Message -eq 'UPDATE_CHILD_FAILED' -and $_.Exception.Data['exitCode'] -eq 9) }
    Assert-Update $failed 'non-JSON child retains its failed exit instead of parser error'

    $engine=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\scripts\node-source-update.ps1'))
    $crashWorker=Join-Path $PSScriptRoot 'fixtures\node-source-update-crash.ps1'
    $fixtureRoot=New-Fixture 'active-updater'; $preview=Invoke-Fixture Preview '' '' ''; $activeRequest=[guid]::NewGuid().ToString('D')
    $unfinished=Invoke-NodeSourceUpdate -ComponentRoot $fixtureRoot -ComponentId fixture -SourcePaths @('src') -Action Update -RequestId $activeRequest -VersionId v1 -ExpectedSourceDigest $preview.sourceDigest -Build {throw 'UPDATE_CHILD_TIMEOUT_CHECK_ORIGINAL_OPERATION'} -Identity $identity -Reload $reload -Observe $observe
    $activeRecovery=Invoke-Fixture Recover $activeRequest 'v1' $preview.sourceDigest
    Assert-Update ($unfinished.phase -eq 'RECOVERY_REQUIRED' -and $activeRecovery.code -eq 'UPDATE_ORIGINAL_UPDATER_ACTIVE') 'recovery cannot retire a still-live original updater instance'
    Assert-Update (-not(Test-Path -LiteralPath (Join-Path $fixtureRoot ('.local\source-updates\'+$activeRequest+'\terminal.json')))) 'live updater denial preserves pending operation'
    foreach ($point in @('after-intent','between-renames','before-reload-marker','finite-timeout','finite-parent-exit','reload-response-lost','tampered-backup')) {
        $fixtureRoot=New-Fixture $point
        $preview=Invoke-Fixture Preview '' '' ''; $requestId=[guid]::NewGuid().ToString('D')
        $operationRoot=Join-Path $fixtureRoot ('.local\source-updates\'+$requestId)
        $childInfo=New-Object Diagnostics.ProcessStartInfo
        $childInfo.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $workerPoint=if($point -eq 'tampered-backup'){'between-renames'}else{$point}
        $childInfo.Arguments='-NoProfile -NonInteractive -File "'+$crashWorker+'" -Engine "'+$engine+'" -Root "'+$fixtureRoot+'" -RequestId '+$requestId+' -Digest '+$preview.sourceDigest+' -Point '+$workerPoint
        $childInfo.UseShellExecute=$false; $childInfo.CreateNoWindow=$true; $childInfo.RedirectStandardOutput=$true; $childInfo.RedirectStandardError=$true
        $childProcess=New-Object Diagnostics.Process; $childProcess.StartInfo=$childInfo
        try {
            [void]$childProcess.Start(); $out=$childProcess.StandardOutput.ReadToEndAsync(); $err=$childProcess.StandardError.ReadToEndAsync()
            if(-not $childProcess.WaitForExit(20000)){throw 'FIXTURE_CHILD_DID_NOT_EXIT'}
            $childOutput=$out.GetAwaiter().GetResult(); $childError=$err.GetAwaiter().GetResult()
            $expectedExit=switch($workerPoint){'after-intent'{91};'between-renames'{92};'before-reload-marker'{93};'finite-parent-exit'{94};default{1}}
            Assert-Update ($childProcess.ExitCode -eq $expectedExit) ($point+' reached the intended fault; '+$childOutput+' '+$childError)
        } finally { $childProcess.Dispose() }
        if ($point -eq 'finite-parent-exit' -or $point -eq 'finite-timeout') {
            $starts=@(Get-ChildItem -LiteralPath (Join-Path $operationRoot 'children') -Filter '*.start.json')
            Assert-Update ($starts.Count -eq 1) ($point+' records the exact child scope before resume')
        }
        if ($point -eq 'finite-parent-exit') {
            Assert-Update (-not (Test-Path -LiteralPath ($starts[0].FullName.Replace('.start.json','.stopped.json')))) 'parent crash leaves no fabricated child completion record'
        }
        if ($point -eq 'between-renames') {
            Assert-Update (-not (Test-Path -LiteralPath (Join-Path $fixtureRoot 'dist')) -and (Test-Path -LiteralPath (Join-Path $operationRoot 'rollback-dist'))) 'crash occurs after old artifact moved and before new artifact promotion'
        }
        $reloadCountBefore=$script:reloads
        $buildCountBefore=$script:builds
        if ($point -eq 'reload-response-lost') {
            $script:loaded=Read-ComponentUpdateJson (Join-Path $fixtureRoot 'loaded.json')
            [IO.File]::WriteAllText((Join-Path $fixtureRoot 'src\main.ts'),'next source edit after previous candidate loaded')
        }
        if ($point -eq 'tampered-backup') { [IO.File]::WriteAllText((Join-Path $operationRoot 'rollback-dist\untracked.js'),'changed outside build identity') }
        $recovery=Invoke-Fixture Recover $requestId 'v1' $preview.sourceDigest
        if ($point -eq 'tampered-backup') {
            Assert-Update ($recovery.phase -eq 'RECOVERY_REQUIRED' -and $recovery.code -eq 'UPDATE_ROLLBACK_ARTIFACT_CHANGED') 'recovery rejects rollback tree drift outside public buildId'
            Assert-Update (-not (Test-Path -LiteralPath (Join-Path $fixtureRoot 'dist'))) 'changed backup is not published'
        } elseif ($point -eq 'reload-response-lost') {
            Assert-Update ($recovery.phase -eq 'ACCEPTED' -and $recovery.code -eq 'UPDATE_RECOVERED' -and $script:reloads -eq $reloadCountBefore -and $script:builds -eq $buildCountBefore) 'lost reload response recovers original loaded candidate after source changes without rebuilding or repeating Reload'
            $nextPreview=Invoke-Fixture Preview '' '' ''
            $next=Invoke-Fixture Update ([guid]::NewGuid().ToString('D')) 'v2' $nextPreview.sourceDigest
            Assert-Update ($next.phase -eq 'ACCEPTED' -and $nextPreview.sourceDigest -ne $preview.sourceDigest) 'recovered original receipt permits a fresh preview and version for later source edits'
        } else {
            Assert-Update ($recovery.phase -eq 'REJECTED' -and $recovery.code -eq 'UPDATE_NOT_APPLIED' -and $script:reloads -eq $reloadCountBefore) ($point+' terminalizes the original request without dispatch: '+$recovery.code)
            Assert-Update ((Read-ComponentUpdateJson (Join-Path $fixtureRoot 'dist\identity.json')).buildId -eq '1111111111111111') ($point+' preserves or restores the original artifact')
            Assert-Update (-not (Test-Path -LiteralPath (Join-Path $fixtureRoot 'reload-called.json'))) ($point+' never invokes owner Reload')
            if ($point -eq 'between-renames' -or $point -eq 'before-reload-marker') {
                Assert-Update ((Read-ComponentUpdateJson (Join-Path $operationRoot 'rollback-dist\identity.json')).buildId -eq '1111111111111111') ($point+' keeps immutable rollback backup after restore')
                Assert-Update ((Read-ComponentUpdateJson (Join-Path $operationRoot 'stage\dist\identity.json')).buildId -eq '2222222222222222') ($point+' keeps the unadopted candidate')
            }
            $script:failReload=$false
            $next=Invoke-Fixture Update ([guid]::NewGuid().ToString('D')) 'v2' $preview.sourceDigest
            Assert-Update ($next.phase -eq 'ACCEPTED') ($point+' permits a fresh version after original terminal rejection: '+$next.code)
        }
    }
    [pscustomobject]@{ok=$true;assertions=$script:assertions;fixture='node-source-update';liveMutation=$false}|ConvertTo-Json
} finally {
    $resolved=[IO.Path]::GetFullPath($testRoot)
    if(-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -notlike 'mcp-node-update-*'){throw 'FIXTURE_CLEANUP_PATH_REJECTED'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
