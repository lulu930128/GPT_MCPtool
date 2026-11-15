param(
    [ValidateSet('Preview','Update','Recover')][string]$Action='Preview',
    [string]$RequestId,[string]$VersionId,[string]$ExpectedSourceDigest
)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$scriptsRoot=$PSScriptRoot
. (Join-Path $root '..\project_reading\scripts\node-source-update.ps1')
$descriptor=Read-ComponentUpdateJson (Join-Path $root 'control-center\update.json')
$python=Join-Path $root '.venv\Scripts\python.exe'
$powershell=Join-Path $PSHOME 'powershell.exe'
$frontend=Join-Path $root 'frontend'
$build={
    param($stageDist,$childJournalRoot)
    $uv=Get-Command uv.exe -CommandType Application -ErrorAction SilentlyContinue
    $node=Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if(-not $uv -or -not $node -or -not(Test-Path -LiteralPath $python -PathType Leaf)){throw 'DEPENDENCY_PREPARATION_REQUIRED'}
    foreach($binary in @('node_modules/typescript/bin/tsc','node_modules/vite/bin/vite.js')){if(-not(Test-Path -LiteralPath (Join-Path $frontend $binary) -PathType Leaf)){throw 'DEPENDENCY_PREPARATION_REQUIRED'}}
    try{
        Invoke-ComponentUpdateProcess -Executable $uv.Source -Arguments 'sync --locked --check --offline' -WorkingDirectory $root -ChildJournalRoot $childJournalRoot | Out-Null
        Invoke-ComponentUpdateProcess -Executable $python -Arguments ('"'+(Join-Path $scriptsRoot 'check-locked-frontend.py')+'"') -WorkingDirectory $root -ChildJournalRoot $childJournalRoot | Out-Null
    }
    catch{throw 'DEPENDENCY_PREPARATION_REQUIRED'}
    Invoke-ComponentUpdateProcess -Executable $python -Arguments '-m compileall -q src' -WorkingDirectory $root -ChildJournalRoot $childJournalRoot | Out-Null
    Invoke-ComponentUpdateProcess -Executable $node.Source -Arguments ('"'+(Join-Path $frontend 'node_modules\typescript\bin\tsc')+'" -b') -WorkingDirectory $frontend -ChildJournalRoot $childJournalRoot | Out-Null
    Invoke-ComponentUpdateProcess -Executable $node.Source -Arguments ('"'+(Join-Path $frontend 'node_modules\vite\bin\vite.js')+'" build --outDir "'+$stageDist+'" --emptyOutDir') -WorkingDirectory $frontend -ChildJournalRoot $childJournalRoot | Out-Null
    if(-not(Test-Path -LiteralPath (Join-Path $stageDist 'index.html') -PathType Leaf)){throw 'UPDATE_FRONTEND_BUILD_MISSING'}
}
$identity={
    param($stageArtifact)
    $stageArgs=if($stageArtifact){' --frontend-dist "'+$stageArtifact+'"'}else{''}
    Invoke-ComponentUpdateProcess -Executable $python -Arguments ('"'+(Join-Path $scriptsRoot 'source-update-identity.py')+'"'+$stageArgs) -WorkingDirectory $root -Json
}
$status={Invoke-ComponentUpdateProcess -Executable $powershell -Arguments ('-NoProfile -NonInteractive -File "'+(Join-Path $scriptsRoot 'runtime-control.ps1')+'" -Action Status') -WorkingDirectory $root -Json}
$schemaPreflight={
    Import-Module (Join-Path $scriptsRoot 'component-runtime.psm1') -Force
    $context=New-PersonalAssetOsRuntimeContext -ProjectRoot $root
    Invoke-ComponentUpdateProcess -Executable $python -Arguments ('"'+(Join-Path $scriptsRoot 'source-update-identity.py')+'" --schema-data-dir "'+$context.dataDir+'"') -WorkingDirectory $root -Json
}
$preflight={
    $reply=& $status
    $allowed=$reply.ok -and $reply.after.status -in @('Ready','Degraded','Unhealthy','Stopped')
    foreach($role in @('server','tunnel')){if($reply.after.$role.ownership -notin @('OwnedReady','Stopped')){$allowed=$false}}
    if(-not $allowed){return [pscustomobject]@{allowed=$false;code='UPDATE_OWNER_PREFLIGHT_REJECTED'}}
    # Both running and stopped paths consult only the migration owner's
    # read-only schema metadata. Startup remains the sole migration executor.
    try { & $schemaPreflight } catch { [pscustomobject]@{allowed=$false;code='UPDATE_SCHEMA_STATE_UNVERIFIED'} }
}
$reload={
    $reply=Invoke-ComponentUpdateProcess -Executable $powershell -Arguments ('-NoProfile -NonInteractive -File "'+(Join-Path $scriptsRoot 'runtime-control.ps1')+'" -Action ReloadRuntime') -WorkingDirectory $root -TimeoutMs 240000 -Json -Lifecycle
    if(-not $reply.ok -or $reply.after.status -ne 'Ready'){throw 'UPDATE_OWNER_NOT_READY'}
}
$observe={
    $reply=& $status
    $health=Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:18876/api/health' -TimeoutSec 5
    $ready=Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:18876/api/readyz' -TimeoutSec 5
    if(-not $health.PSObject.Properties['buildIdentity'] -or -not $ready.PSObject.Properties['buildIdentity'] -or
        $health.buildIdentity -cne 'startup-v1' -or $ready.buildIdentity -cne 'startup-v1'){throw 'UPDATE_LOADED_IDENTITY_UNVERIFIED'}
    [pscustomobject]@{version=$health.version;buildId=$health.buildId;
        ready=($reply.ok -and $reply.after.status -eq 'Ready' -and $reply.after.server.ownership -eq 'OwnedReady' -and $reply.after.tunnel.ownership -eq 'OwnedReady' -and
            $health.ok -and $health.service -eq 'personal-asset-os' -and $health.database -eq 'ready' -and $ready.ready -and $ready.frontendReady -and $ready.buildId -ceq $health.buildId)}
}
$result=Invoke-NodeSourceUpdate -ComponentRoot $root -ComponentId 'personal_asset_os' -SourcePaths $descriptor.sourcePaths -Action $Action -RequestId $RequestId -VersionId $VersionId -ExpectedSourceDigest $ExpectedSourceDigest -ArtifactRelative 'frontend/dist' -Build $build -Identity $identity -Preflight $preflight -Reload $reload -Observe $observe
$result|ConvertTo-Json -Depth 12
if($result.phase -in @('PREVIEW','ACCEPTED')){exit 0};exit 1
