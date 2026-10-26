# Actual Prepare copy and native-loader functions, isolated files/synthetic ACL.
# No production DLL method, process query, pipe, state, Startup or runtime action.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$base=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.tmp'))
$fixture=Join-Path $base ('installed-cooperative-'+[guid]::NewGuid().ToString('N'))
$source=Join-Path $PSScriptRoot '..\scripts'
$checks=0;$module=$null;$other=$null;$success=$false
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message};$script:checks++}
function Refused([scriptblock]$Body,[string]$ExpectedError){
    $actual=$null;try{& $Body|Out-Null}catch{$actual=$_.Exception.Message}
    Check ($null -ne $actual -and $actual.Contains($ExpectedError)) ('Expected '+$ExpectedError+'; got '+$actual)
}
function Parse([string]$Path){
    $tokens=$null;$errors=$null
    $parsed=[Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'FIXTURE_SOURCE_PARSE_FAILED'}
    return $parsed
}
function Write-Fixture([string]$Path,[string]$Text){
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
    [IO.File]::WriteAllText($Path,$Text)
}
try {
    $CandidateRoot=Join-Path $fixture 'candidate';$PackageRoot=Join-Path $fixture 'package'
    $operator=Parse (Join-Path $source 'installed-release-operator.ps1')
    $assign=$operator.Find({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$scriptLists'},$true)
    $loop=$operator.Find({param($n) $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Variable.VariablePath.UserPath -ceq 'componentName' -and $n.Condition.Extent.Text -ceq '$scriptLists.Keys'},$true)
    Check ($null -ne $assign -and $null -ne $loop) 'Actual Prepare copy statements missing'
    $copy=[scriptblock]::Create($assign.Extent.Text+"`n"+$loop.Extent.Text)
    . ([scriptblock]::Create($assign.Extent.Text))
    $verifier=New-Module {function Assert-McpCcNoReparseChain([string]$p){if(-not(Test-Path -LiteralPath $p)){throw 'FIXTURE_INPUT_MISSING'}}}
    foreach($component in $scriptLists.Keys){
        foreach($name in $scriptLists[$component]){
            Write-Fixture (Join-Path $CandidateRoot ($component+'\scripts\'+$name)) 'throw "FIXTURE_NOT_EXECUTABLE"'
        }
        [void][IO.Directory]::CreateDirectory((Join-Path $PackageRoot $component))
    }
    foreach($name in @('process-identity.ps1','cooperative-shutdown-host.ps1','cooperative-layout.ps1')){
        Check (@($scriptLists.codex_bridge|Where-Object{$_ -ceq $name}).Count -eq 1) ('Missing helper in actual Prepare: '+$name)
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $CandidateRoot ('codex_bridge\scripts\'+$name))
    }
    Copy-Item -LiteralPath (Join-Path $source 'codex-bridge-runtime.psm1') -Destination (Join-Path $CandidateRoot 'codex_bridge\scripts\codex-bridge-runtime.psm1')
    & $copy
    foreach($name in @('process-identity.ps1','cooperative-shutdown-host.ps1','codex-bridge-runtime.psm1')){
        Check ((Get-FileHash -LiteralPath (Join-Path $PackageRoot ('codex_bridge\scripts\'+$name))).Hash -ceq
            (Get-FileHash -LiteralPath (Join-Path $source $name)).Hash) ('Prepare helper bytes differ: '+$name)
    }
    # Fresh package destinations prove an absent candidate helper never resolves
    # from the workspace or an already installed release.
    $copiedRoot=$PackageRoot
    foreach($name in @('process-identity.ps1','cooperative-shutdown-host.ps1')){
        $inputPath=Join-Path $CandidateRoot ('codex_bridge\scripts\'+$name)
        $bytes=[IO.File]::ReadAllBytes($inputPath);[IO.File]::Delete($inputPath)
        $PackageRoot=Join-Path $fixture ('missing-'+$name)
        foreach($component in $scriptLists.Keys){[void][IO.Directory]::CreateDirectory((Join-Path $PackageRoot $component))}
        Refused {& $copy} 'FIXTURE_INPUT_MISSING'
        [IO.File]::WriteAllBytes($inputPath,$bytes)
    }
    $PackageRoot=$copiedRoot
    $native=Join-Path $PackageRoot 'mcp_control_center\src'
    [void][IO.Directory]::CreateDirectory($native)
    $module=Import-Module (Join-Path $PackageRoot 'codex_bridge\scripts\codex-bridge-runtime.psm1') -PassThru -Force
    & $module {
        $script:installedFixture=$false;$script:denyFixture=$false;$script:loadPath=$null;$script:observeLoad=$true
        function script:Test-CbInstalledLayout {return $script:installedFixture}
        function script:Assert-CbInstalledAuthorityPath([string]$Path){
            if($script:denyFixture){throw 'FIXTURE_ACL_REJECTED'}
            if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){throw 'FIXTURE_NATIVE_MISSING'}
        }
        function script:Add-Type {param($Path,$ErrorAction)
            if($script:observeLoad){$script:loadPath=$Path;throw 'FIXTURE_LOAD_OBSERVED'}
            Microsoft.PowerShell.Utility\Add-Type -Path $Path -ErrorAction Stop
        }
    }
    Refused {& $module {Initialize-CbCooperativeNative -IdentityOnly}} 'FIXTURE_LOAD_OBSERVED'
    Check ((& $module {$script:loadPath}) -ceq (Join-Path $native 'NormalOperator.Native.cs')) 'Source identity loader changed'
    & $module {$script:installedFixture=$true;$script:loadPath=$null;$script:denyFixture=$true}
    Refused {& $module {Initialize-CbCooperativeNative}} 'FIXTURE_ACL_REJECTED'
    Check ($null -eq (& $module {$script:loadPath})) 'ACL refusal reached native load'
    & $module {$script:denyFixture=$false}
    Refused {& $module {Initialize-CbCooperativeNative}} 'FIXTURE_NATIVE_MISSING'
    Check ($null -eq (& $module {$script:loadPath})) 'Missing installed DLL fell back to source'
    # Tiny inert test assemblies exercise real Add-Type and Assembly.Location.
    # They contain no production P/Invoke or methods and are not Host acceptance.
    $normalDll=Join-Path $native 'NormalOperator.Host.dll'
    $reloadDll=Join-Path $native 'RemoteSelfReload.Native.dll'
    Microsoft.PowerShell.Utility\Add-Type -TypeDefinition 'public static class McpCcNormalNative {}' -OutputAssembly $normalDll
    Microsoft.PowerShell.Utility\Add-Type -TypeDefinition 'public static class McpCcReloadNative {}' -OutputAssembly $reloadDll
    & $module {$script:observeLoad=$false}
    & $module {Initialize-CbCooperativeNative -IdentityOnly}
    Check ([McpCcNormalNative].Assembly.Location -ieq $normalDll) 'Installed identity must load fixed DLL'
    & $module {
        $script:installedFixture=$false;$script:loadPath=$null;$script:observeLoad=$true
    }
    Refused {& $module {Initialize-CbCooperativeNative}} 'FIXTURE_LOAD_OBSERVED'
    Check ((& $module {$script:loadPath}) -ceq (Join-Path $native 'RemoteSelfReload.Native.cs')) 'Source pipe loader changed'
    & $module {$script:observeLoad=$false;$script:installedFixture=$true}
    & $module {Initialize-CbCooperativeNative}
    Check ([McpCcReloadNative].Assembly.Location -ieq $reloadDll) 'Installed pipe must load fixed DLL'
    # Exercise only the operator's native load prefix, stopping before its
    # real Windows token/ancestry inspection or any action dispatch.
    $independent=$operator.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Assert-IndependentOperator'},$true)
    $text=$independent.Body.Extent.Text
    $begin=$text.IndexOf('$installed=Test-Path',[StringComparison]::Ordinal)
    $end=$text.IndexOf('if (-not [McpCcReloadNative]::OutsideAllJobs())',[StringComparison]::Ordinal)
    if($begin -lt 0 -or $end -le $begin){throw 'OPERATOR_NATIVE_PREFIX_MISSING'}
    $loadOperator=[scriptblock]::Create($text.Substring($begin,$end-$begin))
    $manager=Join-Path $PackageRoot 'mcp_control_center'
    Write-Fixture (Join-Path $manager 'config\installed-release.json') '{}'
    $verifier=New-Module {function Assert-McpCcProtectedCodePath([string]$p){if(-not(Test-Path -LiteralPath $p -PathType Leaf)){throw 'FIXTURE_NATIVE_MISSING'}}}
    $Action='Prepare';$InstalledRecoverySha256=$null
    & $loadOperator
    Check ([McpCcReloadNative].Assembly.Location -ieq $reloadDll) 'Installed operator must use the same protected DLL'
    $otherRoot=Join-Path $fixture 'other-release'
    $otherModulePath=Join-Path $otherRoot 'codex_bridge\scripts\codex-bridge-runtime.psm1'
    Write-Fixture $otherModulePath ([IO.File]::ReadAllText((Join-Path $source 'codex-bridge-runtime.psm1')))
    Write-Fixture (Join-Path (Split-Path -Parent $otherModulePath) 'cooperative-layout.ps1') ([IO.File]::ReadAllText((Join-Path $source 'cooperative-layout.ps1')))
    $other=Import-Module $otherModulePath -PassThru -Force
    & $other {
        function script:Test-CbInstalledLayout {return $true}
        function script:Assert-CbInstalledAuthorityPath([string]$Path){}
    }
    Refused {& $other {Initialize-CbCooperativeNative}} 'INSTALLED_LOADED_NATIVE_MISMATCH'
    $manager=Join-Path $otherRoot 'mcp_control_center'
    Write-Fixture (Join-Path $manager 'config\installed-release.json') '{}'
    [void][IO.Directory]::CreateDirectory((Join-Path $manager 'src'))
    Copy-Item -LiteralPath $reloadDll -Destination (Join-Path $manager 'src\RemoteSelfReload.Native.dll')
    Refused {& $loadOperator} 'INSTALLED_LOADED_NATIVE_MISMATCH'
    # Exercise actual installed startup closure against the copied helper files.
    $fixtureBridgeRoot=Join-Path $PackageRoot 'codex_bridge'
    foreach($path in @('scripts\OwnedProcess.Native.dll','dist\src\cooperative-shutdown.js','dist\src\process-identity.js')){
        Write-Fixture (Join-Path $fixtureBridgeRoot $path) 'fixture metadata only'
    }
    & $module {param($p) Assert-CbCooperativeSourceAvailable ([pscustomobject]@{projectRoot=$p})} $fixtureBridgeRoot
    $checks++
    foreach($path in @('scripts\process-identity.ps1','scripts\cooperative-shutdown-host.ps1','scripts\OwnedProcess.Native.dll')){
        $target=Join-Path $fixtureBridgeRoot $path;$bytes=[IO.File]::ReadAllBytes($target);[IO.File]::Delete($target)
        Refused {& $module {param($p) Assert-CbCooperativeSourceAvailable ([pscustomobject]@{projectRoot=$p})} $fixtureBridgeRoot} 'COOPERATIVE_SOURCE_INCOMPLETE'
        [IO.File]::WriteAllBytes($target,$bytes)
    }
    foreach($name in @('process-identity.ps1','cooperative-shutdown-host.ps1')){
        $parsed=Parse (Join-Path $source $name)
        $loads=@($parsed.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Initialize-CbCooperativeNative'},$true))
        $compiles=@($parsed.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type'},$true))
        Check ($loads.Count -eq 1 -and $compiles.Count -eq 0) ('Helper must share fixed loader: '+$name)
    }
    $json=[pscustomobject]@{ok=$true;checks=$checks;packageCopy='ACTUAL_PREPARE_STATEMENTS';nativeLoad='INERT_FIXTURE_DLL';acl='SYNTHETIC_REFUSAL';nativePipe='NOT_RUN';productionTouched=$false;runtimeStarted=$false}|ConvertTo-Json
    $success=$true;$json
} finally {
    if($module){Remove-Module $module -ErrorAction SilentlyContinue}
    if($other){Remove-Module $other -ErrorAction SilentlyContinue}
    # Loaded DLLs stay locked until this test process exits. Retain only this
    # bounded fixture; never delete or alter an installed release to clean up.
    if(-not $success){Write-Output ('ISOLATED_FIXTURE_RETAINED: '+$fixture)}
}
