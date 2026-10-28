# Real Windows processes, inherited pipes and duplicated fixture locks. Never starts a runtime.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$daily=Import-Module (Join-Path $repo 'mcp_control_center/src/McpControlCenter.DailyCode.psm1') -Force -PassThru
$runtime=Import-Module (Join-Path $repo 'codex_bridge/scripts/codex-bridge-runtime.psm1') -Force -PassThru
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('cb-child-'+[guid]::NewGuid().ToString('N'))
$ps=Join-Path $PSHOME 'powershell.exe';$passed=0;$scope=$null;$updater=$null;$inert=$null
$retained=New-Object 'Collections.Generic.List[Diagnostics.Process]'
function Check([bool]$value,[string]$name){if(-not $value){throw "FAILED: $name"};$script:passed++}
function Put($path,$text){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $path));[IO.File]::WriteAllText($path,$text)}
function Info($entry,$arguments=''){
    $si=New-Object Diagnostics.ProcessStartInfo;$si.FileName=$ps
    $si.Arguments='-NoProfile -NonInteractive -File "'+$entry+'" '+$arguments
    $si.WorkingDirectory=$fixture;$si.UseShellExecute=$false;$si.CreateNoWindow=$true
    $si.RedirectStandardOutput=$true;$si.RedirectStandardError=$true;return $si
}
function Await-File($path){
    $watch=[Diagnostics.Stopwatch]::StartNew()
    while(-not(Test-Path -LiteralPath $path)){
        if($updater -and $updater.HasExited){throw ('FIXTURE_UPDATER_FAILED: '+$updater.StandardError.ReadToEnd())}
        if($watch.ElapsedMilliseconds -gt 20000){throw "FIXTURE_NOT_READY: $path"};Start-Sleep -Milliseconds 30
    }
}
function Retain-Identity($path){
    Await-File $path;$value=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json
    $p=[Diagnostics.Process]::GetProcessById([int]$value.pid);$null=$p.Handle
    Check ($p.StartTime.ToUniversalTime().Ticks -eq [long]$value.ticks) 'retain exact fixture process instance'
    $retained.Add($p);return $p
}
try {
    [void][IO.Directory]::CreateDirectory($fixture)
    & $daily {Initialize-DailyChildNative}
    $common=@'
$ErrorActionPreference='Stop'
. '__HELPER__'
function Get-CbCooperativeDailyLayout {param($ProjectRoot) return @{workspaceRoot=$PSScriptRoot;version='fixture'}}
function Assert-CbCooperativeCodePath {param($Path)}
$ctx=@{projectRoot=(Join-Path $PSScriptRoot 'codex_bridge')}
function Identity($name){@{pid=$PID;ticks=[string](Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $PSScriptRoot $name)}
'@
    $common=$common.Replace('__HELPER__',(Join-Path $repo 'codex_bridge/scripts/daily-lifecycle.ps1'))
    Put (Join-Path $fixture 'common.ps1') $common
    Put (Join-Path $fixture 'inert.ps1') 'Start-Sleep -Seconds 90'
    $inert=[Diagnostics.Process]::Start((Info (Join-Path $fixture 'inert.ps1')));$null=$inert.Handle
    Put (Join-Path $fixture 'runtime-control.ps1') @'
. (Join-Path $PSScriptRoot 'common.ps1')
$lease=Open-CbDailyMutation $ctx
try {Identity 'nested.json';while($true){[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'writes.txt'),'x');Start-Sleep -Milliseconds 30}}
finally {$lease.Dispose()}
'@
    Put (Join-Path $fixture 'daily-code-owner.ps1') @'
param([switch]$ExitWithPipe)
. (Join-Path $PSScriptRoot 'common.ps1')
$lease=Open-CbDailyMutation $ctx
Identity 'owner.json'
if($ExitWithPipe){
    $si=New-Object Diagnostics.ProcessStartInfo;$si.FileName=Join-Path $PSHOME 'powershell.exe'
    $si.Arguments='-NoProfile -File "'+(Join-Path $PSScriptRoot 'runtime-control.ps1')+'"'
    $si.UseShellExecute=$false;$si.CreateNoWindow=$true
    $p=[Diagnostics.Process]::Start($si)
    while(-not(Test-Path (Join-Path $PSScriptRoot 'nested.json'))){Start-Sleep -Milliseconds 30}
    $lease.Dispose();'{"ok":true}';exit 0
}
try {& (Join-Path $PSHOME 'powershell.exe') -NoProfile -File (Join-Path $PSScriptRoot 'runtime-control.ps1')}
finally {$lease.Dispose()}
'@
    $lockPath=Join-Path $fixture 'codex_bridge/Runtime/update.lock'
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $lockPath))
    foreach($mode in @('timeout','inherited-pipe')){
        foreach($name in @('owner.json','nested.json')){[IO.File]::Delete((Join-Path $fixture $name))}
        $file=[IO.File]::Open($lockPath,'OpenOrCreate','ReadWrite','None')
        try {
            $si=Info (Join-Path $fixture 'daily-code-owner.ps1') $(if($mode -eq 'inherited-pipe'){'-ExitWithPipe'}else{''})
            $si.EnvironmentVariables['CB_DAILY_PARENT_PID']=[string]$PID
            # Non-microsecond-aligned identity must still delegate.
            $ticks=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)).CreationDate.ToUniversalTime().Ticks+7
            $si.EnvironmentVariables['CB_DAILY_PARENT_TICKS']=[string]$ticks
            $si.EnvironmentVariables['CB_DAILY_LOCK_HANDLE']=[string]$file.SafeFileHandle.DangerousGetHandle().ToInt64()
            $scope=[CbDailyChild]::Start($si)
            $nested=Retain-Identity (Join-Path $fixture 'nested.json')
            Check (-not $nested.HasExited) 'short nested controller delegates and holds real duplicated lock'
            if($mode -eq 'inherited-pipe'){Check ($scope.WaitForExit(5000)) 'owner exits while nested controller retains stdout pipe'}
            $watch=[Diagnostics.Stopwatch]::StartNew();$errorCode=''
            try {& $daily {param($p) Read-DailyOwnerOutput $p 700} $scope|Out-Null}catch{$errorCode=$_.Exception.Message}
            Check ($errorCode -eq 'DAILY_OWNER_TIMEOUT_UNKNOWN') ($mode+' bounded capture deadline')
            $scope.Dispose();$scope=$null
            Check ($nested.WaitForExit(5000)) ($mode+' closes exact nested controller')
            Check ($watch.ElapsedMilliseconds -lt 7000) 'capture and cleanup have bounded total time'
            $hash=(Get-FileHash (Join-Path $fixture 'writes.txt')).Hash;Start-Sleep -Milliseconds 150
            Check ((Get-FileHash (Join-Path $fixture 'writes.txt')).Hash -ceq $hash) 'terminated controller cannot continue writing'
        } finally {if($scope){$scope.Dispose();$scope=$null};$file.Dispose()}
        $probe=[IO.File]::Open($lockPath,'Open','ReadWrite','None');$probe.Dispose()
        Check (-not $inert.HasExited) 'unrelated inert runtime untouched'
    }
    # Kill the retained fixture updater, not a PID lookup. The OS closes its job
    # handle even though the legacy owner/controller know nothing about watchdogs.
    foreach($name in @('owner.json','nested.json')){[IO.File]::Delete((Join-Path $fixture $name))}
    $parent=@'
. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-CbDailyNative
$file=[IO.File]::Open((Join-Path $PSScriptRoot 'codex_bridge/Runtime/update.lock'),'Open','ReadWrite','None')
$si=New-Object Diagnostics.ProcessStartInfo;$si.FileName=Join-Path $PSHOME 'powershell.exe'
$si.Arguments='-NoProfile -File "'+(Join-Path $PSScriptRoot 'legacy-owner.ps1')+'"'
$si.UseShellExecute=$false;$si.CreateNoWindow=$true;$si.RedirectStandardOutput=$true;$si.RedirectStandardError=$true
$si.EnvironmentVariables['FIXTURE_PARENT']=[string]$PID
$si.EnvironmentVariables['FIXTURE_HANDLE']=[string]$file.SafeFileHandle.DangerousGetHandle().ToInt64()
$scope=[CbDailyChild]::Start($si)
Start-Sleep -Seconds 90
'@
    Put (Join-Path $fixture 'updater.ps1') $parent
    Put (Join-Path $fixture 'legacy-owner.ps1') @'
. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-CbDailyNative
$copy=[CbDailyLockFile]::DuplicateUpdateLock([int]$env:FIXTURE_PARENT,[long]$env:FIXTURE_HANDLE,(Join-Path $PSScriptRoot 'codex_bridge/Runtime/update.lock'))
Identity 'owner.json'
& (Join-Path $PSHOME 'powershell.exe') -NoProfile -File (Join-Path $PSScriptRoot 'legacy-controller.ps1')
'@
    Put (Join-Path $fixture 'legacy-controller.ps1') @'
. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-CbDailyNative
$copy=[CbDailyLockFile]::DuplicateUpdateLock([int]$env:FIXTURE_PARENT,[long]$env:FIXTURE_HANDLE,(Join-Path $PSScriptRoot 'codex_bridge/Runtime/update.lock'))
Identity 'nested.json'
while($true){[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'writes.txt'),'y');Start-Sleep -Milliseconds 30}
'@
    $updater=[Diagnostics.Process]::Start((Info (Join-Path $fixture 'updater.ps1')));$null=$updater.Handle
    $owner=Retain-Identity (Join-Path $fixture 'owner.json');$nested=Retain-Identity (Join-Path $fixture 'nested.json')
    $updater.Kill();Check ($updater.WaitForExit(5000)) 'fixture updater force interruption completes'
    Check ($owner.WaitForExit(5000) -and $nested.WaitForExit(5000)) 'source scope contains legacy owner and legacy controller after parent death'
    $probe=[IO.File]::Open($lockPath,'Open','ReadWrite','None');$probe.Dispose()
    Check (-not $inert.HasExited) 'parent death does not terminate an independent service fixture'

    # The actual compiler entry uses the same finite scope; a timeout cannot keep
    # changing dist while a later Build/Stage proceeds.
    $compiler=Join-Path $fixture 'compiler/codex_bridge/node_modules/typescript/bin/tsc'
    Put $compiler "const fs=require('fs');const cp=require('child_process');fs.writeFileSync('compiler.pid',String(process.pid));setInterval(()=>fs.appendFileSync('dist-writes.txt','x'),20);cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});"
    & $daily { $script:DailyBuildTimeoutMs=1200 }
    $code='';try {& $daily {param($s) Build-DailyCandidate $s} (Join-Path $fixture 'compiler')}catch{$code=$_.Exception.Message}
    Check ($code -eq 'DAILY_OWNER_TIMEOUT_UNKNOWN') 'actual Build compiler timeout is bounded'
    $writes=Join-Path $fixture 'compiler/codex_bridge/dist-writes.txt';$hash=(Get-FileHash $writes).Hash;Start-Sleep -Milliseconds 200
    Check ((Get-FileHash $writes).Hash -ceq $hash) 'timed out compiler stops writing dist'

    Put (Join-Path $fixture 'env.ps1') @'
@('CB_DAILY_PARENT_PID','CB_DAILY_PARENT_TICKS','CB_DAILY_LOCK_HANDLE')|ForEach-Object {[Environment]::GetEnvironmentVariable($_,'Process')}|ConvertTo-Json -Compress
'@
    $names=@('CB_DAILY_PARENT_PID','CB_DAILY_PARENT_TICKS','CB_DAILY_LOCK_HANDLE');$saved=@{}
    try {
        foreach($name in $names){$saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process');[Environment]::SetEnvironmentVariable($name,'fixture-lease','Process')}
        $si=Info (Join-Path $fixture 'env.ps1')
        $p=& $runtime {param($i) Start-CbChildProcess $i @{}} $si
        try {$capture=& $daily {param($p) Read-DailyOwnerOutput $p 10000} $p;Check ($capture.stdout -notmatch 'fixture-lease') 'long-lived factory clears all three delegation fields'}finally{$p.Dispose()}
        foreach($name in $names){Check ([Environment]::GetEnvironmentVariable($name,'Process') -eq 'fixture-lease') 'short owner parent environment restored'}
    } finally {foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$saved[$name],'Process')}}
    @{ok=$true;passed=$passed;live=$false}|ConvertTo-Json
} finally {
    if($scope){$scope.Dispose()}
    foreach($p in @($updater,$inert)+@($retained)){if($p){try{if(-not $p.HasExited){$p.Kill();[void]$p.WaitForExit(5000)}}finally{$p.Dispose()}}}
    $resolved=[IO.Path]::GetFullPath($fixture)
    if((Split-Path -Parent $resolved) -ine [IO.Path]::GetTempPath().TrimEnd('\') -or (Split-Path -Leaf $resolved) -cnotmatch '^cb-child-[0-9a-f]{32}$'){throw 'UNSAFE_FIXTURE_CLEANUP'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
