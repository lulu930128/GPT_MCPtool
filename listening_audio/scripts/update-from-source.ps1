param(
    [ValidateSet('Preview','Update','Recover')][string]$Action='Preview',
    [string]$RequestId, [string]$VersionId, [string]$ExpectedSourceDigest
)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $root '..\project_reading\scripts\node-source-update.ps1')
$descriptor=Read-ComponentUpdateJson (Join-Path $root 'control-center\update.json')
$node=(Get-Command node.exe -ErrorAction Stop).Source
$powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$build={
    param($stageDist,$childJournalRoot)
    Invoke-ComponentUpdateProcess -Executable $node -Arguments ('"'+(Join-Path $root 'node_modules\typescript\bin\tsc')+'" -p "'+(Join-Path $root 'tsconfig.json')+'" --outDir "'+$stageDist+'"') -WorkingDirectory $root -ChildJournalRoot $childJournalRoot | Out-Null
    Invoke-ComponentUpdateProcess -Executable $node -Arguments ('"'+(Join-Path $root 'scripts\build-ui.mjs')+'" "'+$stageDist+'"') -WorkingDirectory $root -ChildJournalRoot $childJournalRoot | Out-Null
}
$identity={
    param($distRoot)
    Invoke-ComponentUpdateProcess -Executable $node -Arguments ('"'+(Join-Path $root 'scripts\build-identity.mjs')+'" "'+$distRoot+'"') -WorkingDirectory $root -Json
}
$preflight={
    $reply=Invoke-ComponentUpdateProcess -Executable $powershell -Arguments ('-NoProfile -NonInteractive -File "'+(Join-Path $root 'scripts\runtime-control.ps1')+'" -Action Status') -WorkingDirectory $root -Json
    [pscustomobject]@{ allowed=($reply.ok -and $reply.after.status -in @('Ready','Degraded','Stopped')); code='UPDATE_OWNER_PREFLIGHT_REJECTED' }
}
$reload={
    $reply=Invoke-ComponentUpdateProcess -Executable $powershell -Arguments ('-NoProfile -NonInteractive -File "'+(Join-Path $root 'scripts\runtime-control.ps1')+'" -Action ReloadRuntime') -WorkingDirectory $root -TimeoutMs 240000 -Json -Lifecycle
    if (-not $reply.ok -or $reply.after.status -ne 'Ready') { throw 'UPDATE_OWNER_NOT_READY' }
}
$observe={
    $reply=Invoke-ComponentUpdateProcess -Executable $powershell -Arguments ('-NoProfile -NonInteractive -File "'+(Join-Path $root 'scripts\runtime-control.ps1')+'" -Action Status') -WorkingDirectory $root -Json
    $health=Invoke-RestMethod -Uri 'http://127.0.0.1:18810/health' -TimeoutSec 5 -ErrorAction Stop
    [pscustomobject]@{ ready=($reply.ok -and $reply.after.status -eq 'Ready' -and $health.ok -and $health.service -eq 'listening-audio-mcp'); status=$reply.after.status; version=$health.version; buildId=$health.buildId; contractVersion=$health.contractVersion; toolCount=$health.toolCount }
}
$result=Invoke-NodeSourceUpdate -ComponentRoot $root -ComponentId 'listening_audio' -SourcePaths $descriptor.sourcePaths -Action $Action -RequestId $RequestId -VersionId $VersionId -ExpectedSourceDigest $ExpectedSourceDigest -Build $build -Identity $identity -Preflight $preflight -Reload $reload -Observe $observe
$result | ConvertTo-Json -Depth 12
if ($result.phase -in @('PREVIEW','ACCEPTED')) { exit 0 }
exit 1
