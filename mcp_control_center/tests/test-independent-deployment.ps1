Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$deployment = Import-Module (Join-Path $source 'src\McpControlCenter.Deployment.psm1') -Force -PassThru
$fixture = Join-Path $env:TEMP ('mcpcc-deployment-'+[guid]::NewGuid().ToString('N'))
$cc = Join-Path $fixture 'mcp_control_center'
$script:checks = 0
function Check([bool]$Value,[string]$Message) {
    if (-not $Value) { throw ('CHECK_FAILED: '+$Message) }; $script:checks++
}
function Reject([scriptblock]$Action,[string]$Code) {
    $caught = $false
    try { $null = & $Action } catch { $caught = $true; if ($_.Exception.Message -notlike ('*'+$Code+'*')) { throw } }
    Check $caught $Code
}
function Put([string]$Path,[string]$Text) {
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
    [IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($false)))
}
function Json([string]$Path,$Value) { Put $Path ($Value | ConvertTo-Json -Depth 20) }
$allowlist = @(& $deployment { $script:CodeFiles })
foreach ($relative in $allowlist) {
    $to = Join-Path $cc $relative
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $to))
    [IO.File]::Copy((Join-Path $source $relative),$to)
}
Put (Join-Path $cc '.local\runtime\state.json') 'fixture-state-do-not-copy'
Put (Join-Path $cc '.env') 'fixture-only-not-a-secret'
Put (Join-Path $cc 'config\unlisted-private.json') 'fixture-only-never-read'
Put (Join-Path $cc 'src\unlisted.ps1') '# must not copy'
$stateHash = (Get-FileHash (Join-Path $cc '.local\runtime\state.json')).Hash
$missing = Get-McpCcDeploymentStatus $cc
Check (-not $missing.selected -and $missing.versions.Count -eq 0) 'empty status'
Check (-not (Test-Path (Join-Path $cc 'Runtime'))) 'status creates nothing'
Check ($missing.bridgeStatus -ceq 'CC_BRIDGE_SELECTION_UNAVAILABLE') 'no dev fallback'
$stage = New-McpCcDeploymentCandidate $cc 'fixture-a'
Check ($stage.phase -ceq 'STAGED' -and $stage.fileCount -eq $allowlist.Count) 'complete code candidate'
$a = $stage.codeRoot
$root = Join-Path $cc 'Runtime'
Check (-not (Test-Path (Join-Path $root 'current.json'))) 'stage never selects'
foreach ($relative in @('.local','.env','config\unlisted-private.json','src\unlisted.ps1','config\installed-release.json')) {
    Check (-not (Test-Path (Join-Path $a $relative))) ('excluded '+$relative)
}
Check ((Get-FileHash (Join-Path $cc '.local\runtime\state.json')).Hash -ceq $stateHash) 'existing state unchanged'
Reject { New-McpCcDeploymentCandidate $cc 'fixture-a' } 'CC_VERSION_EXISTS'
Reject { New-McpCcDeploymentCandidate $cc '..\escape' } 'CC_VERSION_INVALID'
$lock = & $deployment { param($r) Open-CcUpdateLock $r } $root
try { Reject { New-McpCcDeploymentCandidate $cc 'locked' } 'being used' }
finally { $lock.Dispose() }
Check (-not (Test-Path (Join-Path $root 'versions\locked'))) 'lock prevents staging'
$layout = Test-McpCcDeploymentVersion $root 'fixture-a'
Check ($layout.workspaceRoot -ceq $fixture) 'nested workspace'
Check ($layout.stateRoot -ceq (Join-Path $cc '.local\runtime')) 'state stays at source component'
$original = [IO.File]::ReadAllText((Join-Path $a 'scripts\tray.ps1'))
Put (Join-Path $a 'scripts\tray.ps1') ($original+'# corruption')
Reject { Test-McpCcDeploymentVersion $root 'fixture-a' } 'CC_COPY_INTEGRITY_FAILED'
Put (Join-Path $a 'scripts\tray.ps1') $original
Put (Join-Path $a '.env') 'fixture-only'
Reject { Test-McpCcDeploymentVersion $root 'fixture-a' } 'CC_UNLISTED_CODE_FILE'
[IO.File]::Delete((Join-Path $a '.env'))
Check ((Test-McpCcDeploymentVersion $root 'fixture-a').version -ceq 'fixture-a') 'restored candidate'

# Complete eight public descriptors, inert entrypoints, and a fake Bridge selector.
$registry = Get-Content -LiteralPath (Join-Path $cc 'config\registry.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$bridgeRuntime = Join-Path $fixture 'codex_bridge\Runtime'
$bridgeRelease = Join-Path $bridgeRuntime 'versions\bridge-a'
$bridgeRoot = Join-Path $bridgeRelease 'codex_bridge'
foreach ($entry in $registry.components) {
    $folder = Split-Path -Leaf $entry.root
    $componentRoot = if ($entry.id -ceq 'codex_bridge') { $bridgeRoot } else { Join-Path $fixture $folder }
    $descriptorPath = Join-Path (Split-Path -Parent $source) ($folder+'\control-center\component.json')
    $descriptorText = [IO.File]::ReadAllText($descriptorPath)
    Put (Join-Path $componentRoot 'control-center\component.json') $descriptorText
    $descriptor = $descriptorText | ConvertFrom-Json
    $paths = @($descriptor.contractScript,$descriptor.lifecycle.controller.path)
    if ($null -ne $descriptor.PSObject.Properties['legacyStartup']) { $paths += $descriptor.legacyStartup.launcher }
    foreach ($p in $descriptor.lifecycle.PSObject.Properties) {
        if ($null -ne $p.Value.PSObject.Properties['path']) { $paths += $p.Value.path }
    }
    if ($null -ne $descriptor.PSObject.Properties['ui']) { $paths += $descriptor.ui.actionEntrypoint.path }
    foreach ($relative in $paths | Select-Object -Unique) { Put (Join-Path $componentRoot $relative) '# inert fixture; must never execute' }
}
Json (Join-Path $bridgeRelease 'daily-mode.json') @{contract='mcpcc-daily-user-v1'}
Json (Join-Path $bridgeRuntime 'current.json') @{contract='mcpcc-daily-current-v1';version='bridge-a'}
$bridgeState = Join-Path $fixture 'bridge-existing-state'
$tunnel = Join-Path $fixture 'tools\tunnel-client.exe'
Json (Join-Path $bridgeRuntime 'settings.json') @{contract='mcpcc-daily-user-v1';bridgeRuntimeDir=$bridgeState;tunnelClientPath=$tunnel}
$bridge = Get-McpCcBridgeDeployment $fixture -IncludeState
Check ($bridge.root -ceq $bridgeRoot) 'Bridge selected code root'
Check ($bridge.controller -ceq (Join-Path $bridgeRoot 'scripts\runtime-control.ps1')) 'canonical controller'
$core = Import-Module (Join-Path $a 'src\McpControlCenter.Core.psm1') -Force -PassThru
$manifest = & $core { Read-McpCcManifest }
Check ($manifest.workspaceRoot -ceq $fixture -and $manifest.components.Count -eq 8) 'actual nested v3 loader'
foreach ($entry in $manifest.registryEntries) {
    $expected = if ($entry.id -ceq 'codex_bridge') { $bridgeRoot } else { Join-Path $fixture (Split-Path -Leaf $entry.root) }
    Check ($entry.resolvedRoot -ceq $expected) ('root '+$entry.id)
}
Check ((& $core { Get-McpCcDefaultRuntimeRoot }) -ceq $layout.stateRoot) 'Core state default'
& $core {param($m,$s) Assert-McpCcRuntimeRoot $m $s} $manifest $layout.stateRoot
$script:checks++
Reject { & $core {param($m,$s) Assert-McpCcRuntimeRoot $m $s} $manifest (Join-Path $fixture 'wrong-state') } 'CC_STATE_ROOT_MISMATCH'
$component = @($manifest.components | Where-Object id -eq 'codex_bridge')[0]
Check ($component.probes[0].resolvedOwnerManagedPidFile -ceq (Join-Path $bridgeState 'codex-bridge-http-server.pid')) 'Bridge persistent PID locator'
Check ($component.probes[1].ownerManagedCommandContains[0] -ceq $tunnel) 'Bridge tunnel identity metadata'
Check ($component.connectivityEvidence.resolvedRemoteEvidencePath -ceq (Join-Path $bridgeState 'remote-registration-evidence.json')) 'Bridge evidence location'
Reject { Resolve-McpCcDeploymentComponentRoot $layout 'omi_search' '..\..\codex_bridge' $bridge } 'CC_COMPONENT_ROOT_INVALID'
Json (Join-Path $bridgeRuntime 'current.json') @{contract='mcpcc-daily-current-v1';version='..\escape'}
Reject { Get-McpCcBridgeDeployment $fixture } 'CC_VERSION_INVALID'
Json (Join-Path $bridgeRuntime 'current.json') @{contract='mcpcc-daily-current-v1';version='absent'}
Reject { & $core { Read-McpCcManifest } } 'does not exist'
Json (Join-Path $bridgeRuntime 'current.json') @{contract='wrong';version='bridge-a'}
Reject { Get-McpCcBridgeDeployment $fixture } 'CC_BRIDGE_SELECTOR_INVALID'
Json (Join-Path $bridgeRuntime 'current.json') @{contract='mcpcc-daily-current-v1';version='bridge-a'}

# Refresh a cached manifest before dispatch; no real controller is executed.
$bRelease = Join-Path $bridgeRuntime 'versions\bridge-b'
[void][IO.Directory]::CreateDirectory($bRelease)
Copy-Item -LiteralPath $bridgeRoot -Destination (Join-Path $bRelease 'codex_bridge') -Recurse
Json (Join-Path $bRelease 'daily-mode.json') @{contract='mcpcc-daily-user-v1'}
Json (Join-Path $bridgeRuntime 'current.json') @{contract='mcpcc-daily-current-v1';version='bridge-b'}
$plan = & $core {param($m) Invoke-McpCcComponentAction -Manifest $m -ComponentId codex_bridge -Action reload_runtime -PlanOnly} $manifest
Check ($plan.path -ceq (Join-Path $bRelease 'codex_bridge\scripts\runtime-control.ps1')) 'stale manifest refreshes Bridge action'

# All selection tests replace only the stopped-tray admission seam. Never touch
# the production mutex, process, Startup folder, IPC pipe or existing state.
& $deployment {
    function script:Enter-CcStoppedTray { throw 'CC_TRAY_PRESENT_USE_ORDINARY_EXIT' }
}
Reject { & $deployment {param($s) Set-McpCcDeploymentSelection $s 'fixture-a'} $cc } 'CC_TRAY_PRESENT_USE_ORDINARY_EXIT'
Check (-not (Test-Path (Join-Path $root 'current.json'))) 'busy selection preserves absence'
& $deployment {
    function script:Enter-CcStoppedTray {
        $fake = [pscustomobject]@{}
        $fake | Add-Member ScriptMethod ReleaseMutex {}
        $fake | Add-Member ScriptMethod Dispose {}
        return $fake
    }
}
$selected = & $deployment {param($s) Set-McpCcDeploymentSelection $s 'fixture-a'} $cc
Check ($selected.phase -ceq 'SELECTED_NOT_STARTED') 'stopped-only initial selection'
$oldBytes = [IO.File]::ReadAllText((Join-Path $root 'current.json'))
$null = & $deployment {param($s) New-McpCcDeploymentCandidate $s 'fixture-b'} $cc
Reject { & $deployment {param($s) Set-McpCcDeploymentSelection $s 'missing'} $cc } 'does not exist'
Check ([IO.File]::ReadAllText((Join-Path $root 'current.json')) -ceq $oldBytes) 'failed selection preserves old selector'
$null = & $deployment {param($s) Set-McpCcDeploymentSelection $s 'fixture-b'} $cc
$backups = @(Get-ChildItem -LiteralPath $root -Filter 'previous-*.json')
Check ($backups.Count -eq 1 -and [IO.File]::ReadAllText($backups[0].FullName) -ceq $oldBytes) 'atomic replace preserves exact backup'
Reject { Assert-McpCcDeploymentSelected $layout } 'CC_SELECTION_CHANGED'
$null = & $deployment {param($s) Set-McpCcDeploymentSelection $s 'fixture-a'} $cc
Assert-McpCcDeploymentSelected $layout
$script:checks++
Check ((Get-FileHash (Join-Path $cc '.local\runtime\state.json')).Hash -ceq $stateHash) 'all operations leave state unchanged'
$beforeStatus = @(Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object { $_.FullName+':'+(Get-FileHash -LiteralPath $_.FullName).Hash }) -join '|'
$status = & $deployment {param($s) Get-McpCcDeploymentStatus $s} $cc
$afterStatus = @(Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object { $_.FullName+':'+(Get-FileHash -LiteralPath $_.FullName).Hash }) -join '|'
Check ($beforeStatus -ceq $afterStatus) 'status byte-read-only'
Check ($status.versions.Count -eq 2 -and $status.selected -ceq 'fixture-a' -and $status.live -ceq 'UNVERIFIED') 'status distinguishes selected and live'
$inactiveTray=Join-Path $root 'versions\fixture-b\scripts\tray.ps1'
$inactiveBytes=[IO.File]::ReadAllBytes($inactiveTray)
try {
    [IO.File]::AppendAllText($inactiveTray,'# damaged inactive fixture')
    $damagedStatus=& $deployment {param($s) Get-McpCcDeploymentStatus $s} $cc
    Check ($damagedStatus.selected -ceq 'fixture-a') 'inactive corruption does not block recovery to selected version'
    Check (@($damagedStatus.versions | Where-Object integrity -eq 'FAIL').Count -eq 1) 'inactive corruption remains visible'
} finally { [IO.File]::WriteAllBytes($inactiveTray,$inactiveBytes) }

# Source WIP changing during a copy cannot publish a mixed candidate.
& $deployment {
    param($s)
    $script:RaceSource=$s
    $script:InventoryBody=(Get-Command Get-CcCodeInventory).ScriptBlock
    $script:RaceFired=$false
    function script:Get-CcCodeInventory([string]$Root) {
        if(-not $script:RaceFired -and $Root -match '\\Runtime\\staging\\') {
            $script:RaceFired=$true
            [IO.File]::AppendAllText((Join-Path $script:RaceSource 'scripts\tray.ps1'),'# concurrent fixture edit')
        }
        & $script:InventoryBody $Root
    }
} $cc
try {
    Reject { & $deployment {param($s) New-McpCcDeploymentCandidate $s 'raced'} $cc } 'CC_SOURCE_CHANGED_OR_COPY_FAILED'
    Check (-not (Test-Path (Join-Path $root 'versions\raced'))) 'mixed source never published'
    Check ([IO.File]::ReadAllText((Join-Path $root 'current.json')) -ceq $oldBytes) 'failed stage preserves selector'
} finally {
    & $deployment { Set-Item Function:script:Get-CcCodeInventory $script:InventoryBody }
    [IO.File]::Copy((Join-Path $source 'scripts\tray.ps1'),(Join-Path $cc 'scripts\tray.ps1'),$true)
}

# Junction preflight uses fixture-only paths, no elevation or permissions changes.
$outside = Join-Path $fixture 'junction-target'
[void][IO.Directory]::CreateDirectory($outside)
$junction = Join-Path $cc 'Runtime\versions\junction'
New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
Reject { & $deployment {param($p) Assert-CcDeploymentPath $p} (Join-Path $junction 'file.ps1') } 'CC_REPARSE_REJECTED'
Reject { & $deployment {param($s) New-McpCcDeploymentCandidate $s 'junction'} $cc } 'CC_REPARSE_REJECTED'
$linkedSource=Join-Path $fixture 'linked\mcp_control_center'
[void][IO.Directory]::CreateDirectory((Split-Path -Parent $linkedSource))
New-Item -ItemType Junction -Path $linkedSource -Target $cc | Out-Null
Reject { & $deployment {param($s) New-McpCcDeploymentCandidate $s 'linked'} $linkedSource } 'CC_REPARSE_REJECTED'

# No hidden live commands in the operator/launcher entrypoints.
$launcher = [IO.File]::ReadAllText((Join-Path $source 'scripts\start-runtime-tray.ps1'))
Check ($launcher -notmatch '-AutoReconcile|-ReplaceExisting|Stop-Process') 'ordinary launcher only'
[pscustomobject]@{ok=$true;checks=$script:checks;fixture=$fixture;productionMutex=$false;liveActions=0;startupChanges=0} | ConvertTo-Json
