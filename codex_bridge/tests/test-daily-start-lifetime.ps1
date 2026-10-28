# Actual daily layout, lease, Start clause and bounded capture. Service is inert.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$daily=Import-Module (Join-Path $repo 'mcp_control_center/src/McpControlCenter.DailyCode.psm1') -Force -PassThru
$root=Join-Path ([IO.Path]::GetTempPath()) ('cb-start-'+[guid]::NewGuid().ToString('N'))
$release=Join-Path $root 'codex_bridge/Runtime/versions/v/codex_bridge'
$passed=0;$parent=$null;$owner=$null;$service=$null;$file=$null
function Put($p,$v){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $p));[IO.File]::WriteAllText($p,$v)}
function Check([bool]$v,[string]$n){if(-not $v){throw "FAILED: $n"};$script:passed++}
function Wait-File($path){$w=[Diagnostics.Stopwatch]::StartNew();while(-not(Test-Path $path)){if($w.ElapsedMilliseconds -gt 15000){throw "FIXTURE_NOT_READY: $path"};Start-Sleep -Milliseconds 20}}
function Retain($path){Wait-File $path;$i=Get-Content $path -Raw|ConvertFrom-Json;$p=[Diagnostics.Process]::GetProcessById($i.pid);$null=$p.Handle;Check ($p.StartTime.ToUniversalTime().Ticks -eq [long]$i.ticks) 'exact fixture identity';return $p}
function Info($path,$argsText){$i=New-Object Diagnostics.ProcessStartInfo;$i.FileName=Join-Path $PSHOME 'powershell.exe';$i.Arguments='-NoProfile -NonInteractive -File "'+$path+'" '+$argsText;$i.UseShellExecute=$false;$i.CreateNoWindow=$true;$i.RedirectStandardOutput=$true;$i.RedirectStandardError=$true;return $i}
try {
    Put (Join-Path (Split-Path -Parent $release) 'daily-mode.json') '{"contract":"mcpcc-daily-user-v1","trayOwner":"independent-cc"}'
    [void][IO.Directory]::CreateDirectory($release)
    Put (Join-Path $root 'service.ps1') @'
param([string]$Result)
@{pid=$PID;ticks=[string](Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks;delegation=@($env:CB_DAILY_PARENT_PID,$env:CB_DAILY_PARENT_TICKS,$env:CB_DAILY_LOCK_HANDLE)}|ConvertTo-Json -Compress|Set-Content -LiteralPath $Result
Start-Sleep -Seconds 90
'@
    # Only the real lifecycle's external service launch is replaced by an inert
    # command. The source Start clause clears env before even an old factory.
    $ownerText=@'
param([string]$Root,[switch]$Hang)
$ErrorActionPreference='Stop'
$module=Import-Module '__RUNTIME__' -Force -PassThru
$context=@{projectRoot=(Join-Path $Root 'codex_bridge/Runtime/versions/v/codex_bridge')}
$lease=& $module {param($c) Open-CbDailyMutation $c} $context
try {
    @{pid=$PID;ticks=[string](Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks}|ConvertTo-Json -Compress|Set-Content (Join-Path $Root 'owner.json')
    function Invoke-CodexBridgeLifecycleAction {param($Context,$Action)
        $i=New-Object Diagnostics.ProcessStartInfo;$i.FileName=Join-Path $PSHOME 'powershell.exe'
        $i.Arguments='-NoProfile -File "'+(Join-Path $Root 'service.ps1')+'" -Result "'+(Join-Path $Root 'service.json')+'"'
        $i.UseShellExecute=$true;$i.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
        # Deliberately an old factory: no explicit delegation cleanup here.
        $p=[Diagnostics.Process]::Start($i);$p.Dispose()
    }
    $t=$null;$e=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile('__OWNER__',[ref]$t,[ref]$e)
    $switch=$ast.Find({param($n) $n -is [Management.Automation.Language.SwitchStatementAst]},$true)
    $text=@($switch.Clauses|Where-Object {$_.Item1.Value -ceq 'Start'})[0].Item2.Extent.Text
    & ([scriptblock]::Create($text.Substring(1,$text.Length-2)))
    if($Hang){Start-Sleep -Seconds 90}
    '{"ok":true}'
} finally {$lease.Dispose()}
'@
    $ownerText=$ownerText.Replace('__RUNTIME__',(Join-Path $repo 'codex_bridge/scripts/codex-bridge-runtime.psm1')).Replace('__OWNER__',(Join-Path $repo 'codex_bridge/scripts/daily-code-owner.ps1'))
    Put (Join-Path $root 'daily-code-owner.ps1') $ownerText
    $lockPath=Join-Path $root 'codex_bridge/Runtime/update.lock'
    $file=[IO.File]::Open($lockPath,'OpenOrCreate','ReadWrite','None')
    $si=Info (Join-Path $root 'daily-code-owner.ps1') ('-Root "'+$root+'"')
    $si.EnvironmentVariables['CB_DAILY_PARENT_PID']=[string]$PID
    $si.EnvironmentVariables['CB_DAILY_PARENT_TICKS']=[string](Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks
    $si.EnvironmentVariables['CB_DAILY_LOCK_HANDLE']=[string]$file.SafeFileHandle.DangerousGetHandle().ToInt64()
    $owner=[Diagnostics.Process]::Start($si);$null=$owner.Handle
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $output=& $daily {param($p) Read-DailyOwnerOutput $p 15000} $owner
    Check ($owner.ExitCode -eq 0 -and ($output.stdout|ConvertFrom-Json).ok) 'actual Start clause returns success with no job'
    $service=Retain (Join-Path $root 'service.json')
    Check ($clock.ElapsedMilliseconds -lt 15000 -and -not $service.HasExited) 'stdout reaches EOF while launched service remains alive'
    $identity=Get-Content (Join-Path $root 'service.json') -Raw|ConvertFrom-Json
    Check (@($identity.delegation|Where-Object {$_}).Count -eq 0) 'old long-lived factory cannot leak Start delegation'
    $file.Dispose();$file=$null;$probe=[IO.File]::Open($lockPath,'Open','ReadWrite','None');$probe.Dispose()
    $service.Kill();[void]$service.WaitForExit(5000);$service.Dispose();$service=$null;$owner.Dispose();$owner=$null
    [IO.File]::Delete((Join-Path $root 'service.json'));[IO.File]::Delete((Join-Path $root 'owner.json'))
    $parentText=@'
$ErrorActionPreference='Stop'
$file=[IO.File]::Open((Join-Path $PSScriptRoot 'codex_bridge/Runtime/update.lock'),'Open','ReadWrite','None')
$si=New-Object Diagnostics.ProcessStartInfo;$si.FileName=Join-Path $PSHOME 'powershell.exe'
$si.Arguments='-NoProfile -File "'+(Join-Path $PSScriptRoot 'daily-code-owner.ps1')+'" -Root "'+$PSScriptRoot+'" -Hang'
$si.UseShellExecute=$false;$si.CreateNoWindow=$true;$si.RedirectStandardOutput=$true;$si.RedirectStandardError=$true
$si.EnvironmentVariables['CB_DAILY_PARENT_PID']=[string]$PID
$si.EnvironmentVariables['CB_DAILY_PARENT_TICKS']=[string](Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks
$si.EnvironmentVariables['CB_DAILY_LOCK_HANDLE']=[string]$file.SafeFileHandle.DangerousGetHandle().ToInt64()
$owner=[Diagnostics.Process]::Start($si)
Start-Sleep -Seconds 90
'@
    Put (Join-Path $root 'updater.ps1') $parentText
    $parent=[Diagnostics.Process]::Start((Info (Join-Path $root 'updater.ps1') ''));$null=$parent.Handle
    $owner=Retain (Join-Path $root 'owner.json');$service=Retain (Join-Path $root 'service.json')
    $parent.Kill();[void]$parent.WaitForExit(5000)
    Check ($owner.WaitForExit(5000) -and $owner.ExitCode -eq 78) 'Start lease watchdog exits after exact updater parent death without a job'
    Check (-not $service.HasExited) 'service started by interrupted Start remains for same-operation observation'
    $probe=[IO.File]::Open($lockPath,'Open','ReadWrite','None');$probe.Dispose()
    Check $true 'watchdog releases duplicated lock so same-boot retry can enter'
    @{ok=$true;passed=$passed;live=$false}|ConvertTo-Json
} finally {
    if($file){$file.Dispose()}
    foreach($p in @($owner,$parent,$service)){if($p){if(-not $p.HasExited){$p.Kill();[void]$p.WaitForExit(5000)};$p.Dispose()}}
    $resolved=[IO.Path]::GetFullPath($root)
    if((Split-Path -Parent $resolved) -ine [IO.Path]::GetTempPath().TrimEnd('\') -or (Split-Path -Leaf $resolved) -cnotmatch '^cb-start-[0-9a-f]{32}$'){throw 'UNSAFE_FIXTURE_CLEANUP'}
    if(Test-Path $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
