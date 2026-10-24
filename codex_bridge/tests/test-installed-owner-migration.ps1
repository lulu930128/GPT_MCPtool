Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$base=Join-Path $workspace 'codex_bridge\.tmp'
$fixture=Join-Path $base ('owner-migration-'+[guid]::NewGuid().ToString('N'))
$utf8=New-Object Text.UTF8Encoding($false)
$checks=0;$verifier=$null;$core=$null
$previousModules=$env:PSModulePath
$previousOverride=[Environment]::GetEnvironmentVariable('MCP_CONTROL_CENTER_DATA_DIR','Process')
function Check([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
function Refused([scriptblock]$Body,[string]$Code){$message='';try{& $Body|Out-Null}catch{$message=$_.Exception.Message};Check ($message -match $Code) "Expected $Code; got $message"}
function Put([string]$Path,[string]$Text){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,$Text,$utf8)}
function Import-Function($Ast,[string]$Name){
    $matches=@($Ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $Name},$true))
    if($matches.Count -ne 1){throw 'SOURCE_FUNCTION_NOT_UNIQUE'}
    return [scriptblock]::Create($matches[0].Extent.Text)
}
try {
    $manager=Join-Path $fixture 'manager'
    $modulePath=Join-Path $manager 'src\McpControlCenter.InstalledRelease.psm1'
    Put $modulePath ([IO.File]::ReadAllText((Join-Path $workspace 'mcp_control_center\src\McpControlCenter.InstalledRelease.psm1')))
    $verifier=Import-Module $modulePath -Force -PassThru
    $sid='S-1-5-21-100-200-300-1001'
    $local=Join-Path $fixture 'local';$source=Join-Path $local 'McpControlCenter'
    $operator=[pscustomobject]@{sid=$sid;localAppData=$local}
    $release=[pscustomobject]@{schemaVersion=5;releaseId='fixture-r5';state=@{localAppData=$local;ownerRoot='C:\McpControlCenter'}}
    Put (Join-Path $source 'state.json') '{"fixture":true}'
    Put (Join-Path $source 'tray.pid') '12345'
    Put (Join-Path $source 'events\old.jsonl') '{"fixture":"history"}'
    # ACL observations/writes are synthetic. File IO and the production copy,
    # hash, journal, inventory and stop-on-partial-failure code run unchanged.
    & $verifier {
        param($s,$root)
        $script:sid=$s;$script:sourceRoot=$root;$script:acls=@{};$script:writes=New-Object 'Collections.Generic.List[object]'
        function script:Get-Acl {param($LiteralPath)
            $directory=[IO.Directory]::Exists($LiteralPath)
            $acl=if($directory){New-Object Security.AccessControl.DirectorySecurity}else{New-Object Security.AccessControl.FileSecurity}
            if($script:acls.ContainsKey($LiteralPath)){$acl.SetSecurityDescriptorSddlForm($script:acls[$LiteralPath]);return $acl}
            $flags=if($directory){'OICI'}else{''}
            $deny=if($LiteralPath -ieq $script:sourceRoot -or $LiteralPath.StartsWith($script:sourceRoot+'\',[StringComparison]::OrdinalIgnoreCase)){'S-1-5-21-100-200-300-1007'}else{'S-1-5-21-100-200-300-1008'}
            $acl.SetSecurityDescriptorSddlForm("O:$($script:sid)G:SYD:(D;$flags;FW;;;$deny)(A;;FA;;;$($script:sid))")
            return $acl
        }
        function script:Set-FixtureAcl($Path,$Acl){
            if($Path -ieq $script:sourceRoot -or $Path.StartsWith($script:sourceRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'SOURCE_ACL_MUTATION_FORBIDDEN'}
            $size=if([IO.File]::Exists($Path)){(Get-Item -LiteralPath $Path).Length}else{-1}
            $script:writes.Add([pscustomobject]@{path=$Path;length=$size})
            # Match the observed Windows writeback metadata; all ACE bytes stay
            # unchanged. The actual NTFS roundtrip has its own isolated test.
            $raw=New-Object Security.AccessControl.RawSecurityDescriptor($Acl.GetSecurityDescriptorSddlForm('All'))
            $raw.SetFlags([Security.AccessControl.ControlFlags]([int]$raw.ControlFlags -bor [int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited))
            $script:acls[$Path]=$raw.GetSddlForm('All')
        }
    } $sid $source
    function Get-Acl {param($LiteralPath) & $verifier {param($p)Get-Acl -LiteralPath $p} $LiteralPath}
    function Set-Acl {param($LiteralPath,$AclObject)
        if(-not $LiteralPath.StartsWith($fixture+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'FIXTURE_WRITE_ESCAPE'}
        & $verifier {param($p,$a)Set-FixtureAcl $p $a} $LiteralPath $AclObject
    }
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $workspace 'codex_bridge\scripts\installed-release-operator.ps1'),[ref]$tokens,[ref]$errors)
    Check ($errors.Count -eq 0) 'Operator must parse'
    foreach($name in @('Test-InstalledStateManifest','Get-OwnerMigrationPlan','Copy-OwnerMigrationEntry','Assert-OwnerMigrationSourceUnchanged','Get-StatePlanHash','Read-BoundedJson','Write-Receipt','New-StateDirectory','Invoke-StateBinding','Get-InactiveBoundState','Get-VerifiedStateRecovery','Copy-StateSnapshot')){. (Import-Function $ast $name)}
    $inventory=Get-OwnerMigrationPlan $release
    Check ($inventory.source -ceq $source -and $inventory.target -ceq 'C:\McpControlCenter' -and $inventory.entries.Count -eq 5) 'Inventory must have one source and one fixed destination'
    Check ($inventory.entries[0].relative -ceq '' -and $inventory.bytes -gt 0) 'Parents must precede descendants'
    $release.state.ownerRoot='C:\other'
    Refused {Get-OwnerMigrationPlan $release} 'INSTALLED_STATE_SCOPE_REJECTED'
    $release.state.ownerRoot='C:\McpControlCenter'
    $saved=Join-Path $fixture 'review'
    Put (Join-Path $saved 'state-acl-before.json') (@{migration=$inventory}|ConvertTo-Json -Depth 8)
    Assert-OwnerMigrationSourceUnchanged $release $saved
    Check $true 'Unchanged source inventory must verify'
    Put (Join-Path $source 'state.json') '{"fixture":"changed"}'
    Refused {Assert-OwnerMigrationSourceUnchanged $release $saved} 'LEGACY_OWNER_STATE_CHANGED'
    Put (Join-Path $source 'state.json') '{"fixture":true}'
    $target=Join-Path $fixture 'copy'
    foreach($row in $inventory.entries){Copy-OwnerMigrationEntry $row $source $target}
    Check ((Get-FileHash -LiteralPath (Join-Path $target 'state.json')).Hash -ceq (Get-FileHash -LiteralPath (Join-Path $source 'state.json')).Hash) 'Copied bytes must match reviewed source'
    $writes=@(& $verifier {$script:writes})
    Check (@($writes|Where-Object{$_.length -gt 0}).Count -eq 0) 'Deny must be applied before any copied file bytes'
    $rules=(Get-Acl -LiteralPath (Join-Path $target 'state.json')).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
    Check (@($rules|Where-Object{$_.AccessControlType -eq 'Deny'}).Count -eq 2) 'Both destination and source Deny must remain'
    $stateRow=@($inventory.entries|Where-Object{$_.relative -ceq 'state.json'})[0]
    $failure=$null
    try{Copy-OwnerMigrationEntry $stateRow $source $target}catch{$failure=$_.Exception;while($failure.InnerException){$failure=$failure.InnerException}}
    Check ($failure -is [IO.IOException]) 'Existing destination must never be overwritten'
    $badRow=$stateRow|Select-Object *;$badRow.relative='..\escape'
    Refused {Copy-OwnerMigrationEntry $badRow $source $target} 'OWNER_MIGRATION_PATH_REJECTED'
    $badRow=$stateRow|Select-Object *;$badRow.sha256='0'*64
    $empty=Join-Path $fixture 'bad-copy';[void][IO.Directory]::CreateDirectory($empty)
    Refused {Copy-OwnerMigrationEntry $badRow $source $empty} 'OWNER_SOURCE_CONTENT_CHANGED'
    Check (-not(Test-Path -LiteralPath (Join-Path $empty 'state.json'))) 'Source digest failure must precede destination creation'
    $badRow=$stateRow|Select-Object *;$badRow.acl='changed'
    Refused {Copy-OwnerMigrationEntry $badRow $source $empty} 'OWNER_SOURCE_ACL_CHANGED'

    # Exercise the real binding transaction in an isolated layout. The reviewed
    # plan, closure/activation and terminal-receipt checks are explicit fixtures.
    # No controller, real Store, live ACL, Host or runner is invoked.
    $script:owner=Join-Path $fixture 'bound'
    $script:plan=[pscustomobject]@{roots=@($script:owner);entries=@();files=@();migration=$inventory}
    function Get-McpCcInstalledStateRoot {param($Release) $script:owner}
    function Get-StateBindingPlan {param($Release) $script:plan}
    function Get-OwnerMigrationPlan {param($Release) $inventory}
    function Get-McpCcInstalledBridgeBinding {param($Root) [pscustomobject]@{fixture=$true}}
    $script:terminalChecks=0
    function Assert-RemoteReceiptsTerminal {param($OwnerRoot)
        Check (Test-Path -LiteralPath (Join-Path $OwnerRoot 'tray.pid')) 'Backup must include the historical PID'
        Check (-not(Test-Path -LiteralPath (Join-Path $script:owner 'state.json'))) 'Terminal receipt gate must precede active state copy'
        $script:terminalChecks++
    }
    $release|Add-Member root (Join-Path $fixture 'code')
    Refused {Invoke-StateBinding $release ('0'*64)} 'STATE_PLAN_CHANGED_NO_MUTATION'
    Check (-not(Test-Path -LiteralPath $script:owner)) 'Plan mismatch must leave the destination absent'
    $result=Invoke-StateBinding $release (Get-StatePlanHash $script:plan)|ConvertFrom-Json
    $runtime=Join-Path $script:owner 'installed-bridge\fixture-r5'
    Check ($result.phase -ceq 'STATE_BOUND' -and $result.ownerMigrationPrepared -and -not $result.canonicalDataMoved) 'Binding reports preparation only; canonical data is not moved'
    Check ((Read-BoundedJson (Join-Path $runtime 'state-binding.json')).phase -ceq 'STATE_BOUND') 'Success must have a durable receipt'
    Check ((Test-Path -LiteralPath (Join-Path $runtime 'legacy-owner-backup\state.json')) -and (Test-Path -LiteralPath (Join-Path $script:owner 'state.json')) -and $script:terminalChecks -eq 1) 'Backup and active copy must both exist'
    Check (-not(Test-Path -LiteralPath (Join-Path $script:owner 'tray.pid'))) 'Old PID must not become active owner evidence'
    Check ((Get-FileHash -LiteralPath (Join-Path $source 'state.json')).Hash -ceq (Get-FileHash -LiteralPath (Join-Path $script:owner 'state.json')).Hash) 'Original owner state must be retained unchanged'
    Refused {Invoke-StateBinding $release (Get-StatePlanHash $script:plan)} 'STATE_BINDING_EXISTS_INSPECT_DO_NOT_RETRY'

    # A later inactive release reuses the same owner without another migration
    # or existing ACL rewrite. Closure and OS observations remain synthetic.
    $manifestPath=Join-Path $fixture 'previous-code\manifest.json';Put $manifestPath '{"fixture":"previous immutable manifest"}'
    $state=[pscustomobject]@{operatorSid=$sid;userProfile=$fixture;localAppData=$local;ownerRoot=$script:owner;dataDir=$script:owner;codexHome=(Join-Path $fixture 'home');projectsFile=(Join-Path $fixture 'projects.json')}
    $startupHash='a'*64
    $script:previousRelease=[pscustomobject]@{schemaVersion=5;releaseId='fixture-r5';root=(Join-Path $fixture 'previous-code');sourcePath=$manifestPath;
        legacyWorkspaceRoot=$fixture;state=$state;cutover=[pscustomobject]@{legacyStartupSha256=$startupHash}}
    $nextRelease=[pscustomobject]@{schemaVersion=5;releaseId='fixture-r7';root=(Join-Path $fixture 'next-code');legacyWorkspaceRoot=$fixture;
        state=($state|Select-Object *);cutover=[pscustomobject]@{legacyStartupSha256=$startupHash}}
    $startupPath=Join-Path ([Environment]::GetFolderPath('Startup')) 'MCP Control Center.lnk'
    $script:changedStartup=$false;$script:badClosure=$false
    function Get-FileHash {param($LiteralPath)
        if($LiteralPath -ieq $startupPath){return [pscustomobject]@{Hash=$(if($script:changedStartup){'b'*64}else{$startupHash})}}
        if(-not $LiteralPath.StartsWith($fixture+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'FIXTURE_READ_ESCAPE'}
        Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $LiteralPath
    }
    function Read-McpCcInstalledRelease {param($ManagerRoot) $script:previousRelease}
    function Assert-McpCcInstalledClosure {param($Release) if($script:badClosure){throw 'INSTALLED_TREE_HASH_MISMATCH'}}
    $boundPlan=[pscustomobject][ordered]@{releaseId='fixture-r5';manifestSha256=(Get-FileHash -LiteralPath $manifestPath).Hash.ToLowerInvariant();migration=$inventory}
    Put (Join-Path $runtime 'state-acl-before.json') ($boundPlan|ConvertTo-Json -Depth 8)
    Write-Receipt (Join-Path $runtime 'state-binding.json') @{contract='installed-state-binding-v1';phase='STATE_BOUND';planSha256=(Get-StatePlanHash $boundPlan);backup=(Join-Path $runtime 'state-acl-before.json')}
    $cutoverPath=Join-Path $runtime 'operator-cutover.json'
    $cutover=[pscustomobject]@{contract='mcpcc-installed-cutover-v1';releaseId='fixture-r5';operatorSid=$sid;phase='UNKNOWN';lastPhase='STOPPING_LEGACY';newPid=$null;newBuildId=$null;newTunnelPid=$null}
    Put $cutoverPath ($cutover|ConvertTo-Json)
    $priorReceiptHash=(Get-FileHash -LiteralPath (Join-Path $runtime 'state-binding.json')).Hash
    $priorCutoverHash=(Get-FileHash -LiteralPath $cutoverPath).Hash
    $reuse=Get-InactiveBoundState $nextRelease $script:previousRelease.root
    Check ($reuse.releaseId -ceq 'fixture-r5' -and $reuse.cutoverSha256 -ceq $priorCutoverHash.ToLowerInvariant()) 'Reuse must bind previous UNKNOWN bytes without changing its phase'
    $script:badClosure=$true;Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root} 'INSTALLED_TREE_HASH_MISMATCH';$script:badClosure=$false
    $nextRelease.state.dataDir='different';Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root} 'STATE_REUSE_SCOPE_CHANGED';$nextRelease.state.dataDir=$script:owner
    $script:changedStartup=$true;Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root} 'STATE_REUSE_STARTUP_SELECTED_OR_CHANGED';$script:changedStartup=$false
    foreach($phase in @('LOCAL_ACCEPTED','SELECTED','STOPPING_LEGACY')){
        $cutover.phase=$phase;Put $cutoverPath ($cutover|ConvertTo-Json)
        Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root} 'STATE_REUSE_CUTOVER_NOT_INACTIVE'
    }
    $cutover.phase='UNKNOWN';$cutover.newPid=999;Put $cutoverPath ($cutover|ConvertTo-Json)
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root} 'STATE_REUSE_CUTOVER_NOT_INACTIVE'
    $cutover.newPid=$null;Put $cutoverPath ($cutover|ConvertTo-Json)
    Put (Join-Path $script:owner 'state.json') '{"fixture":"changed active copy"}'
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root} 'STATE_REUSE_ACTIVE_COPY_CHANGED'
    Put (Join-Path $script:owner 'state.json') '{"fixture":true}'
    $boundPlan.manifestSha256='0'*64;Put (Join-Path $runtime 'state-acl-before.json') ($boundPlan|ConvertTo-Json -Depth 8)
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root} 'STATE_REUSE_PLAN_CHANGED'
    $boundPlan.manifestSha256=(Get-FileHash -LiteralPath $manifestPath).Hash.ToLowerInvariant();Put (Join-Path $runtime 'state-acl-before.json') ($boundPlan|ConvertTo-Json -Depth 8)
    $nextRuntime=Join-Path $script:owner 'installed-bridge\fixture-r7'
    $snapshot=Join-Path $fixture 'snapshot-source.json';Put $snapshot '{"fixture":"deployment"}'
    $file=[pscustomobject]@{source=$snapshot;target=(Join-Path $nextRuntime 'deployment\projects.json');sha256=(Get-FileHash -LiteralPath $snapshot).Hash.ToLowerInvariant();limit=65536}
    $script:plan=[pscustomobject]@{roots=@($script:owner);entries=@();files=@($file);migration=$inventory;ownerReuse=$reuse}
    $writesBefore=@(& $verifier {$script:writes}).Count
    function Copy-OwnerMigrationEntry {throw 'REUSE_MUST_NOT_COPY_OWNER_AGAIN'}
    $reused=Invoke-StateBinding $nextRelease (Get-StatePlanHash $script:plan) $script:previousRelease.root|ConvertFrom-Json
    Check ($reused.phase -ceq 'STATE_BOUND' -and $reused.ownerStateReused -and -not $reused.ownerMigrationPrepared -and $reused.aclEntries -eq 0) 'Reuse must report no repeated migration or existing ACL mutation'
    $newWrites=@(& $verifier {$script:writes})|Select-Object -Skip $writesBefore
    Check (@($newWrites|Where-Object{-not $_.path.StartsWith($nextRuntime,[StringComparison]::OrdinalIgnoreCase)}).Count -eq 0) 'Only new release directories may receive synthetic ACL writes'
    Check ((Get-FileHash -LiteralPath $file.target).Hash -ceq (Get-FileHash -LiteralPath $snapshot).Hash) 'New deployment snapshot must match reviewed bytes'
    Check ((Get-FileHash -LiteralPath $cutoverPath).Hash -ceq $priorCutoverHash -and (Get-FileHash -LiteralPath (Join-Path $runtime 'state-binding.json')).Hash -ceq $priorReceiptHash) 'Previous receipts must remain byte-identical'
    Refused {Invoke-StateBinding $nextRelease (Get-StatePlanHash $script:plan) $script:previousRelease.root} 'STATE_BINDING_EXISTS_INSPECT_DO_NOT_RETRY'
    $nextRelease.releaseId='fixture-r8';$file.target=Join-Path $script:owner 'installed-bridge\fixture-r8\deployment\projects.json'
    Put $snapshot 'changed before copy'
    Refused {Invoke-StateBinding $nextRelease (Get-StatePlanHash $script:plan) $script:previousRelease.root} 'DEPLOYMENT_SOURCE_CHANGED'
    Check ((Read-BoundedJson (Join-Path $script:owner 'installed-bridge\fixture-r8\state-binding.json')).phase -ceq 'UNKNOWN') 'Partial reuse must retain UNKNOWN'
    Refused {Invoke-StateBinding $nextRelease (Get-StatePlanHash $script:plan) $script:previousRelease.root} 'STATE_BINDING_EXISTS_INSPECT_DO_NOT_RETRY'
    . (Import-Function $ast 'Copy-OwnerMigrationEntry')
    $script:plan=[pscustomobject]@{roots=@($script:owner);entries=@();files=@();migration=$inventory}
    $script:owner=Join-Path $fixture 'partial';$script:plan.roots=@($script:owner)
    Put (Join-Path $source 'state.json') 'changed after review'
    Refused {Invoke-StateBinding $release (Get-StatePlanHash $script:plan)} 'OWNER_SOURCE_CONTENT_CHANGED'
    $partialRuntime=Join-Path $script:owner 'installed-bridge\fixture-r5'
    Check ((Read-BoundedJson (Join-Path $partialRuntime 'state-binding.json')).phase -ceq 'UNKNOWN') 'Partial copy must leave UNKNOWN'
    Check (-not(Test-Path -LiteralPath (Join-Path $script:owner 'state.json'))) 'Failed backup must not publish active copied state'
    Refused {Invoke-StateBinding $release (Get-StatePlanHash $script:plan)} 'STATE_BINDING_EXISTS_INSPECT_DO_NOT_RETRY'

    # Use the actual Core default-root function, with only its trust observations
    # stubbed. A selected release must not write back to the AppData default.
    $corePath=Join-Path $manager 'src\McpControlCenter.Core.psm1'
    Put $corePath ([IO.File]::ReadAllText((Join-Path $workspace 'mcp_control_center\src\McpControlCenter.Core.psm1')))
    Put (Join-Path $manager 'config\installed-release.json') '{}'
    $core=Import-Module $corePath -Force -PassThru
    & $core {
        $script:fixtureVersion=5;$script:bindingRefused=$false
        function script:Import-Module {param($Name)}
        function script:Read-McpCcInstalledRelease {param($ManagerRoot)[pscustomobject]@{schemaVersion=$script:fixtureVersion}}
        function script:Get-McpCcInstalledOwnerBinding {param($ManagerRoot)
            if($script:bindingRefused){throw 'INSTALLED_STATE_NOT_BOUND'}
            [pscustomobject]@{ownerRoot='C:\McpControlCenter'}
        }
    }
    [Environment]::SetEnvironmentVariable('MCP_CONTROL_CENTER_DATA_DIR',$null,'Process')
    Check ((Get-McpCcDefaultRuntimeRoot) -ceq 'C:\McpControlCenter') 'Installed Core must select the manifest-bound owner'
    [Environment]::SetEnvironmentVariable('MCP_CONTROL_CENTER_DATA_DIR',(Join-Path $fixture 'untrusted-override'),'Process')
    Refused {Get-McpCcDefaultRuntimeRoot} 'INSTALLED_CALLER_OVERRIDE_REJECTED'
    [Environment]::SetEnvironmentVariable('MCP_CONTROL_CENTER_DATA_DIR',$null,'Process')
    & $core {$script:bindingRefused=$true}
    Refused {Get-McpCcDefaultRuntimeRoot} 'INSTALLED_STATE_NOT_BOUND'
    & $core {$script:fixtureVersion=2}
    Check ((Get-McpCcDefaultRuntimeRoot) -ceq (Join-Path $env:LOCALAPPDATA 'McpControlCenter')) 'Older inert release inspection must remain available'
    # Recovery is a reviewed audit plus fresh controller/selection observations,
    # never permission inferred from a model-supplied success field. Only the CC
    # status cache may differ; every other migrated file retains exact parity.
    $script:owner=Join-Path $fixture 'bound'
    $nextRelease.releaseId='fixture-r9'
    $nextRelease.cutover|Add-Member NoteProperty rollbackBuildId '0123456789abcdef'
    $cutover.lastPhase='SELECTED'
    $cutover|Add-Member NoteProperty newStartTimeUtc $null
    $cutover|Add-Member NoteProperty newTunnelStartTimeUtc $null
    Put $cutoverPath ($cutover|ConvertTo-Json)
    $selectedCutoverHash=(Get-FileHash -LiteralPath $cutoverPath).Hash.ToLowerInvariant()
    Put (Join-Path $script:owner 'state.json') '{"fixture":"new status observation"}'
    $retainedStateHash=(Get-FileHash -LiteralPath (Join-Path $script:owner 'state.json')).Hash.ToLowerInvariant()
    $savedLink=Join-Path $fixture 'selected-startup.lnk';Put $savedLink 'selected fixture link'
    $legacyLink=Join-Path $runtime 'legacy-startup.lnk';Put $legacyLink 'legacy fixture link'
    $startupHash=(Get-FileHash -LiteralPath $legacyLink).Hash.ToLowerInvariant()
    $script:previousRelease.cutover.legacyStartupSha256=$startupHash
    $nextRelease.cutover.legacyStartupSha256=$startupHash
    $recoveryPath=Join-Path $fixture 'source-recovery.json'
    $audit=[pscustomobject]@{contract='r7-selected-source-recovery-v1';phase='SOURCE_RUNTIME_RESTORED';selectedRelease='fixture-r5';
        originalReceiptSha256=$selectedCutoverHash;legacyStartupSha256=$startupHash;selectedStartupSha256=(Get-FileHash -LiteralPath $savedLink).Hash.ToLowerInvariant();
        savedStartup=$savedLink;buildId='0123456789abcdef';cutoverReplayed=$false;newCorePid=101;newTunnelPid=102}
    function Save-RecoveryFixture {Put $recoveryPath ($audit|ConvertTo-Json); (Get-FileHash -LiteralPath $recoveryPath).Hash.ToLowerInvariant()}
    $recoveryHash=Save-RecoveryFixture
    $script:trayPresent=$false;$script:recoveryBusy=$false;$script:unowned=$false;$script:remoteUnresolved=$false
    $script:observedCore=101;$script:observedTunnel=102
    function Assert-NoTray {if($script:trayPresent){throw 'CLOSE_CONTROL_CENTER_UI_ONLY_THEN_REPEAT'}}
    function Get-Health {param([switch]$Idle)
        if(-not $Idle){throw 'IDLE_GATE_REQUIRED'}
        if($script:recoveryBusy){throw 'ACTIVE_WORK_PRESENT'}
        [pscustomobject]@{pid=$script:observedCore;buildId='0123456789abcdef'}
    }
    function Invoke-Controller {param($Root,$Action)
        if($Action -cne 'Status' -or $Root -ine (Join-Path $fixture 'codex_bridge')){throw 'ONLY_SOURCE_STATUS_ALLOWED'}
        [pscustomobject]@{after=[pscustomobject]@{tunnel=[pscustomobject]@{pid=$script:observedTunnel}}}
    }
    function Assert-OwnedReady {param($Result,$Health) if($script:unowned){throw 'OWNER_UNVERIFIED'}}
    function Assert-RemoteReceiptsTerminal {param($OwnerRoot) if($script:remoteUnresolved){throw 'R1_STORE_UNRESOLVED'}}
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root} 'STATE_REUSE_CUTOVER_NOT_INACTIVE'
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath} 'STATE_RECOVERY_INPUT_REJECTED'
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath ('0'*64)} 'STATE_RECOVERY_HASH_CHANGED'
    $recovered=Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash
    Check ($recovered.contract -ceq 'installed-recovered-state-reuse-v1' -and $recovered.recovery.sha256 -ceq $recoveryHash -and
        $recovered.retainedStatus.sha256 -ceq $retainedStateHash) 'Recovered reuse must bind the audit and current status bytes'
    foreach($case in @(
        @('phase','UNKNOWN'),@('selectedRelease','wrong-release'),@('originalReceiptSha256',('0'*64)),
        @('legacyStartupSha256',('0'*64)),@('buildId','changed'),@('cutoverReplayed',$true),@('newCorePid',0),@('newTunnelPid',101)
    )){
        $field=$case[0];$oldValue=$audit.$field;$audit.$field=$case[1];$badHash=Save-RecoveryFixture
        Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $badHash} 'STATE_RECOVERY_RECEIPT_REJECTED'
        $audit.$field=$oldValue
    }
    $recoveryHash=Save-RecoveryFixture
    Put $savedLink 'changed selected link'
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash} 'STATE_RECOVERY_STARTUP_CHANGED'
    Put $savedLink 'selected fixture link'
    $script:trayPresent=$true;Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash} 'CLOSE_CONTROL_CENTER';$script:trayPresent=$false
    $script:recoveryBusy=$true;Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash} 'ACTIVE_WORK_PRESENT';$script:recoveryBusy=$false
    $script:unowned=$true;Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash} 'OWNER_UNVERIFIED';$script:unowned=$false
    $script:remoteUnresolved=$true;Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash} 'R1_STORE_UNRESOLVED';$script:remoteUnresolved=$false
    $script:observedCore=999;Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash} 'STATE_RECOVERY_RUNTIME_CHANGED';$script:observedCore=101
    $script:observedTunnel=999;Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash} 'STATE_RECOVERY_RUNTIME_CHANGED';$script:observedTunnel=102
    $marker=Join-Path $runtime 'codex-bridge-http-server.pid';Put $marker '999'
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash} 'STATE_RECOVERY_INSTALLED_OWNER_PRESENT'
    Remove-Item -LiteralPath $marker
    $history=Join-Path $script:owner 'events\old.jsonl';Put $history 'changed history'
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash} 'STATE_REUSE_ACTIVE_COPY_CHANGED'
    Put $history '{"fixture":"history"}'
    $script:plan=[pscustomobject]@{roots=@($script:owner);entries=@();files=@();migration=$inventory;ownerReuse=$recovered}
    $rebound=Invoke-StateBinding $nextRelease (Get-StatePlanHash $script:plan) $script:previousRelease.root $recoveryPath $recoveryHash|ConvertFrom-Json
    Check ($rebound.ownerStateReused -and -not $rebound.ownerMigrationPrepared -and $rebound.aclEntries -eq 0) 'Recovered bind must not repeat migration or existing ACL writes'
    Check ((Get-FileHash -LiteralPath $cutoverPath).Hash.ToLowerInvariant() -ceq $selectedCutoverHash -and
        (Get-FileHash -LiteralPath (Join-Path $script:owner 'state.json')).Hash.ToLowerInvariant() -ceq $retainedStateHash) 'Recovered bind must preserve UNKNOWN and observed status bytes'
    Refused {Invoke-StateBinding $nextRelease (Get-StatePlanHash $script:plan) $script:previousRelease.root $recoveryPath $recoveryHash} 'STATE_BINDING_EXISTS_INSPECT_DO_NOT_RETRY'
    $nextRelease.releaseId='fixture-r10'
    Put (Join-Path $script:owner 'state.json') '{"fixture":"status changed after plan"}'
    Refused {Invoke-StateBinding $nextRelease (Get-StatePlanHash $script:plan) $script:previousRelease.root $recoveryPath $recoveryHash} 'STATE_REUSE_EVIDENCE_CHANGED'
    Check ((Read-BoundedJson (Join-Path $script:owner 'installed-bridge\fixture-r10\state-binding.json')).phase -ceq 'UNKNOWN') 'Changed recovered evidence leaves UNKNOWN, never a second attempt'
    # A wrapper blocked on inherited output leaves SELECTED, not UNKNOWN.
    # Require the separately reviewed stop/drain chain; never rewrite that phase.
    $nextRelease.releaseId='fixture-r11'
    Put (Join-Path $script:owner 'state.json') '{"fixture":"new status observation"}'
    $cutover.phase='SELECTED';$cutover.PSObject.Properties.Remove('lastPhase')
    Put $cutoverPath ($cutover|ConvertTo-Json)
    $selectedCutoverHash=(Get-FileHash -LiteralPath $cutoverPath).Hash.ToLowerInvariant()
    $audit.originalReceiptSha256=$selectedCutoverHash
    $recoveryHash=Save-RecoveryFixture
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash} 'STATE_RECOVERY_CUTOVER_PHASE_REJECTED'
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root} 'STATE_REUSE_CUTOVER_NOT_INACTIVE'
    $audit.contract='r8-output-source-recovery-v1'
    $stopPath=Join-Path $fixture 'r8-output-stop.json'
    $repairPath=Join-Path $fixture 'r8-connectivity-recovery.json'
    $beforeRepairPath=Join-Path $fixture 'r8-connectivity-before-output-recovery.json'
    $repair=[pscustomobject]@{contract='r8-selected-connectivity-recovery-v1';phase='REPAIRING_CONNECTIVITY';
        releaseId='fixture-r5';originalReceiptSha256=$selectedCutoverHash;corePid=201;buildId=$audit.buildId;
        coreRestarted=$false;startupChanged=$false;cutoverReplayed=$false;originalReceiptChanged=$false}
    Put $beforeRepairPath ($repair|ConvertTo-Json)
    $repair.phase='UNKNOWN';$repair|Add-Member NoteProperty lastPhase 'REPAIRING_CONNECTIVITY'
    $stop=[pscustomobject]@{contract='r8-output-stop-v1';phase='INSTALLED_STOPPED_OUTPUT_DRAINED';releaseId='fixture-r5';
        buildId=$audit.buildId;originalReceiptSha256=$selectedCutoverHash;selectedStartupSha256=$audit.selectedStartupSha256;
        savedStartup=$savedLink;savedRepair=$beforeRepairPath;repairBeforeSha256=(Get-FileHash -LiteralPath $beforeRepairPath).Hash.ToLowerInvariant();
        repairAfterSha256='';coreExited=$true;tunnelExited=$true;handoffExited=$true;startupChanged=$false;corePid=201;tunnelPid=202;handoffPid=203}
    $audit|Add-Member NoteProperty stopReceipt $stopPath
    $audit|Add-Member NoteProperty stopReceiptSha256 ''
    $audit|Add-Member NoteProperty repairReceiptSha256 ''
    function Save-OutputRecoveryFixture {
        Put $repairPath ($repair|ConvertTo-Json)
        $audit.repairReceiptSha256=(Get-FileHash -LiteralPath $repairPath).Hash.ToLowerInvariant()
        $stop.repairAfterSha256=$audit.repairReceiptSha256
        Put $stopPath ($stop|ConvertTo-Json)
        $audit.stopReceiptSha256=(Get-FileHash -LiteralPath $stopPath).Hash.ToLowerInvariant()
        Save-RecoveryFixture
    }
    $recoveryHash=Save-OutputRecoveryFixture
    $drainedReuse=Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash
    Check ($drainedReuse.recovery.sha256 -ceq $recoveryHash -and $drainedReuse.cutoverSha256 -ceq $selectedCutoverHash) 'Drained SELECTED reuse must bind the entire reviewed chain'
    $audit.stopReceiptSha256='0'*64;$badHash=Save-RecoveryFixture
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $badHash} 'STATE_RECOVERY_STOP_HASH_CHANGED'
    $recoveryHash=Save-OutputRecoveryFixture
    $cutover.phase='UNKNOWN';$cutover|Add-Member NoteProperty lastPhase 'SELECTED'
    Put $cutoverPath ($cutover|ConvertTo-Json)
    Refused {Get-VerifiedStateRecovery $nextRelease $script:previousRelease $runtime $selectedCutoverHash $recoveryPath $recoveryHash 'UNKNOWN'} 'STATE_RECOVERY_CUTOVER_PHASE_REJECTED'
    $cutover.phase='SELECTED';$cutover.PSObject.Properties.Remove('lastPhase');Put $cutoverPath ($cutover|ConvertTo-Json)
    foreach($case in @(@('phase','UNKNOWN'),@('releaseId','other'),@('buildId','other'),@('originalReceiptSha256',('0'*64)),
        @('selectedStartupSha256',('0'*64)),@('coreExited',$false),@('tunnelExited',$false),@('handoffExited',$false),
        @('startupChanged',$true),@('corePid',0),@('handoffPid',202),@('handoffExited','True'))){
        $field=$case[0];$oldValue=$stop.$field;$stop.$field=$case[1];$badHash=Save-OutputRecoveryFixture
        Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $badHash} 'STATE_RECOVERY_STOP_RECEIPT_REJECTED'
        $stop.$field=$oldValue
    }
    foreach($case in @(@('phase','CONNECTIVITY_RESTORED'),@('lastPhase','OTHER'),@('corePid',999),@('cutoverReplayed',$true))){
        $field=$case[0];$oldValue=$repair.$field;$repair.$field=$case[1];$badHash=Save-OutputRecoveryFixture
        Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $badHash} 'STATE_RECOVERY_REPAIR_RECEIPT_REJECTED'
        $repair.$field=$oldValue
    }
    $recoveryHash=Save-OutputRecoveryFixture
    $savedBefore=[IO.File]::ReadAllText($beforeRepairPath)
    Put $beforeRepairPath 'changed backup'
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash} 'STATE_RECOVERY_STOP_HASH_CHANGED'
    Put $beforeRepairPath $savedBefore
    $script:unowned=$true;Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash} 'OWNER_UNVERIFIED';$script:unowned=$false
    $script:recoveryBusy=$true;Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash} 'ACTIVE_WORK_PRESENT';$script:recoveryBusy=$false
    $script:plan=[pscustomobject]@{roots=@($script:owner);entries=@();files=@();migration=$inventory;ownerReuse=$drainedReuse}
    $rebound=Invoke-StateBinding $nextRelease (Get-StatePlanHash $script:plan) $script:previousRelease.root $recoveryPath $recoveryHash|ConvertFrom-Json
    Check ($rebound.ownerStateReused -and -not $rebound.ownerMigrationPrepared -and $rebound.aclEntries -eq 0) 'Drained recovery must not repeat migration or existing ACL writes'
    Check ((Get-FileHash -LiteralPath $cutoverPath).Hash.ToLowerInvariant() -ceq $selectedCutoverHash -and
        (Read-BoundedJson $cutoverPath).phase -ceq 'SELECTED') 'Drained recovery must preserve the original SELECTED receipt'

    # Explicit continuation after source has legitimately run since the historical
    # recovery. Keep old receipts immutable and retain all new deduplication IDs.
    . (Import-Function $ast 'Test-RecoveredSourceAcl')
    . (Import-Function $ast 'Get-RecoveredSourceAdvance')
    $aclBefore='O:SYG:SYD:(D;;FW;;;BU)(A;;FA;;;SY)'
    $aclTighter='O:SYG:SYD:(D;;FW;;;WD)(D;;FW;;;BU)(A;;FA;;;SY)'
    Check (Test-RecoveredSourceAcl $aclBefore $aclTighter) 'Additional deny ACEs may tighten source ACL without rewriting any prior ACE'
    Check (-not(Test-RecoveredSourceAcl $aclTighter $aclBefore)) 'Removing a deny is rejected'
    Check (-not(Test-RecoveredSourceAcl $aclBefore 'O:SYG:SYD:(D;;FW;;;BU)(A;;FA;;;SY)(A;;FR;;;WD)')) 'Additional allow is rejected'
    Check (-not(Test-RecoveredSourceAcl $aclBefore 'O:BAG:SYD:(D;;FW;;;BU)(A;;FA;;;SY)')) 'Owner change is rejected'
    Check (-not(Test-RecoveredSourceAcl $aclBefore 'O:SYG:SYD:P(D;;FW;;;BU)(A;;FA;;;SY)')) 'ACL control flags must remain exact'
    Check (Test-RecoveredSourceAcl 'O:SYG:SYD:(D;;FW;;;BU)(D;;FR;;;WD)(A;;FA;;;SY)' 'O:SYG:SYD:(D;;FR;;;WD)(D;;FW;;;BU)(D;;FX;;;AN)(A;;FA;;;SY)') 'Adjacent deny order may change without changing effective access'
    Check (-not(Test-RecoveredSourceAcl 'O:SYG:SYD:(D;;FW;;;BU)(A;;FA;;;SY)(D;;FR;;;WD)' 'O:SYG:SYD:(D;;FW;;;BU)(D;;FR;;;WD)(A;;FA;;;SY)')) 'A deny cannot move across an allow boundary'
    $boundPlan.migration.target=$script:owner
    Put (Join-Path $runtime 'state-acl-before.json') ($boundPlan|ConvertTo-Json -Depth 8)
    Write-Receipt (Join-Path $runtime 'state-binding.json') @{contract='installed-state-binding-v1';phase='STATE_BOUND';planSha256=(Get-StatePlanHash $boundPlan);backup=(Join-Path $runtime 'state-acl-before.json')}
    $priorBinding=(Get-FileHash -LiteralPath (Join-Path $runtime 'state-binding.json')).Hash
    $nextRelease.releaseId='fixture-source-advance'
    $script:previousRelease.cutover|Add-Member NoteProperty rollbackBuildId $audit.buildId
    $nextRelease.cutover.rollbackBuildId='fedcba9876543210'
    $script:observedCore=301;$script:observedTunnel=302
    function Get-Health {param([switch]$Idle)
        if(-not $Idle){throw 'IDLE_GATE_REQUIRED'}
        if($script:recoveryBusy){throw 'ACTIVE_WORK_PRESENT'}
        [pscustomobject]@{pid=$script:observedCore;buildId='fedcba9876543210'}
    }
    function Get-Process {param($Id,$ErrorAction)
        if($Id -notin @(301,302)){throw 'UNEXPECTED_PROCESS_LOOKUP'}
        [pscustomobject]@{StartTime=[datetime]'2026-10-20T00:00:00Z'}
    }
    $trayFile=Join-Path $source 'tray.pid'
    Remove-Item -LiteralPath $trayFile
    Put (Join-Path $source 'state.json') '{"fixture":"fresh source state"}'
    Put (Join-Path $source 'events\2026-10-20.jsonl') '{"fixture":"new event"}'
    $requestId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    $receiptRelative="workspace-local-receipts\$requestId.json"
    $sourceReceipt=Join-Path $source $receiptRelative
    $newReceipt=[pscustomobject]@{requestId=$requestId;componentId='codex_bridge';action='reload_runtime';
        confirmation='interrupt_current_requests';outcome='UNKNOWN';createdAt='2026-10-20T00:00:00Z';updatedAt='2026-10-20T00:00:01Z'}
    Put $sourceReceipt ($newReceipt|ConvertTo-Json)
    function Get-OwnerMigrationPlan {param($Release)
        $rows=@(foreach($item in @((Get-Item -LiteralPath $source)) + @(Get-ChildItem -LiteralPath $source -Recurse -Force)){
            $relative=if($item.FullName -ceq $source){''}else{$item.FullName.Substring($source.Length+1)}
            $acl=Get-Acl -LiteralPath $item.FullName
            $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
            [pscustomobject][ordered]@{relative=$relative;directory=[bool]$item.PSIsContainer;
                length=$(if($item.PSIsContainer){0L}else{$item.Length});
                sha256=$(if($item.PSIsContainer){$null}else{(Get-FileHash -LiteralPath $item.FullName).Hash.ToLowerInvariant()});
                acl=$acl.GetSecurityDescriptorSddlForm($sections)}
        })
        [pscustomobject][ordered]@{source=$source;target=$script:owner;bytes=($rows|Measure-Object length -Sum).Sum;entries=@($rows|Sort-Object relative)}
    }
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash} 'LEGACY_OWNER_STATE_CHANGED'
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root -AllowSourceAdvance} 'SOURCE_ADVANCE_RECOVERY_REQUIRED'
    $advanced=Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash -AllowSourceAdvance
    Check ($advanced.sourceAdvance.receiptImports.Count -eq 1 -and $advanced.recovery.currentSource.corePid -eq 301 -and
        $advanced.recovery.currentSource.buildId -ceq 'fedcba9876543210' -and $advanced.recovery.sourceBuildId -ceq $audit.buildId) 'Fresh source identity and historical drain remain distinct'
    $script:trayPresent=$true
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash -AllowSourceAdvance} 'CLOSE_CONTROL_CENTER'
    $script:trayPresent=$false;$script:recoveryBusy=$true
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash -AllowSourceAdvance} 'ACTIVE_WORK_PRESENT'
    $script:recoveryBusy=$false;$script:unowned=$true
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash -AllowSourceAdvance} 'OWNER_UNVERIFIED'
    $script:unowned=$false
    $nextRelease.cutover.rollbackBuildId='0000000000000000'
    Refused {Get-InactiveBoundState $nextRelease $script:previousRelease.root $recoveryPath $recoveryHash -AllowSourceAdvance} 'SOURCE_ADVANCE_BUILD_REJECTED'
    $nextRelease.cutover.rollbackBuildId='fedcba9876543210'
    $unsupported=Join-Path $source 'new-policy.json';Put $unsupported '{}'
    Refused {Get-RecoveredSourceAdvance $nextRelease $boundPlan.migration} 'SOURCE_ADVANCE_UNSUPPORTED_CHANGE'
    Remove-Item -LiteralPath $unsupported
    $newReceipt.outcome='RUNNING';Put $sourceReceipt ($newReceipt|ConvertTo-Json)
    Refused {Get-RecoveredSourceAdvance $nextRelease $boundPlan.migration} 'SOURCE_ADVANCE_RECEIPT_REJECTED'
    $newReceipt.outcome='UNKNOWN';Put $sourceReceipt ($newReceipt|ConvertTo-Json)
    $targetReceipt=Join-Path $script:owner $receiptRelative;Put $targetReceipt '{"conflict":true}'
    Refused {Get-RecoveredSourceAdvance $nextRelease $boundPlan.migration} 'SOURCE_ADVANCE_RECEIPT_CONFLICT'
    Remove-Item -LiteralPath $targetReceipt
    $savedSource=Join-Path $source 'events\old.jsonl'
    $oldEvent=[IO.File]::ReadAllText($savedSource)
    Remove-Item -LiteralPath $savedSource
    Refused {Get-RecoveredSourceAdvance $nextRelease $boundPlan.migration} 'SOURCE_ADVANCE_ENTRY_REMOVED'
    Put $savedSource $oldEvent
    $changedAcl=$boundPlan.migration.entries[0].acl
    $boundPlan.migration.entries[0].acl='changed'
    Refused {Get-RecoveredSourceAdvance $nextRelease $boundPlan.migration} 'SOURCE_ADVANCE_METADATA_CHANGED'
    $boundPlan.migration.entries[0].acl=$changedAcl
    $script:plan=[pscustomobject]@{roots=@($script:owner);entries=@();files=@();migration=(Get-OwnerMigrationPlan $nextRelease);ownerReuse=$advanced}
    $rebound=Invoke-StateBinding $nextRelease (Get-StatePlanHash $script:plan) $script:previousRelease.root $recoveryPath $recoveryHash -AllowSourceAdvance|ConvertFrom-Json
    $advanceRuntime=Join-Path $script:owner ('installed-bridge\'+$nextRelease.releaseId)
    Check ($rebound.phase -ceq 'STATE_BOUND' -and (Read-BoundedJson $targetReceipt).outcome -ceq 'UNKNOWN') 'Unknown receipt stays deduplicated, never becomes completed or replayed'
    Check ((Get-FileHash -LiteralPath $sourceReceipt).Hash -ceq (Get-FileHash -LiteralPath $targetReceipt).Hash -and
        (Get-FileHash -LiteralPath (Join-Path $advanceRuntime ('legacy-owner-backup\'+$receiptRelative))).Hash -ceq (Get-FileHash -LiteralPath $sourceReceipt).Hash) 'New receipt and full source backup retain exact bytes'
    Check ((Get-FileHash -LiteralPath (Join-Path $runtime 'state-binding.json')).Hash -ceq $priorBinding -and
        (Get-FileHash -LiteralPath $cutoverPath).Hash.ToLowerInvariant() -ceq $selectedCutoverHash) 'Historical deployment receipts are immutable during source advance'
    Check ((Get-FileHash -LiteralPath (Join-Path $advanceRuntime 'legacy-owner-backup\state.json')).Hash -ceq
        (Get-FileHash -LiteralPath (Join-Path $source 'state.json')).Hash -and
        (Get-FileHash -LiteralPath (Join-Path $script:owner 'state.json')).Hash.ToLowerInvariant() -ceq $retainedStateHash) 'Fresh observations are preserved separately, never overwrite installed history'
    Refused {Invoke-StateBinding $nextRelease (Get-StatePlanHash $script:plan) $script:previousRelease.root $recoveryPath $recoveryHash -AllowSourceAdvance} 'STATE_BINDING_EXISTS_INSPECT_DO_NOT_RETRY'
    [pscustomobject]@{ok=$true;checks=$checks;migration='ACTUAL_FUNCTIONS_ISOLATED_IO';recovery='REVIEWED_AUDIT_AND_SYNTHETIC_OWNER';acl='SYNTHETIC_SOURCE_AND_DESTINATION_DENY';partialFailure='UNKNOWN_NO_RETRY';productionTouched=$false;aclMutations=0;runtimeStarted=$false}|ConvertTo-Json
} finally {
    [Environment]::SetEnvironmentVariable('MCP_CONTROL_CENTER_DATA_DIR',$previousOverride,'Process')
    $env:PSModulePath=$previousModules
    if($core){Remove-Module $core -ErrorAction SilentlyContinue}
    if($verifier){Remove-Module $verifier -ErrorAction SilentlyContinue}
    $resolved=[IO.Path]::GetFullPath($fixture)
    if(-not $resolved.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'FIXTURE_CLEANUP_SCOPE_REJECTED'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
