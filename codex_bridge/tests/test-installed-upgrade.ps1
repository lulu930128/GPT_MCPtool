Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('installed-upgrade-'+[guid]::NewGuid().ToString('N'))
$utf8=New-Object Text.UTF8Encoding($false)
$checks=0
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message};$script:checks++}
function Refused([scriptblock]$Body,[string]$Code){$message='';try{& $Body|Out-Null}catch{$message=$_.Exception.Message};Check ($message -ceq $Code) "Expected $Code; got $message"}
function Put([string]$Path,$Value){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 8),$utf8)}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $workspace 'codex_bridge\scripts\installed-release-operator.ps1'),[ref]$tokens,[ref]$errors)
Check ($errors.Count -eq 0) 'Operator syntax'
foreach($name in @('Get-InstalledUpgradeState','Get-StateBindingPlan','Get-StatePlanHash','Read-BoundedJson','Get-CutoverBaselineRoot','Assert-OwnerMigrationSourceUnchanged')){
    $nodes=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
    Check ($nodes.Count -eq 1) ('Unique function '+$name)
    . ([scriptblock]::Create($nodes[0].Extent.Text))
}
# Only fixture bytes are read. OS ACL/selection observations are synthetic;
# lifecycle entrypoints, live stores, migration and existing ACL writes are forbidden.
$verifier=New-Module {
    function Assert-McpCcNoReparseChain {param($p)}
    function Assert-McpCcInstalledPrivateTree {param($p,$s)}
    function Assert-McpCcInstalledPrivatePath {param($p,$s,[switch]$IntegrityOnly)}
    function Assert-McpCcInstalledStateReceipt {param($p,$s)}
    function Get-McpCcInstalledDeploymentFiles {param($r,$p)
        @('projects.json','.tunnel-client\codex-bridge.yaml','.secrets\control-plane-api-key.dpapi')|ForEach-Object{
            [pscustomobject]@{source='C:\never-read-source';target=(Join-Path $p ('deployment\'+$_));sha256=$r.fixtureHash;limit=65536}
        }
    }
}
function Get-OwnerMigrationPlan {throw 'UPGRADE_MUST_NOT_MIGRATE'}
function Set-Acl {throw 'UPGRADE_MUST_NOT_CHANGE_EXISTING_ACL'}
function Invoke-Controller {throw 'FIXTURE_MUST_NOT_DISPATCH'}
function Get-McpCcInstalledStateRoot {param($r) Join-Path $fixture 'owner'}
function Read-McpCcInstalledRelease {param($p) $script:previous}
function Assert-McpCcInstalledClosure {param($r) $script:closureChecks++}
function Assert-InstalledUpgradeSelection {param($r) if(-not $script:selected){throw 'UPGRADE_STARTUP_NOT_SELECTED'}; 'a'*64}
$closureChecks=0;$selected=$true
$operator=[pscustomobject]@{sid='S-1-5-21-100-200-300-1001';userProfile='C:\fixture-user';localAppData='C:\fixture-user\AppData\Local'}
$state=[ordered]@{operatorSid=$operator.sid;userProfile=$operator.userProfile;localAppData=$operator.localAppData;
    ownerRoot='C:\McpControlCenter';dataDir='C:\CodexBridge';codexHome='C:\fixture-user\.codex';projectsFile='C:\fixture-source\codex_bridge\.local\projects.json'}
$previous=[pscustomobject]@{schemaVersion=5;releaseId='old';root=(Join-Path $fixture 'old');legacyWorkspaceRoot='C:\fixture-source';
    sourcePath=(Join-Path $fixture 'old\manifest.json');state=[pscustomobject]$state;
    deployment=@{projectsSha256=('b'*64);credentialSha256=('c'*64)};cutover=@{tunnelProfileSha256=('d'*64);httpTokenSha256=''}}
$release=$previous|ConvertTo-Json -Depth 8|ConvertFrom-Json
$release.releaseId='new';$release.root=Join-Path $fixture 'new';$release.sourcePath=Join-Path $fixture 'new\manifest.json'
$release.cutover|Add-Member NoteProperty legacyStartupSha256 ('a'*64)
$owner=Get-McpCcInstalledStateRoot $release
$oldRuntime=Join-Path $owner 'installed-bridge\old';$newRuntime=Join-Path $owner 'installed-bridge\new'
Put $previous.sourcePath @{fixture='old'};Put $release.sourcePath @{fixture='new'}
$oldPlan=[ordered]@{releaseId='old';manifestSha256=(Get-FileHash -LiteralPath $previous.sourcePath).Hash.ToLowerInvariant();migration=@{historical='never re-read'}}
Put (Join-Path $oldRuntime 'state-acl-before.json') $oldPlan
Put (Join-Path $oldRuntime 'state-binding.json') @{phase='STATE_BOUND';planSha256=(Get-StatePlanHash $oldPlan)}
$accepted=[ordered]@{contract='mcpcc-installed-cutover-v1';phase='LOCAL_ACCEPTED';releaseId='old';operatorSid=$operator.sid;newPid=1}
Put (Join-Path $oldRuntime 'operator-cutover.json') $accepted
$reuse=Get-InstalledUpgradeState $release $previous.root -RequireSelected
Check ($reuse.contract -ceq 'installed-active-state-reuse-v1' -and $closureChecks -eq 1) 'Upgrade verifies protected prior release'
Check ($reuse.releaseRoot -ceq $previous.root) 'Prior installed root is retained'
$selected=$false;Refused {Get-InstalledUpgradeState $release $previous.root -RequireSelected} 'UPGRADE_STARTUP_NOT_SELECTED';$selected=$true
$release.state.dataDir='C:\wrong';Refused {Get-InstalledUpgradeState $release $previous.root} 'UPGRADE_STATE_SCOPE_CHANGED';$release.state.dataDir='C:\CodexBridge'
$release.deployment.credentialSha256='f'*64;Refused {Get-InstalledUpgradeState $release $previous.root} 'UPGRADE_CONFIGURATION_CHANGED';$release.deployment.credentialSha256='c'*64
$accepted.phase='UNKNOWN';Put (Join-Path $oldRuntime 'operator-cutover.json') $accepted
Refused {Get-InstalledUpgradeState $release $previous.root} 'UPGRADE_PREVIOUS_NOT_ACCEPTED'
$accepted.phase='LOCAL_ACCEPTED';Put (Join-Path $oldRuntime 'operator-cutover.json') $accepted
Put (Join-Path $oldRuntime 'state-binding.json') @{phase='STATE_BOUND';planSha256=('0'*64)}
Refused {Get-InstalledUpgradeState $release $previous.root} 'UPGRADE_STATE_PLAN_CHANGED'
Put (Join-Path $oldRuntime 'state-binding.json') @{phase='STATE_BOUND';planSha256=(Get-StatePlanHash $oldPlan)}
foreach($name in @('projects.json','.tunnel-client\codex-bridge.yaml','.secrets\control-plane-api-key.dpapi')){
    Put (Join-Path $oldRuntime ('deployment\'+$name)) @{fixture='synthetic snapshot'}
}
$release|Add-Member NoteProperty fixtureHash (Get-FileHash -LiteralPath (Join-Path $oldRuntime 'deployment\projects.json')).Hash.ToLowerInvariant()
$plan=Get-StateBindingPlan $release -UpgradeRoot $previous.root
Check ($null -eq $plan.migration -and $plan.entries.Count -eq 0) 'Upgrade has no migration or existing ACL mutation'
Check ($plan.files.Count -eq 3 -and @($plan.files|Where-Object{-not $_.source.StartsWith($oldRuntime+'\deployment\')}).Count -eq 0) 'Use prior private snapshots, never source copies'
Put (Join-Path $newRuntime 'state-acl-before.json') $plan
Put (Join-Path $newRuntime 'state-binding.json') @{planSha256=(Get-StatePlanHash $plan)}
Check ((Get-CutoverBaselineRoot $release $newRuntime) -ceq $previous.root) 'Cutover and rollback select previous installed controller'
Assert-OwnerMigrationSourceUnchanged $release $newRuntime
Check $true 'Upgrade validation does not inspect obsolete source state'
Put (Join-Path $newRuntime 'state-binding.json') @{planSha256=('0'*64)}
Refused {Get-CutoverBaselineRoot $release $newRuntime} 'CUTOVER_STATE_PLAN_CHANGED'
Put (Join-Path $newRuntime 'state-binding.json') @{planSha256=(Get-StatePlanHash $plan)}
$accepted.newPid=2;Put (Join-Path $oldRuntime 'operator-cutover.json') $accepted
Refused {Get-CutoverBaselineRoot $release $newRuntime} 'UPGRADE_BASELINE_CHANGED'
# Component-owned v6 upgrades retain the same active stores and snapshots. They
# must not reuse the one-time v5 migration or fall back to a source controller.
$previous.schemaVersion=6;$release.schemaVersion=6
foreach($r in @($previous,$release)){
    $r.state.ownerRoot='C:\fixture-source\mcp_control_center\.local\runtime'
    $r.state.dataDir='C:\fixture-source\codex_bridge\.local\runtime'
}
$v6=Get-StateBindingPlan $release -UpgradeRoot $previous.root
Check ($null -eq $v6.migration -and $v6.entries.Count -eq 0) 'v6 upgrade retains canonical state without ACL mutations'
Check ($v6.ownerReuse.releaseRoot -ceq $previous.root -and $v6.files.Count -eq 3) 'v6 reuses protected deployment snapshots'
Put (Join-Path $newRuntime 'state-acl-before.json') $v6
Put (Join-Path $newRuntime 'state-binding.json') @{planSha256=(Get-StatePlanHash $v6)}
Check ((Get-CutoverBaselineRoot $release $newRuntime) -ceq $previous.root) 'v6 next release uses installed baseline'
Assert-OwnerMigrationSourceUnchanged $release $newRuntime
Refused {Get-StateBindingPlan $release} 'MIGRATION_OR_V6_UPGRADE_REQUIRED'
$previous.schemaVersion=5;Refused {Get-InstalledUpgradeState $release $previous.root} 'UPGRADE_RELEASE_REJECTED';$previous.schemaVersion=6
$initial=[ordered]@{releaseId='new';manifestSha256=(Get-FileHash -LiteralPath $release.sourcePath).Hash.ToLowerInvariant();migrationReceipt='fixture-only'}
Put (Join-Path $newRuntime 'state-acl-before.json') $initial
Put (Join-Path $newRuntime 'state-binding.json') @{planSha256=(Get-StatePlanHash $initial)}
Refused {Get-CutoverBaselineRoot $release $newRuntime} 'MIGRATION_USE_MIGRATION_ACTIONS'
[pscustomobject]@{ok=$true;checks=$checks;scope='source fixture only';fixture=$fixture;runtimeTouched=$false}|ConvertTo-Json
