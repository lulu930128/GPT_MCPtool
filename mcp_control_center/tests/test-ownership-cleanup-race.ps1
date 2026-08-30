Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("mcp-ownership-cleanup-race-" + [Guid]::NewGuid().ToString('N'))
$utf8 = New-Object Text.UTF8Encoding($false)
$assertions = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
    $script:assertions++
}

$cases = @(
    @{ id='project_reading'; module='project_reading\scripts\project-reading-runtime.psm1'; read='Read-PrRuntimeFileSnapshot'; remove='Remove-PrStaleOwnershipPair' },
    @{ id='omi_search'; module='OMI_search\scripts\omi-search-runtime.psm1'; read='Read-OmiRuntimeFileSnapshot'; remove='Remove-OmiStaleOwnershipPair' },
    @{ id='japanese_study'; module='japanese_study\scripts\japanese-study-runtime.psm1'; read='Read-JsRuntimeFileSnapshot'; remove='Remove-JsStaleOwnershipPair' },
    @{ id='personal_asset_os'; module='personal-asset-os\scripts\personal-asset-os-runtime.psm1'; read='Read-PaosRuntimeFileSnapshot'; remove='Remove-PaosStaleOwnershipPair' },
    @{ id='english_study'; module='english_study\scripts\component-runtime.psm1'; read='Read-EnglishStudyRuntimeFileSnapshot'; remove='Remove-EnglishStudyOwnershipPair' }
)

try {
    New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
    foreach ($case in $cases) {
        $caseRoot = Join-Path $testRoot $case.id
        New-Item -ItemType Directory -Force -Path $caseRoot | Out-Null
        $definition = [pscustomobject]@{ pidFile=Join-Path $caseRoot 'runtime.pid'; ownerFile=Join-Path $caseRoot 'runtime.owner.json' }
        [IO.File]::WriteAllText($definition.pidFile, '111', $utf8)
        [IO.File]::WriteAllText($definition.ownerFile, '{"instance":"old"}', $utf8)
        $module = Import-Module (Join-Path $workspaceRoot $case.module) -Force -PassThru
        try {
            $snapshots = & $module {
                param($Definition,$ReadFunction)
                [pscustomobject]@{
                    pid = & $ReadFunction -Path $Definition.pidFile
                    owner = & $ReadFunction -Path $Definition.ownerFile
                }
            } $definition $case.read
            [IO.File]::WriteAllText($definition.ownerFile, '{"instance":"new"}', $utf8)
            $removedChangedPair = & $module {
                param($Definition,$PidSnapshot,$OwnerSnapshot,$RemoveFunction)
                & $RemoveFunction -Definition $Definition -PidSnapshot $PidSnapshot -OwnerSnapshot $OwnerSnapshot
            } $definition $snapshots.pid $snapshots.owner $case.remove
            Assert-True (-not $removedChangedPair) "$($case.id) rejects cleanup after owner evidence changes"
            Assert-True (Test-Path -LiteralPath $definition.pidFile -PathType Leaf) "$($case.id) preserves PID when owner changes"
            Assert-True (([IO.File]::ReadAllText($definition.ownerFile)) -ceq '{"instance":"new"}') "$($case.id) preserves new owner evidence"

            $currentSnapshots = & $module {
                param($Definition,$ReadFunction)
                [pscustomobject]@{
                    pid = & $ReadFunction -Path $Definition.pidFile
                    owner = & $ReadFunction -Path $Definition.ownerFile
                }
            } $definition $case.read
            $removedCurrentPair = & $module {
                param($Definition,$PidSnapshot,$OwnerSnapshot,$RemoveFunction)
                & $RemoveFunction -Definition $Definition -PidSnapshot $PidSnapshot -OwnerSnapshot $OwnerSnapshot
            } $definition $currentSnapshots.pid $currentSnapshots.owner $case.remove
            Assert-True $removedCurrentPair "$($case.id) removes an unchanged stale pair"
            Assert-True (-not (Test-Path -LiteralPath $definition.pidFile)) "$($case.id) removes unchanged stale PID"
            Assert-True (-not (Test-Path -LiteralPath $definition.ownerFile)) "$($case.id) removes unchanged stale owner"
        }
        finally { Remove-Module $module -Force -ErrorAction SilentlyContinue }
    }
    [pscustomobject]@{ ok=$true; components=$cases.Count; assertions=$assertions } | ConvertTo-Json -Depth 3
}
finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
