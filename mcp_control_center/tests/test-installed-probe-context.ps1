Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\src\McpControlCenter.Core.psm1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'CORE_PARSE_FAILED'}
# Exercise the real installed registry mapping and command predicate. All
# release/process observations are inert values; no registry, IPC or ACL IO.
$blocks=@($ast.FindAll({param($n)
    $n -is [Management.Automation.Language.IfStatementAst] -and
    $n.Extent.Text.StartsWith("if (`$null -ne `$installedRelease -and `$installedRelease.schemaVersion -ge 3 -and `$id -ceq 'codex_bridge')")
},$true))
if($blocks.Count -ne 1){throw 'INSTALLED_MAPPING_NOT_UNIQUE'}
$mapping=[scriptblock]::Create($blocks[0].Extent.Text)
$predicate=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Test-McpCcCommandLineContains'},$true))
if($predicate.Count -ne 1){throw 'COMMAND_PREDICATE_NOT_UNIQUE'}
. ([scriptblock]::Create($predicate[0].Extent.Text))
$checks=0
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message};$script:checks++}
function Get-McpCcInstalledStateRoot {param($Release) return 'C:\FixtureOwner'}
function New-ProbeFixture {
    [pscustomobject]@{probes=@(
        [pscustomobject]@{id='mcp';resolvedOwnerManagedPidFile='source-core.pid';ownerManagedCommandContains=@('codex_bridge','dist\src\http-main.js')},
        [pscustomobject]@{id='tunnel';resolvedOwnerManagedPidFile='source-tunnel.pid';ownerManagedCommandContains=@('codex_bridge','tunnel-client')}
    );connectivityEvidence=[pscustomobject]@{resolvedRemoteEvidencePath='source-evidence.json'}}
}
$id='codex_bridge'
$exe='C:\Program Files\FixtureRelease\dependencies\tunnel-client\tunnel-client.exe'
foreach($version in @(3,4,5)){
    $installedRelease=[pscustomobject]@{schemaVersion=$version;releaseId='fixture-release';dependencies=@{tunnelClient=@{path=$exe}}}
    $component=New-ProbeFixture
    & $mapping
    $tunnel=$component.probes[1]
    $pidPath='C:\FixtureOwner\installed-bridge\fixture-release\tunnel-client.pid'
    Check ($tunnel.resolvedOwnerManagedPidFile -ceq $pidPath) 'Installed tunnel must retain the private managed PID path'
    Check ($component.probes[0].resolvedOwnerManagedPidFile -ceq 'C:\FixtureOwner\installed-bridge\fixture-release\codex-bridge-http-server.pid') 'Core PID mapping must remain intact'
    Check ($component.connectivityEvidence.resolvedRemoteEvidencePath -ceq 'C:\FixtureOwner\installed-bridge\fixture-release\remote-registration-evidence.json') 'Remote evidence mapping must remain intact'
    $command='"'+$exe+'" run --profile-dir "C:\FixtureOwner\deployment\tunnel" --profile "codex-bridge" --log.file "C:\FixtureOwner\tunnel.log" --pid.file "'+$pidPath+'"'
    Check (Test-McpCcCommandLineContains $command $tunnel.ownerManagedCommandContains) 'Installed command without a codex_bridge directory must match'
    Check (-not(Test-McpCcCommandLineContains ($command.Replace('FixtureRelease','OtherRelease')) $tunnel.ownerManagedCommandContains)) 'Another release executable must fail'
    Check (-not(Test-McpCcCommandLineContains ($command.Replace($pidPath,'C:\OtherOwner\tunnel-client.pid')) $tunnel.ownerManagedCommandContains)) 'Another owner PID path must fail'
    Check (-not(Test-McpCcCommandLineContains ($command.Replace('--profile "codex-bridge"','--profile "other"')) $tunnel.ownerManagedCommandContains)) 'Another profile must fail'
    Check (-not(Test-McpCcCommandLineContains ($command.Replace('tunnel-client.exe','tunnel-client.exe.other')) $tunnel.ownerManagedCommandContains)) 'Executable suffix must not pass the quoted path fragment'
}
$installedRelease=$null;$component=New-ProbeFixture;& $mapping
Check (($component.probes[1].ownerManagedCommandContains -join ',') -ceq 'codex_bridge,tunnel-client' -and $component.probes[1].resolvedOwnerManagedPidFile -ceq 'source-tunnel.pid') 'Source probe expectations must remain unchanged'
$installedRelease=[pscustomobject]@{schemaVersion=5;releaseId='fixture-release';dependencies=@{tunnelClient=@{path=$exe}}}
$id='unrelated_component';$component=New-ProbeFixture;& $mapping
Check (($component.probes[1].ownerManagedCommandContains -join ',') -ceq 'codex_bridge,tunnel-client' -and $component.probes[1].resolvedOwnerManagedPidFile -ceq 'source-tunnel.pid') 'Other components must remain unchanged'
$id='codex_bridge';$component=New-ProbeFixture;$component.probes[1].id='unknown'
$rejected=$false
try{& $mapping}catch{$rejected=$_.Exception.Message -ceq 'INSTALLED_BRIDGE_PROBE_INVALID'}
Check $rejected 'Unknown installed probe must remain rejected'
[pscustomobject]@{ok=$true;checks=$checks;mapping='ACTUAL_INSTALLED_REGISTRY_BLOCK';ownership='SYNTHETIC_COMMANDS';productionTouched=$false;runtimeStarted=$false}|ConvertTo-Json
