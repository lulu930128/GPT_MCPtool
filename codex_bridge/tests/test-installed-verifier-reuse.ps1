# Actual verifier function and inert DLL; all authority observations synthetic.
# No installed code execution, ACL mutation, process/pipe or state access.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$base=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.tmp'))
$fixture=Join-Path $base ('verifier-reuse-'+[guid]::NewGuid().ToString('N'))
$currentRoot=Join-Path $fixture 'current';$previousRoot=Join-Path $fixture 'previous'
$manager=Join-Path $currentRoot 'mcp_control_center'
[void][IO.Directory]::CreateDirectory((Join-Path $manager 'src'))
[void][IO.Directory]::CreateDirectory((Join-Path $manager 'config'))
[void][IO.Directory]::CreateDirectory((Join-Path $previousRoot 'codex_bridge'))
[IO.File]::WriteAllText((Join-Path $manager 'config\installed-release.json'),'fixture observed manifest')
[IO.File]::WriteAllText((Join-Path $previousRoot 'codex_bridge\fixture.hash'),'previous-tree-digest')
$nativePath=Join-Path $manager 'src\InstalledRelease.Native.dll'
Add-Type -TypeDefinition @'
public static class McpCcInstalledTree {
    public static string VerifyTree(string path) {
        return System.IO.File.ReadAllText(System.IO.Path.Combine(path, "fixture.hash"));
    }
}
'@ -OutputAssembly $nativePath
$modulePath=Join-Path $manager 'src\McpControlCenter.InstalledRelease.psm1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\..\mcp_control_center\src\McpControlCenter.InstalledRelease.psm1') -Destination $modulePath
$module=Import-Module $modulePath -PassThru -Force
$current=[pscustomobject]@{root=$currentRoot;dependencies=@{releaseVerifier=[pscustomobject]@{path=$nativePath;sha256=(Get-FileHash -LiteralPath $nativePath).Hash.ToLowerInvariant()}}}
$previous=[pscustomobject]@{root=$previousRoot;dependencies=@{releaseVerifier=[pscustomobject]@{path=(Join-Path $previousRoot 'DO_NOT_LOAD.dll');sha256=('0'*64)}}}
$checks=0
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message};$script:checks++}
function Refused([scriptblock]$Body,[string]$ExpectedError){
    $failure=$null;try{& $Body|Out-Null}catch{$failure=$_.Exception.Message}
    Check ($null -ne $failure -and $failure.Contains($ExpectedError)) ('Expected '+$ExpectedError+'; got '+$failure)
}
try {
    & $module {
        param($release,$expectedManager)
        $script:currentFixture=$release;$script:managerFixture=$expectedManager;$script:manifestRefused=$false;$script:pathRefused=$false
        $script:checked=New-Object 'Collections.Generic.List[string]'
        function script:Read-McpCcInstalledRelease([string]$ManagerRoot){
            if($script:manifestRefused){throw 'FIXTURE_MANIFEST_REFUSED'}
            if($ManagerRoot -ine $script:managerFixture){throw 'VERIFIER_MUST_USE_PHYSICAL_MODULE'}
            return $script:currentFixture
        }
        function script:Assert-McpCcProtectedCodePath([string]$Path){
            if($script:pathRefused){throw 'FIXTURE_ACL_REFUSED'}
            if(-not(Test-Path -LiteralPath $Path)){throw 'FIXTURE_PATH_MISSING'}
            $script:checked.Add($Path)
        }
    } $current $manager
    $digest=& $module {param($r) Get-McpCcInstalledNativeTreeHash $r 'codex_bridge'} $previous
    Check ($digest -ceq 'previous-tree-digest') 'Must hash target tree with current protected verifier'
    Check ([McpCcInstalledTree].Assembly.Location -ieq $nativePath) 'Must load physically selected verifier only'
    Check ((@(& $module {$script:checked.ToArray()}) -join '|') -ceq ($nativePath+'|'+(Join-Path $previousRoot 'codex_bridge'))) 'Both verifier and target path checks must run'
    & $module {$script:manifestRefused=$true}
    Refused {& $module {param($r) Get-McpCcInstalledNativeTreeHash $r 'codex_bridge'} $previous} 'FIXTURE_MANIFEST_REFUSED'
    & $module {$script:manifestRefused=$false;$script:pathRefused=$true}
    Refused {& $module {param($r) Get-McpCcInstalledNativeTreeHash $r 'codex_bridge'} $previous} 'FIXTURE_ACL_REFUSED'
    & $module {$script:pathRefused=$false}
    $goodHash=$current.dependencies.releaseVerifier.sha256;$current.dependencies.releaseVerifier.sha256='0'*64
    Refused {& $module {param($r) Get-McpCcInstalledNativeTreeHash $r 'codex_bridge'} $previous} 'INSTALLED_DEPENDENCY_HASH_MISMATCH'
    $current.dependencies.releaseVerifier.sha256=$goodHash
    $otherDll=Join-Path $manager 'src\different-verifier.dll'
    Copy-Item -LiteralPath $nativePath -Destination $otherDll
    $current.dependencies.releaseVerifier.path=$otherDll
    Refused {& $module {param($r) Get-McpCcInstalledNativeTreeHash $r 'codex_bridge'} $previous} 'INSTALLED_LOADED_VERIFIER_MISMATCH'
    $current.dependencies.releaseVerifier.path=$nativePath
    [IO.File]::Delete((Join-Path $manager 'config\installed-release.json'))
    # Source-only invocation retains the existing target-pinned contract.
    $previous.dependencies.releaseVerifier.path=$nativePath;$previous.dependencies.releaseVerifier.sha256=$goodHash
    Check ((& $module {param($r) Get-McpCcInstalledNativeTreeHash $r 'codex_bridge'} $previous) -ceq 'previous-tree-digest') 'Source verification fallback changed'
    [pscustomobject]@{ok=$true;checks=$checks;verifier='ACTUAL_FUNCTION_INERT_DLL';acl='SYNTHETIC_REFUSAL';productionTouched=$false;runtimeStarted=$false}|ConvertTo-Json
} finally {
    Remove-Module $module -ErrorAction SilentlyContinue
    # The inert loaded DLL remains process-locked; retain this bounded fixture.
}
