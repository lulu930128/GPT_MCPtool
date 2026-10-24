Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$checks=0
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message};$script:checks++}
function Refused([scriptblock]$Body,[string]$Code){$message='';try{& $Body|Out-Null}catch{$message=$_.Exception.Message};Check ($message -ceq $Code) ('Expected '+$Code+'; got '+$message)}
function Load-Functions([string]$Path,[string[]]$Names){
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'SOURCE_SYNTAX_FAILED'}
    foreach($name in $Names){
        $nodes=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
        if($nodes.Count -ne 1){throw 'FUNCTION_NOT_UNIQUE'}
        # Caller dot-sources the returned source; never execute an entrypoint.
        $nodes[0].Extent.Text
    }
}
$runtime=Join-Path $workspace 'codex_bridge\scripts\codex-bridge-runtime.psm1'
foreach($definition in Load-Functions $runtime @('Get-CbTunnelArguments','Set-CbTunnelAuthorizationEnvironment','Get-CbInstalledChildEnvironment','Set-CbInstalledStartEnvironment')){. ([scriptblock]::Create($definition))}
function Assert-CbInstalledMutationBlocked {param($c)} # OS owner/closure is tested separately.
$binding=[pscustomobject]@{windowsRoot='C:\Windows';userProfile='C:\fixture';localAppData='C:\fixture\Local';codexHome='C:\fixture\home';nodePath='C:\fixture\node.exe'}
$context=[pscustomobject]@{installedBinding=$binding;nodePath=$binding.nodePath;tunnelClientPath='C:\fixture\tunnel.exe';httpEntry='C:\fixture\http-main.js';projectRoot='C:\fixture\code';tunnelProfile='codex-bridge';tunnelProfileDir='C:\fixture\profile';tunnelLogFile='C:\fixture\tunnel.log';tunnelPidFile='C:\fixture\tunnel.pid';token=$null}
$plain=Get-CbTunnelArguments $context
Check ($plain -cnotmatch 'extra-headers') 'Tokenless command remains compatible'
$context.token='synthetic-bearer-only-0000000000000000'
$args=Get-CbTunnelArguments $context
Check ($args -ceq ($plain+' --mcp.extra-headers "Authorization: env:CODEX_BRIDGE_TUNNEL_AUTHORIZATION" --mcp.discovery-extra-headers "Authorization: env:CODEX_BRIDGE_TUNNEL_AUTHORIZATION"')) 'Exact MCP and discovery env reference'
Check (-not $args.Contains($context.token)) 'Secret absent from command'
$environment=Get-CbInstalledChildEnvironment $binding
Set-CbTunnelAuthorizationEnvironment $environment $context
$environment.CONTROL_PLANE_API_KEY='synthetic-control-plane'
$info=New-Object Diagnostics.ProcessStartInfo
$info.FileName=$context.tunnelClientPath;$info.Arguments=$args
Set-CbInstalledStartEnvironment $info $environment $context
Check ($info.EnvironmentVariables['CODEX_BRIDGE_TUNNEL_AUTHORIZATION'] -ceq ('Bearer '+$context.token)) 'Pinned child header value'
Check (-not $info.EnvironmentVariables.ContainsKey('CODEX_BRIDGE_HTTP_TOKEN')) 'Tunnel receives only dedicated header env'
$info.Arguments=$plain
Refused {Set-CbInstalledStartEnvironment $info $environment $context} 'INSTALLED_ARGUMENT_OVERRIDE_REJECTED'
$info.Arguments=$args.Replace('CODEX_BRIDGE_TUNNEL_AUTHORIZATION','UNTRUSTED_REFERENCE')
Refused {Set-CbInstalledStartEnvironment $info $environment $context} 'INSTALLED_ARGUMENT_OVERRIDE_REJECTED'
$info.Arguments=$args;$environment.CODEX_BRIDGE_TUNNEL_AUTHORIZATION='Bearer replaced'
Refused {Set-CbInstalledStartEnvironment $info $environment $context} 'INSTALLED_ENV_OVERRIDE_REJECTED'
$environment.Remove('CODEX_BRIDGE_TUNNEL_AUTHORIZATION')
Refused {Set-CbInstalledStartEnvironment $info $environment $context} 'INSTALLED_HTTP_AUTH_MISMATCH'
Set-CbTunnelAuthorizationEnvironment $environment $context
$environment.CODEX_BRIDGE_HTTP_TOKEN=$context.token
Refused {Set-CbInstalledStartEnvironment $info $environment $context} 'INSTALLED_ENV_OVERRIDE_REJECTED'
$environment.Remove('CODEX_BRIDGE_HTTP_TOKEN')
$context.token=$null;Set-CbTunnelAuthorizationEnvironment $environment $context;$info.Arguments=$plain
Set-CbInstalledStartEnvironment $info $environment $context
Check (-not $info.EnvironmentVariables.ContainsKey('CODEX_BRIDGE_TUNNEL_AUTHORIZATION')) 'Tokenless start clears stale header'
$environment.Clear();$info.EnvironmentVariables.Clear()

# Real Bridge credential reader, synthetic ciphertext and synthetic DPAPI adapter.
# No production paths, RNG, DPAPI encryption, ACL writes or process launches.
$base=[IO.Path]::GetFullPath((Join-Path $workspace 'codex_bridge\.tmp'))
$fixture=Join-Path $base ('bearer-fixture-'+[guid]::NewGuid().ToString('N'))
$data=Join-Path $fixture 'codex_bridge\.local\runtime'
[void][IO.Directory]::CreateDirectory($data)
$savedToken=[Environment]::GetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN','Process')
$utf8=New-Object Text.UTF8Encoding($false)
try {
    $verifier=New-Module {
        function Get-McpCcInstalledOperator {$script:identity}
        function Assert-McpCcInstalledPrivatePath {param($p,$s) if($script:rejectAcl){throw 'INSTALLED_PRIVATE_ACL_REJECTED'}}
    }
    $ccPath=Join-Path $workspace 'mcp_control_center\src\McpControlCenter.InstalledRelease.psm1'
    foreach($definition in Load-Functions $ccPath @('Get-McpCcInstalledTokenHash')){& $verifier ([scriptblock]::Create('function script:'+ $definition.Substring(9)))}
    $identity=[pscustomobject]@{sid='S-1-5-21-100-200-300-1001';userProfile='C:\fixture';localAppData='C:\fixture\Local';isAdmin=$false}
    & $verifier {param($i) $script:identity=$i;$script:rejectAcl=$false} $identity
    . (Join-Path $workspace 'codex_bridge\scripts\bridge-bearer.ps1')
    $independent=$true
    function Assert-IndependentOperator {if(-not $independent){throw 'INDEPENDENT_OPERATOR_REQUIRED'}}
    function Get-Acl {param($LiteralPath)
        $acl=New-Object Security.AccessControl.FileSecurity
        $acl.SetSecurityDescriptorSddlForm('O:S-1-5-21-100-200-300-1001G:SYD:(A;;FA;;;SY)')
        return $acl
    }
    $synthetic='synthetic-bearer-only-0000000000000000'
    function ConvertTo-SecureString {param($String)
        if($String -cne 'SYNTHETIC_CIPHERTEXT'){throw 'FIXTURE_DECRYPT_REJECTED'}
        Microsoft.PowerShell.Security\ConvertTo-SecureString $synthetic -AsPlainText -Force
    }
    $pin=& $verifier {param($v) Get-McpCcInstalledTokenHash $v} $synthetic
    $release=[pscustomobject]@{schemaVersion=6;legacyWorkspaceRoot=$fixture;state=[pscustomobject]@{operatorSid=$identity.sid;userProfile=$identity.userProfile;localAppData=$identity.localAppData;dataDir=$data};cutover=[pscustomobject]@{httpTokenSha256=$pin}}
    $secret=Join-Path $data '.bridge-http-bearer.dpapi'
    [IO.File]::WriteAllText($secret,'SYNTHETIC_CIPHERTEXT',$utf8)
    [Environment]::SetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN',$null,'Process')
    Set-CbInstalledBearerEnvironment $release $verifier
    Check ($env:CODEX_BRIDGE_HTTP_TOKEN -ceq $synthetic) 'Cold process loads exact persisted pin'
    [Environment]::SetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN','synthetic-replaced-00000000000000000000','Process')
    Refused {Set-CbInstalledBearerEnvironment $release $verifier} 'INSTALLED_HTTP_AUTH_MISMATCH'
    [Environment]::SetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN',$null,'Process')
    Refused {Read-CbPersistedBearer $release $verifier ('f'*64)} 'INSTALLED_HTTP_AUTH_MISMATCH'
    & $verifier {$script:rejectAcl=$true}
    Refused {Set-CbInstalledBearerEnvironment $release $verifier} 'INSTALLED_PRIVATE_ACL_REJECTED'
    & $verifier {$script:rejectAcl=$false}
    $identity.isAdmin=$true
    Refused {Set-CbInstalledBearerEnvironment $release $verifier} 'BRIDGE_BEARER_SCOPE_REJECTED'
    $identity.isAdmin=$false
    [IO.File]::WriteAllText($secret,'MALFORMED_SYNTHETIC',$utf8)
    Refused {Set-CbInstalledBearerEnvironment $release $verifier} 'BRIDGE_BEARER_DECRYPT_FAILED'
    $release.cutover.httpTokenSha256=''
    Set-CbInstalledBearerEnvironment $release $verifier
    Check ([string]::IsNullOrEmpty($env:CODEX_BRIDGE_HTTP_TOKEN)) 'Tokenless release never decrypts successor secret'
    $independent=$false
    Refused {Initialize-CbInstalledBearer $release $verifier} 'INDEPENDENT_OPERATOR_REQUIRED'
    $independent=$true
    Refused {Initialize-CbInstalledBearer $release $verifier} 'BRIDGE_BEARER_DECRYPT_FAILED'
    [IO.File]::WriteAllText($secret,'SYNTHETIC_CIPHERTEXT',$utf8)
    $before=(Get-FileHash -LiteralPath $secret).Hash
    Initialize-CbInstalledBearer $release $verifier
    Check ($env:CODEX_BRIDGE_HTTP_TOKEN -ceq $synthetic -and (Get-FileHash -LiteralPath $secret).Hash -ceq $before) 'Resume reuses existing secret without generation or write'
    Initialize-CbInstalledBearer $release $verifier
    Check ((Get-FileHash -LiteralPath $secret).Hash -ceq $before) 'Repeated preparation is byte-preserving'
    [Environment]::SetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN','synthetic-replaced-00000000000000000000','Process')
    Refused {Initialize-CbInstalledBearer $release $verifier} 'INSTALLED_HTTP_AUTH_MISMATCH'
    $release.cutover.httpTokenSha256=$pin
    Refused {Initialize-CbInstalledBearer $release $verifier} 'BRIDGE_BEARER_INITIALIZATION_REJECTED'

    # Execute both real launch wiring functions, intercepting the final process
    # launch and metadata writers. The key-store and ciphertext are inert fixtures.
    foreach($definition in Load-Functions $runtime @('Start-CbTunnelOnce','Start-CbInstalledTunnel')){. ([scriptblock]::Create($definition))}
    function Assert-CbTunnelIdentityReady {param($Context)}
    function Test-CbServerHealth {param($Context) $true}
    function Test-CbTunnelReady {param($Context) $false}
    function Resolve-CbRoleOwnership {param($Context,$Role) [pscustomobject]@{canMutate=$true;state='Stopped'}}
    function Get-CbProcess {param($ProcessId) [pscustomobject]@{Id=$ProcessId}}
    function Write-CbAtomicText {param($Path,$Value)}
    function Write-CbOwnerMetadata {param($Context,$Role,$Process)}
    function Read-McpCcInstalledRelease {param($r) $release}
    $keyStore=Join-Path $fixture 'inert-key-store.ps1'
    [IO.File]::WriteAllText($keyStore,'function Set-ControlPlaneApiKeyEnvFromSecret {param($ProjectRoot,$SecretPath) $env:CONTROL_PLANE_API_KEY="synthetic-control-plane"}',$utf8)
    $credential=Join-Path $fixture 'inert-credential';[IO.File]::WriteAllText($credential,'SYNTHETIC_CONTROL_PLANE',$utf8)
    $release|Add-Member NoteProperty deployment @{credentialSha256=(Get-FileHash -LiteralPath $credential).Hash.ToLowerInvariant()}
    $binding|Add-Member NoteProperty contract 'codex-bridge-installed-binding-v4'
    $binding|Add-Member NoteProperty releaseRoot $fixture
    foreach($entry in @{configRoot=$fixture;runtimeDir=$data;keyStorePath=$keyStore;secretPath=$credential;tunnelProfilePath=$credential}.GetEnumerator()){$context|Add-Member NoteProperty $entry.Key $entry.Value}
    # Test-Path requires files for the source path; these are never executed.
    $context.tunnelClientPath=$credential
    $launches=0
    function Start-CbInstalledChildProcess {param($Info,$Environment,$Context)
        Set-CbInstalledStartEnvironment $Info $Environment $Context
        Check ($Info.Arguments -ceq (Get-CbTunnelArguments $Context)) 'Installed start uses pinned command helper'
        Check ($Info.EnvironmentVariables['CODEX_BRIDGE_TUNNEL_AUTHORIZATION'] -ceq ('Bearer '+$Context.token)) 'Installed start forwards pinned header'
        $script:launches++;return [pscustomobject]@{Id=123}
    }
    function Start-CbChildProcess {param($StartInfo,$Environment)
        Check ($StartInfo.Arguments -ceq (Get-CbTunnelArguments $context)) 'Source start uses the same command helper'
        $expected=if($context.token){'Bearer '+$context.token}else{$null}
        Check ($Environment.CODEX_BRIDGE_TUNNEL_AUTHORIZATION -ceq $expected) 'Source start forwards or clears dedicated header'
        $script:launches++;return [pscustomobject]@{Id=123}
    }
    $controlPlaneBefore=[Environment]::GetEnvironmentVariable('CONTROL_PLANE_API_KEY','Process')
    try {
        $context.token=$synthetic;Start-CbTunnelOnce $context
        $context.PSObject.Properties.Remove('installedBinding')
        Start-CbTunnelOnce $context
        $context.token=$null;Start-CbTunnelOnce $context
        Check ($launches -eq 3) 'All starts were intercepted without native execution'
    } finally {[Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY',$controlPlaneBefore,'Process')}

    # Actual probe uses old/new manifest auth, with all HTTP requests stubbed.
    $operatorPath=Join-Path $workspace 'codex_bridge\scripts\installed-release-operator.ps1'
    foreach($definition in Load-Functions $operatorPath @('Get-ReleaseHttpToken','Assert-HttpAuthentication','Start-SelectedTray')){. ([scriptblock]::Create($definition))}
    $observed=New-Object 'Collections.Generic.List[object]'
    $anonymousRejected=$true
    function Invoke-WebRequest {
        param($Uri,$Method='Get',$Headers,$Body,[switch]$UseBasicParsing,$ContentType,$TimeoutSec,$MaximumRedirection)
        $observed.Add([pscustomobject]@{method=$Method;auth=($Headers -and $Headers.ContainsKey('Authorization'))})
        if($Method -eq 'Get'){
            if($anonymousRejected){
                $exception=New-Object Exception('synthetic unauthorized')
                $exception|Add-Member NoteProperty Response ([pscustomobject]@{StatusCode=401})
                throw $exception
            }
            return [pscustomobject]@{StatusCode=200}
        }
        $tools=@('status','preview','request','receipt','challenge','approve')|ForEach-Object{@{name=('codex_self_reload_'+$_);_meta=@{ui=@{visibility=@('app')}}}}
        [pscustomobject]@{Headers=@{'Mcp-Session-Id'='synthetic-session'};RawContentLength=100;Content=(@{result=@{tools=$tools}}|ConvertTo-Json -Depth 8)}
    }
    [IO.File]::WriteAllText($secret,'SYNTHETIC_CIPHERTEXT',$utf8)
    [Environment]::SetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN',$synthetic,'Process')
    $release.cutover.httpTokenSha256=''
    Assert-HttpAuthentication -Release $release
    Check (@($observed|Where-Object{$_.auth -or $_.method -eq 'Get'}).Count -eq 0) 'Old tokenless probe ignores successor process token'
    $observed.Clear();$release.cutover.httpTokenSha256=$pin
    Assert-HttpAuthentication -Release $release
    Check (@($observed|Where-Object{$_.method -eq 'Post' -and -not $_.auth}).Count -eq 0) 'Pinned probe supplies bearer'
    Check (@($observed|Where-Object{$_.method -eq 'Get' -and -not $_.auth}).Count -eq 1) 'Pinned probe requires anonymous rejection'
    $anonymousRejected=$false
    Refused {Assert-HttpAuthentication -Release $release} 'HTTP_AUTH_DOWNGRADE'

    # Rollback tray inherits the predecessor token mode; caller env is restored.
    $manager=Join-Path $fixture 'mcp_control_center'
    [void][IO.Directory]::CreateDirectory((Join-Path $manager 'config'))
    [IO.File]::WriteAllText((Join-Path $manager 'config\installed-release.json'),'{}',$utf8)
    function Read-McpCcInstalledRelease {param($r) $release}
    function Assert-McpCcInstalledClosure {param($r)}
    function Start-Process {param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,[switch]$PassThru)
        Check ([string]::IsNullOrEmpty($env:CODEX_BRIDGE_HTTP_TOKEN)) 'Rollback tray does not inherit successor token'
        return [pscustomobject]@{Id=123}
    }
    $ps='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    $release.cutover.httpTokenSha256='';$null=Start-SelectedTray $manager
    Check ($env:CODEX_BRIDGE_HTTP_TOKEN -ceq $synthetic) 'Rollback launch restores operator process env'
    # Evaluate the real controller environment preparation and return BEFORE
    # Process.Start. No controller or shell command is executed by this check.
    $definition=Load-Functions $operatorPath @('Invoke-Controller')
    $definition=$definition.Replace('$p=[Diagnostics.Process]::Start($info)','return $info; $p=[Diagnostics.Process]::Start($info)')
    . ([scriptblock]::Create($definition))
    $controllerInfo=Invoke-Controller (Join-Path $fixture 'codex_bridge') Status
    Check (-not $controllerInfo.EnvironmentVariables.ContainsKey('CODEX_BRIDGE_HTTP_TOKEN')) 'Old controller never inherits successor token'
    $release.cutover.httpTokenSha256=$pin
    $controllerInfo=Invoke-Controller (Join-Path $fixture 'codex_bridge') Status
    Check ($controllerInfo.EnvironmentVariables['CODEX_BRIDGE_HTTP_TOKEN'] -ceq $synthetic) 'New controller receives exact pinned token'
    $controllerInfo.EnvironmentVariables.Clear()
} finally {
    [Environment]::SetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN',$savedToken,'Process')
    $resolved=[IO.Path]::GetFullPath($fixture)
    if((Split-Path -Parent $resolved) -ine $base -or (Split-Path -Leaf $resolved) -cnotmatch '^bearer-fixture-[0-9a-f]{32}$'){throw 'UNSAFE_FIXTURE_CLEANUP'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
[pscustomobject]@{ok=$true;checks=$checks;scope='synthetic source only';productionTouched=$false;secretGenerated=$false;lifecycleRun=$false}|ConvertTo-Json
