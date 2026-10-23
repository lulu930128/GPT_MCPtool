# Isolated NTFS fixture; no installed operator, live data or lifecycle invocation.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$checks=0
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message};$script:checks++}
function Refused([scriptblock]$Body,[string]$Code){$actual='';try{& $Body|Out-Null}catch{$actual=$_.Exception.Message};Check ($actual -match $Code) "Expected $Code; got $actual"}
function RefusedId([scriptblock]$Body,[string]$Id){$actual='';try{& $Body|Out-Null}catch{$actual=$_.FullyQualifiedErrorId};Check ($actual -match $Id) "Expected error ID $Id; got $actual"}
$tokens=$null;$errors=$null
$operatorAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\scripts\installed-release-operator.ps1'),[ref]$tokens,[ref]$errors)
Check ($errors.Count -eq 0) 'Operator syntax'
$node=$operatorAst.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Get-StatePlanHash'},$true)
. ([scriptblock]::Create($node.Extent.Text))
$helper=Join-Path $PSScriptRoot '..\scripts\installed-runtime-migration.ps1'
$ast=[Management.Automation.Language.Parser]::ParseFile($helper,[ref]$tokens,[ref]$errors)
Check ($errors.Count -eq 0) 'Helper syntax'
. $helper
$module=Import-Module (Join-Path $PSScriptRoot '..\..\mcp_control_center\src\McpControlCenter.InstalledRelease.psm1') -PassThru
$operator=[pscustomobject]@{sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('migration-live-baseline-fixture-'+[guid]::NewGuid().ToString('N'))
$data=Join-Path $fixture 'data';$owner=Join-Path $fixture 'owner'
$relative='installed-bridge\normal-direct-20261022-r12\tunnel-client.log'
$log=Join-Path $owner $relative
$store=Join-Path $data 'powershell-approval'
[void][IO.Directory]::CreateDirectory((Split-Path -Parent $log))
[void][IO.Directory]::CreateDirectory($store)
$utf8=New-Object Text.UTF8Encoding($false)
$script:Utf8NoBom=$utf8
$coreAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\..\mcp_control_center\src\McpControlCenter.Core.psm1'),[ref]$tokens,[ref]$errors)
Check ($errors.Count -eq 0) 'Control Center syntax'
$writer=$coreAst.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Write-McpCcJsonAtomic'},$true)
. ([scriptblock]::Create($writer.Extent.Text))
foreach($path in @($log,(Join-Path $store 'receipts.jsonl'),(Join-Path $store 'approval.lock'),(Join-Path $owner 'stable.json'),(Join-Path $owner 'state.json'))){[IO.File]::WriteAllText($path,'fixture',$utf8)}
$script:privateFailure='';$script:privatePaths=@()
# Ancestor trust is synthetic because TEMP is not an installed private root.
# The production verifier is still invoked through its exact existing seam;
# no-reparse, stream enumeration, hashing and copy ACL IO below are real NTFS.
$verifier=New-Module -ArgumentList $module {
    param($actual)
    $script:actual=$actual
    function Assert-McpCcNoReparseChain($p){& $script:actual {param($path) Assert-McpCcNoReparseChain $path} $p}
    function Assert-McpCcInstalledPrivatePath($p,$s){
        if($global:MigrationFixturePrivateFailure){throw $global:MigrationFixturePrivateFailure}
        $global:MigrationFixturePrivatePaths+=@($p)
        Assert-McpCcNoReparseChain $p
    }
    function Get-McpCcInstalledPrivateAcl($a,$s,$d,$extra){& $script:actual {param($a,$s,$d,$extra) Get-McpCcInstalledPrivateAcl $a $s $d $extra} $a $s $d $extra}
    function Test-McpCcInstalledAclWrite($a,$b){& $script:actual {param($a,$b) Test-McpCcInstalledAclWrite $a $b} $a $b}
    function Assert-McpCcInstalledPrivateTree($p,$s){}
}
$global:MigrationFixturePrivateFailure='';$global:MigrationFixturePrivatePaths=@()
$previous=[pscustomobject]@{root=(Join-Path $fixture 'release');releaseId='normal-direct-20261022-r12';state=@{dataDir=$data;ownerRoot=$owner}}
$release=[pscustomobject]@{cutover=@{rollbackBuildId='572021d0a632127d'}}
function Get-Health {param([switch]$Idle) return [pscustomobject]@{pid=$PID;buildId='572021d0a632127d';jobs=@{total=522}}}
function Invoke-Controller {return [pscustomobject]@{after=@{tunnel=@{pid=$PID}}}}
function Assert-OwnedReady {}
function Assert-RemoteReceiptsTerminal {}
function Assert-HttpAuthentication {}
$script:hashReads=@()
function Get-FileHash {param($LiteralPath,$Algorithm='SHA256')
    $script:hashReads+=@($LiteralPath)
    Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm -ErrorAction Stop
}
$handles=@()
try {
    foreach($path in @($log,(Join-Path $store 'receipts.jsonl'),(Join-Path $store 'approval.lock'))){
        $handles+=,[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    }
    $failure=$null
    try{Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $log -ErrorAction Stop|Out-Null}catch{$failure=$_}
    # Windows PowerShell wraps this as WriteErrorException, without preserving
    # the IO HResult. Classify its stable error ID/category, not localized text.
    Check ($null -ne $failure -and $failure.FullyQualifiedErrorId -ceq 'FileReadError,Get-FileHash' -and $failure.CategoryInfo.Category -eq 'ReadError') 'Original Get-FileHash reports FileReadError under FileShare.None'
    Write-Output 'REPRO_PASS: FileShare.None -> Get-FileHash FileReadError / ReadError'
    RefusedId {Get-MigrationTree $owner} '^FileReadError,Get-FileHash$'
    $script:hashReads=@()
    $baseline=Get-MigrationFreshBaseline $release $previous
    Check ($script:hashReads -cnotcontains $log) 'Live baseline never opens the active tunnel log for hashing'
    Check (@($script:hashReads|Where-Object {$_ -like '*powershell-approval*'}).Count -eq 0) 'Live Store content remains unread'
    Check ($global:MigrationFixturePrivatePaths -ccontains $log) 'Exact tunnel log goes through private path/owner/ACL verifier'
    $expected=Get-StatePlanHash $baseline
    $handles[0].Seek(0,[IO.SeekOrigin]::End)|Out-Null
    $bytes=$utf8.GetBytes(' expected append');$handles[0].Write($bytes,0,$bytes.Length);$handles[0].Flush($true)
    Check ((Get-StatePlanHash (Get-MigrationFreshBaseline $release $previous)) -ceq $expected) 'Live append does not invalidate Plan/Apply baseline'
    # The existing Tray replaces this observation every refresh while the
    # installed Owner must remain selected for Plan/Apply. Its parent write
    # timestamp changes too; neither is immutable migration authority.
    $observation=Join-Path $owner 'state.json'
    [IO.File]::WriteAllText($observation,'new periodic observation',$utf8)
    [IO.Directory]::SetLastWriteTimeUtc($owner,[DateTime]::UtcNow.AddSeconds(2))
    Check ((Get-StatePlanHash (Get-MigrationFreshBaseline $release $previous)) -ceq $expected) 'Periodic state publication does not invalidate Plan/Apply baseline'
    Write-McpCcJsonAtomic -Path $observation -Document @{observedAt='fixture-refresh';status='Ready'}
    Check ((Get-StatePlanHash (Get-MigrationFreshBaseline $release $previous)) -ceq $expected) 'Actual Control Center atomic writer preserves the live baseline'
    foreach($code in @('INSTALLED_PRIVATE_OWNER_REQUIRED','INSTALLED_PRIVATE_ACL_REJECTED','AccessDenied')){
        $global:MigrationFixturePrivateFailure=$code
        Refused {Get-MigrationFreshBaseline $release $previous} $code
    }
    $global:MigrationFixturePrivateFailure=''
} finally {foreach($handle in $handles){$handle.Dispose()}}

# Use the actual pre-mutation plan hash guard, with real baseline digests.
$guard=$ast.Find({param($n)$n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text -like '*if($ExpectedPlanHash -cne $hash)*' -and $n.Extent.Text.Length -lt 200},$true)
Check ($null -ne $guard) 'Original plan guard retained'
$ExpectedPlanHash=Get-StatePlanHash (Get-MigrationFreshBaseline $release $previous)
function Reject-Drift {
    $hash=Get-StatePlanHash (Get-MigrationFreshBaseline $release $previous)
    Refused {& ([scriptblock]::Create($guard.Extent.Text))} 'STATE_PLAN_CHANGED_NO_MUTATION'
}
$stamp=[IO.File]::GetCreationTimeUtc($log)
[IO.File]::SetCreationTimeUtc($log,$stamp.AddMinutes(-1));Reject-Drift
[IO.File]::SetCreationTimeUtc($log,$stamp)
$attributes=[IO.File]::GetAttributes($log)
[IO.File]::SetAttributes($log,($attributes -bor [IO.FileAttributes]::Hidden));Reject-Drift
[IO.File]::SetAttributes($log,$attributes)
foreach($identityPath in @((Join-Path $owner 'state.json'),$owner)){
    $created=[IO.File]::GetCreationTimeUtc($identityPath)
    if($identityPath -ceq $owner){[IO.Directory]::SetCreationTimeUtc($identityPath,$created.AddMinutes(-1))}
    else{[IO.File]::SetCreationTimeUtc($identityPath,$created.AddMinutes(-1))}
    Reject-Drift
    if($identityPath -ceq $owner){[IO.Directory]::SetCreationTimeUtc($identityPath,$created)}
    else{[IO.File]::SetCreationTimeUtc($identityPath,$created)}
}
# Inject SDDL changes at the read seam; no production or fixture ownership change.
$script:aclDrift=''
$script:aclDriftPath=$log
function Get-Acl {param($LiteralPath)
    $actual=Microsoft.PowerShell.Security\Get-Acl -LiteralPath $LiteralPath -ErrorAction Stop
    if($LiteralPath -ceq $script:aclDriftPath -and $script:aclDrift){return [pscustomobject]@{Sddl=$actual.Sddl+$script:aclDrift}}
    return $actual
}
foreach($aclPath in @($log,(Join-Path $owner 'state.json'),$owner)){
    $script:aclDriftPath=$aclPath
    foreach($change in @('owner-drift','dacl-drift')){$script:aclDrift=$change;Reject-Drift}
}
$script:aclDrift=''
Remove-Item Function:\Get-Acl
$unknown=Join-Path (Split-Path -Parent $log) 'unexpected.log'
[IO.File]::WriteAllText($unknown,'not exempt',$utf8);Reject-Drift
$extra=[IO.File]::Open($unknown,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{RefusedId {Get-MigrationFreshBaseline $release $previous} '^FileReadError,Get-FileHash$'}finally{$extra.Dispose()}
[IO.File]::WriteAllText((Join-Path $owner 'stable.json'),'source drift',$utf8);Reject-Drift
Set-Content -LiteralPath $log -Stream unexpected -Value 'stream'
Refused {Get-MigrationFreshBaseline $release $previous} 'MIGRATION_ALTERNATE_STREAM_REQUIRES_REVIEW'
Remove-Item -LiteralPath $log -Stream unexpected
$saved=Join-Path $fixture 'saved.log'
Move-Item -LiteralPath $log -Destination $saved
RefusedId {Get-MigrationFreshBaseline $release $previous} '^PathNotFound,'
[void][IO.Directory]::CreateDirectory($log)
Refused {Get-MigrationFreshBaseline $release $previous} 'MIGRATION_TUNNEL_METADATA_UNKNOWN'
[IO.Directory]::Delete($log)
Move-Item -LiteralPath $saved -Destination $log

# Once writers close, the unmodified full inventory/copy guards include logs.
$rows=Get-MigrationTree $owner
$logRow=@($rows|Where-Object relative -ceq $relative)
Check ($logRow.Count -eq 1 -and $logRow[0].sha256 -ceq (Get-FileHash $log).Hash.ToLowerInvariant()) 'Stopped full hash includes tunnel log bytes'
$stateRow=@($rows|Where-Object relative -ceq 'state.json')
Check ($stateRow.Count -eq 1 -and $stateRow[0].sha256 -ceq (Get-FileHash (Join-Path $owner 'state.json')).Hash.ToLowerInvariant()) 'Stopped full hash includes state observation bytes'
foreach($target in @((Join-Path $fixture 'backup'),(Join-Path $fixture 'target'))){
    Copy-MigrationTree $owner $target $rows
    Check ((Get-MigrationContentHash (Get-MigrationTree $target)) -ceq (Get-MigrationContentHash $rows)) 'Backup/target copies preserve all files including logs'
}
$stoppedHash=Get-StatePlanHash $rows
[IO.File]::AppendAllText($log,'unexpected stopped write',$utf8)
$rows=Get-MigrationTree $owner
$sourceGuard=$ast.Find({param($n)$n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text -ceq "if((Get-StatePlanHash `$rows) -cne `$stoppedHash){throw 'MIGRATION_STOPPED_SOURCE_CHANGED'}"},$true)
Refused {& ([scriptblock]::Create($sourceGuard.Extent.Text))} 'MIGRATION_STOPPED_SOURCE_CHANGED'
Refused {Copy-MigrationTree $owner (Join-Path $fixture 'refused-copy') (Get-MigrationTree (Join-Path $fixture 'backup'))} 'MIGRATION_CONTENT_CHANGED'
Check (-not(Test-Path -LiteralPath (Join-Path $fixture 'refused-copy'))) 'Source drift rejected before copying'
Refused {Remove-MigrationVerifiedTree $owner $rows} 'MIGRATION_DELETE_SCOPE_REJECTED'
Remove-Variable MigrationFixturePrivateFailure,MigrationFixturePrivatePaths -Scope Global
[pscustomobject]@{ok=$true;checks=$checks;fixture=$fixture;productionTouched=$false;lifecycleRun=$false}|ConvertTo-Json
