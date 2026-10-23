Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$base=Join-Path $workspace 'codex_bridge\.tmp'
$fixture=Join-Path $base ('state-binding-'+[guid]::NewGuid().ToString('N'))
$utf8=New-Object Text.UTF8Encoding($false)
$checks=0
$verifier=$null
function Check([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
function Refused([scriptblock]$Body,[string]$Code){$errorCode='';try{& $Body|Out-Null}catch{$errorCode=$_.Exception.Message};Check ($errorCode -match $Code) "Expected $Code; got $errorCode"}
function Put([string]$Path,[string]$Text){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,$Text,$utf8)}
function Save-Manifest {Put $manifestPath ($document|ConvertTo-Json -Depth 10)}
function Deny-Coverage($Acl){
    # .NET may combine self + inherit-only child ACEs. Compare the denial mask
    # at each inheritance scope, not an ACE count or serialization spelling.
    $masks=@{}
    foreach($rule in $Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
        if($rule.AccessControlType -ne 'Deny'){continue}
        foreach($scope in @('self','directory1','file1','directory2','file2')){
            $applies=if($scope -eq 'self'){-not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)}else{
                $flag=if($scope.StartsWith('directory')){[Security.AccessControl.InheritanceFlags]::ContainerInherit}else{[Security.AccessControl.InheritanceFlags]::ObjectInherit}
                ($rule.InheritanceFlags -band $flag) -and ($scope.EndsWith('1') -or -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::NoPropagateInherit))
            }
            if($applies){$key=$rule.IdentityReference.Value+':'+$scope;if(-not $masks.ContainsKey($key)){$masks[$key]=0};$masks[$key]=$masks[$key] -bor [int]$rule.FileSystemRights}
        }
    }
    @($masks.Keys|Sort-Object|ForEach-Object{$_+':'+$masks[$_]}) -join ','
}
try {
    $releaseRoot=Join-Path $fixture 'release-a';$manager=Join-Path $releaseRoot 'mcp_control_center'
    $bridge=Join-Path $releaseRoot 'codex_bridge';$legacy=Join-Path $fixture 'workspace'
    $user=Join-Path $fixture 'user';$local=Join-Path $user 'AppData\Local';$owner=Join-Path $local 'McpControlCenter'
    $runtime=Join-Path $owner 'installed-bridge\release-a';$data=Join-Path $fixture 'canonical-data';$fixtureCodexHome=Join-Path $user '.codex'
    foreach($dir in @($bridge,$legacy,$runtime,$fixtureCodexHome,(Join-Path $data 'powershell-approval'))){[void][IO.Directory]::CreateDirectory($dir)}
    $modulePath=Join-Path $manager 'src\McpControlCenter.InstalledRelease.psm1'
    Put $modulePath ([IO.File]::ReadAllText((Join-Path $workspace 'mcp_control_center\src\McpControlCenter.InstalledRelease.psm1')))
    $verifier=Import-Module $modulePath -Force -PassThru
    $sid='S-1-5-21-100-200-300-1001';$foreign='S-1-5-21-100-200-300-1007'
    $operator=[pscustomobject]@{sid=$sid;userProfile=$user;localAppData=$local;windows='C:\Windows';isAdmin=$false}
    $manifestPath=Join-Path $manager 'config\installed-release.json'
    $dependencies=@{};foreach($key in @('node','tunnelClient','keyStore','codexLauncher','codexNative','releaseVerifier')){$dependencies[$key]='a'*64}
    $document=[ordered]@{contract='mcpcc-installed-release-v4';schemaVersion=4;releaseId='release-a';legacyWorkspaceRoot=$legacy;dependencies=$dependencies;
        treeHashes=@{mcp_control_center=('a'*64);codex_bridge=('a'*64);dependencies=('a'*64)};
        state=@{operatorSid=$sid;userProfile=$user;localAppData=$local;dataDir=$data;projectsFile=(Join-Path $legacy 'codex_bridge\.local\projects.json');codexHome=$fixtureCodexHome};
        cutover=@{httpTokenSha256='';tunnelProfileSha256=('b'*64);rollbackBuildId='0123456789abcdef';legacyStartupSha256=('c'*64)};
        deployment=@{contract='bridge-private-snapshot-v1';projectsSha256=('d'*64);credentialSha256=('e'*64)}}
    Save-Manifest
    $release=Read-McpCcInstalledRelease $manager
    Check ($release.schemaVersion -eq 4 -and $release.state.dataDir -ceq $data) 'V4 must preserve canonical data path'
    $document.deployment.extra=$true;Save-Manifest
    Refused {Read-McpCcInstalledRelease $manager} 'INSTALLED_MANIFEST_INVALID'
    $document.deployment.Remove('extra');$document.state.codexHome=Join-Path $fixture 'other-home';Save-Manifest
    Refused {Read-McpCcInstalledRelease $manager} 'INSTALLED_STATE_SCOPE_REJECTED'
    $document.state.codexHome=$fixtureCodexHome;Save-Manifest
    $document.contract='mcpcc-installed-release-v5';$document.schemaVersion=5
    $document.state.ownerRoot='C:\McpControlCenter';$document.state.dataDir='C:\CodexBridge';Save-Manifest
    $migratedRelease=Read-McpCcInstalledRelease $manager
    Check ((Get-McpCcInstalledStateRoot $migratedRelease) -ceq 'C:\McpControlCenter') 'V5 owner root must be manifest-pinned outside AppData'
    $document.state.ownerRoot=Join-Path $local 'McpControlCenter';Save-Manifest
    Refused {Read-McpCcInstalledRelease $manager} 'INSTALLED_STATE_SCOPE_REJECTED'
    $document.state.Remove('ownerRoot');Save-Manifest
    Refused {Read-McpCcInstalledRelease $manager} 'INSTALLED_MANIFEST_INVALID'
    $document.state.ownerRoot='C:\McpControlCenter';$document.state.dataDir=$data;Save-Manifest
    Refused {Read-McpCcInstalledRelease $manager} 'INSTALLED_STATE_SCOPE_REJECTED'
    $document.contract='mcpcc-installed-release-v4';$document.schemaVersion=4;$document.state.Remove('ownerRoot');Save-Manifest
    $files=@(& $verifier {param($r,$p) Get-McpCcInstalledDeploymentFiles $r $p} $release $runtime)
    Check ($files.Count -eq 3 -and @($files|Where-Object{-not $_.target.StartsWith($runtime+'\deployment\')}).Count -eq 0) 'All snapshots must be inside private runtime'
    Check ($files[2].source -ceq (Join-Path $legacy 'project_reading\.secrets\control-plane-api-key.dpapi')) 'Shared credential remains an input, never an ACL mutation target'
    foreach($file in $files){Put $file.target ('synthetic '+(Split-Path -Leaf $file.target))}
    $document.deployment.projectsSha256=(Get-FileHash -LiteralPath $files[0].target).Hash.ToLowerInvariant()
    $document.cutover.tunnelProfileSha256=(Get-FileHash -LiteralPath $files[1].target).Hash.ToLowerInvariant()
    $stateReceipt=Join-Path $runtime 'state-binding.json'
    $receipt=@{contract='installed-state-binding-v1';phase='STATE_BOUND';planSha256=('f'*64);backup=(Join-Path $runtime 'state-acl-before.json')}
    Put $stateReceipt ($receipt|ConvertTo-Json)
    Save-Manifest
    & $verifier {
        param($op,$private,$shared,$credential)
        $script:operator=$op;$script:privateRoot=$private;$script:sharedHome=$shared;$script:credential=$credential
        $script:badAcl='';$script:reparse='';$script:closureCalls=0;$script:aclOverrides=@{}
        $script:privateAcl=New-Object Security.AccessControl.DirectorySecurity
        $script:privateAcl.SetSecurityDescriptorSddlForm("O:$($op.sid)G:SYD:(A;;FA;;;$($op.sid))(A;;FA;;;SY)")
        $script:sharedAcl=New-Object Security.AccessControl.DirectorySecurity
        $script:sharedAcl.SetSecurityDescriptorSddlForm("O:$($op.sid)G:SYD:(A;;FA;;;$($op.sid))(A;;FRFX;;;BU)")
        function script:Get-McpCcInstalledOperator {$script:operator}
        function script:Assert-McpCcInstalledClosure {param($Release) $script:closureCalls++} # Synthetic code trust, not OS verification.
        function script:Get-Acl {param($LiteralPath)
            if($script:aclOverrides.ContainsKey($LiteralPath)){return $script:aclOverrides[$LiteralPath]}
            if($LiteralPath -ieq $script:badAcl){$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetSecurityDescriptorSddlForm('O:SYG:SYD:(A;;FW;;;BU)');return $acl}
            if($LiteralPath -ieq $script:sharedHome){return $script:sharedAcl}
            return $script:privateAcl
        }
        function script:Get-Item {param($LiteralPath,[switch]$Force)
            if($LiteralPath -ieq $script:reparse){return [pscustomobject]@{Attributes=[IO.FileAttributes]::ReparsePoint}}
            Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force
        }
        function script:Get-FileHash {param($LiteralPath,$Algorithm)
            if($LiteralPath -ieq $script:credential){throw 'CONTROL_CENTER_MUST_NOT_READ_CREDENTIAL_BYTES'}
            Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256
        }
        function script:Set-Acl {throw 'VERIFIER_MUST_NOT_MUTATE_ACL'}
    } $operator $owner $fixtureCodexHome $files[2].target
    $previousToken=[Environment]::GetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN','Process')
    try {
        [Environment]::SetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN',$null,'Process')
        $binding=Get-McpCcInstalledBridgeBinding $bridge
        Check ($binding.contract -ceq 'codex-bridge-installed-binding-v2' -and $binding.activationReady) 'V4 must produce exact V2 binding'
        Check ($binding.projectsFile -ceq $files[0].target -and $binding.secretPath -ceq $files[2].target -and $binding.codexHome -ceq $fixtureCodexHome -and $binding.dataDir -ceq $data) 'Private snapshots and shared home have distinct responsibilities'
        Check ((& $verifier {$script:closureCalls}) -gt 0) 'Protected code closure remains required'
        $receipt.phase='UNKNOWN';Put $stateReceipt ($receipt|ConvertTo-Json)
        Refused {Get-McpCcInstalledBridgeBinding $bridge} 'INSTALLED_STATE_NOT_BOUND'
        Refused {Get-McpCcInstalledOwnerBinding $manager} 'INSTALLED_STATE_NOT_BOUND'
        $receipt.phase='STATE_BOUND';Put $stateReceipt ($receipt|ConvertTo-Json)
        $original=[IO.File]::ReadAllText($files[0].target);Put $files[0].target 'changed'
        Refused {Get-McpCcInstalledBridgeBinding $bridge} 'INSTALLED_DEPLOYMENT_CHANGED'
        Put $files[0].target $original
        foreach($path in @($fixtureCodexHome,$owner,(Join-Path $data 'powershell-approval'),$files[0].target)){
            & $verifier {param($p)$script:badAcl=$p} $path
            Refused {Get-McpCcInstalledBridgeBinding $bridge} 'INSTALLED_PRIVATE_ACL_REJECTED'
        }
        & $verifier {$script:badAcl=''}
        & $verifier {param($p)$script:reparse=$p} $fixtureCodexHome
        Refused {Get-McpCcInstalledBridgeBinding $bridge} 'INSTALLED_REPARSE_REJECTED'
        & $verifier {$script:reparse=''}
    } finally {[Environment]::SetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN',$previousToken,'Process')}

    # PlanState passes the volume root as its first integrity-only path. The
    # child-only ACE is not effective there; real ancestor replacement rights
    # (including capability SIDs) must still fail before any state mutation.
    $volumeRoot=[IO.Path]::GetPathRoot($fixture)
    $childOnlyAcl=New-Object Security.AccessControl.DirectorySecurity
    $childOnlyAcl.SetSecurityDescriptorSddlForm("O:${sid}G:SYD:(A;;FA;;;$sid)(A;OICIIO;FA;;;AU)")
    $originalChildOnly=$childOnlyAcl.GetSecurityDescriptorSddlForm('All')
    & $verifier {param($p,$a)$script:aclOverrides[$p]=$a} $volumeRoot $childOnlyAcl
    & $verifier {param($p,$s)Assert-McpCcInstalledPrivatePath $p $s -IntegrityOnly} $volumeRoot $sid
    Check $true 'Volume-root integrity must ignore child-only rights'
    Check ($childOnlyAcl.GetSecurityDescriptorSddlForm('All') -ceq $originalChildOnly) 'Verification must not change the supplied ACL'
    Refused {& $verifier {param($p,$s)Assert-McpCcInstalledPrivatePath $p $s} $volumeRoot $sid} 'INSTALLED_PRIVATE_ACL_REJECTED'
    $effectiveAcl=New-Object Security.AccessControl.DirectorySecurity
    $effectiveAcl.SetSecurityDescriptorSddlForm("O:${sid}G:SYD:(A;;FA;;;$sid)(A;;FA;;;AU)")
    & $verifier {param($p,$a)$script:aclOverrides[$p]=$a} $volumeRoot $effectiveAcl
    Refused {& $verifier {param($p,$s)Assert-McpCcInstalledPrivatePath $p $s -IntegrityOnly} $volumeRoot $sid} 'INSTALLED_PRIVATE_ACL_REJECTED'
    & $verifier {param($p,$a)$script:aclOverrides=@{};$script:aclOverrides[$p]=$a} $fixtureCodexHome $childOnlyAcl
    Refused {& $verifier {param($p,$s)Assert-McpCcInstalledPrivatePath $p $s -IntegrityOnly} $fixtureCodexHome $sid} 'INSTALLED_PRIVATE_ACL_REJECTED'
    $capabilityAcl=New-Object Security.AccessControl.DirectorySecurity
    $capabilityAcl.SetSecurityDescriptorSddlForm("O:${sid}G:SYD:(A;;FA;;;$sid)(A;;FA;;;S-1-15-3-100-200-300)")
    foreach($ancestor in @($local,(Split-Path -Parent $local))){
        & $verifier {param($p,$a)$script:aclOverrides=@{};$script:aclOverrides[$p]=$a} $ancestor $capabilityAcl
        Refused {& $verifier {param($p,$s)Assert-McpCcInstalledPrivatePath $p $s -IntegrityOnly} $owner $sid} 'INSTALLED_PRIVATE_ACL_REJECTED'
    }
    & $verifier {param($p,$a)$script:aclOverrides=@{};$script:aclOverrides[$p]=$a} $local $childOnlyAcl
    & $verifier {param($p,$s)Assert-McpCcInstalledPrivatePath $p $s -IntegrityOnly} $owner $sid
    Check $true 'Ancestor child-only rights do not replace a separately protected child'
    & $verifier {$script:aclOverrides=@{}}

    # Real .NET ACL transformation, never Set-Acl. Explicit and inherited Deny,
    # including inherit-only child rules, must survive without trusting the SID.
    foreach($sddl in @("O:${sid}G:SYD:(D;;FR;;;$foreign)(D;OICIIO;FR;;;$foreign)(A;OICIID;FRFX;;;$foreign)(A;;FA;;;$sid)",
        "O:${sid}G:SYD:(D;OICIID;FW;;;$foreign)(A;OICIID;FA;;;BU)(A;;FA;;;$sid)")){
        $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetSecurityDescriptorSddlForm($sddl)
        $old=$acl.GetSecurityDescriptorSddlForm('All');$denies=Deny-Coverage $acl
        $next=& $verifier {param($a,$s)Get-McpCcInstalledPrivateAcl $a $s $true} $acl $sid
        Check ((Deny-Coverage $next) -ceq $denies -and $next.AreAccessRulesProtected) ('All platform Deny coverage must survive; synthetic before='+$denies+' after='+(Deny-Coverage $next))
        Check ($acl.GetSecurityDescriptorSddlForm('All') -ceq $old) 'ACL planning must be pure'
        Check (@($next.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -in @($foreign,'S-1-5-32-545')}).Count -eq 0) 'Foreign Allows must not become trusted'
        $again=& $verifier {param($a,$s)Get-McpCcInstalledPrivateAcl $a $s $true} $next $sid
        Check ($again.GetSecurityDescriptorSddlForm('All') -ceq $next.GetSecurityDescriptorSddlForm('All')) 'ACL transformation must be idempotent'
    }
    $complete=New-Object Security.AccessControl.DirectorySecurity;$complete.SetSecurityDescriptorSddlForm("O:${sid}G:SYD:(D;OICI;FR;;;$foreign)")
    foreach($flags in @('','OICIIO','OICINP')){
        $missingScope=New-Object Security.AccessControl.DirectorySecurity;$missingScope.SetSecurityDescriptorSddlForm("O:${sid}G:SYD:(D;$flags;FR;;;$foreign)")
        Check ((Deny-Coverage $missingScope) -cne (Deny-Coverage $complete)) 'Removing self, child, or deeper Deny must fail coverage comparison'
    }
    $nullAcl=New-Object Security.AccessControl.DirectorySecurity;$nullAcl.SetSecurityDescriptorSddlForm("O:${sid}G:SYD:NO_ACCESS_CONTROL")
    Refused {& $verifier {param($a,$s)Get-McpCcInstalledPrivateAcl $a $s $true} $nullAcl $sid} 'PROTECTED_DACL_REQUIRED'
    $destinationAcl=New-Object Security.AccessControl.DirectorySecurity
    $destinationAcl.SetSecurityDescriptorSddlForm("O:${sid}G:SYD:(D;OICI;FW;;;BU)(A;;FA;;;$sid)")
    $sourceAcl=New-Object Security.AccessControl.DirectorySecurity
    $sourceAcl.SetSecurityDescriptorSddlForm("O:${sid}G:SYD:(D;;FR;;;$foreign)(A;;FA;;;$foreign)")
    $expectedAcl=New-Object Security.AccessControl.DirectorySecurity
    $expectedAcl.SetSecurityDescriptorSddlForm("O:${sid}G:SYD:(D;OICI;FW;;;BU)(D;;FR;;;$foreign)")
    $beforeDestination=$destinationAcl.GetSecurityDescriptorSddlForm('All');$beforeSource=$sourceAcl.GetSecurityDescriptorSddlForm('All')
    $combined=& $verifier {param($a,$s,$old)Get-McpCcInstalledPrivateAcl $a $s $true $old} $destinationAcl $sid $sourceAcl
    Check ((Deny-Coverage $combined) -ceq (Deny-Coverage $expectedAcl)) 'Migration must preserve source and destination Deny together'
    Check (@($combined.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -eq $foreign}).Count -eq 0) 'Source Allows cannot grant migrated owner authority'
    Check ($beforeDestination -ceq $destinationAcl.GetSecurityDescriptorSddlForm('All') -and $beforeSource -ceq $sourceAcl.GetSecurityDescriptorSddlForm('All')) 'Migration planning must leave both supplied ACLs untouched'
    # Extract only the real operator functions. Never invoke its action dispatch,
    # lifecycle, live store, credential decoder or Set-Acl in this fixture.
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $workspace 'codex_bridge\scripts\installed-release-operator.ps1'),[ref]$tokens,[ref]$errors)
    Check ($errors.Count -eq 0) 'Operator must parse'
    foreach($name in @('Copy-StateSnapshot','Get-StatePlanHash','Get-StateBindingPlan','Invoke-StateBinding')){
        $functions=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
        if($functions.Count -ne 1){throw 'SOURCE_FUNCTION_NOT_UNIQUE'}
        . ([scriptblock]::Create($functions[0].Extent.Text))
    }
    Refused {Get-StateBindingPlan (Read-McpCcInstalledRelease $manager)} 'STATE_SCOPE_REJECTED'
    $copySource=Join-Path $fixture 'synthetic-input';Put $copySource 'synthetic fixture, never a credential'
    $copyTarget=Join-Path $fixture 'snapshot';$file=[pscustomobject]@{source=$copySource;target=$copyTarget;limit=65536;sha256=('0'*64)}
    Refused {Copy-StateSnapshot $file} 'DEPLOYMENT_SOURCE_CHANGED'
    Check (-not(Test-Path -LiteralPath $copyTarget)) 'Digest failure must precede output creation'
    $file.sha256=(Get-FileHash -LiteralPath $copySource).Hash.ToLowerInvariant();Copy-StateSnapshot $file
    Check ((Get-FileHash -LiteralPath $copyTarget).Hash -ceq (Get-FileHash -LiteralPath $copySource).Hash) 'Verified snapshot must preserve exact bytes'
    $copyFailure=$null
    try{Copy-StateSnapshot $file}catch{$copyFailure=$_.Exception;while($copyFailure.InnerException){$copyFailure=$copyFailure.InnerException}}
    Check ($copyFailure -is [IO.IOException]) 'CreateNew must reject overwriting an existing snapshot'
    $plan=[pscustomobject][ordered]@{contract='fixture';entries=@(@{before='a';after='b'})}
    $hash=Get-StatePlanHash $plan;$plan.entries[0].after='c'
    Check ((Get-StatePlanHash $plan) -cne $hash) 'Reviewed ACL changes must bind the plan digest'
    Refused {Invoke-StateBinding (Read-McpCcInstalledRelease $manager) ('0'*64)} 'STATE_BINDING_EXISTS_INSPECT_DO_NOT_RETRY'
    [pscustomobject]@{ok=$true;checks=$checks;binding='V4_SNAPSHOTS_V5_FIXED_OWNER';acl='SYNTHETIC_DENY_PRESERVED';snapshotCopy='REAL_ISOLATED_FILES';nativePipe='NOT_RUN';aclMutations=0;productionTouched=$false}|ConvertTo-Json
} finally {
    if($verifier){Remove-Module $verifier -ErrorAction SilentlyContinue}
    $resolved=[IO.Path]::GetFullPath($fixture)
    if(-not $resolved.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'FIXTURE_CLEANUP_SCOPE_REJECTED'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
