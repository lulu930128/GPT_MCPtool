Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'scripts/component-update-common.ps1')
$temp=Join-Path ([IO.Path]::GetTempPath()) ('component-capture-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temp)
$ps=Join-Path $PSHOME 'powershell.exe';$checks=0
function Check($v,$name){if(-not $v){throw ('FAILED: '+$name)};$script:checks++}
function Put($name,$text){$path=Join-Path $temp $name;[IO.File]::WriteAllText($path,$text);return $path}
$child=Put 'writer.ps1' '[IO.File]::WriteAllText((Join-Path $PSScriptRoot "writer.pid"),[string]$PID);while($true){[IO.File]::AppendAllText((Join-Path $PSScriptRoot "writes.txt"),"x");Start-Sleep -Milliseconds 20}'
$parent=Put 'parent.ps1' '$s=New-Object Diagnostics.ProcessStartInfo;$s.FileName=Join-Path $PSHOME "powershell.exe";$s.Arguments="-NoProfile -File `""+(Join-Path $PSScriptRoot "writer.ps1")+"`"";$s.UseShellExecute=$false;$s.CreateNoWindow=$true;$p=[Diagnostics.Process]::Start($s);while($true){Start-Sleep -Milliseconds 50}'
$code='';$clock=[Diagnostics.Stopwatch]::StartNew()
try{Invoke-ComponentUpdateProcess -Executable $ps -Arguments ('-NoProfile -File "'+$parent+'"') -WorkingDirectory $temp -TimeoutMs 2000 -ChildJournalRoot (Join-Path $temp 'children')|Out-Null}catch{$code=$_.Exception.Message}
Check ($code -eq 'UPDATE_CHILD_TIMEOUT_CHECK_ORIGINAL_OPERATION') 'timeout preserves original classification with proven stop'
Check ($clock.ElapsedMilliseconds -lt 9000) 'deadline plus exact-scope cleanup bounded'
Check (Test-Path (Join-Path $temp 'writer.pid')) 'grandchild really ran'
Assert-ComponentUpdateChildrenStopped (Join-Path $temp 'children');$checks++
$hash=(Get-FileHash (Join-Path $temp 'writes.txt')).Hash;Start-Sleep -Milliseconds 200
Check ((Get-FileHash (Join-Path $temp 'writes.txt')).Hash -ceq $hash) 'finite grandchild cannot continue writing'
$noisy=Put 'noisy.ps1' 'while($true){[Console]::Out.Write(("x"*8192))}'
$code='';$clock.Restart()
try{Invoke-ComponentUpdateProcess -Executable $ps -Arguments ('-NoProfile -File "'+$noisy+'"') -WorkingDirectory $temp -TimeoutMs 10000 -ChildJournalRoot (Join-Path $temp 'noisy')|Out-Null}catch{$code=$_.Exception.Message}
Check ($code -eq 'UPDATE_CHILD_OUTPUT_LIMIT') 'large output rejected while child still producing'
Check ($clock.ElapsedMilliseconds -lt 9000) 'output cap fires before overall deadline'
Assert-ComponentUpdateChildrenStopped (Join-Path $temp 'noisy');$checks++
$op='123456781234123412341234567890ab'
foreach($reason in @('DEPENDENCY_PREPARATION_REQUIRED','UPDATE_INPUT_INVALID','UPDATE_PRIOR_OPERATION_RECOVERY_REQUIRED')){
    $entry=Put ($reason+'.ps1') ('Write-Output ''{"phase":"REJECTED","code":"'+$reason+'","operationId":"'+$op+'","blockedByOperationId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'';exit 1')
    $r=Invoke-ComponentUpdateProcess -Executable $ps -Arguments ('-NoProfile -File "'+$entry+'"') -WorkingDirectory $temp -Json -Lifecycle -StructuredOutcome -ExpectedOperationId $op
    Check ($r.phase -eq 'REJECTED' -and $r.code -eq $reason -and $r.blockedByOperationId -eq ('a'*32)) 'known owner rejection survives nonzero exit, before journal and blocker'
}
$entry=Put 'non-json.ps1' '[Console]::Error.WriteLine("fixture-original-error");exit 7'
$code='';try{Invoke-ComponentUpdateProcess -Executable $ps -Arguments ('-NoProfile -File "'+$entry+'"') -WorkingDirectory $temp -Json -Lifecycle -StructuredOutcome -ExpectedOperationId $op|Out-Null}catch{$code=$_.Exception.Message}
Check ($code -eq 'UPDATE_CHILD_FAILED') 'nonJSON exit not obscured by parse error'
$entry=Put 'false-accept.ps1' ('Write-Output ''{"phase":"ACCEPTED","code":"UPDATE_ACCEPTED","operationId":"'+$op+'"}'';exit 1')
$code='';try{Invoke-ComponentUpdateProcess -Executable $ps -Arguments ('-NoProfile -File "'+$entry+'"') -WorkingDirectory $temp -Json -Lifecycle -StructuredOutcome -ExpectedOperationId $op|Out-Null}catch{$code=$_.Exception.Message}
Check ($code -eq 'UPDATE_RESULT_EXIT_CONFLICT') 'nonzero exit can never attest success'
[pscustomobject]@{ok=$true;checks=$checks;evidence='ISOLATED_FINITE_CHILD_AND_COMPONENT_RESULT';fixture=$temp}|ConvertTo-Json -Compress
