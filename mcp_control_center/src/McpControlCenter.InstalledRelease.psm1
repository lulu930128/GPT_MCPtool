Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'

# Fixed layout, never a manifest-provided command, executable or DLL search path.
$script:InstalledComponentFolders=[ordered]@{
    project_reading='project_reading'; omi_search='OMI_search'; japanese_study='japanese_study'
    memory_core='Memory Core'; codex_bridge='codex_bridge'; personal_asset_os='personal-asset-os'
    english_study='english_study'; listening_audio='listening_audio'
}
function Assert-McpCcInstalledFields($Value,[string[]]$Names) {
    if ($null -eq $Value -or $Value -is [string] -or
        (@($Value.PSObject.Properties.Name | Sort-Object) -join ',') -cne (@($Names | Sort-Object) -join ',')) {
        throw 'INSTALLED_MANIFEST_INVALID'
    }
}
function Assert-McpCcInstalledAbsolutePath([string]$Path) {
    # Local drive paths only; reject ADS, provider paths, dot segments, aliases and UNC.
    if ($Path -cnotmatch '^[A-Za-z]:\\[^/:*?"<>|]+$' -or
        $Path -match '(^|\\)\.{1,2}(\\|$)|[ .](\\|$)|\\\\' -or
        [IO.Path]::GetFullPath($Path).TrimEnd('\') -cne $Path) { throw 'INSTALLED_PATH_INVALID' }
}
function Assert-McpCcNoReparseChain([string]$Path) {
    $cursor=[IO.Path]::GetFullPath($Path)
    while ($cursor) {
        $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'INSTALLED_REPARSE_REJECTED' }
        $cursor=Split-Path -Parent $cursor
    }
}
function Assert-McpCcProtectedAcl($Acl,[switch]$Ancestor,[switch]$VolumeRoot) {
    # Windows servicing owns protected Program Files ancestors on real installations.
    # Trust the exact service SID, never a localized account name or arbitrary owner.
    $trusted=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    if ($Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'PROTECTED_OWNER_REQUIRED' }
    # A null DACL grants full access; no implicit accept on an empty rule enumeration.
    $raw=New-Object Security.AccessControl.RawSecurityDescriptor($Acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All))
    if ($null -eq $raw.DiscretionaryAcl) { throw 'PROTECTED_DACL_REQUIRED' }
    $write=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($ace in $Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        # Creating a new sibling under C:\ does not authorize replacing an existing
        # protected child. Inherit-only ancestor ACEs do not apply to the ancestor.
        if ($Ancestor -and ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
        $mask=if ($VolumeRoot) { $write -band (-bnot 6) } else { $write }
        # Deliberately conservative, including inherit-only ACEs: descendants are authority too.
        if ($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Value -notin $trusted -and ($ace.FileSystemRights -band $mask)) {
            throw 'PROTECTED_WRITE_REJECTED'
        }
    }
}
function Assert-McpCcProtectedCodePath([string]$Path) {
    $cursor=[IO.Path]::GetFullPath($Path)
    $first=$true
    while ($cursor) {
        $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'INSTALLED_REPARSE_REJECTED' }
        Assert-McpCcProtectedAcl (Get-Acl -LiteralPath $cursor -ErrorAction Stop) -Ancestor:(-not $first) -VolumeRoot:($cursor -eq [IO.Path]::GetPathRoot($cursor))
        $first=$false
        $cursor=Split-Path -Parent $cursor
    }
}
function Assert-McpCcProtectedCodeTree([string]$Path) {
    Assert-McpCcProtectedCodePath $Path
    # Ancestors are checked once per tree, with no cross-call cache. Only protected parents
    # enter the queue. Recheck all entries on every gate invocation; no warm-cache bypass.
    $queue=New-Object 'Collections.Generic.Stack[string]'
    $queue.Push($Path);$count=0
    while ($queue.Count -gt 0) {
        $directory=$queue.Pop()
        foreach ($child in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
            if (++$count -gt 100000) { throw 'INSTALLED_TREE_LIMIT' }
            if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'INSTALLED_REPARSE_REJECTED' }
            Assert-McpCcProtectedAcl (Get-Acl -LiteralPath $child.FullName -ErrorAction Stop)
            if ($child.PSIsContainer) { $queue.Push($child.FullName) }
        }
    }
}
function Read-McpCcInstalledRelease([string]$ManagerRoot) {
    $manager=[IO.Path]::GetFullPath($ManagerRoot).TrimEnd('\')
    Assert-McpCcInstalledAbsolutePath $manager
    if ((Split-Path -Leaf $manager) -cne 'mcp_control_center') { throw 'INSTALLED_MANAGER_PATH_INVALID' }
    $root=Split-Path -Parent $manager
    $path=Join-Path $manager 'config\installed-release.json'
    Assert-McpCcNoReparseChain $path
    if ((Get-Item -LiteralPath $path).Length -gt 16384) { throw 'INSTALLED_MANIFEST_LIMIT' }
    $release=Get-Content -LiteralPath $path -Encoding UTF8 -Raw | ConvertFrom-Json
    $version=$release.schemaVersion
    $fields=@('contract','schemaVersion','releaseId','legacyWorkspaceRoot','dependencies')
    if ($version -ge 2) { $fields+=@('state','treeHashes') }
    if ($version -ge 3) { $fields+='cutover' }
    if ($version -ge 4) { $fields+='deployment' }
    Assert-McpCcInstalledFields $release $fields
    if ($version -isnot [int] -or $version -notin @(1,2,3,4,5,6) -or $release.contract -cne "mcpcc-installed-release-v$version" -or
        $release.releaseId -isnot [string] -or $release.releaseId -cnotmatch '^[a-z0-9][a-z0-9._-]{0,63}$' -or
        (Split-Path -Leaf $root) -cne $release.releaseId) { throw 'INSTALLED_MANIFEST_INVALID' }
    Assert-McpCcInstalledAbsolutePath $release.legacyWorkspaceRoot
    Assert-McpCcNoReparseChain $release.legacyWorkspaceRoot
    $legacy=[string]$release.legacyWorkspaceRoot
    if ($root.StartsWith($legacy+'\',[StringComparison]::OrdinalIgnoreCase) -or $root -ieq $legacy -or
        $legacy.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'INSTALLED_WORKSPACE_OVERLAP' }
    $dependencyPaths=[ordered]@{node='dependencies\node\node.exe';tunnelClient='dependencies\tunnel-client\tunnel-client.exe';keyStore='dependencies\key-store\key-store.ps1'}
    if ($version -ge 2) {
        # This candidate supports the existing Windows x64 package layout only. No require.resolve
        # fallback to an ancestor node_modules, caller binary, or alternate platform package.
        $dependencyPaths.codexLauncher='codex_bridge\node_modules\@openai\codex\bin\codex.js'
        $dependencyPaths.codexNative='codex_bridge\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
    }
    if($version -ge 3){$dependencyPaths.releaseVerifier='mcp_control_center\src\InstalledRelease.Native.dll'}
    Assert-McpCcInstalledFields $release.dependencies @($dependencyPaths.Keys)
    $dependencies=@{}
    foreach ($name in $dependencyPaths.Keys) {
        $hash=$release.dependencies.$name
        if ($hash -isnot [string] -or $hash -cnotmatch '^[0-9a-f]{64}$') { throw 'INSTALLED_DEPENDENCY_HASH_INVALID' }
        $dependencies[$name]=[pscustomobject]@{path=(Join-Path $root $dependencyPaths[$name]);sha256=$hash}
    }
    $state=$null;$trees=$null
    if ($version -ge 2) {
        $stateFields=@('operatorSid','userProfile','localAppData','dataDir','projectsFile','codexHome')
        if($version -ge 5){$stateFields+='ownerRoot'}
        Assert-McpCcInstalledFields $release.state $stateFields
        if ($release.state.operatorSid -isnot [string] -or $release.state.operatorSid -cnotmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { throw 'INSTALLED_OPERATOR_INVALID' }
        foreach ($name in @($stateFields | Where-Object {$_ -ne 'operatorSid'})) {
            if ($release.state.$name -isnot [string]) { throw 'INSTALLED_STATE_INVALID' }
            Assert-McpCcInstalledAbsolutePath $release.state.$name
            $p=[string]$release.state.$name
            if ($p -ieq $root -or $p.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase) -or
                $root.StartsWith($p+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'INSTALLED_STATE_CODE_OVERLAP' }
        }
        Assert-McpCcInstalledFields $release.treeHashes @('mcp_control_center','codex_bridge','dependencies')
        foreach ($name in @('mcp_control_center','codex_bridge','dependencies')) {
            if ($release.treeHashes.$name -isnot [string] -or $release.treeHashes.$name -cnotmatch '^[0-9a-f]{64}$') { throw 'INSTALLED_TREE_HASH_INVALID' }
        }
        $state=$release.state;$trees=$release.treeHashes
        if($version -eq 5 -and ($state.ownerRoot -cne 'C:\McpControlCenter' -or $state.dataDir -cne 'C:\CodexBridge')) { throw 'INSTALLED_STATE_SCOPE_REJECTED' }
        if($version -eq 6 -and ($state.ownerRoot -cne (Join-Path $legacy 'mcp_control_center\.local\runtime') -or
            $state.dataDir -cne (Join-Path $legacy 'codex_bridge\.local\runtime'))) { throw 'INSTALLED_STATE_SCOPE_REJECTED' }
    }
    $cutover=$null
    if ($version -ge 3) {
        Assert-McpCcInstalledFields $release.cutover @('httpTokenSha256','tunnelProfileSha256','rollbackBuildId','legacyStartupSha256')
        foreach ($name in @('tunnelProfileSha256','legacyStartupSha256')) {
            if ($release.cutover.$name -isnot [string] -or $release.cutover.$name -cnotmatch '^[0-9a-f]{64}$') { throw 'INSTALLED_CUTOVER_INVALID' }
        }
        if ($release.cutover.httpTokenSha256 -isnot [string] -or $release.cutover.httpTokenSha256 -cnotmatch '^([0-9a-f]{64})?$' -or
            $release.cutover.rollbackBuildId -isnot [string] -or $release.cutover.rollbackBuildId -cnotmatch '^[0-9a-f]{16}$') { throw 'INSTALLED_CUTOVER_INVALID' }
        $cutover=$release.cutover
    }
    $deployment=$null
    if ($version -ge 4) {
        Assert-McpCcInstalledFields $release.deployment @('contract','projectsSha256','credentialSha256')
        if ($release.deployment.contract -cne 'bridge-private-snapshot-v1') { throw 'INSTALLED_DEPLOYMENT_INVALID' }
        foreach ($name in @('projectsSha256','credentialSha256')) {
            if ($release.deployment.$name -isnot [string] -or $release.deployment.$name -cnotmatch '^[0-9a-f]{64}$') { throw 'INSTALLED_DEPLOYMENT_INVALID' }
        }
        # Shared Codex home is an input to the sandboxed Codex process, never Host
        # authority. The private stores stay at their original canonical location.
        if ($state.codexHome -ine (Join-Path $state.userProfile '.codex') -or
            $state.projectsFile -ine (Join-Path $legacy 'codex_bridge\.local\projects.json')) { throw 'INSTALLED_STATE_SCOPE_REJECTED' }
        $deployment=$release.deployment
    }
    return [pscustomobject]@{contract=$release.contract;schemaVersion=$version;releaseId=$release.releaseId;root=$root;managerRoot=$manager;
        sourcePath=$path;legacyWorkspaceRoot=$legacy;dependencies=$dependencies;
        state=$state;treeHashes=$trees;cutover=$cutover;deployment=$deployment;
        activationReady=$false;blocker='INSTALLED_LIFECYCLE_BINDINGS_REQUIRED'}
}
function Get-McpCcInstalledStateRoot($Release) {
    # Layout only; callers still perform closure, operator and private ACL gates.
    if($Release.schemaVersion -eq 6){
        if($Release.state.ownerRoot -cne (Join-Path $Release.legacyWorkspaceRoot 'mcp_control_center\.local\runtime') -or
            $Release.state.dataDir -cne (Join-Path $Release.legacyWorkspaceRoot 'codex_bridge\.local\runtime')){throw 'INSTALLED_STATE_SCOPE_REJECTED'}
        return [string]$Release.state.ownerRoot
    }
    if($Release.schemaVersion -eq 5){
        if($Release.state.ownerRoot -cne 'C:\McpControlCenter'){throw 'INSTALLED_STATE_SCOPE_REJECTED'}
        return [string]$Release.state.ownerRoot
    }
    return Join-Path $Release.state.localAppData 'McpControlCenter'
}
function Resolve-McpCcInstalledComponentRoot($Release,[string]$Id,[string]$RootToken) {
    if (-not $script:InstalledComponentFolders.Contains($Id) -or $RootToken -cne $Id) { throw 'INSTALLED_COMPONENT_NOT_ALLOWED' }
    $parent=if ($Id -ceq 'codex_bridge') { $Release.root } else { $Release.legacyWorkspaceRoot }
    $root=Join-Path $parent $script:InstalledComponentFolders[$Id]
    Assert-McpCcNoReparseChain $root
    return $root
}
function Get-McpCcInstalledTreeHash([string]$Path) {
    # Length-bounded inventory, ordinal order, fixed relative paths + file SHA256. The manifest
    # alone is excluded to avoid self-reference; registry and every other byte remain bound.
    $rows=New-Object 'Collections.Generic.List[string]'
    $queue=New-Object 'Collections.Generic.Stack[string]';$queue.Push($Path);$count=0
    while ($queue.Count -gt 0) {
        foreach ($child in Get-ChildItem -LiteralPath $queue.Pop() -Force -ErrorAction Stop) {
            if (++$count -gt 100000) { throw 'INSTALLED_TREE_LIMIT' }
            if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'INSTALLED_REPARSE_REJECTED' }
            $relative=$child.FullName.Substring($Path.Length+1).Replace('\','/')
            if ($relative -ceq 'config/installed-release.json' -and (Split-Path -Leaf $Path) -ceq 'mcp_control_center') { continue }
            if ($child.PSIsContainer) { $rows.Add('D '+$relative);$queue.Push($child.FullName) }
            else { $rows.Add('F '+$relative+' '+(Get-FileHash -LiteralPath $child.FullName -Algorithm SHA256).Hash.ToLowerInvariant()) }
        }
    }
    $rows.Sort([StringComparer]::Ordinal)
    $hash=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes(($rows -join "`n")+"`n")))).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose() }
}
function Assert-McpCcInstalledClosure($Release) {
    # The fixed executable/helper hashes pin dependencies; the entire immutable tree (including
    # node DLLs, CC core/tray/IPC and Bridge dist/web/scripts/node_modules) must also be protected.
    Assert-McpCcProtectedCodePath $Release.sourcePath
    foreach ($name in @('mcp_control_center','codex_bridge','dependencies')) {
        if($Release.schemaVersion -ge 3){$digest=Get-McpCcInstalledNativeTreeHash $Release $name}
        else{Assert-McpCcProtectedCodeTree (Join-Path $Release.root $name);$digest=Get-McpCcInstalledTreeHash (Join-Path $Release.root $name)}
        if ($Release.schemaVersion -ge 2 -and $digest -cne $Release.treeHashes.$name) {
            throw 'INSTALLED_TREE_HASH_MISMATCH'
        }
    }
    foreach ($required in @('mcp_control_center\src\McpControlCenter.Core.psm1','mcp_control_center\src\RemoteSelfReload.Native.cs',
        'mcp_control_center\scripts\tray.ps1','mcp_control_center\config\registry.json',
        'codex_bridge\scripts\runtime-control.ps1','codex_bridge\scripts\codex-bridge-runtime.psm1',
        'codex_bridge\scripts\OwnedProcess.Native.cs','codex_bridge\scripts\self-reload-pipe-client.ps1',
        'codex_bridge\dist\src\http-main.js','codex_bridge\web\self-reload.html','codex_bridge\package.json',
        'codex_bridge\package-lock.json','codex_bridge\node_modules\@openai\codex\bin\codex.js')) {
        $path=Join-Path $Release.root $required
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'INSTALLED_CODE_MISSING' }
        Assert-McpCcProtectedCodePath $path
    }
    foreach ($name in $Release.dependencies.Keys) {
        $dependency=$Release.dependencies[$name]
        Assert-McpCcProtectedCodePath $dependency.path
        if ((Get-FileHash -LiteralPath $dependency.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $dependency.sha256) {
            throw 'INSTALLED_DEPENDENCY_HASH_MISMATCH'
        }
    }
    if($Release.schemaVersion -ge 3){
        foreach($relative in @('mcp_control_center\src\RemoteSelfReload.Native.dll','codex_bridge\scripts\OwnedProcess.Native.dll')){
            if(-not(Test-Path -LiteralPath (Join-Path $Release.root $relative) -PathType Leaf)){throw 'INSTALLED_NATIVE_ASSEMBLY_MISSING'}
        }
    }
}
function Get-McpCcInstalledNativeTreeHash($Release,[string]$Name) {
    # A protected operator may inspect a previous release as data. Keep one
    # verifier assembly from the physically loaded module's own release; loading
    # the previous DLL would collide with the already loaded .NET type. The
    # target release still passes its original tree/ACL/dependency hash checks.
    $verifierRelease=$Release
    $managerRoot=Split-Path -Parent $PSScriptRoot
    if(Test-Path -LiteralPath (Join-Path $managerRoot 'config\installed-release.json')){
        $verifierRelease=Read-McpCcInstalledRelease $managerRoot
    }
    $native=$verifierRelease.dependencies.releaseVerifier
    Assert-McpCcProtectedCodePath $native.path
    if((Get-FileHash -LiteralPath $native.path).Hash.ToLowerInvariant() -cne $native.sha256){throw 'INSTALLED_DEPENDENCY_HASH_MISMATCH'}
    if(-not('McpCcInstalledTree' -as [type])){Add-Type -Path $native.path}
    if([McpCcInstalledTree].Assembly.Location -ine $native.path){throw 'INSTALLED_LOADED_VERIFIER_MISMATCH'}
    $path=Join-Path $Release.root $Name
    Assert-McpCcProtectedCodePath $path
    return [McpCcInstalledTree]::VerifyTree($path)
}
function Assert-McpCcInstalledPrivatePath([string]$Path,[string]$OwnerSid,[switch]$IntegrityOnly) {
    # Every ancestor resists replacement; the target itself also denies foreign reads.
    # Do not create directories or modify ACLs in a verifier.
    $cursor=$Path;$first=$true
    $trusted=@($OwnerSid,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    $write=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    while ($cursor) {
        $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'INSTALLED_REPARSE_REJECTED' }
        $acl=Get-Acl -LiteralPath $cursor -ErrorAction Stop
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'INSTALLED_PRIVATE_OWNER_REQUIRED' }
        $raw=New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All))
        if ($null -eq $raw.DiscretionaryAcl) { throw 'PROTECTED_DACL_REQUIRED' }
        $volumeRoot=$cursor -eq [IO.Path]::GetPathRoot($cursor)
        foreach ($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
            # PlanState checks the volume root directly as the data directory's
            # parent. Inherit-only ACEs cannot replace that root. Keep checking
            # inherited/effective rules on the actual state directory, and keep
            # the stricter child-inheritance policy for every private target.
            if ((-not $first -or ($IntegrityOnly -and $volumeRoot)) -and ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
            $replace=if($volumeRoot){$write -band (-bnot 6)}else{$write}
            if ($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Value -notin $trusted -and (($first -and -not $IntegrityOnly) -or ($ace.FileSystemRights -band $replace))) { throw 'INSTALLED_PRIVATE_ACL_REJECTED' }
        }
        $first=$false;$cursor=Split-Path -Parent $cursor
    }
}
function Test-McpCcInstalledAclWrite($Observed,$Expected) {
    # NTFS may set SE_DACL_AUTO_INHERITED after Set-Acl, even for a protected
    # DACL. It is bookkeeping, not an ACE or permission. Compare all remaining
    # control flags, owner/group and exact DACL bytes; never normalize ACE rights,
    # order, inheritance flags, Deny entries or the protection bit.
    $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
    $actual=New-Object Security.AccessControl.RawSecurityDescriptor($Observed.GetSecurityDescriptorSddlForm($sections))
    $wanted=New-Object Security.AccessControl.RawSecurityDescriptor($Expected.GetSecurityDescriptorSddlForm($sections))
    if($null -eq $actual.DiscretionaryAcl -or $null -eq $wanted.DiscretionaryAcl -or
        -not $Observed.AreAccessRulesProtected -or -not $Expected.AreAccessRulesProtected -or
        -not $Observed.AreAccessRulesCanonical -or -not $Expected.AreAccessRulesCanonical -or
        $actual.Owner.Value -cne $wanted.Owner.Value -or $actual.Group.Value -cne $wanted.Group.Value){return $false}
    $mask=-bnot [int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited
    if(([int]$actual.ControlFlags -band $mask) -ne ([int]$wanted.ControlFlags -band $mask)){return $false}
    $a=New-Object byte[] $actual.DiscretionaryAcl.BinaryLength;$actual.DiscretionaryAcl.GetBinaryForm($a,0)
    $b=New-Object byte[] $wanted.DiscretionaryAcl.BinaryLength;$wanted.DiscretionaryAcl.GetBinaryForm($b,0)
    return [Convert]::ToBase64String($a) -ceq [Convert]::ToBase64String($b)
}
function Get-McpCcInstalledPrivateAcl($Acl,[string]$OwnerSid,[bool]$Directory,$AdditionalDenyAcl=$null) {
    # Pure transformation for the independent operator. No verifier changes ACLs.
    # Keep every Deny (including inherited platform rules); only remove foreign
    # Allows. Do not interpret a Deny as permission to ignore an unsafe Allow.
    $trusted=@($OwnerSid,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    if ($Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'INSTALLED_PRIVATE_OWNER_REQUIRED' }
    $sddl=$Acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group)
    $raw=New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
    if ($null -eq $raw.DiscretionaryAcl) { throw 'PROTECTED_DACL_REQUIRED' }
    $copy=if($Directory){New-Object Security.AccessControl.DirectorySecurity}else{New-Object Security.AccessControl.FileSecurity}
    $aces=@($raw.DiscretionaryAcl)
    if($null -ne $AdditionalDenyAcl){
        # Migration retains source Deny AND destination-inherited Deny. Source
        # Allow/owner/group never grant authority over the new destination.
        if($AdditionalDenyAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted){throw 'INSTALLED_PRIVATE_OWNER_REQUIRED'}
        $extra=New-Object Security.AccessControl.RawSecurityDescriptor($AdditionalDenyAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group))
        if($null -eq $extra.DiscretionaryAcl){throw 'PROTECTED_DACL_REQUIRED'}
        foreach($ace in $extra.DiscretionaryAcl){
            if($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or $ace.AceQualifier -notin @('AccessDenied','AccessAllowed')){throw 'UNSUPPORTED_PRIVATE_ACE'}
            if($ace.AceQualifier -eq 'AccessDenied'){$aces+=@($ace)}
        }
    }
    $dacl=New-Object Security.AccessControl.RawAcl($raw.DiscretionaryAcl.Revision,($aces.Count+3))
    # Promoting inherited rules in-place can leave Deny after explicit Allow,
    # which .NET refuses to edit. Rebuild in canonical order without dropping any
    # Deny, rights or inheritance/propagation flags. Unknown ACE forms fail closed.
    foreach($ace in $aces){
        if($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or
            $ace.AceQualifier -notin @('AccessDenied','AccessAllowed')){throw 'UNSUPPORTED_PRIVATE_ACE'}
    }
    foreach($kind in @('AccessDenied','AccessAllowed')){
        foreach($ace in $aces){
            if($ace.AceQualifier -ne $kind -or ($kind -eq 'AccessAllowed' -and $ace.SecurityIdentifier.Value -notin $trusted)){continue}
            # AddAccessRule merges separate self/child Deny ACEs. Retain the raw
            # rules instead, changing only the inherited marker on promotion.
            $flags=[Security.AccessControl.AceFlags]([int]$ace.AceFlags -band (-bnot [int][Security.AccessControl.AceFlags]::Inherited))
            $dacl.InsertAce($dacl.Count,(New-Object Security.AccessControl.CommonAce($flags,$ace.AceQualifier,$ace.AccessMask,$ace.SecurityIdentifier,$false,$null)))
        }
    }
    $inherit=if($Directory){[Security.AccessControl.AceFlags]([int][Security.AccessControl.AceFlags]::ContainerInherit -bor [int][Security.AccessControl.AceFlags]::ObjectInherit)}else{[Security.AccessControl.AceFlags]::None}
    $full=[int][Security.AccessControl.FileSystemRights]::FullControl
    foreach($sid in @($OwnerSid,'S-1-5-18','S-1-5-32-544')) {
        $exists=@($dacl|Where-Object{$_.AceQualifier -eq 'AccessAllowed' -and $_.SecurityIdentifier.Value -ceq $sid -and $_.AceFlags -eq $inherit -and $_.AccessMask -eq $full}).Count -gt 0
        if(-not $exists){$dacl.InsertAce($dacl.Count,(New-Object Security.AccessControl.CommonAce($inherit,[Security.AccessControl.AceQualifier]::AccessAllowed,$full,(New-Object Security.Principal.SecurityIdentifier($sid)),$false,$null)))}
    }
    $flags=[Security.AccessControl.ControlFlags](([int]$raw.ControlFlags -bor [int][Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -band
        (-bnot ([int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited -bor [int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInheritRequired)))
    $result=New-Object Security.AccessControl.RawSecurityDescriptor($flags,$raw.Owner,$raw.Group,$null,$dacl)
    $bytes=New-Object byte[] $result.BinaryLength;$result.GetBinaryForm($bytes,0)
    $copy.SetSecurityDescriptorBinaryForm($bytes,[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group)
    return $copy
}
function Get-McpCcInstalledDeploymentFiles($Release,[string]$RuntimeRoot) {
    if ($Release.schemaVersion -notin @(4,5,6)) { throw 'INSTALLED_DEPLOYMENT_REQUIRED' }
    $root=Join-Path $RuntimeRoot 'deployment'
    return @(
        [pscustomobject]@{source=$Release.state.projectsFile;target=(Join-Path $root 'projects.json');sha256=$Release.deployment.projectsSha256;limit=65536},
        [pscustomobject]@{source=(Join-Path $Release.legacyWorkspaceRoot 'codex_bridge\.tunnel-client\codex-bridge.yaml');target=(Join-Path $root '.tunnel-client\codex-bridge.yaml');sha256=$Release.cutover.tunnelProfileSha256;limit=65536},
        [pscustomobject]@{source=(Join-Path $Release.legacyWorkspaceRoot 'project_reading\.secrets\control-plane-api-key.dpapi');target=(Join-Path $root '.secrets\control-plane-api-key.dpapi');sha256=$Release.deployment.credentialSha256;limit=65536}
    )
}
function Assert-McpCcInstalledStateReceipt([string]$RuntimeRoot,[string]$OwnerSid) {
    $path=Join-Path $RuntimeRoot 'state-binding.json'
    Assert-McpCcInstalledPrivatePath $path $OwnerSid
    if((Get-Item -LiteralPath $path).Length -gt 4096){throw 'INSTALLED_STATE_RECEIPT_INVALID'}
    $receipt=[IO.File]::ReadAllText($path,[Text.Encoding]::UTF8)|ConvertFrom-Json
    Assert-McpCcInstalledFields $receipt @('contract','phase','planSha256','backup')
    if($receipt.contract -cne 'installed-state-binding-v1' -or $receipt.phase -cne 'STATE_BOUND' -or
        $receipt.planSha256 -cnotmatch '^[0-9a-f]{64}$' -or $receipt.backup -ine (Join-Path $RuntimeRoot 'state-acl-before.json')) { throw 'INSTALLED_STATE_NOT_BOUND' }
}
function Get-McpCcInstalledOperator {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    return [pscustomobject]@{sid=$identity.User.Value;userProfile=[Environment]::GetFolderPath('UserProfile');
        localAppData=[Environment]::GetFolderPath('LocalApplicationData');windows=[Environment]::GetFolderPath('Windows');
        isAdmin=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}
}
function Get-McpCcInstalledBridgeBinding([string]$CodeRoot) {
    $manager=Join-Path (Split-Path -Parent $CodeRoot) 'mcp_control_center'
    if ($manager -ine (Split-Path -Parent $PSScriptRoot)) { throw 'INSTALLED_LOADED_ROOT_MISMATCH' }
    $release=Read-McpCcInstalledRelease $manager
    if ($release.schemaVersion -lt 2) { throw 'INSTALLED_BINDING_MANIFEST_REQUIRED' }
    if ($CodeRoot -ine (Join-Path $release.root 'codex_bridge')) { throw 'INSTALLED_LOADED_ROOT_MISMATCH' }
    Assert-McpCcInstalledClosure $release
    $operator=Get-McpCcInstalledOperator
    if ($operator.isAdmin -or $operator.sid -cne $release.state.operatorSid -or
        $operator.userProfile -ine $release.state.userProfile -or $operator.localAppData -ine $release.state.localAppData) { throw 'INSTALLED_OPERATOR_MISMATCH' }
    $configRoot=Join-Path $release.legacyWorkspaceRoot 'codex_bridge'
    $ownerRoot=Get-McpCcInstalledStateRoot $release
    $runtimeRoot=Join-Path $ownerRoot ('installed-bridge\'+$release.releaseId)
    $profile=Join-Path $configRoot '.tunnel-client'
    $secret=Join-Path $release.legacyWorkspaceRoot 'project_reading\.secrets\control-plane-api-key.dpapi'
    $projects=$release.state.projectsFile
    $privatePaths=@($runtimeRoot,$ownerRoot,$release.state.dataDir)
    if ($release.schemaVersion -ge 4) {
        Assert-McpCcInstalledStateReceipt $runtimeRoot $operator.sid
        $snapshots=@(Get-McpCcInstalledDeploymentFiles $release $runtimeRoot)
        $projects=$snapshots[0].target;$profile=Split-Path -Parent $snapshots[1].target;$secret=$snapshots[2].target
        # Shared home may be readable by sandbox users. It must still resist
        # foreign writes/replacement, and never supplies NORMAL authorization.
        Assert-McpCcInstalledPrivatePath $release.state.codexHome $operator.sid -IntegrityOnly
        foreach($file in $snapshots) {
            Assert-McpCcInstalledPrivatePath $file.target $operator.sid
            if ((Get-Item -LiteralPath $file.target).Length -gt $file.limit -or
                ($file.target -ine $secret -and
                (Get-FileHash -LiteralPath $file.target).Hash.ToLowerInvariant() -cne $file.sha256)) { throw 'INSTALLED_DEPLOYMENT_CHANGED' }
        }
        Assert-McpCcInstalledPrivateTree (Join-Path $release.state.dataDir 'powershell-approval') $operator.sid
    } else { $privatePaths+=@($release.state.codexHome) }
    # Control Center only checks credential metadata/ACL. Bridge verifies its
    # pinned ciphertext digest at deployment and again before the key-store read.
    foreach ($path in ($privatePaths+@($projects,$profile,$secret))) {
        Assert-McpCcInstalledPrivatePath $path $operator.sid
    }
    if ($release.schemaVersion -ge 3) {
        Assert-McpCcInstalledPrivateTree $runtimeRoot $operator.sid
        $profileFile=Join-Path $profile 'codex-bridge.yaml'
        Assert-McpCcInstalledPrivatePath $profileFile $operator.sid
        if ((Get-Item -LiteralPath $profileFile).Length -gt 65536 -or
            (Get-FileHash -LiteralPath $profileFile).Hash.ToLowerInvariant() -cne $release.cutover.tunnelProfileSha256) { throw 'INSTALLED_PROFILE_CHANGED' }
        if($release.schemaVersion -eq 6 -and $release.cutover.httpTokenSha256 -cne ''){
            # Runs during Tray Activation, before any listener or reconciliation.
            # Closure and operator were verified above. Credential IO/decryption
            # remains in the protected Bridge helper; this verifier only hashes env.
            $bearerHelper=Join-Path $release.root 'codex_bridge\scripts\bridge-bearer.ps1'
            Assert-McpCcProtectedCodePath $bearerHelper
            . $bearerHelper
            Set-CbInstalledBearerEnvironment $release $ExecutionContext.SessionState.Module
        }
        $token=[Environment]::GetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN','Process')
        $digest=Get-McpCcInstalledTokenHash $token
        if ($digest -cne $release.cutover.httpTokenSha256) { throw 'INSTALLED_HTTP_AUTH_MISMATCH' }
    }
    return [pscustomobject]@{contract=$(if($release.schemaVersion -eq 6){'codex-bridge-installed-binding-v4'}elseif($release.schemaVersion -eq 5){'codex-bridge-installed-binding-v3'}elseif($release.schemaVersion -eq 4){'codex-bridge-installed-binding-v2'}else{'codex-bridge-installed-binding-v1'});releaseId=$release.releaseId;releaseRoot=$release.root;
        codeRoot=$CodeRoot;configRoot=$configRoot;runtimeRoot=$runtimeRoot;ownerRoot=$ownerRoot;
        projectsFile=$projects;dataDir=$release.state.dataDir;codexHome=$release.state.codexHome;
        handoffDir=(Join-Path $configRoot '.tmp\codex-inbox');operatorSid=$operator.sid;
        userProfile=$operator.userProfile;localAppData=$operator.localAppData;windowsRoot=$operator.windows;
        nodePath=$release.dependencies.node.path;tunnelClientPath=$release.dependencies.tunnelClient.path;
        keyStorePath=$release.dependencies.keyStore.path;codexLauncher=$release.dependencies.codexLauncher.path;
        codexNative=$release.dependencies.codexNative.path;tunnelProfileDir=$profile;secretPath=$secret;
        activationReady=($release.schemaVersion -ge 3);blocker=$(if ($release.schemaVersion -ge 3) { $null } else { 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED' })}
}
function Get-McpCcInstalledOwnerBinding([string]$ManagerRoot) {
    # Canonical owner-only projection for native transport. It does not require or
    # propagate the Bridge HTTP credential/tunnel configuration into a helper.
    if ($ManagerRoot -ine (Split-Path -Parent $PSScriptRoot)) { throw 'INSTALLED_LOADED_ROOT_MISMATCH' }
    $release=Read-McpCcInstalledRelease $ManagerRoot
    if ($release.schemaVersion -lt 3) { throw 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED' }
    Assert-McpCcInstalledClosure $release
    $operator=Get-McpCcInstalledOperator
    if ($operator.isAdmin -or $operator.sid -cne $release.state.operatorSid -or
        $operator.userProfile -ine $release.state.userProfile -or $operator.localAppData -ine $release.state.localAppData -or
        $operator.windows -ine 'C:\Windows') { throw 'INSTALLED_OPERATOR_MISMATCH' }
    $ownerRoot=Get-McpCcInstalledStateRoot $release
    if($release.schemaVersion -ge 4){Assert-McpCcInstalledStateReceipt (Join-Path $ownerRoot ('installed-bridge\'+$release.releaseId)) $operator.sid}
    return [pscustomobject]@{ activationReady=$true; releaseRoot=$release.root; windowsRoot=$operator.windows;
        ownerRoot=$ownerRoot; operatorSid=$operator.sid }
}
function Get-McpCcInstalledTokenHash([string]$Token) {
    if ([string]::IsNullOrEmpty($Token)) { return '' }
    if ($Token.Length -lt 32 -or $Token.Length -gt 8192 -or $Token -cne $Token.Trim()) { throw 'INSTALLED_HTTP_AUTH_INVALID' }
    $h=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Token)))).Replace('-','').ToLowerInvariant() } finally { $h.Dispose() }
}
function Assert-McpCcInstalledPrivateTree([string]$Path,[string]$OwnerSid) {
    Assert-McpCcInstalledPrivatePath $Path $OwnerSid
    $queue=New-Object 'Collections.Generic.Stack[string]';$queue.Push($Path);$count=0
    while ($queue.Count) {
        foreach ($child in Get-ChildItem -LiteralPath $queue.Pop() -Force) {
            if (++$count -gt 10000) { throw 'INSTALLED_PRIVATE_TREE_LIMIT' }
            Assert-McpCcInstalledPrivatePath $child.FullName $OwnerSid
            if ($child.PSIsContainer) { $queue.Push($child.FullName) }
        }
    }
}
function Assert-McpCcInstalledActivation($Manifest,[switch]$TrayBootstrap) {
    if ($Manifest.schemaVersion -eq 4) {
        $release=Read-McpCcInstalledRelease (Split-Path -Parent $PSScriptRoot)
        if ($release.schemaVersion -lt 3) { throw 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED' }
        $binding=Get-McpCcInstalledBridgeBinding (Join-Path $release.root 'codex_bridge')
        Assert-McpCcInstalledSelection $binding -TrayBootstrap:$TrayBootstrap
    }
}
function Assert-McpCcInstalledSelection($Binding,[switch]$TrayBootstrap) {
    if (-not $Binding.activationReady) { throw 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED' }
    $tray=Join-Path $Binding.releaseRoot 'mcp_control_center\scripts\tray.ps1'
    $ps=Join-Path $Binding.windowsRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut=Join-Path ([Environment]::GetFolderPath('Startup')) 'MCP Control Center.lnk'
    Assert-McpCcNoReparseChain $shortcut
    $shell=New-Object -ComObject WScript.Shell
    try {
        $link=$shell.CreateShortcut($shortcut)
        if ($link.TargetPath -ine $ps -or $link.Arguments -cnotin @(
                ('-NoProfile -File "'+$tray+'" -AutoReconcile'),
                ('-NoProfile -WindowStyle Hidden -File "'+$tray+'" -AutoReconcile')) -or
            $link.WorkingDirectory -ine (Split-Path -Parent (Split-Path -Parent $tray))) { throw 'INSTALLED_STARTUP_NOT_SELECTED' }
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
    $native=Join-Path $Binding.releaseRoot 'mcp_control_center\src\RemoteSelfReload.Native.dll'
    if (-not ('McpCcReloadNative' -as [type])) { Add-Type -Path $native }
    if ($TrayBootstrap) {
        $ownerPid=$PID
    } else {
        $pidPath=Join-Path $Binding.ownerRoot 'tray.pid'
        Assert-McpCcInstalledPrivatePath $pidPath $Binding.operatorSid
        $raw=[IO.File]::ReadAllText($pidPath)
        if ($raw -cnotmatch '^\d{1,10}$') { throw 'INSTALLED_OWNER_UNKNOWN' }
        $ownerPid=[int]$raw
    }
    $process=Get-Process -Id $ownerPid -ErrorAction Stop
    try {
        if ($process.Path -ine $ps -or -not [McpCcReloadNative]::OutsideJobs($process)) { throw 'INSTALLED_OWNER_UNKNOWN' }
        $cim=Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction Stop
        $sid=Invoke-CimMethod -InputObject $cim -MethodName GetOwnerSid -ErrorAction Stop
        if ($sid.ReturnValue -ne 0 -or $sid.Sid -cne $Binding.operatorSid -or
            $cim.CommandLine -notmatch ('(?i)^"?'+[regex]::Escape($ps)+'"?\s+-NoProfile\s+(?:-WindowStyle\s+Hidden\s+)?-File\s+"'+[regex]::Escape($tray)+'"(?:\s+-AutoReconcile)?\s*$')) { throw 'INSTALLED_OWNER_UNKNOWN' }
        # Validate lineage while the independent launcher is alive. Later checks prove
        # the same protected tray entrypoint is running outside all jobs; an exited
        # launcher PID must not become an eternal dependency (or be trusted after reuse).
        if($TrayBootstrap){
        $parent=[int]$cim.ParentProcessId;$seen=@{};$depth=0;$explorer=$false
        while($parent -gt 0){
            if($seen.ContainsKey($parent) -or ++$depth -gt 64){throw 'INSTALLED_OWNER_LINEAGE_UNKNOWN'}
            $seen[$parent]=$true
            $ancestor=Get-CimInstance Win32_Process -Filter "ProcessId=$parent" -ErrorAction Stop
            if($null -eq $ancestor){throw 'INSTALLED_OWNER_LINEAGE_UNKNOWN'}
            if($ancestor.Name -match '^(node|codex|codex-exec)\.exe$' -or $ancestor.CommandLine -match 'app-server'){throw 'INSTALLED_OWNER_NOT_INDEPENDENT'}
            if($ancestor.Name -eq 'explorer.exe'){$explorer=$true;break}
            $parent=[int]$ancestor.ParentProcessId
        }
        if(-not $explorer){throw 'INSTALLED_OWNER_LINEAGE_UNKNOWN'}
        }
        # Reject a legacy tray even if it has no PID sidecar. Single named mutex in tray
        # remains the final atomic exclusion before publishing this owner's PID.
        foreach ($p in Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop) {
            if ($p.ProcessId -ne $ownerPid -and $p.CommandLine -match '(?i)[\\/]mcp_control_center[\\/]scripts[\\/]tray\.ps1(?:"|\s|$)') { throw 'INSTALLED_PARALLEL_OWNER' }
        }
    } finally { $process.Dispose() }
}
Export-ModuleMember -Function Read-McpCcInstalledRelease,Resolve-McpCcInstalledComponentRoot,Assert-McpCcInstalledClosure,Assert-McpCcInstalledActivation,Assert-McpCcProtectedCodePath,Assert-McpCcProtectedCodeTree,Get-McpCcInstalledBridgeBinding,Get-McpCcInstalledOwnerBinding,Get-McpCcInstalledStateRoot,Assert-McpCcInstalledSelection
