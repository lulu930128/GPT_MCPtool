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
$build={
    param($unusedArtifact,$childJournalRoot)
    $uv=Get-Command uv.exe -CommandType Application -ErrorAction SilentlyContinue
    if(-not $uv -or -not(Test-Path -LiteralPath $python -PathType Leaf)){throw 'DEPENDENCY_PREPARATION_REQUIRED'}
    try {Invoke-ComponentUpdateProcess -Executable $uv.Source -Arguments 'sync --locked --check --offline' -WorkingDirectory $root -ChildJournalRoot $childJournalRoot | Out-Null}
    catch {throw 'DEPENDENCY_PREPARATION_REQUIRED'}
    # Syntax validation does not import the API or run a migration. The existing
    # interpreter loads source after the component's exact owned reload.
    Invoke-ComponentUpdateProcess -Executable $python -Arguments '-m compileall -q src' -WorkingDirectory $root -ChildJournalRoot $childJournalRoot | Out-Null
}
$identity={
    param($unusedArtifact)
    Invoke-ComponentUpdateProcess -Executable $python -Arguments ('"'+(Join-Path $scriptsRoot 'source-update-identity.py')+'"') -WorkingDirectory $root -Json
}
$status={Invoke-ComponentUpdateProcess -Executable $powershell -Arguments ('-NoProfile -NonInteractive -File "'+(Join-Path $scriptsRoot 'runtime-control.ps1')+'" -Action Status') -WorkingDirectory $root -Json}
$preflight={
    $reply=& $status
    $allowed=$reply.ok -and $reply.after.status -in @('Ready','Degraded','Stopped')
    foreach($role in @('backend','mcp','tunnel')){if($reply.after.$role.ownership -notin @('OwnedReady','Stopped')){$allowed=$false}}
    [pscustomobject]@{allowed=$allowed;code='UPDATE_OWNER_PREFLIGHT_REJECTED'}
}
$reload={
    $reply=Invoke-ComponentUpdateProcess -Executable $powershell -Arguments ('-NoProfile -NonInteractive -File "'+(Join-Path $scriptsRoot 'runtime-control.ps1')+'" -Action ReloadRuntime') -WorkingDirectory $root -TimeoutMs 240000 -Json -Lifecycle
    if(-not $reply.ok -or $reply.after.status -ne 'Ready'){throw 'UPDATE_OWNER_NOT_READY'}
}
$observe={
    $reply=& $status
    $backend=Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:18765/health' -TimeoutSec 5
    $mcp=Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:18818/health' -TimeoutSec 5
    if(-not $backend.PSObject.Properties['build_id'] -or -not $mcp.PSObject.Properties['build_id']){throw 'UPDATE_LOADED_IDENTITY_UNVERIFIED'}
    $owned=$true;foreach($role in @('backend','mcp','tunnel')){if($reply.after.$role.ownership -ne 'OwnedReady'){$owned=$false}}
    [pscustomobject]@{version=$backend.version;buildId=$backend.build_id;
        ready=($reply.ok -and $owned -and $reply.after.status -eq 'Ready' -and $backend.status -eq 'ok' -and $backend.database -eq 'ok' -and
            $mcp.status -eq 'ok' -and $mcp.service -eq 'memory-core-mcp' -and $mcp.build_id -ceq $backend.build_id -and $mcp.version -ceq $backend.version)}
}
$result=Invoke-NodeSourceUpdate -ComponentRoot $root -ComponentId 'memory_core' -SourcePaths $descriptor.sourcePaths -Action $Action -RequestId $RequestId -VersionId $VersionId -ExpectedSourceDigest $ExpectedSourceDigest -PrepareOnly -Build $build -Identity $identity -Preflight $preflight -Reload $reload -Observe $observe
$result|ConvertTo-Json -Depth 12
if($result.phase -in @('PREVIEW','ACCEPTED')){exit 0};exit 1
