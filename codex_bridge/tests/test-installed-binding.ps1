Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$source=Split-Path -Parent $PSScriptRoot
$workspace=Split-Path -Parent $source
$tempBase=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$fixture=Join-Path $tempBase ('cb-installed-binding-'+[guid]::NewGuid().ToString('N'))
$utf8=New-Object Text.UTF8Encoding($false);$passed=0
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message};$script:passed++}
function Denied([scriptblock]$AssertionBody,[string]$Pattern){
    $message='';try{& $AssertionBody | Out-Null}catch{$message=$_.Exception.Message}
    Check ($message -match $Pattern) "Expected $Pattern; actual: $message"
}
function Put([string]$Path,[string]$Text){
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path)|Out-Null
    [IO.File]::WriteAllText($Path,$Text,$utf8)
}
function Save-Manifest {Put $manifestPath ($document|ConvertTo-Json -Depth 8)}
$savedLoaderEnvironment=@{}
# The positive fixture supplies a clean process-local environment. The production guard
# must reject ambient host NODE_* variables too; never weaken it to make a test pass.
foreach($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()){
    if([string]$entry.Key -match '^(NODE_|OPENSSL_)'){$savedLoaderEnvironment[[string]$entry.Key]=[string]$entry.Value}
}
foreach($name in $savedLoaderEnvironment.Keys){[Environment]::SetEnvironmentVariable($name,$null,'Process')}
try {
    $release=Join-Path $fixture 'release-a';$bridge=Join-Path $release 'codex_bridge'
    $manager=Join-Path $release 'mcp_control_center';$legacy=Join-Path $fixture 'legacy'
    $private=Join-Path $fixture 'operator';$owner=Join-Path $private 'Local\McpControlCenter'
    $runtime=Join-Path $owner 'installed-bridge\release-a'
    $manifestPath=Join-Path $manager 'config\installed-release.json'
    $sid='S-1-5-21-100-200-300-1001'
    New-Item -ItemType Directory -Force -Path $legacy,$runtime,(Join-Path $private 'jobs'),(Join-Path $private 'codex-home')|Out-Null
    foreach($name in @('codex-bridge-runtime.psm1','cooperative-layout.ps1','runtime-control.ps1','component-runtime.psm1','runtime-build-id.mjs','OwnedProcess.Native.cs','self-reload-pipe-client.ps1')){
        Put (Join-Path $bridge "scripts\$name") ([IO.File]::ReadAllText((Join-Path $source "scripts\$name")))
    }
    Put (Join-Path $manager 'src\McpControlCenter.InstalledRelease.psm1') ([IO.File]::ReadAllText((Join-Path $workspace 'mcp_control_center\src\McpControlCenter.InstalledRelease.psm1')))
    foreach($name in @('src\McpControlCenter.Core.psm1','src\RemoteSelfReload.Native.cs','scripts\tray.ps1')){Put (Join-Path $manager $name) 'fixture'}
    Put (Join-Path $manager 'config\registry.json') '{"schemaVersion":4}'
    foreach($name in @('dist\src\http-main.js','dist\src\config.js','web\self-reload.html','package.json','package-lock.json',
      'node_modules\@openai\codex\bin\codex.js','node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe')){Put (Join-Path $bridge $name) 'inert fixture, never execute'}
    $dependencies=[ordered]@{node='dependencies\node\node.exe';tunnelClient='dependencies\tunnel-client\tunnel-client.exe';keyStore='dependencies\key-store\key-store.ps1';
      codexLauncher='codex_bridge\node_modules\@openai\codex\bin\codex.js';codexNative='codex_bridge\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'}
    $hashes=[ordered]@{}
    foreach($name in $dependencies.Keys){$p=Join-Path $release $dependencies[$name];if(-not(Test-Path -LiteralPath $p)){Put $p 'inert dependency'};$hashes[$name]=(Get-FileHash -LiteralPath $p).Hash.ToLowerInvariant()}
    Put (Join-Path $release 'dependencies\node\support.dll') 'inert DLL closure'
    Put (Join-Path $legacy 'codex_bridge\.local\projects.json') '{"projects":[]}'
    Put (Join-Path $legacy 'codex_bridge\.local\tray-settings.json') '{malformed, must never select code}'
    Put (Join-Path $legacy 'codex_bridge\.tmp\codex-bridge-http-server.owner.json') '{"executablePath":"C:\\mutable\\evil-node.exe"}'
    Put (Join-Path $legacy 'codex_bridge\.tunnel-client\codex-bridge.yaml') 'synthetic only'
    Put (Join-Path $legacy 'project_reading\.secrets\control-plane-api-key.dpapi') 'NOT A SECRET; synthetic placeholder; never decrypted'
    $document=[ordered]@{contract='mcpcc-installed-release-v2';schemaVersion=2;releaseId='release-a';legacyWorkspaceRoot=$legacy;
      dependencies=$hashes;state=[ordered]@{operatorSid=$sid;userProfile=$private;localAppData=(Join-Path $private 'Local');dataDir=(Join-Path $private 'jobs');
        projectsFile=(Join-Path $legacy 'codex_bridge\.local\projects.json');codexHome=(Join-Path $private 'codex-home')};
      treeHashes=[ordered]@{mcp_control_center=('a'*64);codex_bridge=('a'*64);dependencies=('a'*64)}}
    Save-Manifest
    $cc=Import-Module (Join-Path $manager 'src\McpControlCenter.InstalledRelease.psm1') -Force -PassThru
    $controller=Import-Module (Join-Path $bridge 'scripts\codex-bridge-runtime.psm1') -Force -PassThru
    $privatePaths=@($runtime,$owner,$document.state.dataDir,$document.state.projectsFile,$document.state.codexHome,
      (Join-Path $legacy 'codex_bridge\.tunnel-client'),(Join-Path $legacy 'project_reading\.secrets\control-plane-api-key.dpapi'))
    & $cc {
        param($sid,$profile,$local,$privatePaths)
        $script:operator=[pscustomobject]@{sid=$sid;userProfile=$profile;localAppData=$local;windows='C:\Windows';isAdmin=$false}
        $script:privatePaths=$privatePaths;$script:badPath='';$script:reparsePath='';$script:aclReads=0
        $script:goodAcl=New-Object Security.AccessControl.DirectorySecurity
        $script:goodAcl.SetSecurityDescriptorSddlForm('O:SYG:SYD:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;BU)')
        $script:privateAcl=New-Object Security.AccessControl.DirectorySecurity
        $script:privateAcl.SetSecurityDescriptorSddlForm("O:${sid}G:SYD:(A;;FA;;;SY)(A;;FA;;;$sid)")
        function script:Get-McpCcInstalledOperator {$script:operator}
        function script:Get-Acl {param($LiteralPath)
            $script:aclReads++
            if($LiteralPath -ieq $script:badPath){$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetSecurityDescriptorSddlForm('O:SYG:SYD:(A;;FW;;;BU)');return $a}
            if($LiteralPath -in $script:privatePaths){return $script:privateAcl};return $script:goodAcl
        }
        function script:Get-Item {param($LiteralPath,[switch]$Force)
            if($LiteralPath -ieq $script:reparsePath){return [pscustomobject]@{Attributes=[IO.FileAttributes]::ReparsePoint}}
            Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force
        }
    } $sid $private $document.state.localAppData $privatePaths
    & $controller {
        $script:goodAcl=New-Object Security.AccessControl.DirectorySecurity
        $script:goodAcl.SetSecurityDescriptorSddlForm('O:SYG:SYD:(A;;FA;;;SY)(A;;FRFX;;;BU)')
        function script:Get-Acl {param($LiteralPath) $script:goodAcl}
        # These tripwires must never be reached by a source binding or a blocked action.
        function script:Start-CbChildProcess {throw 'UNEXPECTED_PROCESS_LAUNCH'}
        function script:Get-CbProcess {throw 'UNEXPECTED_PID_READ'}
        function script:Get-CbListenerState {throw 'UNEXPECTED_LISTENER_PROBE'}
        function script:Open-CbOwnedProcess {throw 'UNEXPECTED_NATIVE_HANDLE'}
    }
    foreach($name in @('mcp_control_center','codex_bridge','dependencies')){$document.treeHashes[$name]=& $cc {param($p) Get-McpCcInstalledTreeHash $p} (Join-Path $release $name)}
    Save-Manifest
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $context=New-CodexBridgeRuntimeContext -ProjectRoot $bridge
    $clock.Stop()
    Check ($context.projectRoot -eq $bridge -and $context.configRoot -eq (Join-Path $legacy 'codex_bridge')) 'Code/config roots are distinct'
    Check ($context.runtimeDir -eq $runtime -and $context.dataDir -eq $document.state.dataDir) 'State is outside code and legacy PID directory'
    foreach($name in @('serverPidFile','serverOwnerFile','tunnelPidFile','tunnelOwnerFile','tunnelLogFile','actionLogFile')){Check ($context.$name.StartsWith($runtime+'\')) ('Private runtime path: '+$name)}
    foreach($pair in @(@('nodePath','node'),@('tunnelClientPath','tunnelClient'),@('keyStorePath','keyStore'))){Check ($context.($pair[0]) -eq (Join-Path $release $dependencies[$pair[1]])) ('Pinned '+$pair[0])}
    Check ($context.codexCommand -eq $context.nodePath -and ($context.codexArgs|ConvertFrom-Json)[0] -eq $context.installedBinding.codexLauncher) 'Pinned Node and bundled Codex launcher'
    Check ($context.secretPath -eq (Join-Path $legacy 'project_reading\.secrets\control-plane-api-key.dpapi')) 'Original credential owner path, metadata only'
    Check ($context.installedBinding.handoffDir -eq (Join-Path $legacy 'codex_bridge\.tmp\codex-inbox')) 'Existing handoff location preserved'
    Check ($null -eq $context.expectedBuildId -and $null -eq $context.testActiveFlag -and -not $context.installedBinding.activationReady) 'No caller build override or activation grant'
    $oldPath=$env:PATH
    try{$env:PATH='C:\untrusted';$again=New-CodexBridgeRuntimeContext -ProjectRoot $bridge;Check ($again.nodePath -eq $context.nodePath) 'PATH and poisoned settings/sidecar cannot select a binary'}finally{$env:PATH=$oldPath}
    foreach($name in @('NodePath','TunnelClientPath','KeyStorePath','CodexCommand','CodexArgs','DataDir','ProjectsFile','SecretPath','ExpectedBuildId','TestActiveFlag','Port')){
        $overrides=@{ProjectRoot=$bridge};$overrides[$name]=if($name -eq 'Port'){1234}else{'untrusted'}
        Denied {New-CodexBridgeRuntimeContext @overrides} 'INSTALLED_CALLER_OVERRIDE_REJECTED'
    }
    Denied {New-CodexBridgeRuntimeContext -ProjectRoot (Join-Path $legacy 'codex_bridge')} 'INSTALLED_CALLER_OVERRIDE_REJECTED'
    foreach($name in @('NODE_OPTIONS','NODE_PATH','NODE_REPL_EXTERNAL_MODULE','OPENSSL_CONF','OPENSSL_MODULES','CODEX_BRIDGE_CODEX_COMMAND','CODEX_BRIDGE_CODEX_ARGS',
      'CODEX_BRIDGE_NODE_PATH','CODEX_BRIDGE_TUNNEL_CLIENT_PATH','CODEX_BRIDGE_KEY_STORE_PATH','CODEX_BRIDGE_EXPECTED_TEST_BUILD','CODEX_BRIDGE_TEST_ACTIVE_FLAG')){
        $before=[Environment]::GetEnvironmentVariable($name,'Process')
        try{[Environment]::SetEnvironmentVariable($name,'injected','Process');Denied {New-CodexBridgeRuntimeContext -ProjectRoot $bridge} 'INSTALLED_ENV_OVERRIDE_REJECTED'}
        finally{[Environment]::SetEnvironmentVariable($name,$before,'Process')}
    }
    foreach($action in @('EnsureRunning','RepairConnectivity','RestartCore','ReloadRuntime','ShutdownRuntime')){Denied {Invoke-CodexBridgeLifecycleAction -Context $context -Action $action} 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED'}
    Denied {Get-CodexBridgeRuntimeStatus -Context $context -AdoptLegacyExactListeners} 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED'
    Denied {Write-CodexBridgeLifecycleEvent -Context $context -Action Status -Ok $true} 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED'
    foreach($function in @('Start-CbServer','Start-CbTunnelOnce','Stop-CbOwnedRole')){
        Denied {& $controller {param($fn,$c) & $fn -Context $c} $function $context} 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED'
    }
    # A removed marker on the caller's context cannot erase the physical installed mode.
    $context.PSObject.Properties.Remove('installedBinding')
    Denied {Invoke-CodexBridgeLifecycleAction -Context $context -Action ReloadRuntime} 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED'
    foreach($action in @('Status','SelfTest','EnsureRunning','RepairConnectivity','RestartCore','ReloadRuntime','ShutdownRuntime')){
        $output=& (Join-Path $PSHOME 'powershell.exe') -NoProfile -File (Join-Path $bridge 'scripts\runtime-control.ps1') -Action $action
        $exitCode=$LASTEXITCODE;$result=($output -join "`n")|ConvertFrom-Json
        Check ($result.code -eq 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED' -and $result.componentLaunches -eq 0 -and $exitCode -eq $(if($action -in @('Status','SelfTest')){0}else{1})) ('Controller static guard '+$action)
    }
    Check (@(Get-ChildItem -LiteralPath $runtime -Force).Count -eq 0 -and -not(Test-Path -LiteralPath (Join-Path $bridge '.tmp'))) 'No runtime files inside code or private state'
    foreach($path in @((Split-Path -Parent $release),(Join-Path $release 'dependencies\node\support.dll'),$runtime,$document.state.projectsFile)){
        & $cc {param($p) $script:badPath=$p} $path
        Denied {New-CodexBridgeRuntimeContext -ProjectRoot $bridge} 'PROTECTED_WRITE_REJECTED|INSTALLED_PRIVATE_ACL_REJECTED'
        & $cc {$script:badPath=''}
    }
    & $cc {param($p) $script:reparsePath=$p} (Split-Path -Parent $release)
    Denied {New-CodexBridgeRuntimeContext -ProjectRoot $bridge} 'INSTALLED_REPARSE_REJECTED'
    & $cc {$script:reparsePath='';$script:operator.sid='S-1-5-21-999-999-999-1001'}
    Denied {New-CodexBridgeRuntimeContext -ProjectRoot $bridge} 'INSTALLED_OPERATOR_MISMATCH'
    & $cc {param($sid) $script:operator.sid=$sid} $sid
    foreach($relative in @('dependencies\node\node.exe','dependencies\node\support.dll',$dependencies.codexLauncher,$dependencies.codexNative,$dependencies.keyStore)){
        $p=Join-Path $release $relative;$original=[IO.File]::ReadAllText($p);Put $p ($original+'tampered')
        Denied {New-CodexBridgeRuntimeContext -ProjectRoot $bridge} 'INSTALLED_TREE_HASH_MISMATCH'
        Put $p $original
    }
    $document.dependencies.node='b'*64;Save-Manifest
    Denied {New-CodexBridgeRuntimeContext -ProjectRoot $bridge} 'INSTALLED_DEPENDENCY_HASH_MISMATCH'
    $document.dependencies.node=$hashes.node=(Get-FileHash -LiteralPath (Join-Path $release $dependencies.node)).Hash.ToLowerInvariant();Save-Manifest
    $originalData=$document.state.dataDir;$document.state.dataDir=$bridge;Save-Manifest
    Denied {New-CodexBridgeRuntimeContext -ProjectRoot $bridge} 'INSTALLED_STATE_CODE_OVERLAP'
    $document.state.dataDir=$originalData;$document.state['activationReady']=$true;Save-Manifest
    Denied {New-CodexBridgeRuntimeContext -ProjectRoot $bridge} 'INSTALLED_MANIFEST_INVALID'
    $document.state.Remove('activationReady');Save-Manifest
    # One reachable v3 release-contract fixture. OS selection/ACL are synthetic; the
    # product context comparison and ProcessStartInfo construction run unchanged.
    $document.contract='mcpcc-installed-release-v3';$document.schemaVersion=3
    Put (Join-Path $manager 'src\RemoteSelfReload.Native.dll') 'synthetic compiled native closure'
    Put (Join-Path $manager 'src\InstalledRelease.Native.dll') 'synthetic verifier closure'
    $document.dependencies.releaseVerifier=(Get-FileHash -LiteralPath (Join-Path $manager 'src\InstalledRelease.Native.dll')).Hash.ToLowerInvariant()
    & $cc {
        # Explicit synthetic OS boundary. Real native ACL assertions are tested separately;
        # no production option can substitute this fixture-only module function.
        function script:Get-McpCcInstalledNativeTreeHash($Release,$Name){
            $p=Join-Path $Release.root $Name;Assert-McpCcProtectedCodeTree $p;Get-McpCcInstalledTreeHash $p
        }
    }
    Put (Join-Path $bridge 'scripts\OwnedProcess.Native.dll') 'synthetic compiled native closure'
    foreach($name in @('mcp_control_center','codex_bridge')){$document.treeHashes[$name]=& $cc {param($p) Get-McpCcInstalledTreeHash $p} (Join-Path $release $name)}
    $profileFile=Join-Path $legacy 'codex_bridge\.tunnel-client\codex-bridge.yaml'
    Put $profileFile 'tunnel_id: tunnel_synthetic_only'
    $document.cutover=[ordered]@{httpTokenSha256='';tunnelProfileSha256=(Get-FileHash -LiteralPath $profileFile).Hash.ToLowerInvariant();rollbackBuildId='0123456789abcdef';legacyStartupSha256=('c'*64)}
    & $cc {param($p) $script:privatePaths+=,$p;function script:Assert-McpCcInstalledSelection {param($Binding) if(-not $Binding.activationReady){throw 'SYNTHETIC_SELECTION_REJECTED'}}} $profileFile
    Save-Manifest
    $positive=New-CodexBridgeRuntimeContext -ProjectRoot $bridge
    Check ($positive.installedBinding.activationReady -and $positive.tunnelIdentity.status -ceq 'Ready') 'Version 3 release has reachable verified context'
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$positive.nodePath;$info.Arguments='"'+$positive.httpEntry+'"'
    & $controller {param($i,$c) $e=Get-CbInstalledChildEnvironment $c.installedBinding;$e.CODEX_BRIDGE_HTTP_TOKEN=$c.token;Set-CbInstalledStartEnvironment $i $e $c} $info $positive
    Check (-not $info.UseShellExecute -and $info.CreateNoWindow -and $info.WorkingDirectory -ceq $bridge -and $positive.serverPidFile.StartsWith($runtime+'\')) 'Positive spawn has protected DLL cwd and private state'
    Check (-not $info.EnvironmentVariables.ContainsKey('NODE_OPTIONS') -and $info.EnvironmentVariables['PATH'].StartsWith((Split-Path -Parent $positive.nodePath)+';')) 'Positive spawn fixed loader environment'
    $info.Arguments='--require C:\mutable\loader.js'
    Denied {& $controller {param($i,$c) Set-CbInstalledStartEnvironment $i (Get-CbInstalledChildEnvironment $c.installedBinding) $c} $info $positive} 'INSTALLED_ARGUMENT_OVERRIDE_REJECTED'
    $positive.nodePath='C:\mutable\node.exe'
    Denied {& $controller {param($c) Assert-CbInstalledMutationBlocked $c} $positive} 'INSTALLED_CONTEXT_TAMPERED'
    $positive=New-CodexBridgeRuntimeContext -ProjectRoot $bridge
    Denied {& $controller {param($c) Resolve-CbRoleOwnership $c server -AdoptLegacyExactListener} $positive} 'INSTALLED_LEGACY_ADOPTION_REJECTED'
    Put $profileFile 'tunnel_id: tunnel_changed'
    Denied {New-CodexBridgeRuntimeContext -ProjectRoot $bridge} 'INSTALLED_PROFILE_CHANGED'
    $document.contract='mcpcc-installed-release-v2';$document.schemaVersion=2;$document.Remove('cutover');$document.dependencies.Remove('releaseVerifier');Save-Manifest
    # A deleted manifest plus a v4 registry is still installed and fails closed.
    Remove-Item -LiteralPath $manifestPath
    Denied {New-CodexBridgeRuntimeContext -ProjectRoot $bridge} 'Cannot find path|does not exist'
    Save-Manifest
    # Windows servicing ACLs accepted by exact SID; user ownership and null DACL still fail.
    $aclChecks=& $cc {
        $result=@();$ti='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
        foreach($sddl in @("O:${ti}G:SYD:(A;;FA;;;$ti)(A;;FA;;;SY)(A;;FRFX;;;BU)",'O:SYG:SYD:NO_ACCESS_CONTROL','O:BUG:SYD:(A;;FA;;;SY)')){
            $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetSecurityDescriptorSddlForm($sddl)
            try{Assert-McpCcProtectedAcl $acl;$result+=,$true}catch{$result+=,$false}
        };$result
    }
    Check ($aclChecks[0] -and -not $aclChecks[1] -and -not $aclChecks[2]) 'TrustedInstaller is exact trusted servicing SID; null DACL/user owner denied'
    [pscustomobject]@{ok=$true;assertions=$passed;synthetic=$true;binding='SOURCE_BOUND';activation='V2_BLOCKED_V3_CONTEXT_AND_SPAWN_REACHABLE';g1='CANDIDATE';
      firstBindingMilliseconds=$clock.ElapsedMilliseconds;productionRuntimeTouched=$false;secretBytesRead=$false;aclMutations=0}|ConvertTo-Json
} finally {
    foreach($name in $savedLoaderEnvironment.Keys){[Environment]::SetEnvironmentVariable($name,$savedLoaderEnvironment[$name],'Process')}
    $resolved=[IO.Path]::GetFullPath($fixture)
    if(-not $resolved.StartsWith($tempBase+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'UNSAFE_FIXTURE_CLEANUP'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
