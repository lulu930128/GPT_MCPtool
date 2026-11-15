# Real offline Build/Stage/Update engine; only component lifecycle is an inert fixture.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$module=Import-Module (Join-Path $repo 'mcp_control_center/src/McpControlCenter.DailyCode.psm1') -Force -PassThru
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('mcp-daily-codex-'+[guid]::NewGuid().ToString('N'))
$passed=0
function Check([bool]$Value,[string]$Name){if(-not $Value){throw "FAILED: $Name"};$script:passed++}
function Put([string]$Path,[string]$Text){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,$Text)}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'test-daily-code-update.ps1'),[ref]$tokens,[ref]$errors)
$builder=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'New-Case'},$true)
. ([scriptblock]::Create($builder.Extent.Text))
function Set-CodexPackages([string]$Source,[string]$Version){
    $bridge=Join-Path $Source 'codex_bridge'
    $dependency=@{'@openai/codex'=$Version}
    $cli=@{name='@openai/codex';version=$Version;optionalDependencies=@{'@openai/codex-win32-x64'=('npm:@openai/codex@'+$Version+'-win32-x64')}}
    $native=@{name='@openai/codex';version=($Version+'-win32-x64')}
    Put (Join-Path $bridge 'package.json') (@{name='fixture';private=$true;dependencies=$dependency}|ConvertTo-Json -Depth 8)
    Put (Join-Path $bridge 'package-lock.json') (@{lockfileVersion=3;packages=@{''=@{dependencies=$dependency};'node_modules/@openai/codex'=$cli;'node_modules/@openai/codex-win32-x64'=$native}}|ConvertTo-Json -Depth 8)
    Put (Join-Path $bridge 'node_modules/@openai/codex/package.json') ($cli|ConvertTo-Json -Depth 8)
    Put (Join-Path $bridge 'node_modules/@openai/codex/bin/codex.js') ('// synthetic launcher '+$Version)
    Put (Join-Path $bridge 'node_modules/@openai/codex-win32-x64/package.json') ($native|ConvertTo-Json -Depth 8)
    Put (Join-Path $bridge 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe') ('synthetic native '+$Version)
}
try {
    $case=New-Case codex-upgrade
    Set-CodexPackages $case.source '0.154.0'
    # Invoke the real bounded Node build child with a tiny deterministic compiler fixture.
    Put (Join-Path $case.source 'codex_bridge/node_modules/typescript/bin/tsc') @'
const fs = require('node:fs');
if (process.argv.slice(2).join(' ') !== '-p tsconfig.json') process.exit(2);
fs.writeFileSync('dist/src/http-main.js', '// built fixture');
'@
    $null=New-McpDailyCandidate -Root $case.root -Source $case.source -Version codex-old
    & $module {param($r) Set-DailySelector $r 'codex-old';$script:Running='codex-old';$script:Calls.Clear()} $case.root
    $before=& $module {param($r) Test-DailyVersion $r 'codex-old'} $case.root
    Set-CodexPackages $case.source '0.165.0'
    $retired=Join-Path $case.source 'codex_bridge/node_modules/@openai/.codex-win32-x64-Ab12Cd34/vendor/old.exe'
    Put $retired 'retained old native bytes'
    $result=Invoke-McpDailyUpdate -Root $case.root -CandidateRoot $case.source -Version codex-new -CodeOnly
    Check ($result.phase -ceq 'ACCEPTED') 'package/lock/native upgrade completes real Build/Stage/Update'
    $candidate=Join-Path $case.root 'versions/codex-new/codex_bridge'
    Check (([IO.File]::ReadAllText((Join-Path $candidate 'dist/src/http-main.js'))) -ceq '// built fixture') 'real build output is staged'
    $after=& $module {param($r) Test-DailyVersion $r 'codex-new'} $case.root
    $changed=@(& $module {param($a,$b) Assert-DailyCompatible $a $b} $before $after)
    Check ($changed -contains 'codex_bridge/package.json') 'manifest is a permitted code change'
    Check ($changed -contains 'codex_bridge/package-lock.json') 'lockfile is a permitted code change'
    Check ($changed -contains 'codex_bridge/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe') 'native binary is a permitted code change'
    $package=Get-Content -LiteralPath (Join-Path $candidate 'package.json') -Raw | ConvertFrom-Json
    # Windows PowerShell ConvertFrom-Json cannot represent npm's empty root key.
    Add-Type -AssemblyName System.Web.Extensions
    $json=New-Object Web.Script.Serialization.JavaScriptSerializer
    $lock=$json.DeserializeObject([IO.File]::ReadAllText((Join-Path $candidate 'package-lock.json')))
    $cli=Get-Content -LiteralPath (Join-Path $candidate 'node_modules/@openai/codex/package.json') -Raw | ConvertFrom-Json
    $native=Get-Content -LiteralPath (Join-Path $candidate 'node_modules/@openai/codex-win32-x64/package.json') -Raw | ConvertFrom-Json
    Check ($package.dependencies.'@openai/codex' -ceq $cli.version -and $cli.version -ceq '0.165.0') 'staged manifest and CLI agree'
    Check ($native.version -ceq ($cli.version+'-win32-x64')) 'staged CLI and native agree'
    Check ($lock['packages']['node_modules/@openai/codex']['version'] -ceq $cli.version -and $lock['packages']['node_modules/@openai/codex-win32-x64']['version'] -ceq $native.version) 'staged lock agrees with both packages'
    Check ((Get-McpDailyStatus $case.root).version -ceq 'codex-new') 'selector adopts the fixture candidate'
    Check (Test-Path -LiteralPath (Join-Path $case.root 'versions/codex-old/daily-release.json')) 'previous version remains immutable and available'
    Check (([IO.File]::ReadAllText($retired)) -ceq 'retained old native bytes') 'npm retired bytes remain untouched in source'
    Check (-not(Test-Path -LiteralPath (Join-Path $candidate 'node_modules/@openai/.codex-win32-x64-Ab12Cd34'))) 'retired npm directory is not published'
    $calls=@(& $module {$script:Calls.ToArray()})
    Check (($calls -contains 'codex-old:Stop') -and ($calls -contains 'codex-new:Start') -and ($calls -contains 'codex-new:Verify')) 'existing lifecycle and Verify remain in the transaction'
    Check (@($calls|Where-Object {$_ -match 'Tray'}).Count -eq 0) 'Bridge update never restarts CC'
    # Dependency admission does not exempt config, data contracts or migrations.
    foreach($p in @('codex_bridge/daily-code-contract.json','codex_bridge/control-center/component.json','codex_bridge/scripts/migrations/001.sql')){
        $message=''
        try {& $module {param($p) Assert-DailyCompatible @{files=@(@{path=$p;sha256='a'})} @{files=@(@{path=$p;sha256='b'})}} $p | Out-Null}catch{$message=$_.Exception.Message}
        Check ($message -like 'DAILY_MIGRATION_REQUIRED:*') ($p+' remains protected')
    }
    Put (Join-Path $case.source 'codex_bridge/node_modules/@openai/codex/auth.json') 'synthetic private fixture'
    $message='';try {New-McpDailyCandidate -Root $case.root -Source $case.source -Version private-candidate|Out-Null}catch{$message=$_.Exception.Message}
    Check ($message -like 'DAILY_PRIVATE_FILE_REJECTED:*') 'private dependency files remain rejected before staging'
    [pscustomobject]@{ok=$true;passed=$passed;live=$false;nativeExecution='SYNTHETIC_FIXTURE';oldCli='0.154.0';newCli=$cli.version;newNative=$native.version}|ConvertTo-Json
} finally {
    $resolved=[IO.Path]::GetFullPath($fixture)
    if((Split-Path -Parent $resolved) -ine [IO.Path]::GetTempPath().TrimEnd('\') -or (Split-Path -Leaf $resolved) -cnotmatch '^mcp-daily-codex-[0-9a-f]{32}$'){throw 'UNSAFE_FIXTURE_CLEANUP'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
