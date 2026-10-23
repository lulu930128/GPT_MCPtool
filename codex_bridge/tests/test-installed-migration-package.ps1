# Offline package contents only: actual Prepare copy statements and compiled JS.
# No operator entrypoint, lifecycle, Store open, production Journal or ACL writes.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('migration-package-'+[guid]::NewGuid().ToString('N'))
$checks=0
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message};$script:checks++}
function Parse([string]$Path){
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'PACKAGE_TEST_PARSE_FAILED'}
    return $ast
}
function Write-Fixture([string]$Path,[string]$Text){
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
    [IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($false)))
}
function Run-Checker {
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$node;$info.Arguments='"'+$probe+'"'
    $info.WorkingDirectory=$PackageRoot;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $child=[Diagnostics.Process]::Start($info)
    try{
        $stdout=$child.StandardOutput.ReadToEnd();$stderr=$child.StandardError.ReadToEnd();$child.WaitForExit()
        return [pscustomobject]@{code=$child.ExitCode;stdout=$stdout;stderr=$stderr}
    }finally{$child.Dispose()}
}
$verifier=$null
try {
    $node=(Get-Command node -CommandType Application -ErrorAction Stop).Source
    $operator=Parse (Join-Path $source 'scripts\installed-release-operator.ps1')
    $assign=$operator.Find({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$scriptLists'},$true)
    $scripts=$operator.Find({param($n) $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Variable.VariablePath.UserPath -ceq 'componentName'},$true)
    $trees=$operator.Find({param($n) $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Extent.Text.Contains('"codex_bridge\$dir"')},$true)
    $copy=$operator.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Copy-CodeTree'},$true)
    Check ($null -ne $assign -and $null -ne $scripts -and $null -ne $trees -and $null -ne $copy) 'Actual Prepare copy surface missing'
    . ([scriptblock]::Create($copy.Extent.Text))
    . ([scriptblock]::Create($assign.Extent.Text))
    # Import only the existing verifier's function definitions; tree hashing and
    # reparse checks run on this fixture, never an installed tree or private state.
    $verifier=Import-Module (Join-Path $source '..\mcp_control_center\src\McpControlCenter.InstalledRelease.psm1') -PassThru
    $CandidateRoot=Join-Path $fixture 'input';$PackageRoot=Join-Path $fixture 'contents'
    $bridge=Join-Path $PackageRoot 'codex_bridge'
    foreach($component in $scriptLists.Keys){
        [void][IO.Directory]::CreateDirectory((Join-Path $PackageRoot $component))
        foreach($name in $scriptLists[$component]){
            Write-Fixture (Join-Path $CandidateRoot ($component+'\scripts\'+$name)) 'throw "INERT_PACKAGE_FIXTURE"'
        }
    }
    foreach($name in @('installed-runtime-migration.ps1','check-migration-approvals.mjs')){
        Copy-Item -LiteralPath (Join-Path $source ('scripts\'+$name)) -Destination (Join-Path $CandidateRoot ('codex_bridge\scripts\'+$name))
    }
    foreach($dir in @('src','web','control-center','dist','node_modules')){
        [void][IO.Directory]::CreateDirectory((Join-Path $CandidateRoot ('codex_bridge\'+$dir)))
    }
    Copy-Item -LiteralPath (Join-Path $source 'dist\src') -Destination (Join-Path $CandidateRoot 'codex_bridge\dist') -Recurse
    Copy-Item -LiteralPath (Join-Path $source 'node_modules\zod') -Destination (Join-Path $CandidateRoot 'codex_bridge\node_modules') -Recurse
    & ([scriptblock]::Create($trees.Extent.Text))
    & ([scriptblock]::Create($scripts.Extent.Text))
    # Prepare also ships the package's ESM declaration unchanged.
    Copy-Item -LiteralPath (Join-Path $source 'package.json') -Destination $bridge
    $probe=Join-Path $PackageRoot 'probe.mjs'
    Write-Fixture $probe @'
import assert from "node:assert/strict";
import { checkMigrationApprovals } from "./codex_bridge/scripts/check-migration-approvals.mjs";
import { inspectApprovalJournal } from "./codex_bridge/dist/src/powershell-approval/store.js";
assert.deepEqual(inspectApprovalJournal(""), { entries: 0, receipts: [] });
assert.deepEqual(checkMigrationApprovals(""), { ok: true, entries: 0, requests: 0, expiredReviews: 0 });
console.log("PACKAGE_CLOSURE_OK");
'@
    $result=Run-Checker
    Check ($result.code -eq 0 -and $result.stdout.Trim() -ceq 'PACKAGE_CLOSURE_OK') ('PACKAGED_CHECKER_UNREACHABLE: '+$result.stderr)
    foreach($relative in @('scripts\check-migration-approvals.mjs','scripts\installed-runtime-migration.ps1','dist\src\powershell-approval\store.js')){
        Check ((Get-FileHash -LiteralPath (Join-Path $bridge $relative)).Hash -ceq (Get-FileHash -LiteralPath (Join-Path $source $relative)).Hash) ('Copied bytes differ: '+$relative)
    }
    # Extract only the copied helper's read-only function. Its script root must
    # resolve the copied checker, not the workspace checker or installed r15.
    $helper=Parse (Join-Path $bridge 'scripts\installed-runtime-migration.ps1')
    $idle=$helper.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Assert-MigrationApprovalsIdle'},$true)
    $runner=Join-Path $bridge 'scripts\probe-idle.ps1'
    Write-Fixture $runner ('param($DataRoot,$NodePath)' + "`n" + $idle.Extent.Text + "`nAssert-MigrationApprovalsIdle -DataRoot `$DataRoot -NodePath `$NodePath")
    $data=Join-Path $fixture 'empty-journal';$journal=Join-Path $data 'powershell-approval\receipts.jsonl'
    Write-Fixture $journal ''
    & $runner $data $node
    Check ((Get-Item -LiteralPath $journal).Length -eq 0 -and @(Get-ChildItem -LiteralPath (Split-Path -Parent $journal)).Count -eq 1) 'Read-only helper changed the fixture Journal or opened a Store'
    foreach($relative in @('scripts\check-migration-approvals.mjs','dist\src\powershell-approval\store.js')){
        $path=Join-Path $bridge $relative;$bytes=[IO.File]::ReadAllBytes($path)
        [IO.File]::Delete($path)
        try{
            $result=Run-Checker
            Check ($result.code -ne 0 -and $result.stderr.Contains('ERR_MODULE_NOT_FOUND') -and $result.stderr.Contains([IO.Path]::GetFileName($path))) ('Missing closure member was not rejected: '+$relative)
        }finally{[IO.File]::WriteAllBytes($path,$bytes)}
    }
    # An older compiled Store with no inspection export must also fail closed.
    $storePath=Join-Path $bridge 'dist\src\powershell-approval\store.js';$bytes=[IO.File]::ReadAllBytes($storePath)
    try{
        Write-Fixture $storePath 'export class ApprovalStore {}'
        $result=Run-Checker
        Check ($result.code -ne 0 -and $result.stderr.Contains("does not provide an export named 'inspectApprovalJournal'")) 'Stale compiled Store was not rejected'
    }finally{[IO.File]::WriteAllBytes($storePath,$bytes)}
    [pscustomobject]@{ok=$true;checks=$checks;copy='ACTUAL_PREPARE_STATEMENTS';compiledStore='REAL_IMPORT_AND_INSPECTION';negativeCases=3;lifecycleRun=$false;productionTouched=$false}|ConvertTo-Json
}finally{
    if($verifier){Remove-Module $verifier}
    # Inert bounded TEMP evidence only. No installed release/ZIP is produced.
    Write-Output ('PACKAGE_CONTENTS_FIXTURE: '+$fixture)
}
