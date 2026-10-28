# Real inventory/preflight engine with synthetic files only. No live lifecycle.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$module=Import-Module (Join-Path $repo 'mcp_control_center/src/McpControlCenter.DailyCode.psm1') -Force -PassThru
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('daily-path-'+[guid]::NewGuid().ToString('N'))
$source=Join-Path $fixture 'source';$root=Join-Path $fixture 'Runtime';$passed=0
function Check([bool]$Value,[string]$Name){if(-not $Value){throw ('FAILED: '+$Name)};$script:passed++}
function Denied([scriptblock]$Body,[string]$Pattern){$message='';try{& $Body|Out-Null}catch{$message=$_.Exception.Message};Check ($message -match $Pattern) ($Pattern+' observed='+$message)}
function Put([string]$Path,[string]$Text){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,$Text)}
try {
    foreach($p in @('codex_bridge/src/config.ts','codex_bridge/dist/src/http-main.js','codex_bridge/web/index.html',
        'codex_bridge/scripts/daily-code-owner.ps1','codex_bridge/scripts/daily-runtime-settings.ps1',
        'codex_bridge/scripts/daily-bearer.ps1','codex_bridge/scripts/cooperative-layout.ps1',
        'codex_bridge/control-center/component.json','codex_bridge/node_modules/pkg/index.js',
        'codex_bridge/package.json','codex_bridge/package-lock.json','codex_bridge/daily-code-contract.json',
        'mcp_control_center/src/NormalOperator.Native.cs','mcp_control_center/src/RemoteSelfReload.Native.cs')){Put (Join-Path $source $p) 'fixture v1'}
    $null=New-McpDailyCandidate $root $source legacy
    Put (Join-Path $source 'codex_bridge/dist/tests/config.test.js') '// compiled test'
    Put (Join-Path $source 'codex_bridge/dist/tests/config.test.js.map') '{}'
    $null=New-McpDailyCandidate $root $source fixed
    $old=Join-Path $root 'versions/legacy';$candidate=Join-Path $root 'versions/fixed'
    Put (Join-Path $root 'current.json') '{"contract":"mcpcc-daily-current-v1","version":"legacy"}'
    Put (Join-Path $root 'settings.json') '{"fixture":true}'
    & $module {param($r)
        Write-DailyNew (Join-Path $r 'adoption.json') @{settingsSha256=(Get-DailyDigest (Join-Path $r 'settings.json'))}
        function script:Read-DailySettingsForVersion {param($Root,$Version) return @{fixture=$true}}
        function script:Invoke-DailyOwner {throw 'LIFECYCLE_MUST_NOT_RUN'}
        function script:Get-DailyDigest([string]$Path){
            if($Path -match '[/\\](\.local|\.secrets)([/\\]|$)'){throw 'PRIVATE_CONTENT_MUST_NOT_BE_READ'}
            return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    } $root
    $emptySecrets=Join-Path $old 'project_reading/.secrets';$emptyLocal=Join-Path $old 'codex_bridge/.local'
    [void][IO.Directory]::CreateDirectory($emptySecrets);[void][IO.Directory]::CreateDirectory($emptyLocal)
    Denied {Get-McpDailyStatus $root} '^DAILY_PACKAGE_PATH_REJECTED$'
    # Pin the synthetic incident, not the live manifest, within this module instance.
    & $module {param($r) $script:DailyLegacyEmptyVersion='legacy';$script:DailyLegacyEmptyManifest=Get-DailyDigest (Join-Path $r 'versions/legacy/daily-release.json')} $root
    Check ((Get-McpDailyStatus $root).version -ceq 'legacy') 'pinned old status verifies entire code inventory'
    foreach($relative in @('codex_bridge/.env','codex_bridge/.secrets','codex_bridge/.tunnel-client')){
        $directory=Join-Path $old $relative;[void][IO.Directory]::CreateDirectory($directory)
        Check ((Get-McpDailyStatus $root).version -ceq 'legacy') 'pinned exact empty deny directory accepted'
        Put (Join-Path $directory 'fixture.txt') 'synthetic private sentinel'
        Denied {Get-McpDailyStatus $root} '^DAILY_PRIVATE_FILE_REJECTED'
        [IO.File]::Delete((Join-Path $directory 'fixture.txt'))
        [IO.Directory]::Delete($directory,$false)
        Put $directory 'synthetic private sentinel'
        Denied {Get-McpDailyStatus $root} '^DAILY_PRIVATE_FILE_REJECTED'
        [IO.File]::Delete($directory)
    }
    $preflight=Test-McpDailyUpdate $root fixed -CodeOnly
    Check ($preflight.codeOnlyCompatible -and $preflight.changed.Count -eq 2) 'compiled tests and maps allowed by real preflight'
    foreach($p in @('operations','update.lock')){Check (-not(Test-Path -LiteralPath (Join-Path $root $p))) ('read-only preflight creates no '+$p)}
    Check ((Get-McpDailyStatus $root).version -ceq 'legacy') 'preflight leaves selector unchanged'
    Denied {Test-McpDailyUpdate $root fixed} '^DAILY_CODE_ONLY_REVIEW_REQUIRED$'
    Denied {& $module {param($r) Get-DailyFiles $r} $old} '^DAILY_PACKAGE_PATH_REJECTED$'
    # Each deviation fails without opening a private file, even with the pinned manifest.
    foreach($p in @('project_reading/.secrets/fixture.dpapi','project_reading/.secrets/extra/file.js',
        'project_reading/extra.js','codex_bridge/.local/fixture.json','codex_bridge/.local/code.js')){
        $path=Join-Path $old $p;Put $path 'synthetic private sentinel'
        Denied {Get-McpDailyStatus $root} '^DAILY_(PACKAGE_PATH|PRIVATE_FILE)_REJECTED'
        [IO.File]::Delete($path)
        if($p -like '*/extra/*'){[IO.Directory]::Delete((Split-Path -Parent $path),$false)}
    }
    $other=Join-Path $old 'project_reading/other';[void][IO.Directory]::CreateDirectory($other)
    Denied {Get-McpDailyStatus $root} '^DAILY_PACKAGE_PATH_REJECTED$'
    [IO.Directory]::Delete($other,$false)
    $mf=Join-Path $old 'daily-release.json';$bytes=[IO.File]::ReadAllBytes($mf)
    [IO.File]::AppendAllText($mf,' ')
    Denied {Get-McpDailyStatus $root} '^DAILY_PACKAGE_PATH_REJECTED$'
    [IO.File]::WriteAllBytes($mf,$bytes)
    $code=Join-Path $old 'codex_bridge/src/config.ts';$bytes=[IO.File]::ReadAllBytes($code)
    Put $code 'mutated code'
    Denied {Get-McpDailyStatus $root} '^DAILY_INTEGRITY_FAILED$'
    [IO.File]::WriteAllBytes($code,$bytes)
    $extra=Join-Path $old 'codex_bridge/src/unlisted.ts';Put $extra '// unsanctioned'
    Denied {Get-McpDailyStatus $root} '^DAILY_INTEGRITY_FAILED$'
    [IO.File]::Delete($extra)
    # Candidate does not inherit the legacy exception.
    [void][IO.Directory]::CreateDirectory((Join-Path $candidate 'project_reading/.secrets'))
    Denied {Test-McpDailyUpdate $root fixed -CodeOnly} '^DAILY_PACKAGE_PATH_REJECTED$'
    [IO.Directory]::Delete((Join-Path $candidate 'project_reading/.secrets'),$false)
    [IO.Directory]::Delete((Join-Path $candidate 'project_reading'),$false)
    [void][IO.Directory]::CreateDirectory((Join-Path $candidate 'codex_bridge/.local'))
    Denied {Test-McpDailyUpdate $root fixed -CodeOnly} '^DAILY_PRIVATE_FILE_REJECTED'
    [IO.Directory]::Delete((Join-Path $candidate 'codex_bridge/.local'),$false)
    # No OS symlinks/ACL changes: exercise the real metadata branch with one synthetic reparse entry.
    & $module {param($p)
        $script:ReparseFixture=$p
        function script:Get-ChildItem {param($LiteralPath,[switch]$Force)
            if($LiteralPath -ceq $script:ReparseFixture){return [pscustomobject]@{FullName=(Join-Path $LiteralPath '.secrets');Name='.secrets';PSIsContainer=$true;Attributes=[IO.FileAttributes]::ReparsePoint}}
            Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $LiteralPath -Force:$Force
        }
    } (Join-Path $old 'project_reading')
    Denied {Get-McpDailyStatus $root} '^DAILY_PACKAGE_PATH_REJECTED$'
    & $module {Remove-Item Function:Get-ChildItem}
    $before=& $module {param($r) Test-DailyVersion $r legacy} $root
    foreach($p in @('codex_bridge/dist/tests/migrations/001.js','codex_bridge/dist/tests/schema-migrations/001.js',
        'codex_bridge/dist/tests/change.sql','codex_bridge/dist/tests/schema.json','codex_bridge/dist/other/test.js',
        'codex_bridge/src/migrations/001.ts','codex_bridge/package.json','codex_bridge/package-lock.json',
        'codex_bridge/node_modules/pkg/index.js','codex_bridge/daily-code-contract.json','codex_bridge/control-center/component.json')){
        $after=[pscustomobject]@{files=@($before.files | Where-Object {$_.path -cne $p})+@([pscustomobject]@{path=$p;sha256='changed'})}
        Denied {& $module {param($a,$b) Assert-DailyCompatible $a $b} $before $after} '^DAILY_MIGRATION_REQUIRED:'
    }
    Check ((Test-McpDailyUpdate $root fixed -CodeOnly).candidateFiles -eq (@($before.files).Count+2)) 'candidate remains fully verified'
    Check (@(Get-ChildItem -LiteralPath $emptySecrets -Force).Count -eq 0) 'legacy empty credential directory retained'
    Check (Test-Path -LiteralPath $emptyLocal) 'legacy local directory retained'
    [pscustomobject]@{ok=$true;passed=$passed;live=$false;privateContentsRead=$false;legacyDataDeleted=$false}|ConvertTo-Json
} finally {
    Remove-Module $module
    $resolved=[IO.Path]::GetFullPath($fixture)
    if((Split-Path -Parent $resolved) -ine [IO.Path]::GetTempPath().TrimEnd('\') -or (Split-Path -Leaf $resolved) -cnotmatch '^daily-path-[0-9a-f]{32}$'){throw 'UNSAFE_FIXTURE_CLEANUP'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
