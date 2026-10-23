Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$utf8=New-Object Text.UTF8Encoding($false);$checks=0
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message};$script:checks++}
function Refused([scriptblock]$Body,[string]$Code){$actual='';try{& $Body|Out-Null}catch{$actual=$_.Exception.Message};Check ($actual -match $Code) "Expected $Code; got $actual"}
$tokens=$null;$errors=$null
$path=Join-Path $workspace 'codex_bridge\scripts\installed-runtime-migration.ps1'
$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
Check ($errors.Count -eq 0) 'Migration syntax'
. $path
$operatorAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $workspace 'codex_bridge\scripts\installed-release-operator.ps1'),[ref]$tokens,[ref]$errors)
Check ($errors.Count -eq 0) 'Operator syntax'
foreach($name in @('Get-StatePlanHash')){
    $node=@($operatorAst.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
    . ([scriptblock]::Create($node[0].Extent.Text))
}
$module=Import-Module (Join-Path $workspace 'mcp_control_center\src\McpControlCenter.InstalledRelease.psm1') -PassThru
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$operator=[pscustomobject]@{sid=$owner}
$foreign=New-Object Security.Principal.SecurityIdentifier('S-1-5-21-100-200-300-1234')
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($owner)))
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($foreign,'Modify','ContainerInherit,ObjectInherit','None','Allow')))
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($foreign,'Read','None','None','Deny')))
$next=Get-MigrationAncestorAcl $acl $owner
$rules=@($next.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
Check ($next.AreAccessRulesProtected) 'Ancestor DACL is protected'
$own=@($rules|Where-Object {$_.IdentityReference.Value -ceq $owner -and $_.AccessControlType -eq 'Allow'})
Check ($own.Count -eq 1 -and $own[0].FileSystemRights.HasFlag([Security.AccessControl.FileSystemRights]::FullControl)) 'Operator still owns full access'
$deny=@($rules|Where-Object AccessControlType -eq Deny)
Check ($deny.Count -eq 1 -and $deny[0].IdentityReference.Value -ceq $foreign.Value -and $deny[0].FileSystemRights.HasFlag([Security.AccessControl.FileSystemRights]::Read)) 'Deny preserved'
$allows=@($rules|Where-Object {$_.IdentityReference.Value -ceq $foreign.Value -and $_.AccessControlType -eq 'Allow'})
Check (@($allows|Where-Object {$_.PropagationFlags.HasFlag([Security.AccessControl.PropagationFlags]::InheritOnly) -and $_.FileSystemRights.HasFlag([Security.AccessControl.FileSystemRights]::Modify)}).Count -eq 1) 'Source descendants retain Modify'
Check (@($allows|Where-Object {-not $_.PropagationFlags.HasFlag([Security.AccessControl.PropagationFlags]::InheritOnly) -and ($_.FileSystemRights -band ([Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete))}).Count -eq 0) 'Directory itself rejects foreign write/delete'
$release=[pscustomobject]@{schemaVersion=6;legacyWorkspaceRoot='C:\fixture-source';state=@{ownerRoot='C:\fixture-source\mcp_control_center\.local\runtime';dataDir='C:\fixture-source\codex_bridge\.local\runtime'}}
Check ((Get-McpCcInstalledStateRoot $release) -ceq $release.state.ownerRoot) 'v6 fixed owner'
$release.state.dataDir='C:\CodexBridge';Refused {Get-McpCcInstalledStateRoot $release} 'INSTALLED_STATE_SCOPE_REJECTED'
$release.schemaVersion=5;$release.state.ownerRoot='C:\McpControlCenter'
Check ((Get-McpCcInstalledStateRoot $release) -ceq 'C:\McpControlCenter') 'v5 remains compatible'
# Isolated content fixtures only. No live store or runtime action is invoked.
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('runtime-migration-'+[guid]::NewGuid().ToString('N'))
$source=Join-Path $fixture 'source';[void][IO.Directory]::CreateDirectory((Join-Path $source 'nested'))
[IO.File]::WriteAllText((Join-Path $source 'nested\歷史.json'),'preserved fixture',$utf8)
$verifier=$module
$rows=Get-MigrationTree $source
Check ($rows.Count -eq 3) 'All directories/files included'
Check ((Get-MigrationTreeBytes $source) -eq 17) 'Live sizing needs metadata only'
Assert-MigrationTree $source $rows;Check $true 'Exact content inventory'
[IO.File]::WriteAllText((Join-Path $source 'nested\extra.json'),'unknown',$utf8)
Refused {Assert-MigrationTree $source $rows} 'MIGRATION_CONTENT_CHANGED'
Refused {Remove-MigrationVerifiedTree $source $rows} 'MIGRATION_DELETE_SCOPE_REJECTED'
$locked=Join-Path $source 'journal.jsonl'
$handle=[IO.File]::Open($locked,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{Check ((Get-MigrationTreeBytes $source) -eq 24) 'Sizing does not open a locked journal'
    $without=Get-MigrationTree $source -ExcludeRelative @('journal.jsonl')
    Check (@($without|Where-Object relative -eq 'journal.jsonl').Count -eq 0) 'Live verification excludes the locked journal explicitly'
}finally{$handle.Dispose()}
# Copy runs against disposable fixture directories. Only ancestor trust is
# synthetic; content hashing, ACL transformation/write/readback are real NTFS IO.
$verifier=New-Module -ArgumentList $module {
    param($actual)
    $script:actual=$actual
    function Assert-McpCcNoReparseChain($p){& $script:actual {param($path) Assert-McpCcNoReparseChain $path} $p}
    function Get-McpCcInstalledPrivateAcl($a,$s,$d,$extra){& $script:actual {param($acl,$sid,$dir,$deny) Get-McpCcInstalledPrivateAcl $acl $sid $dir $deny} $a $s $d $extra}
    function Test-McpCcInstalledAclWrite($a,$b){& $script:actual {param($actual,$expected) Test-McpCcInstalledAclWrite $actual $expected} $a $b}
    function Assert-McpCcInstalledPrivateTree($p,$s){}
}
$rows=Get-MigrationTree $source
$target=Join-Path $fixture 'copied'
Copy-MigrationTree $source $target $rows
Check ((Get-MigrationContentHash (Get-MigrationTree $target)) -ceq (Get-MigrationContentHash $rows)) 'Exact byte/tree copy verified'
Check ((Get-Acl -LiteralPath $target).AreAccessRulesProtected) 'Copy root protects inherited private data'
Refused {Copy-MigrationTree $source $target $rows} 'MIGRATION_DESTINATION_EXISTS'
[IO.File]::WriteAllText((Join-Path $source 'nested\歷史.json'),'changed',$utf8)
Refused {Copy-MigrationTree $source (Join-Path $fixture 'must-not-exist') $rows} 'MIGRATION_CONTENT_CHANGED'
Check (-not(Test-Path -LiteralPath (Join-Path $fixture 'must-not-exist'))) 'Changed source is rejected before destination creation'
$verifier=$module
$legacy=Join-Path $fixture 'legacy';$managerFixture=Join-Path $fixture 'release-a\mcp_control_center'
[void][IO.Directory]::CreateDirectory($legacy);[void][IO.Directory]::CreateDirectory((Join-Path $managerFixture 'config'))
$manifest=[ordered]@{contract='mcpcc-installed-release-v6';schemaVersion=6;releaseId='release-a';legacyWorkspaceRoot=$legacy;
    dependencies=@{node=('a'*64);tunnelClient=('a'*64);keyStore=('a'*64);codexLauncher=('a'*64);codexNative=('a'*64);releaseVerifier=('a'*64)};
    treeHashes=@{mcp_control_center=('a'*64);codex_bridge=('a'*64);dependencies=('a'*64)};
    state=@{operatorSid=$owner;userProfile='C:\fixture-user';localAppData='C:\fixture-user\AppData\Local';codexHome='C:\fixture-user\.codex';projectsFile=(Join-Path $legacy 'codex_bridge\.local\projects.json');ownerRoot=(Join-Path $legacy 'mcp_control_center\.local\runtime');dataDir=(Join-Path $legacy 'codex_bridge\.local\runtime')};
    cutover=@{httpTokenSha256='';tunnelProfileSha256=('a'*64);rollbackBuildId=('a'*16);legacyStartupSha256=('a'*64)};
    deployment=@{contract='bridge-private-snapshot-v1';projectsSha256=('a'*64);credentialSha256=('a'*64)}}
$manifestPath=Join-Path $managerFixture 'config\installed-release.json'
[IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 8),$utf8)
$parsed=Read-McpCcInstalledRelease $managerFixture
Check ($parsed.schemaVersion -eq 6 -and -not $parsed.activationReady) 'v6 manifest parsed without granting runtime activation'
$manifest.state.ownerRoot='C:\McpControlCenter';[IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 8),$utf8)
Refused {Read-McpCcInstalledRelease $managerFixture} 'INSTALLED_STATE_SCOPE_REJECTED'
$manager='C:\untrusted-source\mcp_control_center'
Refused {Invoke-InstalledRuntimeMigration -Verb MigrationApply -TargetReleaseRoot (Split-Path -Parent $managerFixture)} 'MIGRATION_USE_INSTALLED_OPERATOR'
$approval=Join-Path $fixture 'approval-fixture'
[void][IO.Directory]::CreateDirectory((Join-Path $approval 'powershell-approval'))
$journal=Join-Path $approval 'powershell-approval\receipts.jsonl'
[IO.File]::WriteAllText($journal,'{"receipt":{"request":{"requestId":"fixture"},"state":"PENDING"}}'+"`n",$utf8)
# Valid Review/Production journals and TTL boundaries are covered by migration-approvals.test.mjs.
Refused {Assert-MigrationApprovalsIdle $approval (Get-Command node.exe).Source} 'MIGRATION_JOURNAL_INVALID'
Import-Module (Join-Path $workspace 'mcp_control_center\src\McpControlCenter.Core.psm1') -Force
$sourceManifest=[pscustomobject]@{workspaceRoot=$workspace;schemaVersion=3}
Refused {Assert-McpCcRuntimeRoot $sourceManifest (Join-Path $workspace 'mcp_control_center\.local\runtime')} 'outside the source workspace'
Assert-McpCcRuntimeRoot $sourceManifest (Join-Path $fixture 'outside-owner');Check $true 'Existing external source owner remains valid'
[pscustomobject]@{ok=$true;checks=$checks;scope='offline ACL and content fixtures';fixture=$fixture;runtimeTouched=$false}|ConvertTo-Json
