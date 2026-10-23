Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$ps='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$parseTokens=$null;$parseErrors=$null
$source=Join-Path $PSScriptRoot '..\scripts\installed-release-operator.ps1'
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$parseTokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'OPERATOR_SYNTAX_INVALID'}
$entry=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Invoke-Controller'},$true)
if($null -eq $entry){throw 'CONTROLLER_FUNCTION_MISSING'}
. ([scriptblock]::Create($entry.Extent.Text))
$fixtureBridgeRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('..\.tmp\controller-output-'+[guid]::NewGuid().ToString('N'))))
$fixtureScripts=Join-Path $fixtureBridgeRoot 'scripts'
$null=New-Item -ItemType Directory -Path $fixtureScripts
$fixtureWorkingDirectory=Join-Path $fixtureScripts 'working directory'
$null=New-Item -ItemType Directory -Path $fixtureWorkingDirectory
$utf8=New-Object Text.UTF8Encoding($false)
$checks=0
function Check([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
function Select-FixtureMode([string]$Mode){[IO.File]::WriteAllText((Join-Path $fixtureScripts 'mode.txt'),$Mode,$utf8)}
function Denied([scriptblock]$Action,[string]$ExpectedError){
    $observedError=$null
    try{& $Action|Out-Null}catch{$observedError=$_.Exception.Message}
    Check ($observedError -ceq $ExpectedError) ('EXPECTED_'+$ExpectedError+'_GOT_'+$observedError)
}
$nativeFile=Join-Path $fixtureScripts 'OwnedProcess.Native.dll'
Add-Type -Path (Join-Path $PSScriptRoot '..\scripts\OwnedProcess.Native.cs') -OutputAssembly $nativeFile -ErrorAction Stop
$childBody=@'
$ErrorActionPreference='Stop'
$stage='observation'
try {
$principal=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
[pscustomobject]@{
    cwd=[Environment]::CurrentDirectory
    explicitValue=$env:CB_OUTPUT_EXPLICIT
    parentOnlyPresent=($null -ne $env:CB_OUTPUT_PARENT_ONLY)
    sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    admin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    stdinEof=([Console]::In.ReadToEnd().Length -eq 0)
}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $PSScriptRoot 'child-observation.json') -Encoding UTF8
$stage='stdout'
[Console]::Out.Write('UNEXPECTED_CHILD_STDOUT')
$stage='stderr'
[Console]::Error.Write('UNEXPECTED_CHILD_STDERR')
$stage='sleep'
Start-Sleep -Milliseconds 6000
[pscustomobject]@{ok=$true;stage='completed'}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $PSScriptRoot 'child-completion.json') -Encoding UTF8
exit 0
} catch {
    # Fixed fixture only: preserve the exact failing stage without using stderr,
    # which is intentionally NUL. Never substitute this for the OS exit code.
    [pscustomobject]@{ok=$false;stage=$stage;errorType=$_.Exception.GetType().FullName;
        errorId=$_.FullyQualifiedErrorId;hresult=$_.Exception.HResult}|
        ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $PSScriptRoot 'child-completion.json') -Encoding UTF8
    exit 1
}
'@
[IO.File]::WriteAllText((Join-Path $fixtureScripts 'detached-child.ps1'),$childBody,$utf8)
$body=@'
param([string]$Action)
$ErrorActionPreference='Stop'
$mode=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'mode.txt'))
if($mode -ceq 'stderr'){[Console]::Error.Write('fixture');exit 0}
if($mode -ceq 'overflow'){[Console]::Out.Write(('x'*70000));exit 0}
if($mode -in @('inherited','detached')){
    # An inert grandchild retains the parent's output handles but self-exits.
    # No network, production state, ACL or lifecycle operation is involved.
    $childInfo=New-Object Diagnostics.ProcessStartInfo
    $childInfo.FileName='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    $childInfo.Arguments='-NoProfile -NonInteractive -Command "Start-Sleep -Milliseconds 6000"'
    $childInfo.WorkingDirectory=Join-Path $PSScriptRoot 'working directory'
    $childInfo.UseShellExecute=$false;$childInfo.CreateNoWindow=$true
    $childInfo.EnvironmentVariables.Clear()
    $childInfo.EnvironmentVariables['SystemRoot']='C:\Windows'
    $childInfo.EnvironmentVariables['WINDIR']='C:\Windows'
    $childInfo.EnvironmentVariables['PSModulePath']='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
    if($mode -ceq 'detached'){
        $childInfo.Arguments='-NoProfile -NonInteractive -File "'+(Join-Path $PSScriptRoot 'detached-child.ps1')+'"'
        $childInfo.EnvironmentVariables['CB_OUTPUT_EXPLICIT']='value '+[char]0x6e2c+[char]0x8a66
        [Environment]::SetEnvironmentVariable('CB_OUTPUT_PARENT_ONLY','fixture','Process')
        Add-Type -Path (Join-Path $PSScriptRoot 'OwnedProcess.Native.dll') -ErrorAction Stop
        $child=[CbDetachedProcess]::Start($childInfo)
    }else{$child=[Diagnostics.Process]::Start($childInfo)}
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'child.pid'),[string]$child.Id)
    $child.Dispose()
}
if($mode -ceq 'wrong-action'){$Action='Unexpected'}
[pscustomobject]@{ok=$true;action=$Action}|ConvertTo-Json -Compress
if($mode -ceq 'exit-code'){exit 7}
exit 0
'@
[IO.File]::WriteAllText((Join-Path $fixtureScripts 'runtime-control.ps1'),$body,$utf8)
$retainedChild=$null
try {
    Select-FixtureMode 'normal'
    $result=Invoke-Controller $fixtureBridgeRoot Status
    Check ($result.ok -eq $true -and $result.action -ceq 'Status') 'NORMAL_RESULT_REQUIRED'
    foreach($mode in @('stderr','overflow','exit-code')){
        Select-FixtureMode $mode
        Denied {Invoke-Controller $fixtureBridgeRoot Status} 'CONTROLLER_FAILED_DO_NOT_RETRY'
    }
    Select-FixtureMode 'wrong-action'
    Denied {Invoke-Controller $fixtureBridgeRoot Status} 'CONTROLLER_UNVERIFIED'
    Select-FixtureMode 'inherited'
    Denied {Invoke-Controller $fixtureBridgeRoot Status} 'CONTROLLER_OUTPUT_NOT_CLOSED_DO_NOT_RETRY'
    $childPid=[int][IO.File]::ReadAllText((Join-Path $fixtureScripts 'child.pid'))
    $retainedChild=Get-Process -Id $childPid -ErrorAction Stop
    $null=$retainedChild.get_Handle()
    Check (-not $retainedChild.HasExited -and $retainedChild.Path -ieq $ps) 'RETURN_MUST_NOT_WAIT_FOR_OR_KILL_GRANDCHILD'
    Check ($retainedChild.WaitForExit(15000)) 'INERT_GRANDCHILD_MUST_EXIT_NATURALLY'
    $retainedChild.Dispose();$retainedChild=$null
    Select-FixtureMode 'detached'
    $result=Invoke-Controller $fixtureBridgeRoot Status
    Check ($result.ok -eq $true -and $result.action -ceq 'Status') 'DETACHED_RESULT_MUST_CLOSE_OUTPUT'
    $childPid=[int][IO.File]::ReadAllText((Join-Path $fixtureScripts 'child.pid'))
    $retainedChild=Get-Process -Id $childPid -ErrorAction Stop
    # Get-Process provides a PID-based Process object. Retain its native handle
    # before waiting; .NET Framework ExitCode requires haveProcessHandle=true.
    # WaitForExit by itself opens/releases only a temporary handle.
    $null=$retainedChild.get_Handle()
    Check (-not $retainedChild.HasExited -and $retainedChild.Path -ieq $ps) 'DETACHED_CHILD_MUST_OUTLIVE_CONTROLLER_RETURN'
    $childExited=$retainedChild.WaitForExit(20000)
    $childExitCode=$null
    # Invoke the getter explicitly so a property access failure cannot become $null.
    if($childExited){$childExitCode=$retainedChild.get_ExitCode()}
    $completionPath=Join-Path $fixtureScripts 'child-completion.json'
    $completion=if(Test-Path -LiteralPath $completionPath){Get-Content -LiteralPath $completionPath -Raw -Encoding UTF8|ConvertFrom-Json}else{$null}
    [pscustomobject]@{phase='DETACHED_CHILD_EXIT';exited=$childExited;exitCode=$childExitCode;completion=$completion}|
        ConvertTo-Json -Depth 4 -Compress|Write-Host
    Check ($childExited -and $null -ne $childExitCode -and $childExitCode -eq 0 -and
        $null -ne $completion -and $completion.ok -eq $true -and $completion.stage -ceq 'completed') 'DETACHED_CHILD_MUST_EXIT_NATURALLY_WITHOUT_BROKEN_PIPE'
    $observed=Get-Content -LiteralPath (Join-Path $fixtureScripts 'child-observation.json') -Raw -Encoding UTF8|ConvertFrom-Json
    Check ($observed.cwd -ieq $fixtureWorkingDirectory) 'EXACT_WORKING_DIRECTORY_REQUIRED'
    Check ($observed.explicitValue -ceq ('value '+[char]0x6e2c+[char]0x8a66) -and -not $observed.parentOnlyPresent) 'EXPLICIT_UNICODE_ENVIRONMENT_ONLY'
    $principal=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    Check ($observed.sid -ceq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -and
        $observed.admin -eq $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'CALLER_TOKEN_MUST_BE_PRESERVED'
    Check ($observed.stdinEof -eq $true) 'DETACHED_STDIN_MUST_BE_NUL'
    [pscustomobject]@{ok=$true;checks=$checks;output='ACTUAL_OPERATOR_FUNCTION';inheritedPipe='BOUNDED_REFUSAL';
        detachedPipe='ACTUAL_NATIVE_CHILD_NO_PIPE_INHERITANCE';childTerminated=$false;
        productionTouched=$false;runtimeStarted=$false;fixtureRetained=$true}|ConvertTo-Json
} finally {
    if($retainedChild){$retainedChild.Dispose()}
    Write-Verbose ('ISOLATED_FIXTURE_RETAINED: '+$fixtureBridgeRoot)
}
