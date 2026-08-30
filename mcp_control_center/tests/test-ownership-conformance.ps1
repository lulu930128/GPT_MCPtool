Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("mcp-ownership-conformance-" + [Guid]::NewGuid().ToString('N'))
$utf8 = New-Object Text.UTF8Encoding($false)
$assertions = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
    $script:assertions++
}

$executable = (Get-Command powershell.exe -ErrorAction Stop).Source
$identity = 'fixture-role'
$cases = @(
    @{ id='project_reading'; module='project_reading\scripts\project-reading-runtime.psm1'; resolve='Resolve-PrRoleOwnership'; listener='Get-PrListenerState'; inspection='Get-PrProcessInspection'; role='tunnel'; context={ param($Root) [pscustomobject]@{ tunnelPidFile=Join-Path $Root 'runtime.pid'; tunnelOwnerFile=Join-Path $Root 'runtime.owner.json'; tunnelHealthPort=19101; tunnelClientPath=$executable; tunnelProfile=$identity } } },
    @{ id='omi_search'; module='OMI_search\scripts\omi-search-runtime.psm1'; resolve='Resolve-OmiRoleOwnership'; listener='Get-OmiListenerState'; inspection='Get-OmiProcessInspection'; role='tunnel'; context={ param($Root) [pscustomobject]@{ tunnelPidFile=Join-Path $Root 'runtime.pid'; tunnelOwnerFile=Join-Path $Root 'runtime.owner.json'; tunnelHealthPort=19102; tunnelClientPath=$executable; tunnelProfile=$identity } } },
    @{ id='japanese_study'; module='japanese_study\scripts\japanese-study-runtime.psm1'; resolve='Resolve-JsRoleOwnership'; listener='Get-JsListenerState'; inspection='Get-JsProcessInspection'; role='tunnel'; context={ param($Root) [pscustomobject]@{ tunnelPidFile=Join-Path $Root 'runtime.pid'; tunnelOwnerFile=Join-Path $Root 'runtime.owner.json'; tunnelHealthPort=19103; tunnelClientPath=$executable; tunnelIdentity=$identity } } },
    @{ id='personal_asset_os'; module='personal-asset-os\scripts\personal-asset-os-runtime.psm1'; resolve='Resolve-PaosRoleOwnership'; listener='Get-PaosListenerState'; inspection='Get-PaosProcessInspection'; role='tunnel'; context={ param($Root) [pscustomobject]@{ tunnelPidFile=Join-Path $Root 'runtime.pid'; tunnelOwnerFile=Join-Path $Root 'runtime.owner.json'; tunnelHealthPort=19104; tunnelClientPath=$executable; tunnelIdentity=$identity } } },
    @{ id='english_study'; module='english_study\scripts\component-runtime.psm1'; resolve='Get-EnglishStudyRoleState'; listener='Get-EnglishStudyListenerState'; inspection='Get-EnglishStudyProcessInspection'; role='tunnel'; context={ param($Root) [pscustomobject]@{ tunnelPidFile=Join-Path $Root 'runtime.pid'; tunnelOwnerFile=Join-Path $Root 'runtime.owner.json'; tunnelHealthPort=19105; tunnelClientPath=$executable; tunnelIdentity=$identity } } }
)

try {
    New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
    foreach ($case in $cases) {
        $caseRoot = Join-Path $testRoot $case.id
        New-Item -ItemType Directory -Force -Path $caseRoot | Out-Null
        $context = & $case.context $caseRoot
        $module = Import-Module (Join-Path $workspaceRoot $case.module) -Force -PassThru
        try {
            $invokeScenario = {
                param($Context,$Role,$ResolveFunction,$ListenerFunction,$InspectionFunction,$Mode,$FakeProcess)
                $script:ConformanceMode = $Mode
                $script:ConformanceFakeProcess = $FakeProcess
                Set-Item -Path ("Function:" + $ListenerFunction) -Value {
                    param([int]$Port)
                    if ($script:ConformanceMode -eq 'listener_unknown') { return [pscustomobject]@{ known=$false; pids=@(); errorCode='listener_query_failed'; error='LISTENER_QUERY_FAILED' } }
                    if ($script:ConformanceMode -eq 'multiple_listeners') { return [pscustomobject]@{ known=$true; pids=@(4111,4222); errorCode=$null; error=$null } }
                    return [pscustomobject]@{ known=$true; pids=@(); errorCode=$null; error=$null }
                }
                Set-Item -Path ("Function:" + $InspectionFunction) -Value {
                    param([int]$ProcessId)
                    if ($script:ConformanceMode -eq 'inspection_unknown') { return [pscustomobject]@{ state='Unknown'; process=$null } }
                    return [pscustomobject]@{ state='Present'; process=$script:ConformanceFakeProcess }
                }
                return & $ResolveFunction -Context $Context -Role $Role
            }

            $listenerUnknown = & $module $invokeScenario $context $case.role $case.resolve $case.listener $case.inspection 'listener_unknown' $null
            Assert-True ($listenerUnknown.state -eq 'OwnershipUnknown' -and -not $listenerUnknown.canMutate) "$($case.id) listener query unknown fails closed"

            $multipleListeners = & $module $invokeScenario $context $case.role $case.resolve $case.listener $case.inspection 'multiple_listeners' $null
            Assert-True ($multipleListeners.state -eq 'OwnershipMismatch' -and -not $multipleListeners.canMutate) "$($case.id) multiple listener owners are a positive mismatch"

            [IO.File]::WriteAllText($context.tunnelPidFile, '4123', $utf8)
            [IO.File]::WriteAllText($context.tunnelOwnerFile, '{', $utf8)
            $inspectionUnknown = & $module $invokeScenario $context $case.role $case.resolve $case.listener $case.inspection 'inspection_unknown' $null
            Assert-True ($inspectionUnknown.state -eq 'OwnershipUnknown' -and -not $inspectionUnknown.canMutate) "$($case.id) process inspection unknown preserves evidence"
            Assert-True ((Test-Path -LiteralPath $context.tunnelPidFile) -and (Test-Path -LiteralPath $context.tunnelOwnerFile)) "$($case.id) inspection unknown performs no cleanup"

            $fakeProcess = [pscustomobject]@{
                ProcessId=4123; ParentProcessId=1; Name='powershell'; ExecutablePath=$executable
                StartTimeUtc='2026-08-30T00:00:00.0000000Z'; CommandLine="$executable $identity"
            }
            $malformedOwner = & $module $invokeScenario $context $case.role $case.resolve $case.listener $case.inspection 'malformed_owner' $fakeProcess
            Assert-True ($malformedOwner.state -eq 'OwnershipUnknown' -and -not $malformedOwner.canMutate) "$($case.id) malformed owner metadata is unknown, not stopped"
            Assert-True ((Test-Path -LiteralPath $context.tunnelPidFile) -and (Test-Path -LiteralPath $context.tunnelOwnerFile)) "$($case.id) malformed owner metadata performs no cleanup"
        }
        finally { Remove-Module $module -Force -ErrorAction SilentlyContinue }
    }
    [pscustomobject]@{ ok=$true; components=$cases.Count; assertions=$assertions } | ConvertTo-Json -Depth 3
}
finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
