Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$projectRoot=(Resolve-Path -LiteralPath(Join-Path $PSScriptRoot '..')).Path
$nodePath=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$tempBase=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
# Spaces and shell metacharacters are intentional: these must remain path data.
$testRoot=Join-Path $tempBase ('cb build & $fixture '' '+[Guid]::NewGuid().ToString('N'))
$utf8=New-Object Text.UTF8Encoding($false);$script:Passed=0
$module=$null;$previousOptions=$env:NODE_OPTIONS;$previousSecret=$env:CB_BUILD_TEST_SECRET

function Assert-True([bool]$Condition,[string]$Message){if(-not$Condition){throw "Assertion failed: $Message"};$script:Passed++}
function Assert-Equal($Actual,$Expected,[string]$Message){Assert-True ([string]$Actual-ceq[string]$Expected) $Message}
function New-BuildContext([string]$Root=$testRoot){return [pscustomobject]@{projectRoot=$Root;nodePath=$nodePath;expectedBuildId=''}}
function Get-Expected($Context){return (& $module {param($c) Get-CbExpectedBuildId -Context $c} $Context)}
function Get-Oracle{
  $value=& $nodePath (Join-Path $testRoot 'scripts\oracle.mjs')
  if($LASTEXITCODE-ne 0){throw 'Canonical Node oracle failed'}
  return [string]$value
}
function Assert-Failure($Context,[string]$Code){
  $message=$null
  try{[void](Get-Expected $Context)}catch{$message=$_.Exception.Message}
  Assert-True ($null-ne$message-and$message.StartsWith($Code+': ',[StringComparison]::Ordinal)) "fails closed with $Code"
  Assert-True ($message-notmatch'never-project|private-path|CB_BUILD_TEST_SECRET') 'failure excludes child output and secrets'
}
function Write-Helper([string]$Source){[IO.File]::WriteAllText($helperPath,$Source,$utf8)}

try{
  # Read only package/dist/web from the real checkout; no context constructor,
  # production settings, PID files, health endpoint, or lifecycle action.
  $module=Import-Module (Join-Path $projectRoot 'scripts\codex-bridge-runtime.psm1') -Force -PassThru
  $actual=Get-Expected (New-BuildContext $projectRoot)
  $nodeActual=& $nodePath (Join-Path $projectRoot 'scripts\runtime-build-id.mjs')
  Assert-Equal $LASTEXITCODE 0 'checkout canonical helper succeeds'
  Assert-Equal $actual $nodeActual 'checkout PowerShell equals Node without ExpectedBuildId'
  Remove-Module $module

  foreach($dir in @('scripts','dist\src','web','web\nested')){New-Item -ItemType Directory -Path(Join-Path $testRoot $dir)-Force|Out-Null}
  foreach($name in @('codex-bridge-runtime.psm1','runtime-build-id.mjs')){Copy-Item -LiteralPath(Join-Path $projectRoot "scripts\$name")-Destination(Join-Path $testRoot "scripts\$name")}
  Copy-Item -LiteralPath(Join-Path $projectRoot 'dist\src\config.js')-Destination(Join-Path $testRoot 'dist\src\config.js')
  Copy-Item -LiteralPath(Join-Path $projectRoot 'dist\src\installed-runtime.js')-Destination(Join-Path $testRoot 'dist\src\installed-runtime.js')
  [IO.File]::WriteAllText((Join-Path $testRoot 'package.json'),'{"type":"module"}',$utf8)
  $names=@('_first.txt','-last.txt','Zebra.txt','alpha.txt','a-b.txt','a_b.txt','a.b.txt','10.txt','2.txt',([string][char]0xe9+'clair.txt'),([string][char]0x4e2d+'.txt'))
  foreach($name in $names){[IO.File]::WriteAllText((Join-Path $testRoot "web\$name"),$name,$utf8)}
  [IO.File]::WriteAllBytes((Join-Path $testRoot 'web\nested\binary.bin'),[byte[]]@(0,255,13,10))
  [IO.File]::WriteAllText((Join-Path $testRoot 'scripts\oracle.mjs'),@'
import { computeRuntimeBuildId } from '../dist/src/config.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
console.log(await computeRuntimeBuildId(resolve(dirname(fileURLToPath(import.meta.url)), '..')));
'@,$utf8)
  $helperPath=Join-Path $testRoot 'scripts\runtime-build-id.mjs';$helperSource=[IO.File]::ReadAllText($helperPath)
  $module=Import-Module (Join-Path $testRoot 'scripts\codex-bridge-runtime.psm1') -Force -PassThru
  $context=New-BuildContext;$initial=Get-Expected $context
  Assert-Equal $initial (Get-Oracle) 'mixed case punctuation Unicode and nested bytes agree across languages'
  foreach($name in $names){Remove-Item -LiteralPath(Join-Path $testRoot "web\$name")}
  [array]::Reverse($names)
  foreach($name in $names){[IO.File]::WriteAllText((Join-Path $testRoot "web\$name"),$name,$utf8)}
  Assert-Equal (Get-Expected (New-BuildContext)) $initial 'file creation order does not change the ID'
  [IO.File]::WriteAllBytes((Join-Path $testRoot 'web\nested\binary.bin'),[byte[]]@(1,255,13,10))
  $changed=Get-Expected (New-BuildContext)
  Assert-True ($changed-ne$initial) 'same length byte change is detected by a new call'
  Assert-Equal $changed (Get-Oracle) 'modified bytes still agree with Node'
  Assert-Equal (Get-Expected $context) $initial 'one call retains its build snapshot'
  Rename-Item -LiteralPath(Join-Path $testRoot 'web\nested\binary.bin')-NewName 'renamed.bin'
  $renamed=Get-Expected (New-BuildContext)
  Assert-True ($renamed-ne$changed) 'relative path rename changes the ID'
  Assert-Equal $renamed (Get-Oracle) 'renamed file agrees with Node'
  Remove-Item -LiteralPath(Join-Path $testRoot 'web\nested\renamed.bin')
  Assert-True ((Get-Expected (New-BuildContext))-ne$renamed) 'file removal changes the ID'

  $counterPrefix="import fs from 'node:fs'; fs.appendFileSync(new URL('./calls.txt', import.meta.url), 'x');`n"
  Write-Helper ($counterPrefix+$helperSource)
  $cached=New-BuildContext;$cachedValue=Get-Expected $cached
  & $module {param($value) $script:FixtureHealthBuild=$value;function script:Get-CbHealth {param($Context) return [pscustomobject]@{ok=$true;service='codex-handoff-bridge';buildId=$script:FixtureHealthBuild}}} $cachedValue
  1..8|ForEach-Object {Assert-True (& $module {param($c) Test-CbServerHealth -Context $c} $cached) 'repeated health comparison passes'}
  Assert-Equal ([IO.File]::ReadAllText((Join-Path $testRoot 'scripts\calls.txt'))) 'x' 'health polling forks Node once per context'
  & $module {$script:FixtureHealthBuild='0000000000000000'}
  Assert-True (-not(& $module {param($c) Test-CbServerHealth -Context $c} $cached)) 'health build mismatch remains rejected'

  Write-Helper ($counterPrefix+"process.stdout.write('invalid');")
  $failed=New-BuildContext;Assert-Failure $failed 'BUILD_ID_OUTPUT_INVALID';Assert-Failure $failed 'BUILD_ID_OUTPUT_INVALID'
  Assert-Equal ([IO.File]::ReadAllText((Join-Path $testRoot 'scripts\calls.txt'))) 'xx' 'failures are cached without retry forks'
  foreach($source in @("process.stdout.write('');","process.stdout.write('ABCDEF0123456789');","process.stdout.write('0123456789abcdef\n0123456789abcdef');","process.stdout.write('x'.repeat(1000000));")){
    Write-Helper $source;Assert-Failure (New-BuildContext) 'BUILD_ID_OUTPUT_INVALID'
  }
  Write-Helper "process.stdout.write('0123456789abcdef');process.exitCode=7;"
  Assert-Failure (New-BuildContext) 'BUILD_ID_COMPUTE_FAILED'
  Write-Helper "process.stderr.write('never-project private-path');setInterval(()=>{},1000);"
  Assert-Failure (New-BuildContext) 'BUILD_ID_STDERR'
  Write-Helper 'setInterval(()=>{},1000);'
  $timer=[Diagnostics.Stopwatch]::StartNew();Assert-Failure (New-BuildContext) 'BUILD_ID_TIMEOUT'
  Assert-True ($timer.Elapsed.TotalSeconds-lt 15) 'hung helper is bounded and reaped'

  # No NODE_OPTIONS preloads and no inherited secrets reach the helper.
  $env:NODE_OPTIONS='--require=private-path-never-project';$env:CB_BUILD_TEST_SECRET='never-project'
  Write-Helper ("if (process.env.NODE_OPTIONS || process.env.CB_BUILD_TEST_SECRET) process.exit(8);`n"+$helperSource)
  Assert-True ((Get-Expected (New-BuildContext))-cmatch'\A[0-9a-f]{16}\z') 'helper has a minimal environment'
  $env:NODE_OPTIONS=$previousOptions;$env:CB_BUILD_TEST_SECRET=$previousSecret
  Write-Helper $helperSource
  $unsafe=New-BuildContext;$unsafe.projectRoot=Join-Path $testRoot 'other'
  Assert-Failure $unsafe 'BUILD_ID_PATH_UNSAFE'
  $badNode=New-BuildContext;$badNode.nodePath='node.exe'
  Assert-Failure $badNode 'BUILD_ID_NODE_INVALID'
  $badNode=New-BuildContext;$badNode.nodePath=Join-Path $testRoot 'node.exe'
  Assert-Failure $badNode 'BUILD_ID_NODE_INVALID'
  [IO.File]::WriteAllText($badNode.nodePath,'not an executable',$utf8)
  Assert-Failure $badNode 'BUILD_ID_NODE_INVALID' # Previous failure stays cached.
  Assert-Failure (New-BuildContext | ForEach-Object {$_.nodePath=Join-Path $testRoot 'node.exe';$_}) 'BUILD_ID_COMPUTE_FAILED'
  Remove-Item -LiteralPath $helperPath
  Assert-Failure (New-BuildContext) 'BUILD_ID_HELPER_MISSING'
  $override=New-BuildContext;$override.expectedBuildId='test-build'
  Assert-Equal (Get-Expected $override) 'test-build' 'explicit test override still works without helper'
  Write-Helper $helperSource
  Remove-Item -LiteralPath(Join-Path $testRoot 'dist\src\config.js')
  Assert-Failure (New-BuildContext) 'BUILD_ID_CONFIG_MISSING'
  $redirected=Join-Path $testRoot 'redirected-config';$junction=Join-Path $testRoot 'dist\src'
  New-Item -ItemType Directory -Path $redirected|Out-Null
  Copy-Item -LiteralPath(Join-Path $projectRoot 'dist\src\config.js')-Destination(Join-Path $redirected 'config.js')
  Remove-Item -LiteralPath(Join-Path $junction 'installed-runtime.js') # Exact disposable support file; leave directory empty.
  Remove-Item -LiteralPath $junction -Force # Empty fixture directory only.
  New-Item -ItemType Junction -Path $junction -Target $redirected|Out-Null
  try{Assert-Failure (New-BuildContext) 'BUILD_ID_PATH_UNSAFE'}finally{[IO.Directory]::Delete($junction)}

  [pscustomobject]@{ok=$true;assertions=$script:Passed;checkoutBuildId=$actual;powershell=$PSVersionTable.PSVersion.ToString();productionRuntimeTouched=$false}|ConvertTo-Json
}
finally{
  $env:NODE_OPTIONS=$previousOptions;$env:CB_BUILD_TEST_SECRET=$previousSecret
  if($null-ne$module){Remove-Module $module -ErrorAction SilentlyContinue}
  $resolved=[IO.Path]::GetFullPath($testRoot)
  if($resolved.StartsWith($tempBase+'\',[StringComparison]::OrdinalIgnoreCase)-and(Test-Path -LiteralPath $resolved)){
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
