Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
# Shared mechanical primitives only. Each component owns its preparation,
# compatibility gates, lifecycle call, loaded identity and recovery policy.
function Assert-ComponentUpdatePath([string]$Path) {
    $cursor=[IO.Path]::GetFullPath($Path)
    while($cursor){
        if((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'UPDATE_REPARSE_REJECTED'}
        $cursor=Split-Path -Parent $cursor
    }
}
function Get-ComponentUpdateSourceDigest([string]$Root,[string[]]$Paths) {
    $Root=[IO.Path]::GetFullPath($Root).TrimEnd('\');Assert-ComponentUpdatePath $Root
    $rows=New-Object 'Collections.Generic.SortedDictionary[string,string]' ([StringComparer]::Ordinal)
    foreach($relative in $Paths){
        if($relative -cnotmatch '^[A-Za-z0-9_][A-Za-z0-9_./-]*$' -or $relative -match '(^|/)\.\.(/|$)|(^|/)(\.local|\.env[^/]*|Runtime|node_modules|\.venv|data|logs?|backups?|exports?)(/|$)'){throw 'UPDATE_SOURCE_PATH_REJECTED'}
        $path=Join-Path $Root $relative;Assert-ComponentUpdatePath $path
        if(-not(Test-Path -LiteralPath $path)){throw 'UPDATE_SOURCE_MISSING'}
        $pending=New-Object 'Collections.Generic.Stack[string]';$pending.Push($path)
        while($pending.Count){
            $item=Get-Item -LiteralPath $pending.Pop() -Force
            if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'UPDATE_REPARSE_REJECTED'}
            $name=$item.FullName.Substring($Root.Length+1).Replace('\','/')
            # Never read a secret/state file even when accidentally placed in code.
            if($name -match '(^|/)(__pycache__|\.pytest_cache)(/|$)' -or $name -match '\.pyc$'){continue}
            if($name -match '(^|/)(\.env[^/]*|\.local|\.git|\.secrets|node_modules|\.venv|logs?|backups?|exports?)(/|$)' -or $name -match '\.(dpapi|pem|key|pfx|p12|db|sqlite[0-9]*|log|pid)$'){throw 'UPDATE_PRIVATE_SOURCE_REJECTED'}
            if($item.PSIsContainer){foreach($child in Get-ChildItem -LiteralPath $item.FullName -Force){$pending.Push($child.FullName)}}
            else {
                if($rows.Count -ge 10000 -or $item.Length -gt 32000000){throw 'UPDATE_SOURCE_LIMIT'}
                $rows[$name]=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
    }
    $rows['@shared/component-update-common.ps1']=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $nodeOwner=Join-Path (Split-Path -Parent $PSCommandPath) 'node-source-update.ps1'
    if(Test-Path -LiteralPath $nodeOwner){$rows['@shared/node-source-update.ps1']=(Get-FileHash -LiteralPath $nodeOwner -Algorithm SHA256).Hash.ToLowerInvariant()}
    $native=Join-Path $PSScriptRoot '../../codex_bridge/scripts/DailyLifecycle.Native.cs'
    Assert-ComponentUpdatePath $native
    $rows['@shared/DailyLifecycle.Native.cs']=(Get-FileHash -LiteralPath $native -Algorithm SHA256).Hash.ToLowerInvariant()
    $text=(@(foreach($row in $rows.GetEnumerator()){$row.Key+':'+$row.Value}) -join "`n")
    $hash=[Security.Cryptography.SHA256]::Create()
    try{return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
}
function Read-ComponentUpdateJson([string]$Path) {
    Assert-ComponentUpdatePath $Path
    if((Get-Item -LiteralPath $Path).Length -gt 1048576){throw 'UPDATE_JSON_LIMIT'}
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}
function Write-ComponentUpdateJson([string]$Path,$Value) {
    Assert-ComponentUpdatePath $Path
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
    $tmp=$Path+'.pending-'+[guid]::NewGuid().ToString('N')
    $bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 12))
    $file=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
    # Immutable facts. Never replace a prior operation, candidate or failure.
    [IO.File]::Move($tmp,$Path)
}
function Invoke-ComponentUpdateProcess {
    param([string]$Executable,[string]$Arguments,[string]$WorkingDirectory,[int]$TimeoutMs=120000,[switch]$Json,[switch]$Lifecycle,
        [switch]$StructuredOutcome,[string]$ExpectedOperationId,[string]$ChildJournalRoot)
    if($StructuredOutcome -and (-not $Json -or -not $Lifecycle -or $ExpectedOperationId -cnotmatch '^[0-9a-f]{32}$')){throw 'UPDATE_RESULT_CONTRACT_REQUIRED'}
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$Executable;$info.Arguments=$Arguments;$info.WorkingDirectory=$WorkingDirectory
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $p=$null;$childEvidence=$null;$scopeStopped=$false
    try {
        if($Lifecycle){$p=New-Object Diagnostics.Process;$p.StartInfo=$info;if(-not $p.Start()){throw 'UPDATE_CHILD_START_FAILED'};$null=$p.Handle}
        else{
            # Reuse the daily updater's reviewed create-suspended / assign / resume
            # primitive. Finite build descendants cannot outlive this capture.
            if(-not('CbDailyChild' -as [type])){Add-Type -Path (Join-Path $PSScriptRoot '../../codex_bridge/scripts/DailyLifecycle.Native.cs')}
            if($ChildJournalRoot){
                Assert-ComponentUpdatePath $ChildJournalRoot
                $childId=[guid]::NewGuid().ToString('N');$childJobName='Local\McpComponentBuild.'+$childId
                $childEvidence=Join-Path $ChildJournalRoot $childId
                $beforeResume=[Action[Diagnostics.Process]]{
                    param($created)
                    Write-ComponentUpdateJson -Path ($childEvidence+'.start.json') -Value @{pid=$created.Id;startTicks=[string]$created.StartTime.ToUniversalTime().Ticks;executable=$created.Path;jobName=$childJobName;state='SUSPENDED_IN_RETAINED_SCOPE'}
                }
                $p=[CbDailyChild]::StartTracked($info,$childJobName,$beforeResume)
            }else{$p=[CbDailyChild]::Start($info)}
        }
        $watch=[Diagnostics.Stopwatch]::StartNew()
        $outBuffer=New-Object char[] 4096;$errBuffer=New-Object char[] 4096
        $outTask=$p.StandardOutput.ReadAsync($outBuffer,0,$outBuffer.Length);$errTask=$p.StandardError.ReadAsync($errBuffer,0,$errBuffer.Length)
        $stdout='';$stderr='';$outDone=$false;$errDone=$false
        while(-not($outDone -and $errDone -and $p.HasExited)){
            if($watch.ElapsedMilliseconds -ge $TimeoutMs){throw 'UPDATE_CHILD_TIMEOUT_CHECK_ORIGINAL_OPERATION'}
            if(-not $outDone -and $outTask.IsCompleted){
                $count=$outTask.GetAwaiter().GetResult()
                if($count -eq 0){$outDone=$true}else{$stdout+=(-join $outBuffer[0..($count-1)]);if($stdout.Length -gt 1048576){throw 'UPDATE_CHILD_OUTPUT_LIMIT'};$outTask=$p.StandardOutput.ReadAsync($outBuffer,0,$outBuffer.Length)}
            }
            if(-not $errDone -and $errTask.IsCompleted){
                $count=$errTask.GetAwaiter().GetResult()
                if($count -eq 0){$errDone=$true}else{$stderr+=(-join $errBuffer[0..($count-1)]);if($stderr.Length -gt 1048576){throw 'UPDATE_CHILD_OUTPUT_LIMIT'};$errTask=$p.StandardError.ReadAsync($errBuffer,0,$errBuffer.Length)}
            }
            Start-Sleep -Milliseconds 5
        }
        $result=$null
        if(-not $Lifecycle){
            $scopeStopped=$p.StopAndConfirm(5000)
            if(-not $scopeStopped){throw 'UPDATE_FINITE_CHILD_STOP_UNVERIFIED'}
            if($childEvidence){Write-ComponentUpdateJson -Path ($childEvidence+'.stopped.json') -Value @{scopeEmpty=$true;at=[DateTime]::UtcNow.ToString('o')}}
        }
        if($Json){try{$result=$stdout|ConvertFrom-Json}catch{}}
        if($StructuredOutcome -and $result){
            # Only the fixed component-owner adapter may use this contract. A
            # build's arbitrary JSON never becomes an accepted updater result.
            if($null -eq $result.PSObject.Properties['operationId'] -or $result.operationId -cne $ExpectedOperationId -or
                $null -eq $result.PSObject.Properties['phase'] -or $result.phase -cnotin @('ACCEPTED','REJECTED','RECOVERY_REQUIRED') -or
                $null -eq $result.PSObject.Properties['code'] -or [string]$result.code -cnotmatch '^[A-Z][A-Z0-9_]{0,95}$'){throw 'UPDATE_RESULT_CONTRACT_INVALID'}
            if($p.ExitCode -ne 0 -and $result.phase -eq 'ACCEPTED'){throw 'UPDATE_RESULT_EXIT_CONFLICT'}
            return $result
        }
        if($p.ExitCode -ne 0){
            $code='UPDATE_CHILD_FAILED'
            if($result -and $result.PSObject.Properties['code'] -and [string]$result.code -cmatch '^[A-Z][A-Z0-9_]{0,95}$'){$code=[string]$result.code}
            elseif($result -and $result.PSObject.Properties['errorCode'] -and [string]$result.errorCode -cmatch '^[A-Z][A-Z0-9_]{0,95}$'){$code=[string]$result.errorCode}
            $errorObject=New-Object InvalidOperationException($code);$errorObject.Data['exitCode']=$p.ExitCode;throw $errorObject
        }
        if($Json){if($null -eq $result){throw 'UPDATE_CHILD_INVALID_JSON'};return $result}
        return [pscustomobject]@{exitCode=$p.ExitCode}
    } catch {
        if($p){
            if($Lifecycle){
                # This helper may have created a legitimate long-lived runtime.
                # Leave its original owner in charge and keep uncertainty visible.
                if(-not $p.HasExited){throw 'UPDATE_LIFECYCLE_RESULT_UNCERTAIN'}
            }elseif(-not $scopeStopped){
                $scopeStopped=$p.StopAndConfirm(5000)
                if(-not $scopeStopped){throw 'UPDATE_FINITE_CHILD_STOP_UNVERIFIED'}
                if($childEvidence){Write-ComponentUpdateJson -Path ($childEvidence+'.stopped.json') -Value @{scopeEmpty=$true;at=[DateTime]::UtcNow.ToString('o')}}
            }
        }
        throw
    } finally {if($p){$p.Dispose()}}
}
function Assert-ComponentUpdateChildrenStopped([string]$Root) {
    Assert-ComponentUpdatePath $Root
    if(-not(Test-Path -LiteralPath $Root)){return}
    if(-not('CbDailyChild' -as [type])){Add-Type -Path (Join-Path $PSScriptRoot '../../codex_bridge/scripts/DailyLifecycle.Native.cs')}
    foreach($file in Get-ChildItem -LiteralPath $Root -Filter '*.start.json' -File){
        $start=Read-ComponentUpdateJson $file.FullName
        $endPath=$file.FullName.Replace('.start.json','.stopped.json')
        if(Test-Path -LiteralPath $endPath){$end=Read-ComponentUpdateJson $endPath;if($end.scopeEmpty -ne $true){throw 'UPDATE_FINITE_CHILD_STOP_UNVERIFIED'};continue}
        $state=[CbDailyChild]::QueryTrackedState([string]$start.jobName)
        if($state -notin @('ABSENT','EMPTY')){throw 'UPDATE_FINITE_CHILD_STOP_UNVERIFIED'}
        try{$child=[Diagnostics.Process]::GetProcessById([int]$start.pid)}catch [ArgumentException]{continue}
        try{if(-not $child.HasExited -and $child.StartTime.ToUniversalTime().Ticks -eq [long]$start.startTicks){throw 'UPDATE_FINITE_CHILD_STOP_UNVERIFIED'}}finally{$child.Dispose()}
    }
}
