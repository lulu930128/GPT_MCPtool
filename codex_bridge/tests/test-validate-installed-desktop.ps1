# Only AST-extracted launcher functions and disposable files. No NativeOperator,
# Installed Operator, Job breakaway, production process, or private-state access.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$checks=0
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message};$script:checks++}
$path=Join-Path $PSScriptRoot '..\scripts\validate-installed-desktop.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
Check ($errors.Count -eq 0) 'Launcher parses in Windows PowerShell 5.1'
$functions=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true))
$module=New-Module -ScriptBlock ([scriptblock]::Create(($functions.Extent.Text -join "`n")))
$native=$functions|Where-Object Name -CEQ 'Invoke-DesktopNativeFixture'
Check ($native.Extent.Text.Contains('-Mode NativeOperator -FixtureRoot $FixtureRoot')) 'Only the unchanged NativeOperator fixture is invoked'
Check ($native.Extent.Text.Contains('-NoProfile -NonInteractive -File $FixtureScript')) 'Fixed Windows PowerShell file invocation'
Check ($ast.Extent.Text -notmatch 'Start-Process|ScheduledTask|schtasks|Invoke-Expression|Set-Acl|Stop-Process|installed-release-operator\.ps1') 'No lifecycle or alternate launcher'
$context=$functions|Where-Object Name -CEQ 'Assert-DesktopValidationContext'
Check ($context.Extent.Text.Contains('NON_ADMIN_OPERATOR_REQUIRED') -and $context.Extent.Text.Contains('WINDOWS_POWERSHELL_51_REQUIRED')) 'Desktop context cannot silently accept Admin or another shell'
$good='{"ok":true,"outsideJobs":true,"independentOperatorVerified":true,"productionTouched":false,"scope":"NativeOperator"}'
Check ((& $module {param($r) Get-DesktopFixtureVerdict ($r|ConvertFrom-Json) 0} $good) -ceq 'PASS') 'Exact native evidence accepted'
foreach($field in @('ok','outsideJobs','independentOperatorVerified','productionTouched')){
    foreach($value in @('opposite','string','missing')){
        $r=$good|ConvertFrom-Json
        switch($value){
            opposite {$r.$field=-not $r.$field}
            string {$r.$field=[string]$r.$field}
            missing {$r.PSObject.Properties.Remove($field)}
        }
        Check ((& $module {param($r) Get-DesktopFixtureVerdict $r 0} $r) -cne 'PASS') ('Refuse '+$field+' '+$value)
    }
}
foreach($r in @($null,@(),[pscustomobject]@{},($good.Replace('NativeOperator','NativeEvent')|ConvertFrom-Json))){
    Check ((& $module {param($r) Get-DesktopFixtureVerdict $r 0} $r) -cne 'PASS') 'Missing/malformed/event-only evidence refused'
}
Check ((& $module {param($r) Get-DesktopFixtureVerdict ($r|ConvertFrom-Json) 1} $good) -ceq 'NATIVE_FIXTURE_EXIT_FAILED') 'Nonzero child exit cannot PASS'
Check ((& $module {Get-DesktopFixtureVerdict ([pscustomobject]@{ok=$false;error='INDEPENDENT_OPERATOR_REQUIRED';productionTouched=$false}) 1}) -ceq 'INDEPENDENT_OPERATOR_REQUIRED') 'Original independence refusal preserved'

# Execute the actual orchestration with ONLY the context/process boundary stubbed.
# The native fixture file is never executed by this test.
& $module {
    $script:calls=0;$script:mode='pass';$script:roots=[Collections.Generic.List[string]]::new()
    function script:Assert-DesktopValidationContext {if($script:mode -eq 'context'){throw 'NON_ADMIN_OPERATOR_REQUIRED'}}
    function script:Invoke-DesktopNativeFixture([string]$FixtureScript,[string]$FixtureRoot){
        $script:calls++;$script:roots.Add($FixtureRoot)
        if(-not(Test-Path -LiteralPath (Join-Path $FixtureRoot 'fixture-only'))){throw 'MARKER_MISSING'}
        if((Split-Path -Parent $FixtureRoot) -ine [IO.Path]::GetTempPath().TrimEnd('\') -or
            (Split-Path -Leaf $FixtureRoot) -cnotmatch '^installed-handoff-native-[0-9a-f]{32}$'){throw 'ROOT_INVALID'}
        $json='{"ok":true,"outsideJobs":true,"independentOperatorVerified":true,"productionTouched":false,"scope":"NativeOperator"}'
        switch($script:mode){
            missing {return 1}
            malformed {$json='{'}
            oversized {$json='x'*16385}
            refused {$json='{"ok":false,"error":"INDEPENDENT_OPERATOR_REQUIRED","productionTouched":false}'}
        }
        [IO.File]::WriteAllText((Join-Path $FixtureRoot 'native-result.json'),$json)
        return $(if($script:mode -eq 'refused'){1}else{0})
    }
}
$fixtureScript=Join-Path $PSScriptRoot 'test-installed-auto-resume.ps1'
$a=& $module {param($p) Invoke-InstalledDesktopValidation $p} $fixtureScript
$b=& $module {param($p) Invoke-InstalledDesktopValidation $p} $fixtureScript
Check ($a.status -ceq 'PASS' -and $b.status -ceq 'PASS' -and $a.fixtureRoot -cne $b.fixtureRoot) 'Unique roots and real marker/result IO with synthetic child boundary'
foreach($pair in @(@('missing','NATIVE_RESULT_MISSING'),@('malformed','NATIVE_RESULT_INVALID'),@('oversized','NATIVE_RESULT_TOO_LARGE'),@('refused','INDEPENDENT_OPERATOR_REQUIRED'),@('context','NON_ADMIN_OPERATOR_REQUIRED'))){
    $r=& $module {param($p,$mode) $script:mode=$mode;Invoke-InstalledDesktopValidation $p} $fixtureScript $pair[0]
    Check ($r.status -ceq 'FAIL' -and $r.code -ceq $pair[1]) ('Orchestration refuses '+$pair[0])
}
Check ((& $module {$script:calls}) -eq 6) 'Context refusal never invokes the child'
[pscustomobject]@{ok=$true;checks=$checks;scope='launcher parser/static/synthetic fixture IO only';nativeOperator='NOT_RUN';productionTouched=$false}|ConvertTo-Json
