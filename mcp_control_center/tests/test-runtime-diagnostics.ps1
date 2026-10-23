Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'EXPECTED_WINDOWS_POWERSHELL_5_1' }
$root=Split-Path -Parent $PSScriptRoot
$source=Get-Content -LiteralPath (Join-Path $root 'src\WorkspaceLocal.Native.cs') -Raw -Encoding UTF8
$fixture=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'WorkspaceLocal.Check.cs') -Raw -Encoding UTF8
Add-Type -TypeDefinition ($source+"`n"+$fixture) -ReferencedAssemblies System.Web.Extensions,System.Core
Import-Module (Join-Path $root 'src\McpControlCenter.WorkspaceLocal.psm1') -Force
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'src\McpControlCenter.Core.psm1'),[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'CORE_PARSE_FAILED' }
# Load pure function bodies only; all probe IO below is mocked, no module bootstrap.
foreach ($name in @('Get-McpCcObjectProperty','Get-McpCcNestedProperty','Test-McpCcValueEqual','Test-McpCcOperationalSummaryValue','Get-McpCcProbeResult')) {
    $node=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
    . ([scriptblock]::Create($node.Extent.Text))
}
$script:checks=0;$script:httpCalls=0
function Check([bool]$Value,[string]$Message) { if (-not $Value) { throw "CHECK_FAILED: $Message" };$script:checks++ }
function Invoke-WebRequest { param([switch]$UseBasicParsing,$Uri,$TimeoutSec) $script:httpCalls++;return [pscustomobject]@{StatusCode=200;Content=$script:mockBody} }
function Test-McpCcPortAgainstPolicy { param($Port,$HostName,$Policy) return [pscustomobject]@{known=$false;safe=$false} }
function Get-McpCcPortOwner { param($Port,$ExpectedCommandFragments,$ManagedPidPath,$ManagedExpectedCommandFragments,$ScanContext) return [pscustomobject]@{known=$true;pid=123;matchesExpected=$true} }
$descriptor=Get-Content -Raw -Encoding UTF8 (Join-Path $root '..\codex_bridge\control-center\component.json') | ConvertFrom-Json
Check (($descriptor.probes[0].publicSummaryFields -join ',') -ceq 'service,version,buildId,jobs.active,jobs.awaitingApproval,jobs.scope,controller') 'exact descriptor opt-in'
$safe=$ast.Find({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$script:SafeSummaryFields'},$true)
. ([scriptblock]::Create($safe.Extent.Text))
foreach ($field in @('jobs.active','jobs.awaitingApproval','jobs.scope','controller')) { Check ($field -cin $script:SafeSummaryFields) 'allowed operational field' }
$probe=[pscustomobject]@{id='mcp';label='fixture';role='core';required=$true;kind='json';url='http://127.0.0.1:18828/health';port=18828;
    expected=[pscustomobject]@{ok=$true;service='codex-handoff-bridge'};summaryFields=$descriptor.probes[0].publicSummaryFields}
$owner=[pscustomobject]@{sample=$null}
$owner | Add-Member ScriptMethod Publish { param($sample) $this.sample=$sample }
function Publish-Fixture($ProbeResult) {
    $at=[DateTimeOffset]::UtcNow.ToString('o')
    $components=@(foreach ($id in [McpCc.WorkspaceLocal.Contract]::Ids) {
        [pscustomobject]@{id=$id;status='Ready';localStatus='Ready';readinessScope='local';checkedAt=$at;issues=@();capabilities=@('reload_runtime');probes=@(if($id -ceq 'codex_bridge'){$ProbeResult})}
    })
    Publish-McpCcWorkspaceLocalState -Owner $owner -State ([pscustomobject]@{components=$components})
    Check ($null -ne $owner.sample) 'publisher sample'
    return ([McpCc.WorkspaceLocal.Fixture]::Diagnostics($owner.sample,'codex_bridge') | ConvertFrom-Json)
}
function Probe-Fixture($Payload) {
    $script:mockBody=$Payload | ConvertTo-Json -Depth 8 -Compress
    return Get-McpCcProbeResult -Probe $probe -TimeoutSeconds 1 -TcpPortTester {param($Port) return $true}
}
$payload=[pscustomobject]@{ok=$true;service='codex-handoff-bridge';buildId='abcd1234';controller='ready';jobs=[pscustomobject]@{scope='all';active=1;awaitingApproval=0};secret='must-not-leak'}
$r=Publish-Fixture (Probe-Fixture $payload)
Check ($r.detail.status -ceq 'Ready' -and $r.detail.probes[0].activeJobs -eq 1 -and $r.detail.probes[0].pendingApproval -eq 0) 'Ready and active preserved'
Check ($r.detail.probes[0].controller -ceq 'ready') 'known provider controller'
Check ($r.detail.observedAt -ceq $r.observedAt) 'timestamp preserved'
Check (-not (($r | ConvertTo-Json -Depth 10).Contains('must-not-leak'))) 'no raw payload'
$before=$script:httpCalls
$null=[McpCc.WorkspaceLocal.Fixture]::Diagnostics($owner.sample,'codex_bridge')
Check ($before -eq $script:httpCalls) 'IPC reply has no provider calls'
$legacy=[McpCc.WorkspaceLocal.Fixture]::Status($owner.sample) | ConvertFrom-Json
Check ($legacy.components.Count -eq 7 -and @($legacy.components[0].PSObject.Properties).Count -eq 4) 'legacy row unchanged'
foreach ($invalid in @(-1,1.5,'1',$true,$null,[long]2147483648)) {
    $payload.jobs.active=$invalid
    $r=Publish-Fixture (Probe-Fixture $payload)
    Check ($null -eq $r.detail.probes[0].activeJobs -and $null -eq $r.detail.probes[0].pendingApproval) 'invalid count unknown'
}
$payload.jobs.active=0;$payload.jobs.awaitingApproval=0
foreach ($invalid in @('recent','ALL',$null,[pscustomobject]@{scope='all'})) {
    $payload.jobs.scope=$invalid;$r=Publish-Fixture (Probe-Fixture $payload)
    Check ($null -eq $r.detail.probes[0].activeJobs) 'scope must be all'
}
$payload.jobs.scope='all'
foreach ($invalid in @('READY','private-token',[pscustomobject]@{token='secret'},$null)) {
    $payload.controller=$invalid;$r=Publish-Fixture (Probe-Fixture $payload)
    Check ($null -eq $r.detail.probes[0].controller) 'invalid controller unknown'
}
$payload.controller='ready';$payload.buildId='private/path';$r=Publish-Fixture (Probe-Fixture $payload)
Check ($null -eq $r.detail.probes[0].runtimeBuildId) 'unsafe build stripped'
$payload.ok=$false;$r=Publish-Fixture (Probe-Fixture $payload)
Check ($r.detail.probes[0].success -eq $false -and $null -eq $r.detail.probes[0].activeJobs -and $null -eq $r.detail.probes[0].controller) 'failed health never promotes summary'
# Immutability, staleness, reset and old snapshots without enrichment.
$rows=@(foreach($id in [McpCc.WorkspaceLocal.Contract]::Ids){[McpCc.WorkspaceLocal.Row]@{componentId=$id;status='Ready';observedAt=[DateTimeOffset]::UtcNow.AddMinutes(-2).ToString('o');capabilities=@()}})
$old=[McpCc.WorkspaceLocal.Snapshot]::new([McpCc.WorkspaceLocal.Row[]]$rows)
Check (([McpCc.WorkspaceLocal.Fixture]::Diagnostics($old,'codex_bridge') | ConvertFrom-Json).code -ceq 'SNAPSHOT_STALE') 'stale response'
foreach($row in $rows){$row.observedAt=[DateTimeOffset]::UtcNow.ToString('o')}
$old=[McpCc.WorkspaceLocal.Snapshot]::new([McpCc.WorkspaceLocal.Row[]]$rows)
Check (([McpCc.WorkspaceLocal.Fixture]::Diagnostics($old,'codex_bridge') | ConvertFrom-Json).code -ceq 'SNAPSHOT_UNAVAILABLE') 'old snapshot enrichment absent'
$p=[McpCc.WorkspaceLocal.ProbeDetail]@{role='core';success=$true;tcpOpen=$true;ownerKnown=$true;pid=123;matchesExpected=$true;runtimeBuildId='abcd1234';activeJobs=1;pendingApproval=0;controller='ready'}
$d=[McpCc.WorkspaceLocal.Detail]@{componentId='codex_bridge';status='Ready';localStatus='Ready';observedAt=$rows[0].observedAt;readinessScope='local';probes=@($p)}
$snapshot=[McpCc.WorkspaceLocal.Snapshot]::new([McpCc.WorkspaceLocal.Row[]]$rows,[McpCc.WorkspaceLocal.Detail[]]@($d))
Check (([McpCc.WorkspaceLocal.Fixture]::Status($old)) -ceq ([McpCc.WorkspaceLocal.Fixture]::Status($snapshot))) 'legacy serialized bytes unchanged'
$p.activeJobs=999;$d.localStatus='Stopped';$rows[0].status='Stopped'
$r=[McpCc.WorkspaceLocal.Fixture]::Diagnostics($snapshot,'codex_bridge') | ConvertFrom-Json
Check ($r.detail.probes[0].activeJobs -eq 1 -and $r.detail.localStatus -ceq 'Ready' -and $r.detail.status -ceq 'Ready') 'immutable snapshot copy'
$rows[0].status='Ready';$d.localStatus='Ready';$d.probes=[McpCc.WorkspaceLocal.ProbeDetail[]]@($p,$p,$p,$p,$p,$p,$p,$p)
$snapshot=[McpCc.WorkspaceLocal.Snapshot]::new([McpCc.WorkspaceLocal.Row[]]$rows,[McpCc.WorkspaceLocal.Detail[]]@($d))
Check ([Text.Encoding]::UTF8.GetByteCount([McpCc.WorkspaceLocal.Fixture]::Diagnostics($snapshot,'codex_bridge')) -lt 16384) 'bounded maximum probe response'
$d.probes=[McpCc.WorkspaceLocal.ProbeDetail[]]@($p,$p,$p,$p,$p,$p,$p,$p,$p)
$rejected=$false
try {$null=[McpCc.WorkspaceLocal.Snapshot]::new([McpCc.WorkspaceLocal.Row[]]$rows,[McpCc.WorkspaceLocal.Detail[]]@($d))} catch {$rejected=$true}
Check $rejected 'oversize native enrichment rejected'
Publish-McpCcWorkspaceLocalState -Owner $owner -State $null
Check ($null -eq $owner.sample) 'reset clears snapshot'
[pscustomobject]@{ok=$true;checks=$script:checks;httpCalls=$script:httpCalls;evidence='MOCK_HEALTH_TO_REAL_PUBLISHER_NATIVE_SNAPSHOT';liveProbe=$false;liveRestart=$false} | ConvertTo-Json -Compress
