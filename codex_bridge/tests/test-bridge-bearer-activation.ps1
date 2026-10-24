Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$base=[IO.Path]::GetFullPath((Join-Path $workspace 'codex_bridge\.tmp'))
$fixture=Join-Path $base ('bearer-activation-'+[guid]::NewGuid().ToString('N'))
$utf8=New-Object Text.UTF8Encoding($false);$checks=0
function Put([string]$Path,[string]$Value){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,$Value,$utf8)}
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message};$script:checks++}
function Refused([scriptblock]$Body,[string]$Code){$message='';try{& $Body|Out-Null}catch{$message=$_.Exception.Message};Check ($message -ceq $Code) ('Expected '+$Code+'; got '+$message)}
$saved=[Environment]::GetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN','Process')
$module=$null
try {
    $root=Join-Path $fixture 'release';$manager=Join-Path $root 'mcp_control_center';$bridge=Join-Path $root 'codex_bridge'
    $modulePath=Join-Path $manager 'src\McpControlCenter.InstalledRelease.psm1'
    Put $modulePath ([IO.File]::ReadAllText((Join-Path $workspace 'mcp_control_center\src\McpControlCenter.InstalledRelease.psm1')))
    Put (Join-Path $bridge 'scripts\bridge-bearer.ps1') ([IO.File]::ReadAllText((Join-Path $workspace 'codex_bridge\scripts\bridge-bearer.ps1')))
    $data=Join-Path $fixture 'codex_bridge\.local\runtime';$owner=Join-Path $fixture 'mcp_control_center\.local\runtime'
    $runtime=Join-Path $owner 'installed-bridge\new'
    $files=@(
        [pscustomobject]@{target=(Join-Path $runtime 'deployment\projects.json');limit=65536;sha256=''},
        [pscustomobject]@{target=(Join-Path $runtime 'deployment\.tunnel-client\codex-bridge.yaml');limit=65536;sha256=''},
        [pscustomobject]@{target=(Join-Path $runtime 'deployment\.secrets\control-plane-api-key.dpapi');limit=65536;sha256=''}
    )
    foreach($file in $files){Put $file.target 'INERT METADATA FIXTURE';$file.sha256=(Get-FileHash -LiteralPath $file.target).Hash.ToLowerInvariant()}
    $secret=Join-Path $data '.bridge-http-bearer.dpapi';Put $secret 'SYNTHETIC_CIPHERTEXT'
    # Verify Windows permits the reservation's metadata/ACL check while the
    # CreateNew handle is exclusive. This empty fixture is never a credential.
    $reservation=Join-Path $fixture 'empty-reservation'
    $handle=[IO.File]::Open($reservation,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $acl=Get-Acl -LiteralPath $reservation -ErrorAction Stop
        Check ($null -ne $acl -and (Get-Item -LiteralPath $reservation).Length -eq 0) 'Exclusive reservation permits metadata validation before any credential bytes'
    } finally {$handle.Dispose()}
    $identity=[pscustomobject]@{sid='S-1-5-21-100-200-300-1001';isAdmin=$false;userProfile='C:\fixture';localAppData='C:\fixture\Local';windows='C:\Windows'}
    $module=Import-Module $modulePath -PassThru -Force
    $synthetic='synthetic-bearer-only-0000000000000000'
    $pin=& $module {param($v) Get-McpCcInstalledTokenHash $v} $synthetic
    $release=[pscustomobject]@{root=$root;schemaVersion=6;releaseId='new';legacyWorkspaceRoot=$fixture;
        state=[pscustomobject]@{operatorSid=$identity.sid;userProfile=$identity.userProfile;localAppData=$identity.localAppData;dataDir=$data;ownerRoot=$owner;projectsFile=$files[0].target;codexHome='C:\fixture\home'};
        cutover=[pscustomobject]@{httpTokenSha256=$pin;tunnelProfileSha256=$files[1].sha256};
        dependencies=@{node=@{path='C:\fixture\node.exe'};tunnelClient=@{path='C:\fixture\tunnel.exe'};keyStore=@{path='C:\fixture\key-store.ps1'};codexLauncher=@{path='C:\fixture\codex.js'};codexNative=@{path='C:\fixture\codex.exe'}}}
    & $module {
        param($r,$i,$f,$value)
        $script:release=$r;$script:identity=$i;$script:files=$f;$script:synthetic=$value
        $script:trace=New-Object 'Collections.Generic.List[string]';$script:rejectClosure=$false;$script:rejectAcl=$false
        function script:Read-McpCcInstalledRelease {param($p) $script:release}
        function script:Assert-McpCcInstalledClosure {param($r)
            $script:trace.Add('closure');if($script:rejectClosure){throw 'INSTALLED_TREE_CHANGED'}
        }
        function script:Get-McpCcInstalledOperator {$script:identity}
        function script:Get-McpCcInstalledStateRoot {param($r) $r.state.ownerRoot}
        function script:Assert-McpCcInstalledStateReceipt {param($p,$s)}
        function script:Get-McpCcInstalledDeploymentFiles {param($r,$p) $script:files}
        function script:Assert-McpCcInstalledPrivateTree {param($p,$s)}
        function script:Assert-McpCcInstalledPrivatePath {param($p,$s,[switch]$IntegrityOnly)
            if($script:rejectAcl){throw 'INSTALLED_PRIVATE_ACL_REJECTED'}
        }
        function script:Assert-McpCcProtectedCodePath {param($p)
            if($p -ine (Join-Path $script:release.root 'codex_bridge\scripts\bridge-bearer.ps1')){throw 'WRONG_BOOTSTRAP_HELPER'}
            $script:trace.Add('protected-helper')
        }
        function script:Get-Acl {param($LiteralPath)
            $acl=New-Object Security.AccessControl.FileSecurity
            $acl.SetSecurityDescriptorSddlForm('O:S-1-5-21-100-200-300-1001G:SYD:(A;;FA;;;SY)');return $acl
        }
        function script:ConvertTo-SecureString {param($String)
            if($String -cne 'SYNTHETIC_CIPHERTEXT'){throw 'FIXTURE_DECRYPT_REJECTED'}
            $script:trace.Add('dpapi')
            Microsoft.PowerShell.Security\ConvertTo-SecureString $script:synthetic -AsPlainText -Force
        }
        function script:Assert-McpCcInstalledSelection {param($Binding,[switch]$TrayBootstrap)
            if(-not $TrayBootstrap -or -not $Binding.activationReady -or $env:CODEX_BRIDGE_HTTP_TOKEN -cne $script:synthetic){throw 'ACTIVATION_TOKEN_NOT_READY'}
            $script:trace.Add('selection')
        }
    } $release $identity $files $synthetic

    # Same public entry used by tray.ps1, with a truly empty process token.
    # Only filesystem/OS authority and DPAPI observations are synthetic. Real
    # Activation -> binding -> protected Bridge helper -> pin comparison executes.
    [Environment]::SetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN',$null,'Process')
    Assert-McpCcInstalledActivation ([pscustomobject]@{schemaVersion=4}) -TrayBootstrap
    $trace=@(& $module {$script:trace.ToArray()})
    Check (($trace -join ',') -ceq 'closure,protected-helper,dpapi,selection') 'Credential loaded and verified before Tray activation returns'
    Check ($env:CODEX_BRIDGE_HTTP_TOKEN -ceq $synthetic) 'Login without ambient token is supported'
    $traySource=[IO.File]::ReadAllText((Join-Path $workspace 'mcp_control_center\scripts\tray.ps1'))
    Check ($traySource.IndexOf('Assert-McpCcInstalledActivation') -lt $traySource.IndexOf('Invoke-McpCcNormalOperatorOwner')) 'Real tray calls activation before native owner listener'
    # Execute only the actual Prepare script-list/copy statements into this
    # fixture. No operator entrypoint or protected release is loaded/executed.
    $tokens=$null;$errors=$null
    $operatorAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $workspace 'codex_bridge\scripts\installed-release-operator.ps1'),[ref]$tokens,[ref]$errors)
    Check ($errors.Count -eq 0) 'Operator syntax'
    $assign=$operatorAst.Find({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$scriptLists'},$true)
    $copy=$operatorAst.Find({param($n)$n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Variable.VariablePath.UserPath -ceq 'componentName'},$true)
    . ([scriptblock]::Create($assign.Extent.Text))
    $CandidateRoot=$workspace;$PackageRoot=Join-Path $fixture 'package';$verifier=$module
    & ([scriptblock]::Create($copy.Extent.Text))
    $copiedHelper=Join-Path $PackageRoot 'codex_bridge\scripts\bridge-bearer.ps1'
    Check ((Get-FileHash -LiteralPath $copiedHelper).Hash -ceq (Get-FileHash -LiteralPath (Join-Path $bridge 'scripts\bridge-bearer.ps1')).Hash) 'Actual Prepare copy contains exact helper bytes'

    & $module {$script:trace.Clear();$script:synthetic='synthetic-replaced-00000000000000000000'}
    [Environment]::SetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN',$null,'Process')
    Refused {Assert-McpCcInstalledActivation ([pscustomobject]@{schemaVersion=4}) -TrayBootstrap} 'INSTALLED_HTTP_AUTH_MISMATCH'
    Check (-not (& $module {$script:trace.Contains('selection')})) 'Wrong decrypted token blocks activation'
    & $module {param($v) $script:synthetic=$v;$script:trace.Clear();$script:rejectClosure=$true} $synthetic
    Refused {Assert-McpCcInstalledActivation ([pscustomobject]@{schemaVersion=4}) -TrayBootstrap} 'INSTALLED_TREE_CHANGED'
    Check ((@(& $module {$script:trace.ToArray()}) -join ',') -ceq 'closure') 'Bad protected closure blocks credential read'
    & $module {$script:trace.Clear();$script:rejectClosure=$false;$script:rejectAcl=$true}
    Refused {Assert-McpCcInstalledActivation ([pscustomobject]@{schemaVersion=4}) -TrayBootstrap} 'INSTALLED_PRIVATE_ACL_REJECTED'
    Check (-not (& $module {$script:trace.Contains('dpapi')})) 'Unsafe private ACL blocks decrypt'
    & $module {$script:trace.Clear();$script:rejectAcl=$false}
    [Environment]::SetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN','synthetic-untrusted-00000000000000000','Process')
    Refused {Assert-McpCcInstalledActivation ([pscustomobject]@{schemaVersion=4}) -TrayBootstrap} 'INSTALLED_HTTP_AUTH_MISMATCH'
    Check (-not (& $module {$script:trace.Contains('dpapi')})) 'Ambient mismatch is not silently replaced'
} finally {
    [Environment]::SetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN',$saved,'Process')
    if($module){Remove-Module $module -Force}
    $resolved=[IO.Path]::GetFullPath($fixture)
    if((Split-Path -Parent $resolved) -ine $base -or (Split-Path -Leaf $resolved) -cnotmatch '^bearer-activation-[0-9a-f]{32}$'){throw 'UNSAFE_FIXTURE_CLEANUP'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
[pscustomobject]@{ok=$true;checks=$checks;scope='actual activation call chain with synthetic OS and DPAPI';productionTouched=$false;listenerStarted=$false;secretGenerated=$false}|ConvertTo-Json
