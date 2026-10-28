Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\scripts\component-update-common.ps1')
$workspaceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$node=(Get-Command node.exe -ErrorAction Stop).Source
$results=@()
foreach($componentId in @('japanese_study','english_study','listening_audio')) {
    $root=Join-Path $workspaceRoot $componentId
    $fixture=Join-Path $root ('.local\stage-fixture-'+[guid]::NewGuid().ToString('N'))
    $stage=Join-Path $fixture 'dist'
    try {
        Assert-ComponentUpdatePath $fixture
        [void][IO.Directory]::CreateDirectory($stage)
        # Execute the actual component-owned callbacks, without evaluating the
        # wrapper's dispatch entrypoint or contacting any live lifecycle owner.
        $tokens=$null; $parseErrors=$null
        $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'scripts\update-from-source.ps1'),[ref]$tokens,[ref]$parseErrors)
        if($parseErrors.Count){throw 'ADAPTER_PARSE_FAILED'}
        $buildAssignment=$ast.Find({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$build'},$false)
        $identityAssignment=$ast.Find({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$identity'},$false)
        $build=[scriptblock]::Create($buildAssignment.Right.Expression.ScriptBlock.Extent.Text.Trim().Substring(1).TrimEnd('}'))
        $identity=[scriptblock]::Create($identityAssignment.Right.Expression.ScriptBlock.Extent.Text.Trim().Substring(1).TrimEnd('}'))
        $childJournalRoot=Join-Path $fixture 'children'
        & $build $stage $childJournalRoot
        Assert-ComponentUpdateChildrenStopped -Root $childJournalRoot
        $childStarts=@(Get-ChildItem -LiteralPath $childJournalRoot -Filter '*.start.json' -File)
        $expectedChildren=if($componentId -eq 'listening_audio'){2}else{1}
        if($childStarts.Count -ne $expectedChildren){throw 'ADAPTER_BUILD_CHILD_NOT_TRACKED'}
        $staged=& $identity $stage
        $current=& $identity (Join-Path $root 'dist')
        foreach($field in @('version','buildId','contractVersion','toolCount')) {
            if([string]$staged.$field -cne [string]$current.$field){throw ('STAGED_IDENTITY_DIFFERS: '+$componentId+' '+$field)}
        }
        if($staged.buildId -cnotmatch '^[a-f0-9]{16}$'){throw 'STAGED_IDENTITY_INVALID'}
        $results += [pscustomobject]@{componentId=$componentId;identity=$staged;equalToNormalBuild=$true;trackedBuildChildren=$childStarts.Count;liveMutation=$false}
    } finally {
        $resolved=[IO.Path]::GetFullPath($fixture)
        if(-not $resolved.StartsWith($root+'\.local\stage-fixture-',[StringComparison]::OrdinalIgnoreCase)){throw 'FIXTURE_CLEANUP_PATH_REJECTED'}
        if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
    }
}
[pscustomobject]@{ok=$true;components=$results}|ConvertTo-Json -Depth 8
