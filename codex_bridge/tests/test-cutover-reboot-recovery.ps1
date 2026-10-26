# Real receipt/hash engine with synthetic OS boot/process evidence; no live action.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$module=Import-Module (Join-Path $repo 'mcp_control_center/src/McpControlCenter.DailyCode.psm1') -Force -PassThru
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('cutover-recovery-'+[guid]::NewGuid().ToString('N'))
$name='cutover-'+[guid]::NewGuid().ToString('N');$op=Join-Path $fixture ('operations/'+$name)
$passed=0
function Check([bool]$Value,[string]$Name){if(-not $Value){throw ('FAILED: '+$Name)};$script:passed++}
function Denied([scriptblock]$Body,[string]$Code){$msg='';try{& $Body|Out-Null}catch{$msg=$_.Exception.Message};Check ($msg -eq $Code) ($Code+' observed='+$msg)}
function Put([string]$Name,$Value){[IO.File]::WriteAllText((Join-Path $op $Name),($Value|ConvertTo-Json -Depth 6))}
try {
    [void][IO.Directory]::CreateDirectory($op)
    $now=[DateTime]::UtcNow
    Put 'intent.json' @{inspect=$false;utc=$now.AddMinutes(-10).ToString('o')}
    Put 'failure.json' @{phase='STOPPING_LEGACY';oldStopped=$false;selected=$false;startupChanged=$false;code='CUTOVER_CONTROLLER_FAILED'}
    Put 'terminal.json' @{phase='UNKNOWN';automaticRetry=$false;code='CUTOVER_CONTROLLER_FAILED'}
    Put 'stop-intent.json' @{phase='STOPPING_LEGACY';roles=@(@{role='server';pid=12345;startTimeUtc=$now.AddHours(-1).ToString('o')},@{role='tunnel';pid=23456;startTimeUtc=$now.AddHours(-1).ToString('o')})}
    Put 'observation.json' @{fixture=$true}
    [IO.File]::WriteAllText((Join-Path $op 'startup.before.lnk'),'fixture shortcut bytes')
    [IO.File]::SetCreationTimeUtc((Join-Path $op 'terminal.json'),$now.AddMinutes(-9))
    & $module {param($b,$start)
        $script:Boot=$b;$script:OriginalStart=$start;$script:ProcessMode='absent'
        function script:Get-DailyBootUtc {return $script:Boot}
        function script:Get-Process {param($Id,$ErrorAction)
            if($script:ProcessMode -eq 'denied'){throw 'FIXTURE_OS_DENIED'}
            if($script:ProcessMode -eq 'absent'){return $null}
            $p=[pscustomobject]@{StartTime=$(if($script:ProcessMode -eq 'original'){$script:OriginalStart}else{$script:Boot.AddSeconds(30)})}
            $p|Add-Member ScriptMethod Dispose {};return $p
        }
        function script:Get-CimInstance {param($ClassName,$Filter,$ErrorAction)
            if($script:ProcessMode -eq 'denied'){throw 'FIXTURE_OS_DENIED'}
            if($script:ProcessMode -eq 'absent'){return $null}
            return [pscustomobject]@{CreationDate=$(if($script:ProcessMode -eq 'original'){$script:OriginalStart}elseif($script:ProcessMode -eq 'unknown'){$null}else{$script:Boot.AddSeconds(30)})}
        }
    } $now.AddHours(-2) $now.AddHours(-1)
    Denied {& $module {param($r) Assert-DailyNoPending $r} $fixture} 'DAILY_INTERRUPTED_UNKNOWN_DO_NOT_RETRY'
    Denied {& $module {param($r,$n) Resolve-DailyCutoverAfterReboot $r $n} $fixture $name} 'DAILY_RECOVERY_REBOOT_REQUIRED'
    Check (-not(Test-Path -LiteralPath (Join-Path $op 'recovered-after-reboot.json'))) 'same-boot refusal writes no resolution'
    & $module {param($b) $script:Boot=$b;$script:ProcessMode='original'} $now.AddMinutes(-5)
    Denied {& $module {param($r,$n) Resolve-DailyCutoverAfterReboot $r $n} $fixture $name} 'DAILY_RECOVERY_ORIGINAL_PROCESS_PRESENT'
    & $module {$script:ProcessMode='denied'}
    Denied {& $module {param($r,$n) Resolve-DailyCutoverAfterReboot $r $n} $fixture $name} 'FIXTURE_OS_DENIED'
    & $module {$script:ProcessMode='reused'}
    $hashes=@{};foreach($file in Get-ChildItem -LiteralPath $op -File){$hashes[$file.Name]=(Get-FileHash -LiteralPath $file.FullName).Hash}
    & $module {param($r,$n) Resolve-DailyCutoverAfterReboot $r $n} $fixture $name
    Check (Test-Path -LiteralPath (Join-Path $op 'recovered-after-reboot.json')) 'post-boot resolution appended'
    foreach($file in $hashes.Keys){Check ((Get-FileHash -LiteralPath (Join-Path $op $file)).Hash -ceq $hashes[$file]) ('original bytes preserved '+$file)}
    Check ((Get-Content -LiteralPath (Join-Path $op 'terminal.json') -Raw|ConvertFrom-Json).phase -ceq 'UNKNOWN') 'original UNKNOWN never rewritten'
    & $module {param($r) Assert-DailyNoPending $r} $fixture
    Check $true 'validated retired process epoch permits a new operation'
    $resolutionHash=(Get-FileHash -LiteralPath (Join-Path $op 'recovered-after-reboot.json')).Hash
    & $module {param($r,$n) Resolve-DailyCutoverAfterReboot $r $n} $fixture $name
    Check ((Get-FileHash -LiteralPath (Join-Path $op 'recovered-after-reboot.json')).Hash -ceq $resolutionHash) 'resolution read is idempotent'
    Put 'observation.json' @{fixture='modified'}
    Denied {& $module {param($r) Assert-DailyNoPending $r} $fixture} 'DAILY_RECOVERY_ORIGINAL_CHANGED'
    Put 'observation.json' @{fixture=$true}
    Put 'failure.json' @{phase='ADOPTING';oldStopped=$true;selected=$true;startupChanged=$false;code='CUTOVER_CONTROLLER_FAILED'}
    Denied {& $module {param($r) Assert-DailyNoPending $r} $fixture} 'DAILY_RECOVERY_SCOPE_REJECTED'
    Denied {& $module {param($r) Resolve-DailyCutoverAfterReboot $r '../foreign'} $fixture} 'DAILY_RECOVERY_SCOPE_REJECTED'
    Put 'failure.json' @{phase='STOPPING_LEGACY';oldStopped=$false;selected=$false;startupChanged=$false;code='DAILY_STATE_LOCK_PRESENT'}
    Put 'terminal.json' @{phase='UNKNOWN';automaticRetry=$false;code='DAILY_STATE_LOCK_PRESENT'}
    [IO.File]::SetCreationTimeUtc((Join-Path $op 'terminal.json'),$now.AddMinutes(-9))
    Denied {& $module {param($p) Get-DailyCutoverRecoveryFacts $p} $op} 'DAILY_RECOVERY_STOP_EVIDENCE_REQUIRED'
    Put 'controller-stop.json' @{action='ShutdownRuntime';ok=$true;exitCode=0;stderrCharacters=0;code=$null}
    Put 'controller-stopped.json' @{action='Stopped';ok=$false;exitCode=1;stderrCharacters=0;code='DAILY_STATE_LOCK_PRESENT'}
    $facts=& $module {param($p) Get-DailyCutoverRecoveryFacts $p} $op
    Check ($facts.originalHashes.Count -eq 8) 'lock failure recovery pins both controller receipts'
    Put 'controller-stop.json' @{action='ShutdownRuntime';ok=$false;exitCode=1;stderrCharacters=0;code='FAILED'}
    Denied {& $module {param($p) Get-DailyCutoverRecoveryFacts $p} $op} 'DAILY_RECOVERY_STOP_EVIDENCE_REQUIRED'
    $lockFile=Join-Path $fixture 'approval.lock'
    $backup=$lockFile+'.retired-'+[guid]::NewGuid().ToString('N')
    $lockRecord=@{contract='approval-lock-owner-v1';identityStatus='OS_OBSERVED';identity=@{pid=12345;sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;image='C:\Program Files\McpCcReleases\normal-direct-bearer-20261023\dependencies\node\node.exe';startedUtcTicks=[string]$now.AddHours(-1).Ticks}}
    [IO.File]::WriteAllText($lockFile,($lockRecord|ConvertTo-Json -Depth 5))
    [IO.File]::SetCreationTimeUtc($lockFile,$now.AddMinutes(-10));[IO.File]::SetLastWriteTimeUtc($lockFile,$now.AddMinutes(-10))
    $lockHash=(Get-FileHash -LiteralPath $lockFile).Hash
    Denied {& $module {param($p,$b,$t) Move-DailyStaleApprovalLock $p $b $t} $lockFile $backup $now.AddHours(-2)} 'DAILY_LOCK_RECOVERY_REBOOT_REQUIRED'
    & $module {$script:ProcessMode='original'}
    Denied {& $module {param($p,$b,$t) Move-DailyStaleApprovalLock $p $b $t} $lockFile $backup $now.AddMinutes(-5)} 'DAILY_LOCK_RECOVERY_OWNER_PRESENT'
    & $module {$script:ProcessMode='denied'}
    Denied {& $module {param($p,$b,$t) Move-DailyStaleApprovalLock $p $b $t} $lockFile $backup $now.AddMinutes(-5)} 'FIXTURE_OS_DENIED'
    Check ((Get-FileHash -LiteralPath $lockFile).Hash -ceq $lockHash) 'refused recovery preserves lock bytes'
    & $module {$script:ProcessMode='unknown'}
    Denied {& $module {param($p,$b,$t) Move-DailyStaleApprovalLock $p $b $t} $lockFile $backup $now.AddMinutes(-5)} 'DAILY_LOCK_RECOVERY_OWNER_UNKNOWN'
    & $module {$script:ProcessMode='absent'}
    $busy=[IO.File]::Open($lockFile,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {
        $denied=$false;try{& $module {param($p,$b,$t) Move-DailyStaleApprovalLock $p $b $t} $lockFile $backup $now.AddMinutes(-5)|Out-Null}catch{$denied=$true}
        Check $denied 'active file handle blocks quarantine'
    } finally {$busy.Dispose()}
    & $module {$script:ProcessMode='reused'}
    $result=& $module {param($p,$b,$t) Move-DailyStaleApprovalLock $p $b $t} $lockFile $backup $now.AddMinutes(-5)
    Check (-not(Test-Path -LiteralPath $lockFile)) 'verified stale lock released'
    Check ((Get-FileHash -LiteralPath $backup).Hash -ceq $lockHash) 'quarantine preserves exact lock bytes'
    Check ($result.journalRead -eq $false -and $result.journalChanged -eq $false) 'journal remains untouched'
    [pscustomobject]@{ok=$true;passed=$passed;live=$false;originalUnknownPreserved=$true;rebootPerformed=$false}|ConvertTo-Json
} finally {
    if(Test-Path -LiteralPath $fixture){
        $resolved=(Resolve-Path -LiteralPath $fixture).Path
        if((Split-Path -Parent $resolved) -ine [IO.Path]::GetTempPath().TrimEnd('\') -or (Split-Path -Leaf $resolved) -cnotmatch '^cutover-recovery-[0-9a-f]{32}$'){throw 'FIXTURE_CLEANUP_REJECTED'}
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
