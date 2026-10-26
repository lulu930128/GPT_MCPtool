Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
# Reuse the established isolated upgrade fixture, including its v5/clean-v6 cases.
. (Join-Path $PSScriptRoot 'test-installed-upgrade.ps1') | Out-Null
$operatorCodePath=Join-Path $workspace 'codex_bridge\scripts\installed-release-operator.ps1'
foreach($name in @('Get-SelectedV6History','Get-VerifiedSelectedV6Attestation',
    'New-SelectedV6Attestation','Assert-RecoveryBoundSuccessor')){
    $nodes=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
    Check ($nodes.Count -eq 1) ('Unique function '+$name)
    . ([scriptblock]::Create($nodes[0].Extent.Text))
}
& $verifier {
    $script:deny=$false
    function script:Assert-McpCcInstalledFields($Value,[string[]]$Names){
        $actual=@($Value.PSObject.Properties.Name)
        if($actual.Count -ne $Names.Count -or @($actual|Where-Object{$_ -cnotin $Names}).Count){throw 'FIXTURE_FIELDS_REJECTED'}
    }
    function script:Assert-McpCcInstalledPrivatePath {param($p,$s,[switch]$IntegrityOnly) if($script:deny){throw 'ACL_DENIED'}}
}
function Copy-Json($Value){$Value|ConvertTo-Json -Depth 12|ConvertFrom-Json}
function Hash([string]$Path){(Get-FileHash -LiteralPath $Path).Hash.ToLowerInvariant()}
function Save-Audit($Value){
    $bytes=$utf8.GetBytes(($Value|ConvertTo-Json -Depth 12))
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$pin=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
    [IO.File]::WriteAllBytes((Join-Path $oldRuntime ('selected-v6-attestation-'+$pin+'.json')),$bytes)
    return $pin
}
function Audit-Path([string]$Pin){Join-Path $oldRuntime ('selected-v6-attestation-'+$Pin+'.json')}
$previous.cutover.rollbackBuildId='1234567890abcdef'
Put (Join-Path $oldRuntime 'legacy-startup.lnk') @{fixture='original rollback selector'}
$previous.cutover.legacyStartupSha256=Hash (Join-Path $oldRuntime 'legacy-startup.lnk')
$original=[ordered]@{contract='mcpcc-installed-cutover-v1';phase='UNKNOWN';lastPhase='SELECTED';releaseId='old';operatorSid=$operator.sid;
    oldPid=101;oldTunnelPid=102;oldBuildId=$previous.cutover.rollbackBuildId;newPid=$null;newTunnelPid=$null;
    newBuildId=$null;newStartTimeUtc=$null;newTunnelStartTimeUtc=$null}
$originalPath=Join-Path $oldRuntime 'operator-cutover.json'
Put $originalPath $original
$history=Get-SelectedV6History $previous
$originalHash=Hash $originalPath
$originalBytes=[IO.File]::ReadAllBytes($originalPath)
$live=[pscustomobject][ordered]@{history=$history;startupSha256=('a'*64);buildId='fedcba0987654321';
    codeRoot=(Join-Path $previous.root 'codex_bridge');mcp=@{uiSha256=('b'*64);powerShellReviewStore='UNVERIFIED';powerShellHost='UNVERIFIED'};
    processes=@([pscustomobject]@{pid=201;startedUtcTicks='123456789';sid=$operator.sid;image='fixture-node';session=1;elevated=$false;inAnyJob=$false},
        [pscustomobject]@{pid=202;startedUtcTicks='123456790';sid=$operator.sid;image='fixture-tunnel';session=1;elevated=$false;inAnyJob=$false});
    jobsScope='all';activeJobs=0;awaitingApproval=0;r1ReceiptsTerminal=$true}
$observeFailure='';$observations=0
# Only the OS/network boundary is synthetic. Production history, hash, receipt
# creation, verifier, ownerReuse and successor-plan functions execute unchanged.
function Get-SelectedV6Observation($Previous){
    $script:observations++
    if($script:observeFailure){throw $script:observeFailure}
    return $script:live
}
Refused {Get-InstalledUpgradeState $release $previous.root -RequireSelected} 'UPGRADE_PREVIOUS_NOT_ACCEPTED'
foreach($code in @('ACL_DENIED','OWNER_UNVERIFIED','RECOVERY_LOADED_NATIVE_CHANGED','RECOVERY_LOADED_UI_CHANGED',
    'ALL_JOBS_MUST_BE_TERMINAL','R1_STORE_UNRESOLVED',
    'TUNNEL_NOT_READY','INSTALLED_PARALLEL_OWNER','RECOVERY_OBSERVATION_EXPIRED')){
    $observeFailure=$code
    Refused {New-SelectedV6Attestation $previous $originalHash $history.manifestSha256} $code
    Check (@(Get-ChildItem -LiteralPath $oldRuntime -Filter 'selected-v6-attestation-*.json').Count -eq 0) ('No publication on '+$code)
    Check ((Hash $originalPath) -ceq $originalHash) ('History retained on '+$code)
}
$observeFailure=''
Refused {New-SelectedV6Attestation $previous ('f'*64) $history.manifestSha256} 'RECOVERY_REVIEW_PINS_CHANGED'
Refused {New-SelectedV6Attestation $previous $originalHash ('f'*64)} 'RECOVERY_REVIEW_PINS_CHANGED'
$created=New-SelectedV6Attestation $previous $originalHash $history.manifestSha256
$pin=$created.attestationSha256
Check ($created.phase -ceq 'ATTESTED_SELECTED_V6' -and (Hash (Audit-Path $pin)) -ceq $pin) 'Durable separately pinned attestation'
Check ([Convert]::ToBase64String([IO.File]::ReadAllBytes($originalPath)) -ceq [Convert]::ToBase64String($originalBytes)) 'Original bytes preserved'
$audit=Read-BoundedJson (Audit-Path $pin)
$good=Copy-Json $live
$result=Get-InstalledUpgradeState $release $previous.root -RequireSelected -AttestationSha256 $pin
Check ($result.attestationSha256 -ceq $pin -and $result.cutoverSha256 -ceq $originalHash) 'Explicit attestation permits same canonical upgrade state'
foreach($change in @('corePid','coreTime','tunnelPid','tunnelTime','sid','image','session','elevated','job','build','ui','codeRoot','startup','approvals')){
    $live=Copy-Json $good
    switch($change){
        corePid {$live.processes[0].pid++} coreTime {$live.processes[0].startedUtcTicks='987'}
        tunnelPid {$live.processes[1].pid++} tunnelTime {$live.processes[1].startedUtcTicks='987'}
        sid {$live.processes[0].sid='foreign'} image {$live.processes[0].image='foreign'} session {$live.processes[0].session++}
        elevated {$live.processes[0].elevated=$true} job {$live.processes[0].inAnyJob=$true}
        build {$live.buildId='0000000000000000'} ui {$live.mcp.uiSha256='0'*64} codeRoot {$live.codeRoot='foreign'}
        startup {$live.startupSha256='0'*64} approvals {$live.awaitingApproval++}
    }
    Refused {Get-InstalledUpgradeState $release $previous.root -RequireSelected -AttestationSha256 $pin} 'RECOVERY_ATTESTATION_STALE'
}
$live=Copy-Json $good
$forged=Copy-Json $audit;$forged.evidence.processes[0].pid++
$forgedPin=Save-Audit $forged
Refused {Get-InstalledUpgradeState $release $previous.root -RequireSelected -AttestationSha256 $forgedPin} 'RECOVERY_ATTESTATION_STALE'
$forged=Copy-Json $audit;$forged.phase='LOCAL_ACCEPTED';$forgedPin=Save-Audit $forged
Refused {Get-VerifiedSelectedV6Attestation $previous $forgedPin -Observe} 'RECOVERY_ATTESTATION_REJECTED'
foreach($hours in @(-5,1)){
    $expired=Copy-Json $audit;$at=[DateTimeOffset]::UtcNow.AddHours($hours)
    $expired.createdUtc=$at.ToString('o');$expired.expiresUtc=$at.AddHours(4).ToString('o')
    $expiredPin=Save-Audit $expired
    Refused {Get-VerifiedSelectedV6Attestation $previous $expiredPin -Observe} 'RECOVERY_ATTESTATION_EXPIRED'
}
$forged=Copy-Json $audit;$forged.expiresUtc=([DateTimeOffset]::Parse($audit.createdUtc).AddDays(1)).ToString('o');$forgedPin=Save-Audit $forged
Refused {Get-VerifiedSelectedV6Attestation $previous $forgedPin -Observe} 'RECOVERY_ATTESTATION_TIME_REJECTED'
$savedBytes=[IO.File]::ReadAllBytes((Audit-Path $pin));[IO.File]::AppendAllText((Audit-Path $pin),' ')
Refused {Get-VerifiedSelectedV6Attestation $previous $pin -Observe} 'RECOVERY_ATTESTATION_CHANGED'
[IO.File]::WriteAllBytes((Audit-Path $pin),$savedBytes)
[IO.File]::AppendAllText($originalPath,' ')
Refused {Get-VerifiedSelectedV6Attestation $previous $pin -Observe} 'RECOVERY_ATTESTATION_REJECTED'
[IO.File]::WriteAllBytes($originalPath,$originalBytes)
& $verifier {$script:deny=$true}
Refused {Get-VerifiedSelectedV6Attestation $previous $pin -Observe} 'ACL_DENIED'
& $verifier {$script:deny=$false}
foreach($field in @('phase','lastPhase','newPid','newTunnelPid','newBuildId','newStartTimeUtc','newTunnelStartTimeUtc','oldBuildId','operatorSid','releaseId')){
    $changed=Copy-Json $original;$changed.$field=if($field -in @('newPid','newTunnelPid')){123}else{'changed'}
    Put $originalPath $changed
    Refused {Get-SelectedV6History $previous} 'RECOVERY_HISTORY_REJECTED'
}
Put $originalPath $original
$savedPlan=[IO.File]::ReadAllBytes((Join-Path $oldRuntime 'state-acl-before.json'))
Put (Join-Path $oldRuntime 'state-acl-before.json') @{releaseId='old';manifestSha256='changed'}
Refused {Get-SelectedV6History $previous} 'RECOVERY_STATE_PLAN_CHANGED'
[IO.File]::WriteAllBytes((Join-Path $oldRuntime 'state-acl-before.json'),$savedPlan)
$previous.schemaVersion=5
Refused {Get-InstalledUpgradeState $null $previous.root -RequireSelected -AttestationSha256 $pin} 'UPGRADE_PREVIOUS_NOT_ACCEPTED'
$previous.schemaVersion=6
# Prepare/Plan/Bind must observe live evidence. After binding, only the hash in
# immutable ownerReuse supplies the historical baseline for cutover/rollback.
$release.cutover|Add-Member NoteProperty rollbackBuildId $good.buildId -Force
$UpgradeFromReleaseRoot=$previous.root;$InstalledRecoverySha256=$pin
$prepareAssignment=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and
    $n.Left -is [Management.Automation.Language.VariableExpressionAst] -and $n.Left.VariablePath.UserPath -ceq 'upgrade'},$true))
Check ($prepareAssignment.Count -eq 1) 'Unique actual Prepare admission statement'
. ([scriptblock]::Create($prepareAssignment[0].Extent.Text))
Check ($upgrade.attestationSha256 -ceq $pin) 'Actual Prepare statement forwards reviewed pin'
$InstalledRecoverySha256=''
Refused {. ([scriptblock]::Create($prepareAssignment[0].Extent.Text))} 'UPGRADE_PREVIOUS_NOT_ACCEPTED'
$InstalledRecoverySha256=$pin;$manifest=Copy-Json $release
$prepareFinal=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.CommandAst] -and
    $n.Extent.Text -ceq 'Get-InstalledUpgradeState ([pscustomobject]$manifest) $previous.root -RequireSelected -AttestationSha256 $InstalledRecoverySha256'},$true))
Check ($prepareFinal.Count -eq 1) 'Unique actual Prepare final validation'
$finalPrepare=& ([scriptblock]::Create($prepareFinal[0].Extent.Text))
Check ($finalPrepare.attestationSha256 -ceq $pin) 'Actual Prepare final validation retains pin'
$plan=Get-StateBindingPlan $release -UpgradeRoot $previous.root -AttestationSha256 $pin
Check ($plan.ownerReuse.attestationSha256 -ceq $pin -and $plan.entries.Count -eq 0 -and $null -eq $plan.migration) 'Plan preserves existing store path and pin'
Put (Join-Path $newRuntime 'state-acl-before.json') $plan
Put (Join-Path $newRuntime 'state-binding.json') @{phase='STATE_BOUND';planSha256=(Get-StatePlanHash $plan)}
Check ((Get-CutoverBaselineRoot $release $newRuntime) -ceq $previous.root) 'Bound successor resolves installed rollback baseline'
Check ((Get-CutoverBaselineRoot $release $newRuntime -ExpectedAttestationSha256 $pin) -ceq $previous.root) 'Explicit later pin matches immutable ownerReuse'
Refused {Get-CutoverBaselineRoot $release $newRuntime -ExpectedAttestationSha256 ('e'*64)} 'RECOVERY_BOUND_PIN_CHANGED'
Assert-OwnerMigrationSourceUnchanged $release $newRuntime
Check $true 'Pre-stop cutover reobserves exact attested instance'
$stopped=@{contract='mcpcc-installed-cutover-v1';phase='UPGRADE_STOPPED';releaseId='new';operatorSid=$operator.sid;
    oldBuildId=$good.buildId;newPid=$null;newTunnelPid=$null}
Put (Join-Path $newRuntime 'operator-cutover.json') $stopped
$observeFailure='STOPPED_RUNTIME_MUST_NOT_BE_PROBED'
Assert-OwnerMigrationSourceUnchanged $release $newRuntime -StoppedUpgrade
Check $true 'Only explicit bound UPGRADE_STOPPED avoids live predecessor probe'
Check ((Get-CutoverBaselineRoot $release $newRuntime) -ceq $previous.root) 'Rollback can use bound historical baseline after predecessor stops'
$stopped.phase='UNKNOWN';Put (Join-Path $newRuntime 'operator-cutover.json') $stopped
Refused {Assert-OwnerMigrationSourceUnchanged $release $newRuntime -StoppedUpgrade} 'RECOVERY_STOPPED_SUCCESSOR_REQUIRED'
$observeFailure=''
$changed=Copy-Json $plan;$changed.ownerReuse.attestationSha256='f'*64
Put (Join-Path $newRuntime 'state-acl-before.json') $changed
Refused {Get-CutoverBaselineRoot $release $newRuntime} 'CUTOVER_STATE_PLAN_CHANGED'
Put (Join-Path $newRuntime 'state-acl-before.json') $plan
Refused {Get-InstalledUpgradeState $null $previous.root -AttestationSha256 $pin} 'RECOVERY_BOUND_SUCCESSOR_REQUIRED'
Check ((Hash $originalPath) -ceq $originalHash) 'History hash preserved after all upgrade paths'
# Exercise actual BindState copy/receipt flow in a third, new fixture release.
foreach($name in @('Invoke-StateBinding','Copy-StateSnapshot','Write-Receipt')){
    $node=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))[0]
    . ([scriptblock]::Create($node.Extent.Text))
}
function New-StateDirectory([string]$Path,[string]$OwnerRoot){
    if(-not $Path.StartsWith($fixture+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'FIXTURE_WRITE_ESCAPE'}
    [void][IO.Directory]::CreateDirectory($Path)
}
function Get-McpCcInstalledBridgeBinding {param($p) [pscustomobject]@{fixture=$true}}
$bindRelease=Copy-Json $release;$bindRelease.releaseId='bound';$bindRelease.root=Join-Path $fixture 'bound'
$bindRelease.sourcePath=Join-Path $bindRelease.root 'manifest.json';Put $bindRelease.sourcePath @{fixture='bound'}
$bindPlan=Get-StateBindingPlan $bindRelease -UpgradeRoot $previous.root -AttestationSha256 $pin
Refused {Invoke-StateBinding $bindRelease ('0'*64) -UpgradeRoot $previous.root -AttestationSha256 $pin} 'STATE_PLAN_CHANGED_NO_MUTATION'
Check (-not(Test-Path (Join-Path $owner 'installed-bridge\bound'))) 'Bad binding digest cannot write'
$bound=Invoke-StateBinding $bindRelease (Get-StatePlanHash $bindPlan) -UpgradeRoot $previous.root -AttestationSha256 $pin|ConvertFrom-Json
Check ($bound.phase -ceq 'STATE_BOUND' -and $bound.ownerStateReused -and -not $bound.canonicalDataMoved) 'Actual binding reuses owner without migrating data'
$boundPlan=Read-BoundedJson (Join-Path $owner 'installed-bridge\bound\state-acl-before.json')
Check ($boundPlan.ownerReuse.attestationSha256 -ceq $pin) 'Actual binding durably pins attestation'
Refused {Invoke-StateBinding $bindRelease (Get-StatePlanHash $bindPlan) -UpgradeRoot $previous.root -AttestationSha256 $pin} 'STATE_BINDING_EXISTS_INSPECT_DO_NOT_RETRY'
# Execute the real observation and MCP/UI checks with inert native proofs and
# fixed transport responses. No production DLL, process, listener or store opens.
$nativeDir=Join-Path $previous.root 'mcp_control_center\src'
[void][IO.Directory]::CreateDirectory($nativeDir)
$nativePath=Join-Path $nativeDir 'NormalOperator.Host.dll'
Add-Type -TypeDefinition @'
using System;
public static class McpCcNormalNative {
 public sealed class Proof { public int pid,session; public long startedUtcTicks; public string sid,image; public bool elevated,inAnyJob; }
 public static Proof Inspect(object value) { return ((FixtureProcess)value).proof; }
}
public sealed class FixtureProcess : IDisposable {
 public int Id,SessionId; public McpCcNormalNative.Proof proof; public bool disposed;
 public void Dispose() { disposed=true; }
}
public static class McpCcReloadNative {}
'@ -OutputAssembly $nativePath
Copy-Item -LiteralPath $nativePath -Destination (Join-Path $nativeDir 'RemoteSelfReload.Native.dll')
Add-Type -Path $nativePath
$previous|Add-Member NoteProperty dependencies @{node=@{path='C:\fixture\node.exe'};tunnelClient=@{path='C:\fixture\tunnel.exe'}} -Force
$operator|Add-Member NoteProperty windows 'C:\Windows' -Force
$processMap=@{}
foreach($row in @(@(201,$previous.dependencies.node.path,'codex-bridge-http-server.owner.json'),@(202,$previous.dependencies.tunnelClient.path,'tunnel-client.owner.json'))){
    $p=New-Object FixtureProcess;$p.Id=$row[0];$p.SessionId=1;$p.proof=New-Object McpCcNormalNative+Proof
    $p.proof.pid=$row[0];$p.proof.session=1;$p.proof.sid=$operator.sid;$p.proof.image=$row[1];$p.proof.startedUtcTicks=[DateTime]::UtcNow.AddMinutes(-5).Ticks
    $processMap[$p.Id]=$p
    Put (Join-Path $oldRuntime $row[2]) @{pid=$p.Id;executablePath=$row[1];startTimeUtc=(New-Object DateTime($p.proof.startedUtcTicks,[DateTimeKind]::Utc)).ToString('o')}
}
function Get-Process {param($Id,$ErrorAction) if($Id -eq $PID){return [pscustomobject]@{SessionId=1}};return $script:processMap[[int]$Id]}
function Get-CimInstance {param($ClassName,$Filter,$ErrorAction) [pscustomobject]@{fixture=$true}}
function Invoke-CimMethod {param($InputObject,$MethodName,$ErrorAction) [pscustomobject]@{ReturnValue=0;Sid=$operator.sid}}
$httpFault='';$boundaryFault='';$httpClosed=0;$storeReads=0
$fixtureHealth=[pscustomobject]@{ok=$true;service='codex-handoff-bridge';buildId=$good.buildId;pid=201;controller='ready';jobs=@{scope='all';active=0;awaitingApproval=0}}
$fixtureStatus=[pscustomobject]@{after=@{status='Ready';canonicalBuildId=$good.buildId;
    server=@{pid=201;listenerPid=201;ownership='OwnedReady'};tunnel=@{pid=202;listenerPid=202;ownership='OwnedReady'};tunnelIdentity=@{status='Ready'}}}
function Invoke-RestMethod {param($Uri,$TimeoutSec,$MaximumRedirection) $script:fixtureHealth}
function Invoke-Controller {param($Root,$Verb)
    if($Root -ine (Join-Path $previous.root 'codex_bridge') -or $Verb -cne 'Status'){throw 'FIXTURE_LIFECYCLE_OR_ROOT_ESCAPE'}
    return $script:fixtureStatus
}
function Get-ReleaseHttpToken {param($Release) return $null}
function Assert-RemoteReceiptsTerminal {param($OwnerRoot,$SelectedRoot) if($script:boundaryFault -ceq 'receipts'){throw 'R1_STORE_UNRESOLVED'}}
& $verifier {
    $script:selectionFailure=''
    function script:Assert-McpCcInstalledSelection {param($b) if($script:selectionFailure){throw $script:selectionFailure}}
}
$fixtureHtml='<html>selected installed bytes</html>'
$uiPath=Join-Path $previous.root 'codex_bridge\web\codex-console.html'
[void][IO.Directory]::CreateDirectory((Split-Path -Parent $uiPath));[IO.File]::WriteAllText($uiPath,$fixtureHtml,$utf8)
function Invoke-WebRequest {
    param([switch]$UseBasicParsing,$Uri,$Method,$Headers,$ContentType,$TimeoutSec,$MaximumRedirection,$Body)
    if($Uri -eq 'http://127.0.0.1:18829/readyz'){return @{StatusCode=200;Content=$(if($script:httpFault -eq 'tunnel'){'not ready'}else{'ready'})}}
    if($Method -eq 'Delete'){$script:httpClosed++;return}
    $request=$Body|ConvertFrom-Json
    if($request.method -ceq 'initialize'){return @{Headers=@{'Mcp-Session-Id'='fixture-session'}}}
    if($request.method -ceq 'notifications/initialized'){return}
    $payload=switch($request.method){
        'tools/list' {
            $toolRows=@('status','preview','request','receipt','challenge','approve')|ForEach-Object{@{name=('codex_self_reload_'+$_);_meta=@{ui=@{visibility=@('app')}}}}
            @{result=@{tools=@($toolRows)}}
        }
        'tools/call' {
            $script:storeReads++
            @{result=@{structuredContent=@{reviewStore=@{startup=@{status='FAILED';errorCode='STORE_LOCKED'};
                current=@{lifecycle='UNVERIFIED';owner='UNVERIFIED';presence='PRESENT';recovery='INDEPENDENT_REVIEW_REQUIRED'}};
                normalExecution=@{configured=$false};deployment='EXECUTION_DISABLED'}}}
        }
        'resources/read' {@{id=4;result=@{contents=@(@{uri='ui://codex-bridge/chat-workspace-v15.html';text=$(if($script:httpFault -eq 'ui'){'wrong'}else{$fixtureHtml})})}}}
        default {throw 'FIXTURE_UNKNOWN_HTTP_CALL'}
    }
    return @{RawContentLength=100;Content=($payload|ConvertTo-Json -Depth 12)}
}
foreach($name in @('Get-SelectedV6Observation','Get-Health','Assert-OwnedReady','Assert-HttpAuthentication')){
    $node=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))[0]
    . ([scriptblock]::Create($node.Extent.Text))
}
$observed=Get-SelectedV6Observation $previous
Check ($observed.mcp.uiSha256 -ceq (Hash $uiPath) -and $observed.buildId -ceq $good.buildId -and $observed.processes.Count -eq 2) 'Actual observation combines loaded UI, Build and retained OS proof'
Check ($observed.mcp.powerShellReviewStore -ceq 'UNVERIFIED' -and $observed.mcp.powerShellHost -ceq 'UNVERIFIED' -and $storeReads -eq 0) 'Selected recovery uses original Cutover scope; no ReviewStore/Host acceptance claim'
Refused {Assert-HttpAuthentication -Release $previous -MigrationStoreStatus} 'MIGRATION_STORE_NOT_OPEN'
Check ($storeReads -eq 1) 'Existing migration still rejects STORE_LOCKED / UNVERIFIED / EXECUTION_DISABLED'
$observed=Get-SelectedV6Observation $previous
Check ($storeReads -eq 1 -and $observed.mcp.powerShellHost -ceq 'UNVERIFIED') 'Store failure does not become an extra selected recovery gate'
Check ($httpClosed -gt 0 -and $processMap[201].disposed -and $processMap[202].disposed) 'Sessions and retained handles close'
foreach($field in @('sid','image','session','elevated','inAnyJob','startedUtcTicks')){
    $proof=$processMap[201].proof;$saved=$proof.$field
    $proof.$field=switch($field){sid {'foreign'} image {'foreign'} session {2} elevated {$true} inAnyJob {$true} startedUtcTicks {1L}}
    Refused {Get-SelectedV6Observation $previous} 'RECOVERY_PROCESS_IDENTITY_CHANGED'
    $proof.$field=$saved
}
$processMap[202].proof.startedUtcTicks++
Refused {Get-SelectedV6Observation $previous} 'RECOVERY_PROCESS_IDENTITY_CHANGED'
$processMap[202].proof.startedUtcTicks--
$fixtureHealth.jobs.active=1;Refused {Get-SelectedV6Observation $previous} 'ALL_JOBS_MUST_BE_TERMINAL';$fixtureHealth.jobs.active=0
$fixtureHealth.jobs.awaitingApproval=1;Refused {Get-SelectedV6Observation $previous} 'ALL_JOBS_MUST_BE_TERMINAL';$fixtureHealth.jobs.awaitingApproval=0
$fixtureHealth.jobs.scope='recent';Refused {Get-SelectedV6Observation $previous} 'RUNTIME_UNVERIFIED';$fixtureHealth.jobs.scope='all'
$fixtureStatus.after.canonicalBuildId='0'*16;Refused {Get-SelectedV6Observation $previous} 'OWNER_UNVERIFIED';$fixtureStatus.after.canonicalBuildId=$good.buildId
$fixtureStatus.after.tunnel.ownership='OwnershipUnknown';Refused {Get-SelectedV6Observation $previous} 'OWNER_UNVERIFIED';$fixtureStatus.after.tunnel.ownership='OwnedReady'
foreach($pair in @(@('ui','RECOVERY_LOADED_UI_CHANGED'),@('tunnel','TUNNEL_NOT_READY'))){
    $httpFault=$pair[0];Refused {Get-SelectedV6Observation $previous} $pair[1]
}
$httpFault=''
$boundaryFault='receipts';Refused {Get-SelectedV6Observation $previous} 'R1_STORE_UNRESOLVED'
$boundaryFault=''
& $verifier {$script:selectionFailure='INSTALLED_PARALLEL_OWNER'}
Refused {Get-SelectedV6Observation $previous} 'INSTALLED_PARALLEL_OWNER'
& $verifier {$script:selectionFailure=''}
$selected=$false;Refused {Get-SelectedV6Observation $previous} 'UPGRADE_STARTUP_NOT_SELECTED';$selected=$true
[IO.File]::AppendAllText((Join-Path $nativeDir 'RemoteSelfReload.Native.dll'),'changed')
Refused {Get-SelectedV6Observation $previous} 'RECOVERY_LOADED_NATIVE_CHANGED'
# AST guards examine the actual entrypoint; never dot-source its lifecycle body.
$source=$ast.Extent.Text
Check ($source.Contains("'AttestSelectedV6'") -and $source.Contains('RECOVERY_ABANDONED_OPERATOR_DO_NOT_RETRY')) 'Explicit local action and abandoned mutex rejection'
Check ($source.Contains('-UpgradeRoot $UpgradeFromReleaseRoot -AttestationSha256 $InstalledRecoverySha256')) 'Plan/Bind parameter forwarding'
Check ($source.Contains('Get-InstalledUpgradeState $null $UpgradeFromReleaseRoot -RequireSelected -AttestationSha256 $InstalledRecoverySha256')) 'Prepare parameter forwarding'
Check ($source.Contains('Get-InstalledUpgradeState ([pscustomobject]$manifest) $previous.root -RequireSelected -AttestationSha256 $InstalledRecoverySha256')) 'Prepare final revalidation'
$resumeNode=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Get-UpgradeResumeReceipt'},$true)
$resume=$resumeNode.Extent.Text
$migrationCalls=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Assert-OwnerMigrationSourceUnchanged'},$true))
$stoppedCalls=@($migrationCalls|Where-Object{@($_.CommandElements|Where-Object{$_ -is [Management.Automation.Language.CommandParameterAst] -and $_.ParameterName -ceq 'StoppedUpgrade'}).Count -gt 0})
Check ($stoppedCalls.Count -eq 1 -and $stoppedCalls[0].Extent.StartOffset -gt $resumeNode.Extent.StartOffset -and $stoppedCalls[0].Extent.EndOffset -lt $resumeNode.Extent.EndOffset) 'Only the shared resume function passes stopped admission; initial and preflight do not'
$resumeCalls=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Get-UpgradeResumeReceipt'},$true))
Check ($resumeCalls.Count -eq 2) 'Manual and automatic Cutover invoke the same resume function'
Check ($resume.Contains('Assert-OwnerMigrationSourceUnchanged $release $runtime -StoppedUpgrade') -and $resume.Contains("`$saved.phase -cne 'UPGRADE_STOPPED'")) 'Shared stopped resume retains original stopped-phase validation'
$writer=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'New-SelectedV6Attestation'},$true))[0].Extent.Text
Check ($writer.IndexOf('Get-SelectedV6Observation') -lt $writer.IndexOf('[IO.File]::Open')) 'All live validation precedes durable publication'
Check ($writer.Contains('[IO.FileMode]::CreateNew') -and $writer.Contains('$stream.Flush($true)') -and -not $writer.Contains('Write-Receipt')) 'Publication cannot overwrite historical receipt'
foreach($name in @('Get-SelectedV6History','Get-SelectedV6Observation','New-SelectedV6Attestation')){
    $text=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))[0].Extent.Text
    Check ($text -notmatch 'ShutdownRuntime|EnsureRunning|Set-Acl|Start-SelectedTray|Terminate|\.Kill\(') ('No lifecycle mutation in '+$name)
    Check ($text -notmatch 'receipts\.jsonl|check-migration-approvals|Get-SelectedV6Approvals') ('No external ApprovalStore journal read in '+$name)
}
[pscustomobject]@{ok=$true;checks=$checks;scope='actual receipt/upgrade functions with synthetic OS observations';
    approvalEvidence='EXISTING_CUTOVER_STATUS_AND_R1_TERMINALS';liveAcceptance='UNVERIFIED';runtimeTouched=$false;fixture=$fixture}|ConvertTo-Json
