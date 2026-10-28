# Real Windows file handles / identities and processes. All bytes are fixtures.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$module=Import-Module (Join-Path $repo 'codex_bridge/scripts/codex-bridge-runtime.psm1') -Force -PassThru
$daily=Import-Module (Join-Path $repo 'mcp_control_center/src/McpControlCenter.DailyCode.psm1') -Force -PassThru
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('cb-lock-'+[guid]::NewGuid().ToString('N'))
$op=Join-Path $fixture 'operations/11111111111111111111111111111111'
$data=Join-Path $fixture 'data';$path=Join-Path $data 'powershell-approval/approval.lock'
$node=(Get-Command node.exe).Source;$child=$null;$other=$null;$passed=0
function Check([bool]$v,[string]$name){if(-not $v){throw "FAILED: $name"};$script:passed++}
function Denied([scriptblock]$b,[string]$pattern){$message='';try {& $b|Out-Null}catch{$message=$_.Exception.Message};Check ($message -match $pattern) ($pattern+' actual='+$message)}
function Put([string]$p,[string]$text){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $p));[IO.File]::WriteAllText($p,$text)}
function Start-InertNode([string]$entry){
    Put $entry 'setTimeout(() => {}, 30000);'
    $si=New-Object Diagnostics.ProcessStartInfo;$si.FileName=$node;$si.Arguments='"'+$entry+'"';$si.UseShellExecute=$false;$si.CreateNoWindow=$true
    return [Diagnostics.Process]::Start($si)
}
try {
    [void][IO.Directory]::CreateDirectory($op);Put $path ''
    $context=[pscustomobject]@{projectRoot=(Join-Path $fixture 'codex_bridge');dataDir=$data;nodePath=$node}
    & $module {
        # Only listener/PID registry observations are synthetic. CIM and lock IO are real.
        function script:Resolve-CbRoleOwnership {param($Context,$Role,[switch]$ReadOnly) return @{state='Stopped';canMutate=$true;pid=$null}}
        Initialize-CbDailyNative
    }
    $now=[DateTime]::UtcNow.Ticks;$aligned=$now-($now%10)
    Check ([CbDailyLockFile]::SameProcessStart($aligned,$aligned+7)) 'native trailing 100 ns digits agree with CIM microseconds'
    Check (-not[CbDailyLockFile]::SameProcessStart($aligned,$aligned+10)) 'distinct microsecond creation time is different instance'
    $cim=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
    $ticks=$cim.CreationDate.ToUniversalTime().Ticks+7
    $record=@{contract='approval-lock-owner-v1';instance=[guid]::NewGuid().ToString();identity=@{pid=$PID;startedUtcTicks=[string]$ticks;image=(Get-Process -Id $PID).Path}}
    Put $path ($record|ConvertTo-Json -Depth 4)
    Denied {& $module {param($c,$o) Move-CbDailyApprovalLock $c $o} $context $op} 'DAILY_LOCK_OWNER_PRESENT'
    Check (Test-Path $path) 'live owner marker preserved despite sub-microsecond tail'
    $alive=& $daily {param($i) Test-DailyProcessAlive $i} @{pid=$PID;startedUtc=([DateTime]::new($ticks,[DateTimeKind]::Utc).ToString('o'))}
    Check $alive 'operation owner identity uses same precision'
    $record.identity.startedUtcTicks=[string]($ticks-10000000)
    Put $path ($record|ConvertTo-Json -Depth 4)
    $result=& $module {param($c,$o) Move-CbDailyApprovalLock $c $o} $context $op
    Check ($result.phase -eq 'RETIRED' -and -not(Test-Path $path)) 'PID reuse retires original marker without touching reused process'
    Check ($null -ne (Get-Process -Id $PID)) 'reused process remains alive'

    foreach($bytes in @([byte[]]@(),[Text.Encoding]::UTF8.GetBytes('legacy'),[Text.Encoding]::UTF8.GetBytes('{"identity":null}'),[byte[]]@(0xff,0xc3),[Text.Encoding]::UTF8.GetBytes('{"identity":'))){
        [IO.File]::WriteAllBytes($path,$bytes);$hash=(Get-FileHash $path).Hash
        $result=& $module {param($c,$o) Move-CbDailyApprovalLock $c $o} $context $op
        Check ($result.phase -eq 'RETIRED') 'empty legacy incomplete or invalid UTF8 lock recovers after core absence'
        Check ((Get-FileHash $result.backup).Hash -ceq $hash) 'retired bytes exactly preserved'
    }
    Put $path 'identical bytes'
    $snap=[CbDailyLockFile]::Open($path,$false);$id=$snap.Identity;$hash=$snap.Sha256;$snap.Dispose()
    [IO.File]::Move($path,($path+'.original'));Put $path 'identical bytes'
    $next=[CbDailyLockFile]::Open($path,$true)
    try {
        Denied {$next.Retire(($path+'.wrong'),$id,$hash)} 'DAILY_LOCK_CHANGED'
        Denied {[IO.File]::Delete($path)} 'process|access|used|being|使用|存取'
    }finally{$next.Dispose()}
    Check (Test-Path $path) 'same-content replacement retains new file identity'

    $other=Start-InertNode (Join-Path $fixture 'other/codex_bridge/dist/src/http-main.js')
    $result=& $module {param($c,$o) Move-CbDailyApprovalLock $c $o} $context $op
    Check ($result.phase -eq 'RETIRED' -and -not $other.HasExited) 'unrelated checkout does not block this data owner'
    $child=Start-InertNode (Join-Path $fixture 'codex_bridge/dist/src/http-main.js')
    Put $path ''
    Denied {& $module {param($c,$o) Move-CbDailyApprovalLock $c $o} $context $op} 'DAILY_CORE_STILL_PRESENT'
    Check (-not $child.HasExited -and (Test-Path $path)) 'non-listening component process protects empty marker'

    [pscustomobject]@{ok=$true;passed=$passed;realWindowsHandles=$true;realProcesses=$true;productionTouched=$false}|ConvertTo-Json
} finally {
    foreach($p in @($child,$other)){if($p){if(-not $p.HasExited){$p.Kill();[void]$p.WaitForExit(3000)};$p.Dispose()}}
    $resolved=[IO.Path]::GetFullPath($fixture)
    if((Split-Path -Parent $resolved) -ine [IO.Path]::GetTempPath().TrimEnd('\') -or (Split-Path -Leaf $resolved) -cnotmatch '^cb-lock-[0-9a-f]{32}$'){throw 'UNSAFE_FIXTURE_CLEANUP'}
    if(Test-Path $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
