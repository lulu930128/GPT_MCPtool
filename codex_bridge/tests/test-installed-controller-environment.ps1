Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$ps='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$source=Join-Path $PSScriptRoot '..\scripts\installed-release-operator.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'OPERATOR_SYNTAX_INVALID'}
$function=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Invoke-Controller'},$true)
if($null -eq $function){throw 'CONTROLLER_FUNCTION_MISSING'}
# Exercise the actual operator child environment against a temporary controller.
# No live Status, network, Store, installation, Startup or ACL mutation.
$fixtureFunction=$function.Extent.Text.Replace("throw 'CONTROLLER_FAILED_DO_NOT_RETRY'",'throw ("ISOLATED_CONTROLLER_FAILURE exit="+$p.ExitCode+" stderr="+$err.Substring(0,[Math]::Min(2000,$err.Length)))')
. ([scriptblock]::Create($fixtureFunction))
$base=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.tmp'))
$fixture=Join-Path $base ('operator-env-'+[guid]::NewGuid().ToString('N'))
$oldLoader=[Environment]::GetEnvironmentVariable('NODE_OPTIONS','Process')
try {
    $null=New-Item -ItemType Directory -Path (Join-Path $fixture 'scripts') -Force
    $body=@'
param([string]$Action)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
if($Action -cne 'Status'){throw 'FIXED_ACTION_REQUIRED'}
# Windows PowerShell 5.1 appends .CPL during startup. Permit only that known
# normalization of the fixed launch value, never arbitrary inherited extensions.
if(@('.COM;.EXE;.BAT;.CMD','.COM;.EXE;.BAT;.CMD;.CPL') -cnotcontains $env:PATHEXT){throw 'FIXED_ENV_REQUIRED'}
if($env:NODE_OPTIONS){throw 'LOADER_ENV_LEAKED'}
& 'C:\Windows\System32\cmd.exe' /d /c exit 7
if($LASTEXITCODE -ne 7){throw 'NATIVE_INVOCATION_FAILED'}
[pscustomobject]@{ok=$true;action=$Action;nativeExit=$LASTEXITCODE;observedPathExt=$env:PATHEXT}|ConvertTo-Json -Compress
exit 0
'@
    [IO.File]::WriteAllText((Join-Path $fixture 'scripts\runtime-control.ps1'),$body,(New-Object Text.UTF8Encoding($false)))
    [Environment]::SetEnvironmentVariable('NODE_OPTIONS','fixture-must-not-reach-child','Process')
    $result=Invoke-Controller $fixture Status
    if($result.nativeExit -ne 7){throw 'NATIVE_EXIT_NOT_PRESERVED'}
    # Keep the Runner environment and canonical policy declaration in agreement.
    $policy=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\src\powershell-approval\host-admission.ts'))
    $kernel=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\..\mcp_control_center\src\NormalOperator.Execution.cs'))
    if($policy -notmatch 'PATHEXT: "\.COM;\.EXE;\.BAT;\.CMD"' -or
       $kernel -notmatch 'EnvironmentVariables\["PATHEXT"\]="\.COM;\.EXE;\.BAT;\.CMD"'){throw 'NORMAL_ENV_POLICY_MISMATCH'}
    [pscustomobject]@{ok=$true;nativeExit=7;observedPathExt=$result.observedPathExt;loaderInherited=$false;normalEnvironmentParity=$true;productionTouched=$false}|ConvertTo-Json
} finally {
    [Environment]::SetEnvironmentVariable('NODE_OPTIONS',$oldLoader,'Process')
    $resolved=[IO.Path]::GetFullPath($fixture)
    if((Split-Path -Parent $resolved) -ine $base -or (Split-Path -Leaf $resolved) -cnotmatch '^operator-env-[0-9a-f]{32}$'){throw 'UNSAFE_FIXTURE_CLEANUP'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
