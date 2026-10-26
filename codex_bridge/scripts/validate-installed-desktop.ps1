# Offline desktop handoff only. Never invoke an Installed Operator entrypoint.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'

function Assert-DesktopValidationContext {
    $ps=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or
        (Get-Process -Id $PID).Path -ine $ps){throw 'WINDOWS_POWERSHELL_51_REQUIRED'}
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal=[Security.Principal.WindowsPrincipal]::new($identity)
        if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'NON_ADMIN_OPERATOR_REQUIRED'}
    } finally {$identity.Dispose()}
    # Explorer ancestry and OutsideAllJobs remain owned by the ORIGINAL
    # Assert-IndependentOperator called inside NativeOperator, without overrides.
}

function Assert-DesktopFixturePath([string]$Path) {
    $cursor=[IO.Path]::GetFullPath($Path)
    while($cursor){
        $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'FIXTURE_REPARSE_REJECTED'}
        $cursor=Split-Path -Parent $cursor
    }
}

function Get-DesktopFixtureVerdict($Result,[int]$ExitCode) {
    if($null -eq $Result){return 'NATIVE_RESULT_INVALID'}
    $fields=@($Result.PSObject.Properties.Name)
    if($fields -contains 'ok' -and $Result.ok -is [bool] -and -not $Result.ok -and
        $fields -contains 'error' -and $Result.error -is [string] -and $Result.error -cmatch '^[A-Z][A-Z0-9_]{0,95}$'){
        return $Result.error
    }
    foreach($name in @('ok','outsideJobs','independentOperatorVerified','productionTouched')){
        if($fields -notcontains $name -or $Result.$name -isnot [bool]){return 'NATIVE_RESULT_INVALID'}
    }
    if($ExitCode -ne 0){return 'NATIVE_FIXTURE_EXIT_FAILED'}
    if(-not $Result.ok -or -not $Result.outsideJobs -or -not $Result.independentOperatorVerified -or
        $Result.productionTouched -or $fields -notcontains 'scope' -or $Result.scope -cne 'NativeOperator'){
        return 'NATIVE_OPERATOR_NOT_VERIFIED'
    }
    return 'PASS'
}

function Invoke-DesktopNativeFixture([string]$FixtureScript,[string]$FixtureRoot) {
    $ps=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $ps -NoProfile -NonInteractive -File $FixtureScript -Mode NativeOperator -FixtureRoot $FixtureRoot | Out-Host
    return $LASTEXITCODE
}

function Invoke-InstalledDesktopValidation([string]$FixtureScript) {
    $fixture=$null
    try {
        Assert-DesktopValidationContext
        Assert-DesktopFixturePath $FixtureScript
        $temp=[IO.Path]::GetTempPath().TrimEnd('\')
        Assert-DesktopFixturePath $temp
        $fixture=Join-Path $temp ('installed-handoff-native-'+[guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $fixture -ErrorAction Stop | Out-Null
        $marker=[IO.File]::Open((Join-Path $fixture 'fixture-only'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $marker.Dispose()
        $exitCode=Invoke-DesktopNativeFixture $FixtureScript $fixture
        $resultPath=Join-Path $fixture 'native-result.json'
        if(-not(Test-Path -LiteralPath $resultPath -PathType Leaf)){throw 'NATIVE_RESULT_MISSING'}
        Assert-DesktopFixturePath $resultPath
        if((Get-Item -LiteralPath $resultPath).Length -gt 16384){throw 'NATIVE_RESULT_TOO_LARGE'}
        try {$result=[IO.File]::ReadAllText($resultPath,[Text.Encoding]::UTF8)|ConvertFrom-Json}
        catch {throw 'NATIVE_RESULT_INVALID'}
        $code=Get-DesktopFixtureVerdict $result $exitCode
        return [pscustomobject]@{status=$(if($code -ceq 'PASS'){'PASS'}else{'FAIL'});code=$code;
            fixtureRoot=$fixture;nativeResult=$resultPath;installedAclAcceptance='NOT_TESTED'}
    } catch {
        $code=$_.Exception.Message
        if($code -cnotmatch '^[A-Z][A-Z0-9_]{0,95}$'){$code='DESKTOP_VALIDATION_FAILED'}
        return [pscustomobject]@{status='FAIL';code=$code;fixtureRoot=$fixture;installedAclAcceptance='NOT_TESTED'}
    }
}

$result=Invoke-InstalledDesktopValidation (Join-Path $PSScriptRoot '..\tests\test-installed-auto-resume.ps1')
$result|ConvertTo-Json
if($result.status -cne 'PASS'){exit 1}
exit 0
