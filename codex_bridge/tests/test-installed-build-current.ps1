# Actual freshness/context functions, isolated files and synthetic authority gates.
# No production state, process, IPC, ACL write, build or runtime action.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$base=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.tmp'))
$fixture=Join-Path $base ('installed-build-current-'+[guid]::NewGuid().ToString('N'))
$module=$null;$checks=0
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message};$script:checks++}
function Refused([scriptblock]$Body,[string]$ExpectedError){
    $actual=$null;try{& $Body|Out-Null}catch{$actual=$_.Exception.Message}
    Check ($null -ne $actual -and $actual.StartsWith($ExpectedError,[StringComparison]::Ordinal)) ('Expected '+$ExpectedError+'; got '+$actual)
}
$modulePath=Join-Path $PSScriptRoot '..\scripts\codex-bridge-runtime.psm1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($modulePath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'RUNTIME_PARSE_FAILED'}
$functions=foreach($name in @('Test-CbBuildCurrent','Assert-CbInstalledMutationBlocked')){
    $matches=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
    if($matches.Count -ne 1){throw 'ACTUAL_FUNCTION_NOT_UNIQUE'}
    $matches[0].Extent.Text
}
$module=New-Module -ScriptBlock ([scriptblock]::Create(($functions -join [Environment]::NewLine)))
try {
    foreach($dir in @('src','web','dist\src')){[void][IO.Directory]::CreateDirectory((Join-Path $fixture $dir))}
    $entry=Join-Path $fixture 'dist\src\http-main.js'
    $sourceFile=Join-Path $fixture 'src\changed.ts'
    $webFile=Join-Path $fixture 'web\widget.html'
    $packageFile=Join-Path $fixture 'package.json'
    $stamp=[DateTime]::SpecifyKind([DateTime]'2026-01-01T00:00:00',[DateTimeKind]::Utc)
    foreach($path in @($entry,$sourceFile,$webFile,$packageFile)){
        [IO.File]::WriteAllText($path,'fixture only')
        [IO.File]::SetLastWriteTimeUtc($path,$stamp)
    }
    & $module {
        param($root,$entryPath)
        $script:installed=$false;$script:bindingFailure=$null;$script:selectionFailure=$null
        $script:reads=0;$script:selections=0
        $script:binding=[pscustomobject]@{activationReady=$true;codeRoot=$root}
        $script:context=[pscustomobject]@{projectRoot=$root;httpEntry=$entryPath}
        function script:Test-CbInstalledLayout {$script:installed}
        # Synthetic closure boundary: every invocation is observable. The real
        # Get-CbInstalledBinding still verifies the protected manifest/tree/ACL.
        function script:Get-CbInstalledBinding {
            $script:reads++
            if(-not $script:installed){throw 'INSTALLED_RELEASE_REQUIRED'}
            if($script:bindingFailure){throw $script:bindingFailure}
            return $script:binding
        }
        function script:New-CbInstalledRuntimeContext($Binding){
            [pscustomobject]@{installedBinding=$Binding;projectRoot=$Binding.codeRoot;
                httpEntry=(Join-Path $Binding.codeRoot 'dist\src\http-main.js')}
        }
        function script:Assert-McpCcInstalledSelection($Binding){
            $script:selections++
            if($script:selectionFailure){throw $script:selectionFailure}
        }
    } $fixture $entry
    Check (& $module {Test-CbBuildCurrent $script:context}) 'Source current build must pass'
    foreach($path in @($sourceFile,$webFile,$packageFile)){
        [IO.File]::SetLastWriteTimeUtc($path,$stamp.AddMinutes(1))
        Check (-not (& $module {Test-CbBuildCurrent $script:context})) ('Source stale input must refuse: '+(Split-Path -Leaf $path))
        [IO.File]::SetLastWriteTimeUtc($path,$stamp)
    }
    [IO.File]::Move($entry,$entry+'.saved')
    Check (-not (& $module {Test-CbBuildCurrent $script:context})) 'Source missing entry must refuse'
    [IO.File]::Move($entry+'.saved',$entry)
    [IO.Directory]::Move((Join-Path $fixture 'src'),(Join-Path $fixture 'src.saved'))
    Refused {& $module {Test-CbBuildCurrent $script:context}} 'BUILD_CHECK_FAILED:'
    [IO.Directory]::Move((Join-Path $fixture 'src.saved'),(Join-Path $fixture 'src'))
    foreach($path in @($sourceFile,$webFile,$packageFile)){[IO.File]::SetLastWriteTimeUtc($path,$stamp.AddMinutes(1))}
    & $module {
        $script:installed=$true;$script:context=New-CbInstalledRuntimeContext $script:binding
        $script:context|Add-Member -NotePropertyName buildIdCache -NotePropertyValue ([pscustomobject]@{value='caller';error=$null})
    }
    Check (& $module {Test-CbBuildCurrent $script:context}) 'Verified installed artifacts need not share the entry timestamp'
    Check (& $module {$script:reads -eq 1 -and $script:selections -eq 1}) 'Installed mode must revalidate authority and selection'
    Check (& $module {$null -eq $script:context.PSObject.Properties['buildIdCache']}) 'Caller build cache must not survive authority verification'
    foreach($failure in @('INSTALLED_MANIFEST_INVALID','PROTECTED_WRITE_REJECTED','INSTALLED_TREE_HASH_MISMATCH','INSTALLED_DEPENDENCY_HASH_MISMATCH')){
        & $module {param($errorCode) $script:bindingFailure=$errorCode} $failure
        Refused {& $module {Test-CbBuildCurrent $script:context}} $failure
    }
    & $module {$script:bindingFailure=$null}
    foreach($failure in @('INSTALLED_STARTUP_NOT_SELECTED','INSTALLED_OWNER_UNKNOWN','INSTALLED_PARALLEL_OWNER')){
        & $module {param($errorCode) $script:selectionFailure=$errorCode} $failure
        Refused {& $module {Test-CbBuildCurrent $script:context}} $failure
    }
    & $module {$script:selectionFailure=$null}
    foreach($property in @('projectRoot','httpEntry','installedBinding')){
        & $module {param($name,$existingEntry)
            $script:context=New-CbInstalledRuntimeContext $script:binding
            # Use an existing path so entry existence cannot conceal context refusal.
            $script:context.$name=if($name -eq 'httpEntry'){$existingEntry}else{'caller-forged'}
        } $property $sourceFile
        Refused {& $module {Test-CbBuildCurrent $script:context}} 'INSTALLED_CONTEXT_TAMPERED'
    }
    & $module {$script:context=New-CbInstalledRuntimeContext $script:binding;$script:binding.activationReady=$false}
    Refused {& $module {Test-CbBuildCurrent $script:context}} 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED'
    & $module {$script:binding.activationReady=$true;$script:installed=$false}
    Refused {& $module {Test-CbBuildCurrent $script:context}} 'INSTALLED_RELEASE_REQUIRED'
    & $module {$script:installed=$true;$script:context.PSObject.Properties.Remove('installedBinding')}
    Refused {& $module {Test-CbBuildCurrent $script:context}} 'INSTALLED_CONTEXT_TAMPERED'
    & $module {$script:context=New-CbInstalledRuntimeContext $script:binding}
    [IO.File]::Move($entry,$entry+'.saved')
    Check (-not (& $module {Test-CbBuildCurrent $script:context})) 'Installed missing entry must refuse'
    [IO.File]::Move($entry+'.saved',$entry)
    & $module {$script:bindingFailure='INSTALLED_TREE_HASH_MISMATCH'}
    Refused {& $module {Test-CbBuildCurrent $script:context}} 'INSTALLED_TREE_HASH_MISMATCH'
    [pscustomobject]@{ok=$true;checks=$checks;freshness='ACTUAL_FUNCTIONS_ISOLATED_TIMESTAMPS';
        authority='SYNTHETIC_REFUSAL';productionTouched=$false;runtimeStarted=$false;fixtureRetained=$true}|ConvertTo-Json
} finally {if($module){Remove-Module $module -Force}}
