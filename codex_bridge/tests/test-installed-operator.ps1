Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$path=Join-Path $PSScriptRoot '..\scripts\installed-release-operator.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'OPERATOR_SYNTAX_INVALID'}
# Load only the pure archive-path function; never invoke the operator script,
# ACL writer, Startup COM, private-state reader, or lifecycle in this fixture.
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Resolve-ReleaseArchivePath'},$true)
. ([scriptblock]::Create($function.Extent.Text))
$root='C:\fixture\release-a';$passed=0
if((Resolve-ReleaseArchivePath $root 'dependencies/node/node.exe' 0) -cne ($root+'\dependencies\node\node.exe')){throw 'VALID_ENTRY_UNREACHABLE'};$passed++
foreach($entry in @('../escape','codex_bridge/../../escape','C:/escape','codex_bridge/evil:stream','codex_bridge/x /evil','codex_bridge//evil','codex_bridge/CON.txt','other/code.js','/codex_bridge/a')){
    $denied=$false;try{Resolve-ReleaseArchivePath $root $entry 0|Out-Null}catch{$denied=$_.Exception.Message -match '^PACKAGE_ENTRY_'}
    if(-not $denied){throw 'ARCHIVE_ESCAPE_ACCEPTED'};$passed++
}
foreach($attributes in @(0x400,0xA0000000L)){
    $signed=[BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]$attributes),0)
    $denied=$false;try{Resolve-ReleaseArchivePath $root 'codex_bridge/link' $signed|Out-Null}catch{$denied=$_.Exception.Message -ceq 'PACKAGE_ENTRY_INVALID'}
    if(-not $denied){throw 'ARCHIVE_LINK_ACCEPTED'};$passed++
}
$cc=Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'mcp_control_center'
$nativeSource=[IO.File]::ReadAllText((Join-Path $cc 'src\InstalledRelease.Native.cs'))
Add-Type -TypeDefinition $nativeSource
$cases=@(
    @{sddl='O:SYG:SYD:(A;;FA;;;SY)(A;;FRFX;;;BU)';allow=$true},
    @{sddl='O:SYG:SYD:(A;;FW;;;BU)';allow=$false},
    @{sddl='O:BUG:SYD:(A;;FA;;;SY)';allow=$false},
    @{sddl='O:SYG:SYD:NO_ACCESS_CONTROL';allow=$false}
)
foreach($case in $cases){
    $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetSecurityDescriptorSddlForm($case.sddl)
    $accepted=$false;try{[McpCcInstalledTree]::AssertAcl($acl);$accepted=$true}catch{}
    if($accepted -ne $case.allow){throw 'NATIVE_ACL_POLICY_REGRESSION'};$passed++
}
# Digest parity only: a separately named, test-only class reads this writable fixture.
# The production class above retains all ACL denials; no production flag bypasses them.
$hashFixture=$nativeSource.Replace('McpCcInstalledTree','McpCcInstalledHashFixture').Replace('if (!Trusted(acl.GetOwner(typeof(SecurityIdentifier)).Value))','if (false)').Replace('if (ace.AccessControlType == AccessControlType.Allow && !Trusted(ace.IdentityReference.Value) && (ace.FileSystemRights & write) != 0)','if (false)')
Add-Type -TypeDefinition $hashFixture -IgnoreWarnings -WarningAction SilentlyContinue
$fixture=Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) '.tmp') ('r1-native-hash-'+[guid]::NewGuid().ToString('N'))
try {
    $tree=Join-Path $fixture 'mcp_control_center';[void][IO.Directory]::CreateDirectory((Join-Path $tree 'config'))
    [IO.File]::WriteAllText((Join-Path $tree 'Z.txt'),'native hash fixture')
    [IO.File]::WriteAllText((Join-Path $tree 'config\a.json'),'{"fixture":true}')
    [IO.File]::WriteAllText((Join-Path $tree 'config\installed-release.json'),'excluded circular manifest')
    $module=Import-Module (Join-Path $cc 'src\McpControlCenter.InstalledRelease.psm1') -PassThru
    $psDigest=& $module {param($p) Get-McpCcInstalledTreeHash $p} $tree
    if([McpCcInstalledHashFixture]::VerifyTree($tree) -cne $psDigest){throw 'NATIVE_MANIFEST_DIGEST_CHANGED'};$passed++
} finally {
    $resolved=[IO.Path]::GetFullPath($fixture)
    if((Split-Path -Parent $resolved) -ine (Join-Path (Split-Path -Parent $PSScriptRoot) '.tmp') -or (Split-Path -Leaf $resolved) -cnotmatch '^r1-native-hash-[0-9a-f]{32}$'){throw 'UNSAFE_FIXTURE_CLEANUP'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
# Exercise only the actual Prepare allowlist/copy and compiler statements. Never
# invoke Prepare's live probes, private inputs, Startup COM or operator entrypoint.
function Check-Package([bool]$Value,[string]$Message) {
    if(-not $Value){throw $Message};$script:passed++
}
function Denied-Package([scriptblock]$Body,[string]$Pattern) {
    $failure=$null
    try{& $Body | Out-Null}catch{$failure=$_}
    Check-Package ($null -ne $failure -and ($failure.Exception.Message -match $Pattern -or $failure.FullyQualifiedErrorId -match $Pattern)) ('PACKAGE_EXPECTED_REJECTION: '+$Pattern)
}
function Clear-PackageScripts {
    foreach($component in $scriptLists.Keys){
        $scripts=[IO.Path]::GetFullPath((Join-Path $PackageRoot ($component+'\scripts')))
        if((Split-Path -Parent $fixture) -ine (Join-Path (Split-Path -Parent $PSScriptRoot) '.tmp') -or (Split-Path -Leaf $fixture) -cnotmatch '^r1-prepare-[0-9a-f]{32}$' -or
            -not $scripts.StartsWith($fixture+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'UNSAFE_FIXTURE_CLEANUP'}
        if(Test-Path -LiteralPath $scripts){Remove-Item -LiteralPath $scripts -Recurse -Force}
    }
}
function Get-PrepareAssignment([string]$Name) {
    $nodes=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and
        $n.Left -is [Management.Automation.Language.VariableExpressionAst] -and $n.Left.VariablePath.UserPath -ceq $Name},$true))
    if($nodes.Count -ne 1){throw ('PREPARE_ASSIGNMENT_NOT_UNIQUE: '+$Name)}
    return $nodes[0]
}
function Get-PrepareLoop([string]$Name) {
    $nodes=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Variable.VariablePath.UserPath -ceq $Name},$true))
    if($nodes.Count -ne 1){throw ('PREPARE_LOOP_NOT_UNIQUE: '+$Name)}
    return $nodes[0]
}
$allowlist=Get-PrepareAssignment 'scriptLists';$copyLoop=Get-PrepareLoop 'componentName'
$compiler=Get-PrepareAssignment 'framework';$compileLoop=Get-PrepareLoop 'native'
$copyScripts=[scriptblock]::Create($allowlist.Extent.Text+"`n"+$copyLoop.Extent.Text)
$compileNative=[scriptblock]::Create($ast.Extent.Text.Substring($compiler.Extent.StartOffset,$compileLoop.Extent.EndOffset-$compiler.Extent.StartOffset))
Check-Package ($compileLoop.Extent.EndOffset -lt (Get-PrepareAssignment 'trees').Extent.StartOffset) 'NATIVE_OUTPUT_MUST_PRECEDE_TREE_HASHES'
$fixture=Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) '.tmp') ('r1-prepare-'+[guid]::NewGuid().ToString('N'))
$managerSource=$cc
try {
    $CandidateRoot=Join-Path $fixture 'candidate';$PackageRoot=Join-Path $fixture 'package'
    $cc=Join-Path $PackageRoot 'mcp_control_center';$bridge=Join-Path $PackageRoot 'codex_bridge'
    [void][IO.Directory]::CreateDirectory((Join-Path $cc 'src'))
    [void][IO.Directory]::CreateDirectory($bridge)
    $verifier=Import-Module (Join-Path $managerSource 'src\McpControlCenter.InstalledRelease.psm1') -Force -PassThru
    . ([scriptblock]::Create($allowlist.Extent.Text))
    Check-Package (@($scriptLists.codex_bridge | Where-Object {$_ -ceq 'powershell-host-transport.ps1'}).Count -eq 1) 'HOST_TRANSPORT_ALLOWLIST_MISSING'
    foreach($component in $scriptLists.Keys){
        $scripts=Join-Path $CandidateRoot ($component+'\scripts');[void][IO.Directory]::CreateDirectory($scripts)
        foreach($name in $scriptLists[$component]){[IO.File]::WriteAllText((Join-Path $scripts $name),'throw "FIXTURE_MUST_NOT_EXECUTE"')}
    }
    $transport=Join-Path $CandidateRoot 'codex_bridge\scripts\powershell-host-transport.ps1'
    # A file outside CandidateRoot must never supply a missing allowlisted input.
    $transportBytes=[IO.File]::ReadAllBytes($transport);[IO.File]::Delete($transport)
    Denied-Package {& $copyScripts} 'PathNotFound|ItemNotFound'
    [IO.File]::WriteAllBytes($transport,$transportBytes)
    Clear-PackageScripts
    # Synthetic reparse metadata; no junction creation, privilege or ACL change.
    & $verifier {
        param($p)
        $script:packageReparse=$p
        function script:Get-Item {param($LiteralPath,[switch]$Force)
            if($LiteralPath -eq $script:packageReparse){return [pscustomobject]@{Attributes=[IO.FileAttributes]::ReparsePoint}}
            Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force
        }
    } (Split-Path -Parent $transport)
    Denied-Package {& $copyScripts} 'INSTALLED_REPARSE_REJECTED'
    & $verifier {Remove-Item Function:\Get-Item}
    Clear-PackageScripts
    & $copyScripts
    Check-Package ([IO.File]::ReadAllText((Join-Path $bridge 'scripts\powershell-host-transport.ps1')) -ceq [IO.File]::ReadAllText($transport)) 'TRANSPORT_COPY_MISMATCH'
    $normalSources=@('NormalOperator.Native.cs','NormalOperator.Pipe.cs','NormalOperator.Security.cs','NormalOperator.Execution.cs','NormalOperator.Host.cs')
    foreach($name in @('RemoteSelfReload.Native.cs','InstalledRelease.Native.cs')+$normalSources){
        Copy-Item -LiteralPath (Join-Path $managerSource ('src\'+$name)) -Destination (Join-Path $cc ('src\'+$name))
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\scripts\OwnedProcess.Native.cs') -Destination (Join-Path $bridge 'scripts\OwnedProcess.Native.cs') -Force
    # A poisoned extra C# file proves the compiler uses the fixed five-file list.
    [IO.File]::WriteAllText((Join-Path $cc 'src\NormalOperator.Unlisted.cs'),'NOT VALID C#')
    . ([scriptblock]::Create((Get-PrepareAssignment 'nativeBuilds').Extent.Text))
    $hostBuild=@($nativeBuilds | Where-Object {(Split-Path -Leaf $_.output) -ceq 'NormalOperator.Host.dll'})
    Check-Package ($nativeBuilds.Count -eq 4 -and $hostBuild.Count -eq 1 -and
        (($hostBuild[0].sources | ForEach-Object {Split-Path -Leaf $_}) -join ',') -ceq ($normalSources -join ',')) 'HOST_NATIVE_SOURCE_SET_CHANGED'
    $outputs=@($nativeBuilds | ForEach-Object {$_.output})
    foreach($output in $outputs){
        [IO.File]::WriteAllText($output,'prebuilt sentinel')
        Denied-Package {& $compileNative} 'PREBUILT_NATIVE_OUTPUT_REJECTED'
        Check-Package ([IO.File]::ReadAllText($output) -ceq 'prebuilt sentinel') 'PREBUILT_OUTPUT_OVERWRITTEN'
        foreach($built in $outputs){if(Test-Path -LiteralPath $built){[IO.File]::Delete($built)}}
    }
    foreach($name in $normalSources){
        $missing=Join-Path $cc ('src\'+$name);$bytes=[IO.File]::ReadAllBytes($missing);[IO.File]::Delete($missing)
        Denied-Package {& $compileNative} 'PathNotFound|ItemNotFound'
        Check-Package (-not(Test-Path -LiteralPath $hostBuild[0].output)) 'MISSING_SOURCE_PRODUCED_HOST_DLL'
        [IO.File]::WriteAllBytes($missing,$bytes)
        foreach($built in $outputs){if(Test-Path -LiteralPath $built){[IO.File]::Delete($built)}}
    }
    & $verifier {
        param($p)
        $script:packageReparse=$p
        function script:Get-Item {param($LiteralPath,[switch]$Force)
            if($LiteralPath -eq $script:packageReparse){return [pscustomobject]@{Attributes=[IO.FileAttributes]::ReparsePoint}}
            Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force
        }
    } (Join-Path $cc 'src\NormalOperator.Host.cs')
    Denied-Package {& $compileNative} 'INSTALLED_REPARSE_REJECTED'
    & $verifier {Remove-Item Function:\Get-Item}
    foreach($built in $outputs){if(Test-Path -LiteralPath $built){[IO.File]::Delete($built)}}
    $brokenSource=Join-Path $cc 'src\NormalOperator.Host.cs';$bytes=[IO.File]::ReadAllBytes($brokenSource)
    [IO.File]::WriteAllText($brokenSource,'NOT VALID C#')
    Denied-Package {& $compileNative} 'NATIVE_COMPILE_FAILED'
    Check-Package (-not(Test-Path -LiteralPath $hostBuild[0].output)) 'FAILED_COMPILE_PRODUCED_HOST_DLL'
    [IO.File]::WriteAllBytes($brokenSource,$bytes)
    foreach($built in $outputs){if(Test-Path -LiteralPath $built){[IO.File]::Delete($built)}}
    & $compileNative
    foreach($built in $outputs){Check-Package (Test-Path -LiteralPath $built -PathType Leaf) 'NATIVE_OUTPUT_MISSING'}
    # Metadata only: no Add-Type/LoadFrom, Host method, candidate script or DLL execution.
    # Loading bytes also avoids retaining a Windows file lock on the disposable DLL.
    $assembly=[Reflection.Assembly]::ReflectionOnlyLoad([IO.File]::ReadAllBytes($hostBuild[0].output))
    Check-Package ($assembly.ImageRuntimeVersion -ceq 'v4.0.30319' -and $assembly.GetName().Name -ceq 'NormalOperator.Host') 'HOST_FRAMEWORK_ASSEMBLY_MISMATCH'
    foreach($name in @('McpCcNormalNative','McpCcNormalPipe','McpCcNormalSecurity','McpCcNormalExecution','McpCcNormalHost')){
        $type=$assembly.GetType($name,$true)
        Check-Package ($type.Assembly -eq $assembly) 'HOST_TYPES_MUST_SHARE_ASSEMBLY'
    }
    # Real tree hashing and closure mismatch rejection, with only protected-ACL/native
    # acquisition replaced by the existing digest-only fixture. Not OS acceptance.
    [void][IO.Directory]::CreateDirectory((Join-Path $PackageRoot 'dependencies'))
    & $verifier {
        function script:Assert-McpCcProtectedCodePath {param($Path) Assert-McpCcNoReparseChain $Path}
        function script:Get-McpCcInstalledNativeTreeHash {param($Release,$Name)
            [McpCcInstalledHashFixture]::VerifyTree((Join-Path $Release.root $Name))
        }
    }
    $trees=@{};foreach($component in @('mcp_control_center','codex_bridge','dependencies')){
        $componentRoot=Join-Path $PackageRoot $component
        $trees[$component]=& $verifier {param($p) Get-McpCcInstalledTreeHash $p} $componentRoot
        Check-Package ([McpCcInstalledHashFixture]::VerifyTree($componentRoot) -ceq $trees[$component]) 'PACKAGE_NATIVE_TREE_HASH_MISMATCH'
    }
    $release=[pscustomobject]@{root=$PackageRoot;sourcePath=$hostBuild[0].output;schemaVersion=3;treeHashes=$trees}
    foreach($target in @($hostBuild[0].output,(Join-Path $bridge 'scripts\powershell-host-transport.ps1'),(Join-Path $cc 'src\NormalOperator.Host.cs'))){
        # Use an unchanged existing file for the preliminary manifest path guard.
        $release.sourcePath=Join-Path $cc 'src\InstalledRelease.Native.cs'
        $bytes=[IO.File]::ReadAllBytes($target)
        [IO.File]::AppendAllText($target,'tampered')
        Denied-Package {Assert-McpCcInstalledClosure $release} 'INSTALLED_TREE_HASH_MISMATCH'
        [IO.File]::Delete($target)
        Denied-Package {Assert-McpCcInstalledClosure $release} 'INSTALLED_TREE_HASH_MISMATCH'
        [IO.File]::WriteAllBytes($target,$bytes)
    }
} finally {
    $resolved=[IO.Path]::GetFullPath($fixture)
    if((Split-Path -Parent $resolved) -ine (Join-Path (Split-Path -Parent $PSScriptRoot) '.tmp') -or (Split-Path -Leaf $resolved) -cnotmatch '^r1-prepare-[0-9a-f]{32}$'){throw 'UNSAFE_FIXTURE_CLEANUP'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
    if($verifier){Remove-Module $verifier}
}
$runtime=Import-Module (Join-Path $PSScriptRoot '..\scripts\codex-bridge-runtime.psm1') -PassThru
$idleCases=& $runtime {
    function script:Get-CbHealth {param($Context) $script:operatorHealthFixture}
    $result=@()
    foreach($jobs in @(@{scope='all';active=0;awaitingApproval=0},@{active=0;awaitingApproval=0},@{scope='all';active=$null;awaitingApproval=0},@{scope='all';active=1;awaitingApproval=0})){
        $script:operatorHealthFixture=[pscustomobject]@{jobs=[pscustomobject]$jobs;controller='ready'}
        try{Assert-CbIdleForMutation ([pscustomobject]@{requireAllJobs=$true});$result+='ALLOW'}catch{$result+=$_.Exception.Message.Split(':')[0]}
    };$result
}
if(($idleCases -join ',') -cne 'ALLOW,ACTIVE_STATE_UNKNOWN,ACTIVE_STATE_UNKNOWN,ACTIVE_WORK_PRESENT'){throw 'OPERATOR_IDLE_GATE_REGRESSION'};$passed+=4
[pscustomobject]@{ok=$true;assertions=$passed;nativeHashParity=$true;prepareNativeCompile='PASS';hostAssembly='METADATA_ONLY';
    reparse='SYNTHETIC';nativeOrAclMutation=$false;archiveExtraction=$false;productionTouched=$false}|ConvertTo-Json
