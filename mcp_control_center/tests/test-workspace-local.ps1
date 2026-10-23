Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'EXPECTED_WINDOWS_POWERSHELL_5_1' }
$root=Split-Path -Parent $PSScriptRoot
$source=Get-Content -LiteralPath (Join-Path $root 'src\WorkspaceLocal.Native.cs') -Raw -Encoding UTF8
$fixture=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'WorkspaceLocal.Check.cs') -Raw -Encoding UTF8
Add-Type -TypeDefinition ($source+"`n"+$fixture) -ReferencedAssemblies System.Web.Extensions,System.Core
$temp=Join-Path $root ('.tmp\workspace-local-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
$checks=[McpCc.WorkspaceLocal.Fixture]::Run($temp)
$recoveryChecks=[McpCc.WorkspaceLocal.Fixture]::RunRecovery($temp);$checks+=$recoveryChecks
$diagnosticChecks=[McpCc.WorkspaceLocal.Fixture]::RunDiagnostics($temp);$checks+=$diagnosticChecks
foreach($file in @('src\McpControlCenter.WorkspaceLocal.psm1','src\McpControlCenter.Core.psm1','scripts\tray.ps1','tests\test-workspace-local.ps1','tests\test-workspace-delegation.ps1')) {
    $tokens=$null;$errors=$null
    $null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root $file),[ref]$tokens,[ref]$errors)
    if($errors.Count) { throw 'POWERSHELL_SYNTAX_FAILED' };$checks++
}
Import-Module (Join-Path $root 'src\McpControlCenter.WorkspaceLocal.psm1') -Force
$module=Get-Module McpControlCenter.WorkspaceLocal
# Import only the real pure validator and property helper, never core bootstrap.
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'src\McpControlCenter.Core.psm1'),[ref]$tokens,[ref]$errors)
foreach($functionName in @('Get-McpCcObjectProperty','Assert-McpCcControllerActionResult')) {
    $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $functionName},$true)
    & $module ([scriptblock]::Create($definition.Extent.Text.Replace(('function '+$functionName),('function script:'+$functionName))))
}
# All lifecycle calls below use this module-scope fake. No core import, live
# registry, controller process, production pipe, AppData or service is accessed.
& $module {
    function script:Invoke-McpCcComponentAction {
        param($Manifest,$ComponentId,$Action,$RuntimeRoot)
        if($ComponentId -cne $Manifest.expected -or $Action -cne 'reload_runtime') { throw 'WRONG_DELEGATION' }
        if($Manifest.fixture -eq 'CONTROLLER_TIMEOUT') { throw 'ACTIVE_WORK_PRESENT in untrusted timeout text' }
        if($Manifest.fixture -ne 'success' -and $Manifest.fixture -ne 'failed') {
            $doc=[pscustomobject]@{ok=$false;action='ReloadRuntime';before=@{};after=@{};ownedPids=@();elapsedMs=1;errorCode=$Manifest.fixture;message='private-token-never-persist'}
            if($Manifest.fixture -eq 'WRONG_ACTION') {$doc.action='RestartCore';$doc.errorCode='ACTIVE_WORK_PRESENT'}
            if($Manifest.fixture -eq 'MALFORMED') {$doc.ok='false';$doc.errorCode='ACTIVE_WORK_PRESENT'}
            Assert-McpCcControllerActionResult -Document $doc -ExpectedAction ReloadRuntime
        }
        if($Manifest.fixture -eq 'failed') { return [pscustomobject]@{delegated=$true;exitCode=1;result=[pscustomobject]@{ok=$false}} }
        return [pscustomobject]@{delegated=$true;exitCode=0;result=[pscustomobject]@{ok=$true}}
    }
}
$fakeOwner=[pscustomobject]@{outcome=$null;count=0;reason=$null}
$fakeOwner | Add-Member ScriptMethod Complete {param($id,$outcome) $this.outcome=$outcome;$this.reason=$null;$this.count++}
$fakeOwner | Add-Member ScriptMethod CompleteRefusal {param($id,$reason) $this.outcome='UNKNOWN';$this.reason=$reason;$this.count++}
$fakeOwner | Add-Member NoteProperty sample $null
$fakeOwner | Add-Member ScriptMethod Publish {param($value) $this.sample=$value}
$components=@(foreach($id in [McpCc.WorkspaceLocal.Contract]::Ids) {
    [pscustomobject]@{id=$id;status='Ready';checkedAt=[DateTimeOffset]::UtcNow.ToString('o');capabilities=@('reload_runtime');issues=@();secret='fixture-private';pid=123}
})
Publish-McpCcWorkspaceLocalState -Owner $fakeOwner -State ([pscustomobject]@{components=$components})
if($fakeOwner.sample -isnot [McpCc.WorkspaceLocal.Snapshot]) {throw 'PROJECTION_FAILED'};$checks++
Publish-McpCcWorkspaceLocalState -Owner $fakeOwner -State ([pscustomobject]@{components=@()})
if($null -ne $fakeOwner.sample) {throw 'INVALID_SNAPSHOT_NOT_CLEARED'};$checks++
foreach($id in [McpCc.WorkspaceLocal.Contract]::Ids) {
    $request=[pscustomobject]@{componentId=$id;action='reload_runtime';confirmation='interrupt_current_requests';requestId=[Guid]::NewGuid().ToString('D')}
    Invoke-McpCcWorkspaceLocalRestart -Owner $fakeOwner -Request $request -Manifest @{fixture='success';expected=$id} -RuntimeRoot $temp
    if($fakeOwner.outcome -cne 'COMPLETED') {throw 'DELEGATION_FAILED'};$checks++
    foreach($reason in @('OWNERSHIP_UNKNOWN','OWNERSHIP_MISMATCH','ACTIVE_WORK_PRESENT','ACTIVE_STATE_UNKNOWN','CONTROLLER_TIMEOUT','failed','UNRECOGNIZED_CODE','WRONG_ACTION','MALFORMED','ACTIVE_WORK_PRESENT private-token')) {
        Invoke-McpCcWorkspaceLocalRestart -Owner $fakeOwner -Request $request -Manifest @{fixture=$reason;expected=$id} -RuntimeRoot $temp
        if($fakeOwner.outcome -cne 'UNKNOWN') {throw 'CONTROLLER_FAILURE_NOT_CLOSED'};$checks++
        $expectedReason=if([McpCc.WorkspaceLocal.RefusalDiagnostic]::IsReason($reason)) {$reason} else {$null}
        if($fakeOwner.reason -cne $expectedReason) {throw 'REFUSAL_PROVENANCE_FAILED'};$checks++
    }
}
$before=$fakeOwner.count
# End-to-end private evidence path: real validator -> PowerShell exception wrapper
# -> real Owner/ReceiptStore. Only the component execution remains simulated.
$evidenceRoot=Join-Path $temp 'controller-evidence'
$evidenceOwner=[McpCc.WorkspaceLocal.Fixture]::Open(('mcpcc-local-fixture-'+[Guid]::NewGuid().ToString('N')),$evidenceRoot)
try {
    foreach($case in @('ACTIVE_WORK_PRESENT','CONTROLLER_TIMEOUT','MALFORMED','success')) {
        $request=[pscustomobject]@{componentId='codex_bridge';action='reload_runtime';confirmation='interrupt_current_requests';requestId=[Guid]::NewGuid().ToString('D')}
        [McpCc.WorkspaceLocal.Fixture]::Accept($evidenceOwner,$request.requestId,$request.componentId)
        Invoke-McpCcWorkspaceLocalRestart -Owner $evidenceOwner -Request $request -Manifest @{fixture=$case;expected='codex_bridge'} -RuntimeRoot $evidenceRoot
        $receipt=Get-Content -Raw -Encoding UTF8 (Join-Path $evidenceRoot ('workspace-local-receipts/'+$request.requestId+'.json')) | ConvertFrom-Json
        $expectedOutcome=if($case -eq 'success') {'COMPLETED'} else {'UNKNOWN'}
        if($receipt.outcome -cne $expectedOutcome -or $evidenceOwner.HasActiveRequest) {throw 'PERSISTED_OUTCOME_FAILED'};$checks++
        $sidecar=Join-Path $evidenceRoot ('workspace-local-diagnostics/'+$request.requestId+'.json')
        if($case -eq 'ACTIVE_WORK_PRESENT') {
            $text=Get-Content -Raw -Encoding UTF8 $sidecar
            $diagnostic=$text | ConvertFrom-Json
            if($diagnostic.reason -cne $case -or $diagnostic.requestId -cne $request.requestId -or $text.Contains('private-token')) {throw 'PRIVATE_EVIDENCE_FAILED'}
        } elseif(Test-Path -LiteralPath $sidecar) {throw 'AMBIGUOUS_REFUSAL_PERSISTED'}
        $checks++
    }
} finally {$evidenceOwner.Dispose()}
foreach($invalid in @(@{componentId='project_reading'},@{componentId='mcp_control_center'},@{componentId='unknown'},@{componentId='CODEX_BRIDGE'},@{action='restart_core'},@{confirmation='yes'},@{requestId='invalid'})) {
    $request=[pscustomobject]@{componentId='codex_bridge';action='reload_runtime';confirmation='interrupt_current_requests';requestId=[Guid]::NewGuid().ToString('D')}
    foreach($key in $invalid.Keys) {$request.$key=$invalid[$key]}
    $denied=$false
    try {Invoke-McpCcWorkspaceLocalRestart -Owner $fakeOwner -Request $request -Manifest @{} -RuntimeRoot $temp} catch {$denied=$true}
    if(-not $denied -or $fakeOwner.count -ne $before) {throw 'COHORT_ESCAPE'};$checks++
}
$name='mcpcc-local-fixture-'+[Guid]::NewGuid().ToString('N')
$owner=[McpCc.WorkspaceLocal.Fixture]::Open($name,$temp)
try {
    $node=New-Object Diagnostics.Process
    $node.StartInfo.FileName=(Get-Command node).Source
    $node.StartInfo.Arguments='"'+(Join-Path $root '..\project_reading\scripts\smoke-workspace-local.mjs')+'" '+$name
    $node.StartInfo.UseShellExecute=$false;$node.StartInfo.CreateNoWindow=$true
    $node.StartInfo.RedirectStandardOutput=$true;$node.StartInfo.RedirectStandardError=$true
    $null=$node.Start()
    $deadline=[DateTime]::UtcNow.AddSeconds(25);$delegations=0
    while(-not $node.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        $pending=$owner.TakePending()
        if($null -ne $pending) {$delegations++;$owner.Complete($pending.requestId,'COMPLETED')}
        Start-Sleep -Milliseconds 30
    }
    if(-not $node.HasExited) {throw 'INTEROP_TIMEOUT'}
    $node.WaitForExit()
    $stdout=$node.StandardOutput.ReadToEnd();$stderr=$node.StandardError.ReadToEnd()
    if($node.ExitCode -ne 0) {Write-Output $stderr;throw 'INTEROP_FAILED'}
    if($delegations -ne 7) {throw 'DUPLICATE_DISPATCH'};$checks++
    Write-Output $stdout
} finally {$owner.Dispose();if($null -ne $node){$node.Dispose()}}
[pscustomobject]@{ok=$true;checks=$checks;recoveryChecks=$recoveryChecks;diagnosticChecks=$diagnosticChecks;evidence='ISOLATED_NATIVE_PIPE_AND_MOCK_CONTROLLER';liveRestart=$false;productionPipe=$false} | ConvertTo-Json -Compress
