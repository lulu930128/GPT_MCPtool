# Verify the actual settings adapter, preflight child and launch environment.
# All paths/stores are synthetic; the server launcher is intercepted before spawn.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$component=Split-Path -Parent $PSScriptRoot
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('daily-config-'+[guid]::NewGuid().ToString('N'))
$code=Join-Path $fixture 'Runtime/versions/v2/codex_bridge'
$config=Join-Path $fixture 'stable/codex_bridge'
$secret=Join-Path $fixture 'actual-credentials/fixture.dpapi'
$passed=0;$oldHome=$env:CODEX_HOME;$module=$null
function Check([bool]$Value,[string]$Name){if(-not $Value){throw ('FAILED: '+$Name)};$script:passed++}
function Put([string]$Path,[string]$Text){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,$Text)}
try {
    . (Join-Path $component 'scripts/daily-runtime-settings.ps1')
    function Read-CbDailySettings {
        param($ReleaseRoot)
        return @{dataDir=(Join-Path $fixture 'data');projectsFile=(Join-Path $config 'projects.json');codexCommand=(Get-Command node.exe).Source;
            nodePath=(Get-Command node.exe).Source;tunnelClientPath='fixture';tunnelProfileDir='fixture';keyStorePath='fixture';
            secretPath=$secret;bridgeRuntimeDir=(Join-Path $fixture 'operational');codexHome=(Join-Path $fixture 'home')}
    }
    function New-CodexBridgeRuntimeContext {
        param($ProjectRoot,$DataDir,$ProjectsFile,$CodexCommand,$NodePath,$TunnelClientPath,$TunnelProfileDir,$KeyStorePath,$SecretPath,$Token)
        return [pscustomobject]@{projectRoot=$ProjectRoot;dataDir=$DataDir;projectsFile=$ProjectsFile;codexCommand=$CodexCommand;
            nodePath=$NodePath;secretPath=$SecretPath;runtimeDir='';serverPidFile='';serverOwnerFile='';tunnelPidFile='';
            tunnelOwnerFile='';tunnelLogFile='';actionLogFile='';token=$Token}
    }
    $env:CODEX_HOME=$null
    $daily=New-CbDailyContext $code
    Check ($daily.configRoot -ceq 'C:\GPT_MCPtool\codex_bridge') 'daily adapter pins stable config root'
    Check ($daily.secretPath -ceq $secret) 'daily adapter preserves configured credential path'
    Check ($daily.projectRoot -ceq $code) 'daily adapter retains immutable executable root'
    Check ($daily.runtimeDir -ceq (Join-Path $fixture 'operational')) 'operational state remains configured'
    Check ($daily.requireAllJobs) 'all-jobs shutdown gate retained'
    foreach($p in @('scripts','dist/src')){[void][IO.Directory]::CreateDirectory((Join-Path $code $p))}
    Copy-Item -LiteralPath (Join-Path $component 'scripts/codex-bridge-runtime.psm1') -Destination (Join-Path $code 'scripts/codex-bridge-runtime.psm1')
    Copy-Item -LiteralPath (Join-Path $component 'scripts/cooperative-layout.ps1') -Destination (Join-Path $code 'scripts/cooperative-layout.ps1')
    Copy-Item -LiteralPath (Join-Path $component 'scripts/daily-lifecycle.ps1') -Destination (Join-Path $code 'scripts/daily-lifecycle.ps1')
    foreach($name in @('config.js','installed-runtime.js')){Copy-Item -LiteralPath (Join-Path $component ('dist/src/'+$name)) -Destination (Join-Path $code ('dist/src/'+$name))}
    Put (Join-Path $code 'package.json') '{"type":"module"}'
    Put (Join-Path $config 'projects.json') (@{projects=@(@{id='fixture';name='Fixture';path=$config})}|ConvertTo-Json -Depth 4)
    Put (Join-Path $code 'scripts/runtime-build-id.mjs') @'
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { loadBridgeConfig } from "../dist/src/config.js";
const env = process.env;
const config = await loadBridgeConfig();
assert.equal(env.CODEX_BRIDGE_CONFIG_ROOT.endsWith("stable\\codex_bridge"), true);
assert.equal(env.CODEX_BRIDGE_SECRET_PATH.endsWith("actual-credentials\\fixture.dpapi"), true);
assert.equal(config.handoffDir, join(env.CODEX_BRIDGE_CONFIG_ROOT, ".tmp", "codex-inbox"));
for (const arg of config.codexArgs.filter((arg) => arg.startsWith("permissions."))) {
  assert.ok(arg.includes(`${JSON.stringify(dirname(env.CODEX_BRIDGE_SECRET_PATH))} = "deny"`));
  assert.ok(!arg.includes(JSON.stringify(join(dirname(config.projectRoot), "project_reading", ".secrets"))));
}
assert.equal(env.CODEX_BRIDGE_HTTP_TOKEN, undefined);
process.stdout.write("0123456789abcdef\n");
'@
    $module=Import-Module (Join-Path $code 'scripts/codex-bridge-runtime.psm1') -Force -PassThru
    $context=[pscustomobject]@{projectRoot=$code;configRoot=$config;secretPath=$secret;nodePath=(Get-Command node.exe).Source;
        projectsFile=(Join-Path $config 'projects.json');dataDir=(Join-Path $fixture 'data');hostName='127.0.0.1';port=1;
        codexCommand=(Get-Command node.exe).Source;codexArgs='["app-server"]';expectedBuildId='';testActiveFlag='';token=$null;
        httpEntry=(Join-Path $code 'dist/src/http-main.js')}
    $build=& $module {param($c) Invoke-CbBuildIdHelper $c -StartupPreflight} $context
    Check ($build -ceq '0123456789abcdef') 'actual preflight child loads config with owner paths and no bearer'
    Check (-not(Test-Path -LiteralPath $secret)) 'config resolution never creates or reads a credential'
    Check (-not(Test-Path -LiteralPath (Join-Path $code '.local'))) 'preflight leaves immutable config root untouched'
    & $module {
        function script:Assert-CbInstalledMutationBlocked {}
        function script:Resolve-CbRoleOwnership {return @{canMutate=$true;state='Stopped'}}
        function script:Test-CbServerHealth {return $false}
        function script:Assert-CbStartupPreflight {}
        function script:Start-CbChildProcess {param($StartInfo,$Environment) $script:CapturedEnvironment=$Environment;throw 'FIXTURE_LAUNCH_CAPTURED'}
    }
    $message='';try{& $module {param($c) Start-CbServer $c} $context}catch{$message=$_.Exception.Message}
    Check ($message -ceq 'FIXTURE_LAUNCH_CAPTURED') 'real server start reaches intercepted child launcher'
    $captured=& $module {$script:CapturedEnvironment}
    Check ($captured.CODEX_BRIDGE_CONFIG_ROOT -ceq $config) 'server receives stable config root'
    Check ($captured.CODEX_BRIDGE_SECRET_PATH -ceq $secret) 'server receives actual configured secret path'
    Check ($captured.CODEX_BRIDGE_PROJECT_ROOT -ceq $code) 'server keeps immutable code root'
    [pscustomobject]@{ok=$true;passed=$passed;live=$false;serverStarted=$false;privateContentsRead=$false}|ConvertTo-Json
} finally {
    $env:CODEX_HOME=$oldHome
    if($module){Remove-Module $module}
    $resolved=[IO.Path]::GetFullPath($fixture)
    if((Split-Path -Parent $resolved) -ine [IO.Path]::GetTempPath().TrimEnd('\') -or (Split-Path -Leaf $resolved) -cnotmatch '^daily-config-[0-9a-f]{32}$'){throw 'UNSAFE_FIXTURE_CLEANUP'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
