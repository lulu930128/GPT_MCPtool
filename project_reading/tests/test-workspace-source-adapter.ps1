param()
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$componentRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixtureBase=Join-Path $componentRoot ('.tmp\workspace-source-adapter\'+[guid]::NewGuid().ToString('N'))
$root=Join-Path $fixtureBase 'source'
[void][IO.Directory]::CreateDirectory($root)
$script:checks=0
function Assert-Adapter([bool]$Condition,[string]$Label) {
    if(-not $Condition){throw ('ASSERT_FAILED: '+$Label)}
    $script:checks++
}
function Get-AdapterCallback([string]$Name) {
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $componentRoot 'scripts\update-from-source.ps1'),[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'ADAPTER_PARSE_FAILED'}
    $assignments=@($ast.FindAll({param($item)
        $item -is [Management.Automation.Language.AssignmentStatementAst] -and $item.Left.Extent.Text -ceq ('$'+$Name)
    },$true))
    if($assignments.Count -ne 1){throw 'ADAPTER_CALLBACK_NOT_UNIQUE'}
    # Only the actual callback expression is evaluated. The wrapper's top-level
    # update dispatch, Reload callback and live observe callback are never run.
    $expression=$assignments[0].Right.Find({param($item) $item -is [Management.Automation.Language.ScriptBlockExpressionAst]},$true)
    if($null -eq $expression){throw 'ADAPTER_CALLBACK_NOT_SCRIPTBLOCK'}
    # GetScriptBlock preserves the original file's PSScriptRoot. Re-parsing the
    # expression text would lose that context and test a different callback.
    return $expression.ScriptBlock.GetScriptBlock()
}
foreach($relative in @('src','tests','package.json','tsconfig.json')) {
    Copy-Item -LiteralPath (Join-Path $componentRoot $relative) -Destination (Join-Path $root $relative) -Recurse
}
[void][IO.Directory]::CreateDirectory((Join-Path $root 'scripts'))
Copy-Item -LiteralPath (Join-Path $componentRoot 'scripts\write-build-metadata.mjs') -Destination (Join-Path $root 'scripts\write-build-metadata.mjs')
# Reuse the installed compiler bytes in an isolated fixture. Remaining module
# resolution reads the existing ancestor node_modules; no install or sync runs.
[void][IO.Directory]::CreateDirectory((Join-Path $root 'node_modules\.bin'))
Copy-Item -LiteralPath (Join-Path $componentRoot 'node_modules\typescript') -Destination (Join-Path $root 'node_modules\typescript') -Recurse
Copy-Item -LiteralPath (Join-Path $componentRoot 'node_modules\.bin\tsc.cmd') -Destination (Join-Path $root 'node_modules\.bin\tsc.cmd')
. (Join-Path $componentRoot 'scripts\component-update-common.ps1')
$script:realProcess=${function:Invoke-ComponentUpdateProcess}
$node=(Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
$ps=Join-Path $PSHOME 'powershell.exe'
$script:buildCalls=0;$script:statusCalls=0
$script:statusReply=$null
function Invoke-ComponentUpdateProcess {
    param([string]$Executable,[string]$Arguments,[string]$WorkingDirectory,[int]$TimeoutMs=120000,
        [switch]$Json,[switch]$Lifecycle,[string]$ChildJournalRoot)
    if($Lifecycle -or $Arguments -match 'ReloadRuntime'){throw 'LIVE_RELOAD_FORBIDDEN_IN_FIXTURE'}
    if($Executable -ieq $ps) {
        if(-not $Json -or $Arguments -notmatch ' -Action Status$'){throw 'UNEXPECTED_OWNER_ACTION'}
        $script:statusCalls++
        return $script:statusReply
    }
    if($Executable -ine $node -or $WorkingDirectory -ine $root -or
        $ChildJournalRoot -ine (Join-Path $fixtureBase 'children-stage') -or
        ($Arguments -notmatch 'write-build-metadata\.mjs" --out-dir ' -and $Arguments -notmatch 'typescript[\\/]bin[\\/]tsc" -p ')) {
        throw 'UNEXPECTED_BUILD_PROCESS'
    }
    $script:buildCalls++
    & $script:realProcess @PSBoundParameters
}
$build=Get-AdapterCallback 'build'
$identity=Get-AdapterCallback 'identity'
$preflight=Get-AdapterCallback 'preflight'
$stage=Join-Path $fixtureBase 'stage'
& $build $stage (Join-Path $fixtureBase 'children-stage')
Assert-Adapter ($script:buildCalls -eq 2) 'real build callback emits metadata then invokes the compiler'
Assert-Adapter (-not (Test-Path -LiteralPath (Join-Path $root 'dist'))) 'staged callback does not publish default dist'
$stagedIdentity=& $identity $stage
$package=Read-ComponentUpdateJson (Join-Path $root 'package.json')
Assert-Adapter ($stagedIdentity.version -ceq $package.version -and $stagedIdentity.contractVersion -ceq $package.toolContractVersion) 'real identity callback preserves application and tool contract versions'
Assert-Adapter ($stagedIdentity.buildId -cmatch '^[a-f0-9]{20}$') 'staged identity has generated build id'
$npm=(Get-Command npm.cmd -CommandType Application -ErrorAction Stop).Source
$npmCli=Join-Path (Split-Path -Parent $npm) 'node_modules\npm\bin\npm-cli.js'
if(-not (Test-Path -LiteralPath $npmCli -PathType Leaf)){throw 'NPM_CLI_NOT_FOUND'}
& $script:realProcess -Executable $node -Arguments ('"'+$npmCli+'" run build') -WorkingDirectory $root -ChildJournalRoot (Join-Path $fixtureBase 'children-normal') | Out-Null
$normal=Join-Path $root 'dist'
$normalIdentity=& $identity $normal
Assert-Adapter ($normalIdentity.version -ceq $stagedIdentity.version -and $normalIdentity.contractVersion -ceq $stagedIdentity.contractVersion -and $normalIdentity.buildId -cmatch '^[a-f0-9]{20}$') 'ordinary npm build identity matches the same application contract'
function Get-CompiledInventory([string]$Directory) {
    # Build timestamp and buildId intentionally differ for separate builds.
    @(Get-ChildItem -LiteralPath $Directory -File -Recurse | Where-Object { $_.Name -cne 'build-info.json' } | ForEach-Object {
        ($_.FullName.Substring($Directory.Length+1).Replace('\','/')+'|'+(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)
    } | Sort-Object)
}
$stageFiles=@(Get-CompiledInventory $stage)
$normalFiles=@(Get-CompiledInventory $normal)
Assert-Adapter ($stageFiles.Count -gt 0 -and ($stageFiles -join "`n") -ceq ($normalFiles -join "`n")) 'staged and ordinary builds produce identical compiled artifacts'
foreach($status in @('Ready','Degraded','Stopped')) {
    $script:statusReply=[pscustomobject]@{ok=$true;after=[pscustomobject]@{status=$status}}
    $gate=@(& $preflight)
    Assert-Adapter ($gate.Count -eq 1) ('preflight returns exactly one decision for '+$status)
    Assert-Adapter ($gate[0].allowed -eq $true) ('preflight explicitly returns allowed=true for '+$status)
}
foreach($status in @('Misconfigured','OwnershipMismatch','Failed','Starting','Unknown','ready','')) {
    $script:statusReply=[pscustomobject]@{ok=$true;after=[pscustomobject]@{status=$status}}
    $failure=$null
    try { & $preflight | Out-Null } catch { $failure=$_.Exception.Message }
    Assert-Adapter ($failure -ceq 'UPDATE_OWNER_PREFLIGHT_REJECTED') ('preflight rejects '+$status)
}
$script:statusReply=[pscustomobject]@{ok=$false;after=[pscustomobject]@{status='Ready'}}
$failure=$null
try { & $preflight | Out-Null } catch { $failure=$_.Exception.Message }
Assert-Adapter ($failure -ceq 'UPDATE_OWNER_PREFLIGHT_REJECTED') 'failed owner result cannot allow Ready'
Assert-Adapter ($script:statusCalls -eq 11 -and $script:buildCalls -eq 2) 'preflight only observes mocked Status and never rebuilds or reloads'
[pscustomobject]@{status='PASS_ISOLATED_ACTUAL_CALLBACKS';checks=$script:checks;compiledArtifactCount=$stageFiles.Count;
    fixtureRoot=$fixtureBase;liveMutation=$false;liveReloadCalls=0}|ConvertTo-Json -Compress
