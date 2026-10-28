param([ValidateSet('Preview','Update','Recover')][string]$Action='Preview',
    [string]$RequestId,[string]$VersionId,[string]$ExpectedSourceDigest)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'node-source-update.ps1')
$descriptor=Read-ComponentUpdateJson (Join-Path $root 'control-center/update.json')
$node=(Get-Command node.exe -ErrorAction Stop).Source
$ps=Join-Path $PSHOME 'powershell.exe'
$build={param($stageDist,$childJournalRoot)
    Invoke-ComponentUpdateProcess -Executable $node -Arguments ('"'+(Join-Path $root 'scripts/write-build-metadata.mjs')+'" --out-dir "'+$stageDist+'"') -WorkingDirectory $root -ChildJournalRoot $childJournalRoot|Out-Null
    Invoke-ComponentUpdateProcess -Executable $node -Arguments ('"'+(Join-Path $root 'node_modules/typescript/bin/tsc')+'" -p "'+(Join-Path $root 'tsconfig.json')+'" --outDir "'+$stageDist+'"') -WorkingDirectory $root -ChildJournalRoot $childJournalRoot|Out-Null
}
$identity={param($dist)
    $meta=Read-ComponentUpdateJson (Join-Path $dist 'build-info.json')
    $package=Read-ComponentUpdateJson (Join-Path $root 'package.json')
    [pscustomobject]@{version=$package.version;buildId=$meta.buildId;contractVersion=$package.toolContractVersion}
}
$preflight={
    $status=Invoke-ComponentUpdateProcess -Executable $ps -Arguments ('-NoProfile -NonInteractive -File "'+(Join-Path $PSScriptRoot 'runtime-control.ps1')+'" -Action Status') -WorkingDirectory $root -Json
    if(-not $status.ok -or $status.after.status -cnotin @('Ready','Degraded','Stopped')){throw 'UPDATE_OWNER_PREFLIGHT_REJECTED'}
    return [pscustomobject]@{allowed=$true}
}
$reload={
    $r=Invoke-ComponentUpdateProcess -Executable $ps -Arguments ('-NoProfile -NonInteractive -File "'+(Join-Path $PSScriptRoot 'runtime-control.ps1')+'" -Action ReloadRuntime') -WorkingDirectory $root -TimeoutMs 180000 -Json -Lifecycle
    if(-not $r.ok -or $r.after.status -cne 'Ready'){throw 'UPDATE_OWNER_NOT_READY'}
}
$observe={
    $r=Invoke-ComponentUpdateProcess -Executable $ps -Arguments ('-NoProfile -NonInteractive -File "'+(Join-Path $PSScriptRoot 'runtime-control.ps1')+'" -Action Status') -WorkingDirectory $root -Json
    $h=Invoke-RestMethod -Uri 'http://127.0.0.1:18787/health' -TimeoutSec 5 -UseBasicParsing
    [pscustomobject]@{ready=($r.ok -and $r.after.status -ceq 'Ready' -and $h.ok -and $h.service -ceq 'gpt-project-workspace-mcp');version=$h.version;buildId=$h.buildId;contractVersion=$h.toolContractVersion}
}
$result=Invoke-NodeSourceUpdate -ComponentRoot $root -ComponentId project_reading -SourcePaths $descriptor.sourcePaths -Action $Action -RequestId $RequestId -VersionId $VersionId -ExpectedSourceDigest $ExpectedSourceDigest -Build $build -Identity $identity -Preflight $preflight -Reload $reload -Observe $observe
$result|ConvertTo-Json -Depth 12
if($result.phase -notin @('PREVIEW','ACCEPTED')){exit 1}
