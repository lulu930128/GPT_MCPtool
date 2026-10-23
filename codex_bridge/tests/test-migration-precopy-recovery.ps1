# Offline only. Function definitions and synthetic observations, never the operator entrypoint.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$utf8=New-Object Text.UTF8Encoding($false)
$checks=0
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message};$script:checks++}
function Refused([scriptblock]$Body,[string]$Code){$actual='';try{& $Body|Out-Null}catch{$actual=$_.Exception.Message};Check ($actual -match $Code) "Expected $Code; got $actual"}
$tokens=$null;$errors=$null
$operatorAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\scripts\installed-release-operator.ps1'),[ref]$tokens,[ref]$errors)
Check ($errors.Count -eq 0) 'Operator syntax'
foreach($name in @('Get-StatePlanHash','Get-Health')){
    $node=$operatorAst.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
    . ([scriptblock]::Create($node.Extent.Text))
}
$helper=Join-Path $PSScriptRoot '..\scripts\installed-runtime-migration.ps1'
$ast=[Management.Automation.Language.Parser]::ParseFile($helper,[ref]$tokens,[ref]$errors)
Check ($errors.Count -eq 0) 'Helper syntax'
. $helper
# Fail first: the old Plan rejects every existing CC .local, including this incident.
function Get-InstalledUpgradeState {return $script:upgrade}
function Assert-InstalledUpgradeSelection {return ('c'*64)}
function Get-Acl {return $script:acl}
function Get-MigrationAncestorAcl {return $script:acl}
function Test-Path {param($LiteralPath) return $LiteralPath -match '\\mcp_control_center\\.local$|tray-settings.json$'}
function Get-FileHash {param($LiteralPath) return [pscustomobject]@{Hash=('c'*64)}}
$operator=[pscustomobject]@{sid='S-1-5-21-1-2-3-1001';isAdmin=$false}
$acl=[pscustomobject]@{Sddl='fixture-acl'}
$upgrade=[pscustomobject]@{releaseId='normal-direct-20261022-r12'}
$previous=[pscustomobject]@{schemaVersion=5;root='C:\fixture\releases\normal-direct-20261022-r12';releaseId='normal-direct-20261022-r12';legacyWorkspaceRoot='C:\fixture\workspace';state=[pscustomobject]@{operatorSid=$operator.sid;userProfile='fixture';localAppData='fixture';projectsFile='fixture';codexHome='fixture';dataDir='C:\fixture\data';ownerRoot='C:\fixture\owner'};deployment=@{projectsSha256='a';credentialSha256='b'};cutover=@{tunnelProfileSha256='c';httpTokenSha256='d';rollbackBuildId='572021d0a632127d'}}
$release=$previous|ConvertTo-Json -Depth 8|ConvertFrom-Json
$release.schemaVersion=6;$release.releaseId='fixture-successor';$release.root='C:\fixture\releases\fixture-successor'
$release.state.dataDir='C:\fixture\workspace\codex_bridge\.local\runtime';$release.state.ownerRoot='C:\fixture\workspace\mcp_control_center\.local\runtime'
$release|Add-Member NoteProperty sourcePath 'C:\fixture\successor-manifest.json'
# These seams isolate external observation; subsequent cases exercise the actual incident validator.
function Get-MigrationPreCopyIncident {return [pscustomobject]@{receiptSha256='incident';planSha256='old-plan'}}
function Get-MigrationFreshBaseline {return [pscustomobject]@{jobCount=520;dataSha256='fresh';oldCore=@{pid=700;startedUtc='fresh'}}}
$plan=Get-RuntimeMigrationPlan $release $previous -RecoverR15PreCopy
Check ($plan.incident.planSha256 -ceq 'old-plan' -and $plan.baseline.jobCount -eq 520) 'Fresh plan references incident and current jobs'
Refused {Get-RuntimeMigrationPlan $release $previous} 'MIGRATION_CC_LOCAL_EXISTS_REQUIRES_REVIEW'
Check ($plan.baseline.oldCore.pid -eq 700) 'Fresh process, never historical PID'

function Load-Function($Tree,[string]$Name){
    $node=$Tree.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $Name},$true)
    return [scriptblock]::Create($node.Extent.Text)
}
. (Load-Function $ast 'Get-MigrationPreCopyIncident')
. (Load-Function $ast 'Get-MigrationFreshBaseline')
. (Load-Function $ast 'Get-MigrationAncestorAcl')
$realHash=Load-Function $operatorAst 'Get-StatePlanHash'
# Retain the real digest function under a distinct name; only the synthetic
# historical plan has a pinned digest. No production JSON or private bytes used.
. ([scriptblock]::Create($realHash.ToString().Replace('function Get-StatePlanHash','function Get-FixtureHash')))
$id='runtime-owner-20261022-r15'
$pin='013828ce8efa10c21277a728d4519814f6e5ab4f356cf400ef7d2ea91ad0947d'
$manifestPin='1a7cf1845f43b2ed25320a6fbad96623999aceb8f942083180616fa3cf217ee4'
$planPin='dfea28836cc350fccc0bbd5e653cb3311a6f409340476ca261be04fe2dad3b11'
$ccLocal=Join-Path $release.legacyWorkspaceRoot 'mcp_control_center\.local'
$bridgeParent=Join-Path $release.legacyWorkspaceRoot 'codex_bridge\.local\migration-backups'
$ccBackup=Join-Path $ccLocal ('migration-backups\'+$id);$bridgeBackup=Join-Path $bridgeParent $id
$receiptPath=Join-Path $ccBackup 'migration.json'
$recoveryPath=Join-Path $previous.state.ownerRoot ('runtime-migration-'+$id+'-acl.json')
$old=$release|ConvertTo-Json -Depth 8|ConvertFrom-Json
$old.releaseId=$id;$old.sourcePath='C:\fixture\r15-manifest.json'
$release.cutover|Add-Member NoteProperty legacyStartupSha256 ('c'*64)
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetSecurityDescriptorSddlForm('O:S-1-5-21-1-2-3-1001G:S-1-5-21-1-2-3-1001D:P(A;;FA;;;S-1-5-21-1-2-3-1001)')
$historicalPlan=[pscustomobject][ordered]@{contract='installed-runtime-migration-plan-v1';releaseId=$id;manifestSha256=$manifestPin;
    previousRoot=$previous.root;previous=$upgrade;ccLocal=$ccLocal;ccBackup=$ccBackup;bridgeBackup=$bridgeBackup;
    bridgeTarget=$release.state.dataDir;ccTarget=$release.state.ownerRoot;startupSha256=('c'*64);settingsSha256=('c'*64);
    ancestors=@([pscustomobject]@{path=$release.legacyWorkspaceRoot;before=$acl.Sddl;after=$acl.Sddl})}
$historicalJson=$historicalPlan|ConvertTo-Json -Depth 8 -Compress
function Get-StatePlanHash($Plan){if(($Plan|ConvertTo-Json -Depth 8 -Compress) -ceq $script:historicalJson){return $script:planPin};Get-FixtureHash $Plan}
$incident=[pscustomobject]@{contract='installed-runtime-migration-v1';phase='UNKNOWN';lastPhase='STOPPED_EXIT_TRAY';failure='MIGRATION_APPROVAL_NOT_TERMINAL';verification=$null;plan=$historicalPlan;planSha256=$planPin;jobCount=517;oldCore=@{pid=60024;startedUtc='historical'}}
$hashes=@{};$hashes[$receiptPath]=$pin;$hashes[$old.sourcePath]=$manifestPin
$documents=@{};$documents[$receiptPath]=$incident;$documents[$recoveryPath]=$historicalPlan
$script:aclFailure='';$script:closureFailure='';$script:extraPath='';$script:badAncestor=$false
$verifier=New-Module {
    function Assert-McpCcInstalledPrivateTree($p,$s){if($global:preCopyAclFailure){throw $global:preCopyAclFailure}}
    function Assert-McpCcInstalledPrivatePath($p,$s){if($global:preCopyAclFailure){throw $global:preCopyAclFailure}}
}
$global:preCopyAclFailure=''
function Assert-McpCcInstalledClosure {if($script:closureFailure){throw $script:closureFailure}}
function Read-McpCcInstalledRelease {return $script:old}
function Get-FileHash {param($LiteralPath) if($script:hashes.ContainsKey($LiteralPath)){return [pscustomobject]@{Hash=$script:hashes[$LiteralPath]}};return [pscustomobject]@{Hash=('c'*64)}}
function Read-BoundedJson($Path){if(-not $script:documents.ContainsKey($Path)){throw 'UNEXPECTED_FIXTURE_READ'};return $script:documents[$Path]}
function Test-Path {param($LiteralPath) return $LiteralPath -ceq $script:extraPath -or $LiteralPath -ceq $script:ccLocal -or $LiteralPath -match 'tray-settings.json$'}
function Get-Acl {if($script:badAncestor){throw 'Access is denied'};return $script:acl}
function Row([string]$Name,[bool]$Directory){[pscustomobject][ordered]@{relative=$Name;directory=$Directory;length=0;sha256=$null;sddl=$script:acl.Sddl}}
$ccRows=@((Row '' $true),(Row 'migration-backups' $true),(Row ('migration-backups\'+$id) $true),(Row ('migration-backups\'+$id+'\migration.json') $false),(Row ('migration-backups\'+$id+'\startup.lnk') $false))
$bridgeRows=@((Row '' $true),(Row $id $true),(Row ($id+'\tray-settings.json') $false))
function Get-MigrationTree($Root,[string[]]$ExcludeRelative=@()){
    if($Root -ceq $script:ccLocal){return $script:ccRows}
    if($Root -ceq $script:bridgeParent){return $script:bridgeRows}
    if($Root -ceq $script:previous.state.dataDir){
        Check (($ExcludeRelative -join ',') -ceq 'powershell-approval\receipts.jsonl,powershell-approval\approval.lock') 'Running Journal/lock excluded'
        return @([pscustomobject]@{sha256=$script:dataDigest})
    }
    if($Root -ceq $script:previous.state.ownerRoot){return @([pscustomobject]@{relative='';directory=$true;sha256='owner';writtenUtc='fixture'})}
    throw 'UNEXPECTED_FIXTURE_TREE'
}
$evidence=Get-MigrationPreCopyIncident $release $previous
Check ($evidence.receiptSha256 -ceq $pin -and $evidence.planSha256 -ceq $planPin) 'Exact reviewed incident accepted read-only'
$hashes[$receiptPath]='bad';Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_RECEIPT_HASH_CHANGED';$hashes[$receiptPath]=$pin
$hashes[$old.sourcePath]='bad';Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_MANIFEST_CHANGED';$hashes[$old.sourcePath]=$manifestPin
foreach($phase in @('COPYING','COPIED','STARTING','LOCAL_ACCEPTED','STOPPED_EXIT_TRAY')){
    $incident.phase=$phase;Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_NOT_PRECOPY'
};$incident.phase='UNKNOWN'
foreach($phase in @('COPYING','COPIED','STARTING','LOCAL_ACCEPTED','STOPPING','UNKNOWN')){
    $incident.lastPhase=$phase;Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_NOT_PRECOPY'
};$incident.lastPhase='STOPPED_EXIT_TRAY'
$incident.failure='other';Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_NOT_PRECOPY';$incident.failure='MIGRATION_APPROVAL_NOT_TERMINAL'
$incident.planSha256='bad';Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_RECEIPT_CHANGED';$incident.planSha256=$planPin
$incident.plan.previousRoot='C:\fixture\other';Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_RECEIPT_CHANGED';$incident.plan.previousRoot=$previous.root
foreach($target in @($release.state.dataDir,$release.state.ownerRoot)){
    $script:extraPath=$target;Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_TARGET_EXISTS'
};$script:extraPath=''
$baseCc=$ccRows;$baseBridge=$bridgeRows
foreach($entry in @('foreign','migration-backups\foreign','migration-backups\runtime-owner-20261022-r15\manifest.json','migration-backups\runtime-owner-20261022-r15\state')){
    $ccRows=$baseCc+@(Row $entry $false);Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_FOREIGN_ENTRY'
};$ccRows=$baseCc
$bridgeRows=$baseBridge+@(Row ($id+'\manifest.json') $false);Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_FOREIGN_ENTRY';$bridgeRows=$baseBridge
$ccRows[1].directory=$false;Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_FOREIGN_ENTRY';$ccRows[1].directory=$true
$ccRows[1].sddl='O:SYG:SY';Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_ACL_UNKNOWN';$ccRows[1].sddl=$acl.Sddl
$ccRows[1].sddl='O:SYG:SYD:(OA;;FR;11111111-1111-1111-1111-111111111111;;BU)';Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_ACL_UNKNOWN';$ccRows[1].sddl=$acl.Sddl
foreach($failure in @('INSTALLED_PRIVATE_ACL_REJECTED','INSTALLED_PRIVATE_OWNER_REQUIRED','INSTALLED_REPARSE_REJECTED','Access is denied')){
    $global:preCopyAclFailure=$failure;Refused {Get-MigrationPreCopyIncident $release $previous} ([regex]::Escape($failure))
};$global:preCopyAclFailure=''
$script:badAncestor=$true;Refused {Get-MigrationPreCopyIncident $release $previous} 'Access is denied';$script:badAncestor=$false
$oldAcl=$acl;$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetSecurityDescriptorSddlForm('O:S-1-5-21-1-2-3-1001G:S-1-5-21-1-2-3-1001D:P(A;;FR;;;S-1-5-21-1-2-3-1001)')
Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_ANCESTOR_CHANGED';$acl=$oldAcl
$operator.isAdmin=$true;Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_RELEASE_REJECTED';$operator.isAdmin=$false
$release.releaseId=$id;Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_RELEASE_REJECTED';$release.releaseId='fixture-successor'
$script:closureFailure='INSTALLED_CLOSURE_CHANGED';Refused {Get-MigrationPreCopyIncident $release $previous} 'INSTALLED_CLOSURE_CHANGED';$script:closureFailure=''
$settingsPath=Join-Path $release.legacyWorkspaceRoot 'codex_bridge\.local\tray-settings.json'
$hashes[$settingsPath]='bad';Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_SELECTION_CHANGED';$hashes.Remove($settingsPath)
foreach($path in @((Join-Path $ccBackup 'startup.lnk'),(Join-Path $bridgeBackup 'tray-settings.json'))){
    $hashes[$path]='bad';Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_SELECTION_CHANGED';$hashes.Remove($path)
}
$release.cutover.legacyStartupSha256='bad';Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_SELECTION_CHANGED';$release.cutover.legacyStartupSha256='c'*64
$documents[$recoveryPath]=@{changed=$true};Refused {Get-MigrationPreCopyIncident $release $previous} 'MIGRATION_INCIDENT_ACL_RECOVERY_CHANGED';$documents[$recoveryPath]=$historicalPlan

# Successor's own stopped receipt is allowed only in its exact new directory;
# the historical evidence digest stays the same and its bytes are never copied.
$successor=[pscustomobject]@{releaseId=$release.releaseId;ccBackup=(Join-Path (Split-Path -Parent $ccBackup) $release.releaseId);bridgeBackup=(Join-Path $bridgeParent $release.releaseId)}
$ccRows=$baseCc+@((Row ('migration-backups\'+$release.releaseId) $true),(Row ('migration-backups\'+$release.releaseId+'\migration.json') $false),(Row ('migration-backups\'+$release.releaseId+'\startup.lnk') $false))
$bridgeRows=$baseBridge+@((Row $release.releaseId $true),(Row ($release.releaseId+'\tray-settings.json') $false))
$resumed=Get-MigrationPreCopyIncident $release $previous $successor
Check ((Get-StatePlanHash $resumed) -ceq (Get-StatePlanHash $evidence)) 'Successor does not rewrite or adopt incident'
$ccRows=$baseCc;$bridgeRows=$baseBridge

# Actual fresh-baseline logic, real Get-Health validation, synthetic canonical IO.
$script:health=[pscustomobject]@{ok=$true;service='codex-handoff-bridge';buildId='572021d0a632127d';pid=700;controller='ready';jobs=@{scope='all';total=520;active=0;awaitingApproval=0}}
$script:dataDigest='fresh-data';$script:ownerFailure='';$script:storeFailure='';$script:journalLength=42
function Invoke-RestMethod {return $script:health}
function Invoke-Controller {return [pscustomobject]@{after=@{tunnel=@{pid=701}}}}
function Assert-OwnedReady {if($script:ownerFailure){throw $script:ownerFailure}}
function Assert-RemoteReceiptsTerminal {}
function Assert-HttpAuthentication {if($script:storeFailure){throw $script:storeFailure}}
function Get-Process {return [pscustomobject]@{StartTime=[DateTime]'2026-10-23T00:00:00Z'}}
function Get-Item {
    param($LiteralPath,$Stream)
    if($Stream){return [pscustomobject]@{Stream=':$DATA'}}
    return [pscustomobject]@{PSIsContainer=$false;Attributes=0;Length=$script:journalLength;CreationTimeUtc=[DateTime]'2026-10-23T00:00:00Z';LastWriteTimeUtc=[DateTime]'2026-10-23T00:00:00Z'}
}
$baseline=Get-MigrationFreshBaseline $release $previous
Check ($baseline.jobCount -eq 520 -and $baseline.oldCore.pid -eq 700 -and $baseline.oldTunnel.pid -eq 701) 'Current owner/job/process baseline'
foreach($field in @('active','awaitingApproval')){
    $health.jobs[$field]=1;Refused {Get-MigrationFreshBaseline $release $previous} 'ALL_JOBS_MUST_BE_TERMINAL';$health.jobs[$field]=0
}
$script:ownerFailure='OWNER_UNVERIFIED';Refused {Get-MigrationFreshBaseline $release $previous} 'OWNER_UNVERIFIED';$script:ownerFailure=''
$script:storeFailure='MIGRATION_STORE_NOT_OPEN';Refused {Get-MigrationFreshBaseline $release $previous} 'MIGRATION_STORE_NOT_OPEN';$script:storeFailure=''
$health.jobs.total=$null;Refused {Get-MigrationFreshBaseline $release $previous} 'MIGRATION_JOB_BASELINE_UNKNOWN';$health.jobs.total=520
$plan=Get-RuntimeMigrationPlan $release $previous -RecoverR15PreCopy
$ExpectedPlanHash=Get-StatePlanHash $plan
$hashGuard=$ast.Find({param($n)$n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text -like '*if($ExpectedPlanHash -cne $hash)*' -and $n.Extent.Text.Length -lt 200},$true)
Check ($null -ne $hashGuard) 'Actual pre-mutation Plan hash guard exists'
$guard=[scriptblock]::Create($hashGuard.Extent.Text)
$hash=$ExpectedPlanHash;& $guard;Check $true 'Unchanged fresh plan accepted'
$script:dataDigest='drift';$hash=Get-StatePlanHash (Get-RuntimeMigrationPlan $release $previous -RecoverR15PreCopy)
Refused {& $guard} 'STATE_PLAN_CHANGED_NO_MUTATION';$script:dataDigest='fresh-data'
$script:journalLength=43;$hash=Get-StatePlanHash (Get-RuntimeMigrationPlan $release $previous -RecoverR15PreCopy)
Refused {& $guard} 'STATE_PLAN_CHANGED_NO_MUTATION';$script:journalLength=42
$health.jobs.total=521;$hash=Get-StatePlanHash (Get-RuntimeMigrationPlan $release $previous -RecoverR15PreCopy)
Refused {& $guard} 'STATE_PLAN_CHANGED_NO_MUTATION';$health.jobs.total=520
$ExpectedPlanHash=$planPin;$hash=Get-StatePlanHash $plan
Refused {& $guard} 'STATE_PLAN_CHANGED_NO_MUTATION'
$receipt=[pscustomobject]@{jobCount=520;oldCore=$baseline.oldCore;oldTunnel=$baseline.oldTunnel;plan=@{baseline=$baseline};stoppedDataSha256=('a'*64)}
Assert-MigrationRecoveryStopBaseline $receipt;Check $true 'Fresh post-stop baseline accepted'
$receipt.jobCount=517;Refused {Assert-MigrationRecoveryStopBaseline $receipt} 'MIGRATION_BASELINE_CHANGED';$receipt.jobCount=520
$receipt.oldCore=@{pid=60024;startedUtc='historical'};Refused {Assert-MigrationRecoveryStopBaseline $receipt} 'MIGRATION_BASELINE_CHANGED';$receipt.oldCore=$baseline.oldCore
$receipt.stoppedDataSha256=$null;Refused {Assert-MigrationRecoveryStopBaseline $receipt} 'MIGRATION_BASELINE_CHANGED'

# Execute the actual failure-recording catch with an existing receipt and no
# mutation. It must only rethrow, including Plan/identity validation failures.
$invoke=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Invoke-InstalledRuntimeMigration'},$true)
$assignment=$invoke.Find({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$receipt' -and $n.Right.Extent.Text.Contains("phase='STOPPING'")},$true)
$before=Invoke-Controller;$hash=Get-StatePlanHash $plan
. ([scriptblock]::Create($assignment.Extent.Text))
Check ($receipt.jobCount -eq 520 -and $receipt.oldCore.pid -eq 700 -and $receipt.oldTunnel.pid -eq 701) 'Actual successor receipt captures current health and processes'
$receipt|Add-Member NoteProperty stoppedDataSha256 ('a'*64)
Assert-MigrationRecoveryStopBaseline $receipt;Check $true 'Actual new receipt agrees with fresh plan'
$stoppedGuard=$invoke.Find({param($n)$n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.Contains("throw 'MIGRATION_STOPPED_DATA_CHANGED'") -and $n.Extent.Text.Length -lt 260},$true)
Check ($null -ne $stoppedGuard) 'Post-stop source drift guard exists'
function Get-MigrationTree {return @(@{sha256='post-stop-drift'})}
Refused {& ([scriptblock]::Create($stoppedGuard.Extent.Text))} 'MIGRATION_STOPPED_DATA_CHANGED'
$sourceGuard=$invoke.Find({param($n)$n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text -ceq "if((Get-StatePlanHash `$rows) -cne `$stoppedHash){throw 'MIGRATION_STOPPED_SOURCE_CHANGED'}"},$true)
$rows=@(@{sha256='owner-or-data-drift'});$stoppedHash='sealed-baseline'
Refused {& ([scriptblock]::Create($sourceGuard.Extent.Text))} 'MIGRATION_STOPPED_SOURCE_CHANGED'
$catch=$invoke.Find({param($n)$n -is [Management.Automation.Language.CatchClauseAst] -and $n.Extent.Text.Contains('$mutationStarted')},$true)
$mutationStarted=$false;$script:writes=0
function Write-Receipt { $script:writes++;throw 'UNEXPECTED_WRITE' }
$catchProbe=[scriptblock]::Create('try {throw "FIXTURE_PLAN_REJECTED"} '+$catch.Extent.Text)
Refused {& $catchProbe} 'FIXTURE_PLAN_REJECTED'
Check ($script:writes -eq 0) 'Read-only failure cannot rewrite any receipt'
$phaseGuard=$invoke.Find({param($n)$n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text -ceq "if(`$receipt.phase -cne 'STOPPED_EXIT_TRAY'){throw 'MIGRATION_PHASE_REJECTED_NO_RETRY'}"},$true)
$receipt.phase='UNKNOWN';Refused {& ([scriptblock]::Create($phaseGuard.Extent.Text))} 'MIGRATION_PHASE_REJECTED_NO_RETRY'
Check ($operatorAst.Extent.Text.Contains("'check-migration-approvals.mjs'")) 'Checker allowlist retained'
Check ($operatorAst.Extent.Text.Contains('-RecoverR15PreCopy:$RecoverR15PreCopy')) 'Existing operator routes bounded option'
[pscustomobject]@{ok=$true;checks=$checks;scope='synthetic function and guard fixtures';productionTouched=$false;lifecycleRun=$false;aclWrites=0;receiptWrites=$script:writes}|ConvertTo-Json
