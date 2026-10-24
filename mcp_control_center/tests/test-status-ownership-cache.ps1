Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\src\McpControlCenter.Core.psm1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'CORE_PARSE_FAILED' }
# Load function bodies only: no module bootstrap, real manifest, runtime or HTTP.
foreach ($node in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($node.Extent.Text))
}
$script:checks = 0
function Check([bool]$Value, [string]$Message) {
    if (-not $Value) { throw "CHECK_FAILED: $Message" }; $script:checks++
}
function Reset-Fixture {
    $script:tcpCalls = 0; $script:cimCalls = 0; $script:identityCalls = 0; $script:httpCalls = 0
    $script:changeListeners = $false; $script:changeIdentity = $false; $script:denyCim = $false; $script:denyIdentity = $false
    $script:failHttp = $false; $script:policyCalls = 0; $script:pidText = '100'
    $script:denyListeners = $false; $script:denyNetstat = $false; $script:netstatCalls = 0
    $script:listenerDelayMs = 0; $script:cimDelayMs = 0; $script:httpDelayMs = 0
    $script:rows = @([pscustomobject]@{ LocalPort = 18100; OwningProcess = 300 })
    $script:processes = @{}
    $script:generations = @{}
    foreach ($id in @(100, 200, 300)) {
        $created = [datetime]'2026-01-01T00:00:00Z'
        $created = $created.AddSeconds($id)
        $script:processes[$id] = [pscustomobject]@{ ProcessId = $id; ParentProcessId = ($id - 100); CreationDate = $created; Name = 'fixture.exe'; CommandLine = "fixture-$id" }
        $script:generations[$id] = $created.ToUniversalTime().Ticks
    }
}
function Get-NetTCPConnection {
    param($State, $LocalPort, $ErrorAction)
    $script:tcpCalls++
    if ($script:listenerDelayMs) { [Threading.Thread]::Sleep($script:listenerDelayMs) }
    if ($script:denyListeners) { throw 'FIXTURE_LISTENERS_UNAVAILABLE' }
    if ($script:changeIdentity -and $script:tcpCalls -gt 1) { $script:generations[300] += 10000000 }
    if ($script:changeListeners -and $script:tcpCalls -gt 1) { return @() }
    if ($null -ne $LocalPort) { return @($script:rows | Where-Object { $_.LocalPort -eq $LocalPort }) }
    return $script:rows
}
function Get-McpCcNetstatListeners {
    $script:netstatCalls++
    if ($script:denyNetstat) { throw 'FIXTURE_NETSTAT_UNAVAILABLE' }
    return @(foreach ($row in $script:rows) {
        "  TCP    127.0.0.1:$($row.LocalPort)    0.0.0.0:0    LISTENING    $($row.OwningProcess)"
        "  TCP    [::1]:$($row.LocalPort)    [::]:0    LISTENING    $($row.OwningProcess)"
    })
}
function Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    $script:cimCalls++
    if ($script:cimDelayMs) { [Threading.Thread]::Sleep($script:cimDelayMs) }
    if ($script:denyCim) { throw [UnauthorizedAccessException]::new('FIXTURE_CIM_ACCESS_DENIED') }
    $id = [int]($Filter -replace 'ProcessId=', '')
    return $script:processes[$id]
}
function Get-Process {
    param($Id, $ErrorAction)
    $script:identityCalls++
    if ($script:denyIdentity) { throw [UnauthorizedAccessException]::new('FIXTURE_START_TIME_ACCESS_DENIED') }
    if (-not $script:generations.ContainsKey([int]$Id)) { throw 'FIXTURE_PROCESS_MISSING' }
    $result = [pscustomobject]@{ StartTime = [datetime]::new($script:generations[[int]$Id], [DateTimeKind]::Utc) }
    $result | Add-Member ScriptMethod Dispose { }
    return $result
}
function Test-Path { param($LiteralPath, $PathType) return $true }
function Get-Content { param($LiteralPath, $Encoding, [switch]$Raw) return $script:pidText }
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, $Uri, $TimeoutSec)
    $script:httpCalls++
    if ($script:httpDelayMs) { [Threading.Thread]::Sleep($script:httpDelayMs) }
    if ($script:failHttp) { throw 'FIXTURE_HTTP_FAILURE' }
    return [pscustomobject]@{ StatusCode = 200; Content = 'ok' }
}
function Test-McpCcTcpPort { param($Port) return $true }
function Get-McpCcWindowsTcpPortPolicy { $script:policyCalls++; return $null }
function Get-McpCcComponentActionBinding { param($Component, $Action) return @{ actionSpec = @{ path = 'fixture.ps1' } } }
function Resolve-McpCcChildPath { param($Root, $RelativePath, $Label) return 'fixture.ps1' }
function Read-McpCcRemoteEvidenceFile { param($Component, $NowUtc) return $null }

$probe = [pscustomobject]@{
    id = 'fixture'; label = 'fixture'; role = 'connectivity'; required = $true
    url = 'http://127.0.0.1:18100/readyz'; port = 18100; kind = 'text'; expectedText = @('ok'); summaryFields = @()
    ownerCommandContains = @('fixture-300'); resolvedOwnerManagedPidFile = 'fixture.pid'; ownerManagedCommandContains = @('fixture-100')
}
$component = [pscustomobject]@{
    id = 'fixture'; displayName = 'fixture'; resolvedRoot = 'fixture-root'; runtimeMode = 'component-controller'
    capabilities = @(); autoStart = $false; startupOrder = 1; probes = @($probe)
}
$manifest = [pscustomobject]@{ components = @($component); settings = @{ probeTimeoutSeconds = 2 } }
# Exercise production probe/classification with fixed OS evidence, never live processes.
# Project Reading has direct command ownership; the existing fixture also covers managed lineage.
$projectProbe = [pscustomobject]@{
    id = 'core'; label = 'core'; role = 'core'; required = $true
    url = 'http://127.0.0.1:18100/readyz'; port = 18100; kind = 'text'; expectedText = @('ok'); summaryFields = @()
    ownerCommandContains = @('project_reading', 'dist\src\http-main.js')
    resolvedOwnerManagedPidFile = $null; ownerManagedCommandContains = @()
}
$tunnelProbe = [pscustomobject]@{
    id = 'tunnel'; label = 'tunnel'; role = 'connectivity'; required = $true
    url = 'http://127.0.0.1:18101/readyz'; port = 18101; kind = 'text'; expectedText = @('ok'); summaryFields = @()
    ownerCommandContains = @('fixture-200'); resolvedOwnerManagedPidFile = $null; ownerManagedCommandContains = @()
}
foreach ($fallback in @($false, $true)) {
    foreach ($case in @('null', 'empty', 'whitespace', 'foreign', 'matching', 'cimDenied', 'generationDenied', 'noCreation')) {
        Reset-Fixture
        $script:denyListeners = $fallback
        $script:rows += [pscustomobject]@{ LocalPort = 18101; OwningProcess = 200 }
        $script:processes[300].CommandLine = 'node.exe C:\fixture\project_reading\dist\src\http-main.js'
        switch ($case) {
            'null' { $script:processes[300].CommandLine = $null }
            'empty' { $script:processes[300].CommandLine = '' }
            'whitespace' { $script:processes[300].CommandLine = '  ' }
            'foreign' { $script:processes[300].CommandLine = 'node.exe C:\fixture\foreign\dist\src\http-main.js' }
            'cimDenied' { $script:denyCim = $true }
            'generationDenied' { $script:denyIdentity = $true }
            'noCreation' { $script:processes[300].CreationDate = $null }
        }
        $expected = if ($case -eq 'matching') { 'Ready' } elseif ($case -eq 'foreign') { 'OwnershipMismatch' } else { 'OwnershipUnknown' }
        $component.probes = @($projectProbe, $tunnelProbe)
        # Direct callers do not have the generation check; test their evidence separately.
        if (-not $fallback -and $case -notin @('generationDenied', 'noCreation')) {
            $directStatus = Get-McpCcComponentStatus -Component $component -TimeoutSeconds 2
            Check ($directStatus.status -eq $expected -and $directStatus.localStatus -eq $expected) "$case direct component classification agrees with scan classification"
            Check ((Get-McpCcRestartMcpDecision -ComponentStatus $directStatus).allowed -eq ($expected -eq 'Ready')) "$case direct component restart stays fail closed"
            $direct = Get-McpCcProbeResult -Probe $projectProbe -TimeoutSeconds 2
            Check ($direct.owner.known -and $direct.owner.pid -eq 300) "$case direct probe retains listener PID evidence"
            if ($expected -eq 'OwnershipUnknown') {
                Check ($null -eq $direct.owner.matchesExpected -and $direct.owner.relation -eq 'Unknown') "$case direct probe preserves unknown command identity"
            } else {
                Check ($direct.owner.matchesExpected -eq ($expected -eq 'Ready')) "$case direct probe distinguishes foreign from owned"
            }
        }
        $state = Get-McpCcSystemState -Manifest $manifest -BootId 'fixture'
        $observed = $state.components[0]
        Check ($observed.status -eq $expected -and $observed.localStatus -eq $expected) "$case fallback=$fallback preserves three-state ownership classification"
        Check ($observed.probes[0].owner.known -and $observed.probes[0].owner.pid -eq 300) "$case scan retains PID without claiming identity"
        if ($expected -eq 'OwnershipUnknown') {
            Check ($null -eq $observed.probes[0].owner.matchesExpected -and $state.overall -eq 'Failed' -and $observed.readinessScope -eq 'none') "$case cannot publish readiness"
        }
        $decision = Get-McpCcRestartMcpDecision -ComponentStatus $observed
        Check ($decision.allowed -eq ($expected -eq 'Ready')) "$case restart decision stays fail closed"
        if ($expected -ne 'Ready') { Check ($null -eq $decision.action) "$case exposes no restart action" }
        if ($case -in @('null', 'empty', 'whitespace', 'foreign', 'matching')) {
            Check ($observed.probes[1].owner.matchesExpected -eq $true) "$case leaves matching tunnel ownership intact"
        }
        if ($fallback) { Check ($state.timing.ownership.netstatFallbacks -eq 2) "$case uses bounded listener fallback" }
    }
}
foreach ($missingCommand in @($null, '', '  ')) {
    foreach ($useScan in @($false, $true)) {
        Reset-Fixture
        $script:processes[100].CommandLine = $missingCommand
        $scan = if ($useScan) { New-McpCcOwnershipScan } else { $null }
        $owner = Get-McpCcPortOwner -Port 18100 -ExpectedCommandFragments @('fixture-300') -ManagedPidPath 'fixture.pid' -ManagedExpectedCommandFragments @('fixture-100') -ScanContext $scan
        Check ($owner.known -and $owner.pid -eq 300 -and $owner.managedPid -eq 100 -and $null -eq $owner.matchesExpected -and $owner.relation -eq 'Unknown') 'missing managed command cannot become a mismatch or positive lineage proof'
    }
}
$component.probes = @($probe)
Reset-Fixture
$component.probes = @(1..22 | ForEach-Object { $probe })
$state = Get-McpCcSystemState -Manifest $manifest -BootId 'fixture'
Check ($state.components[0].issues.Count -eq 0) 'fixture component status succeeds'
Check ($state.components[0].status -eq 'Ready') 'classification contract is unchanged'
Check (@($state.components[0].probes | Where-Object { $_.owner.matchesExpected -eq $true }).Count -eq 22) 'all duplicate-port probes retain proven lineage'
Check ($script:tcpCalls -eq 2 -and $script:cimCalls -eq 3 -and $script:httpCalls -eq 22 -and $script:policyCalls -eq 1) '22 probes use two listener samples, three CIM records, one policy sample'
Check ($state.timing.ownership.processCacheHits -gt 20 -and $state.timing.ownership.listenerQueries -eq 2) 'cache metrics count actual work'
Check ($state.components[0].probes[0].timing.httpMs -le $state.components[0].probes[0].elapsedMs) 'legacy elapsed retains HTTP plus preflight/parse scope'
Check ($state.timing.ownershipValidationMs -ge 0 -and $state.timing.portPolicyMs -ge 0) 'scan timing fields exist'
$firstMetrics = $state.timing
$null = Get-McpCcSystemState -Manifest $manifest -BootId 'fixture'
Check ($script:tcpCalls -eq 4 -and $script:cimCalls -eq 6) 'next scan resamples all OS ownership data'
$script:rows[0].OwningProcess = 200
$state = Get-McpCcSystemState -Manifest $manifest -BootId 'fixture'
Check ($state.components[0].status -eq 'OwnershipMismatch') 'changed owner cannot inherit previous scan proof'

Reset-Fixture
$script:changeListeners = $true
$state = Get-McpCcSystemState -Manifest $manifest -BootId 'fixture'
Check (@($state.components[0].probes | Where-Object { $_.owner.matchesExpected -eq $true }).Count -eq 0) 'listener disappearing during scan withdraws all positive proofs'
Check ($state.components[0].status -eq 'OwnershipUnknown' -and $state.components[0].localStatus -eq 'OwnershipUnknown' -and $state.overall -eq 'Failed') 'final listener change overrides component and aggregate Ready'
Check ($state.components[0].readinessScope -eq 'none' -and $state.components[0].connectivity.localTunnel.status -eq 'Unknown') 'final listener change withdraws connectivity/readiness claims'
Reset-Fixture
$script:changeIdentity = $true
$state = Get-McpCcSystemState -Manifest $manifest -BootId 'fixture'
Check ($state.overall -eq 'Failed' -and $state.components[0].status -eq 'OwnershipUnknown' -and $state.components[0].localStatus -eq 'OwnershipUnknown') 'identity change after last probe also invalidates aggregate output'
Check ($state.components[0].readinessScope -eq 'none' -and $state.components[0].connectivity.localTunnel.status -eq 'Unknown') 'identity change cannot publish stale readiness'
Reset-Fixture
$script:rows = @()
$state = Get-McpCcSystemState -Manifest $manifest -BootId 'fixture'
Check ($null -eq $state.components[0].probes[0].owner.matchesExpected -and $script:cimCalls -eq 0) 'missing listener stays unknown despite HTTP success'
Check ($state.overall -eq 'Failed' -and $state.components[0].status -eq 'OwnershipUnknown') 'unknown ownership never publishes Ready'
Reset-Fixture
$script:rows += [pscustomobject]@{ LocalPort = 18100; OwningProcess = 200 }
$state = Get-McpCcSystemState -Manifest $manifest -BootId 'fixture'
Check ($null -eq $state.components[0].probes[0].owner.matchesExpected) 'multiple owners on the same port are ambiguous'
Reset-Fixture
$script:denyListeners = $true
$state = Get-McpCcSystemState -Manifest $manifest -BootId 'fixture'
Check ($state.overall -eq 'Ready' -and $script:netstatCalls -eq 2 -and $state.timing.ownership.netstatFallbacks -eq 2) 'netstat fallback is bounded to the same two scan samples'
$script:denyNetstat = $true
$state = Get-McpCcSystemState -Manifest $manifest -BootId 'fixture'
Check ($state.overall -eq 'Failed' -and $state.components[0].status -eq 'OwnershipUnknown' -and $script:netstatCalls -eq 4) 'failed OS snapshots fail closed without per-probe retry'

foreach ($case in @('cim', 'identity', 'missing', 'pidfile', 'mismatch', 'cycle', 'newParent', 'noCreation')) {
    Reset-Fixture
    switch ($case) {
        'cim' { $script:denyCim = $true }
        'identity' { $script:denyIdentity = $true }
        'missing' { $script:processes.Remove(300) }
        'pidfile' { $script:pidText = 'invalid' }
        'mismatch' { $script:processes[100].CommandLine = 'unrelated' }
        'cycle' { $script:processes[200].ParentProcessId = 300 }
        'newParent' { $script:processes[100].CreationDate = $script:processes[300].CreationDate.AddDays(1); $script:generations[100] = $script:processes[100].CreationDate.ToUniversalTime().Ticks }
        'noCreation' { $script:processes[300].CreationDate = $null }
    }
    $scan = New-McpCcOwnershipScan
    $owner = Get-McpCcPortOwner -Port 18100 -ExpectedCommandFragments @('fixture-300') -ManagedPidPath 'fixture.pid' -ManagedExpectedCommandFragments @('fixture-100') -ScanContext $scan
    Check ($owner.matchesExpected -ne $true) "$case fails closed"
}
Reset-Fixture
$scan = New-McpCcOwnershipScan
$first = Get-McpCcPortOwner -Port 18100 -ExpectedCommandFragments @('fixture-300') -ScanContext $scan
$script:generations[300] += 10000000
$second = Get-McpCcPortOwner -Port 18100 -ExpectedCommandFragments @('fixture-300') -ScanContext $scan
Check ($first.matchesExpected -eq $true -and $null -eq $second.matchesExpected) 'PID reuse within scan cannot reuse cached command identity'
$sample = [pscustomobject]@{ probes = @([pscustomobject]@{ port = 18100; owner = $first; tcpOpen = $true; ownershipRequired = $true }); localStatus = 'Ready'; status = 'Ready'; readinessScope = 'local'; connectivity = @{ localTunnel = @{ status = 'Ready'; errorCode = $null } }; issues = @() }
Complete-McpCcOwnershipScan -ScanContext $scan -Components @($sample)
Check ($null -eq $first.matchesExpected -and $scan.closed -and $scan.processes.Count -eq 0) 'final generation check withdraws earlier proof and discards scan data'
Check ((Get-McpCcPortOwner -Port 18100 -ExpectedCommandFragments @('fixture-300') -ScanContext $scan).matchesExpected -ne $true) 'closed context cannot be reused'
Reset-Fixture
$scan = New-McpCcOwnershipScan
$scan.clock = [pscustomobject]@{ Elapsed = [timespan]::FromSeconds(121) }
Check ((Get-McpCcPortOwner -Port 18100 -ExpectedCommandFragments @('fixture-300') -ScanContext $scan).matchesExpected -ne $true) 'expired context is rejected'

Reset-Fixture
$direct = Get-McpCcPortOwner -Port 18100 -ExpectedCommandFragments @('fixture-300') -ManagedPidPath 'fixture.pid' -ManagedExpectedCommandFragments @('fixture-100')
Check ($direct.matchesExpected -eq $true) 'old direct caller signature still works'
$lineage = Get-McpCcProcessLineage -ProcessId 300 -ExpectedAncestorProcessId 100 -ProcessLookup { param($id) $script:processes[$id] }
Check ($lineage.known -and $lineage.matches -and $lineage.depth -eq 2) 'legacy ProcessLookup injection still works'
$script:processes[200].ParentProcessId = 300
Check (-not (Get-McpCcProcessLineage -ProcessId 300 -ExpectedAncestorProcessId 100 -ProcessLookup { param($id) $script:processes[$id] }).matches) 'legacy lineage cycles remain rejected'
Reset-Fixture
$script:failHttp = $true
$result = Get-McpCcProbeResult -Probe $probe -TimeoutSeconds 2 -TcpPortTester { param($port) $false }
Check (-not $result.tcpOpen -and $script:tcpCalls -eq 0 -and $result.timing.tcpMs -ge 0) 'failed HTTP and injected closed TCP skip owner lookup'
$null = Get-McpCcSystemState -Manifest $manifest -BootId 'fixture' -StatusProvider { param($c, $timeout) [pscustomobject]@{ status = 'Ready' } }
Check ($script:tcpCalls -eq 0 -and $script:policyCalls -eq 0) 'StatusProvider retains two arguments and bypasses OS sampling'
Reset-Fixture
$script:listenerDelayMs = 20; $script:cimDelayMs = 10; $script:httpDelayMs = 25; $script:failHttp = $true
$scan = New-McpCcOwnershipScan
$timed = Get-McpCcProbeResult -Probe $probe -TimeoutSeconds 2 -ScanContext $scan -TcpPortTester { param($port) [Threading.Thread]::Sleep(15); return $true }
Check ($timed.timing.httpMs -ge 25 -and $timed.timing.tcpMs -ge 15 -and $timed.timing.ownerMs -ge 50) 'independent fixture delays are attributed to HTTP, TCP and owner phases'
Check ($scan.metrics.listenerMs -ge 20 -and $scan.metrics.processMs -ge 30) 'nested OS metrics measure the listener and CIM portions'
Check ($timed.elapsedMs -lt ($timed.timing.httpMs + $timed.timing.tcpMs + $timed.timing.ownerMs)) 'legacy elapsed excludes subsequent TCP/owner work'
[pscustomobject]@{ ok = $true; checks = $script:checks; fixtureOnly = $true; probes = 22; listenerQueries = 2; cimQueries = 3; timing = $firstMetrics } | ConvertTo-Json -Depth 5 -Compress
