# Real dispatcher, isolated module boundary. Never connects the production pipe.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$sourceRoot=Split-Path -Parent $PSScriptRoot
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('cc-daily-terminal-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixture)
Copy-Item -LiteralPath (Join-Path $sourceRoot 'src/McpControlCenter.WorkspaceUpdate.psm1') -Destination $fixture
$fakeDaily=@'
function Repair-McpDailyOperation {
    param($Root,$OperationId,$Version,$SourceDigest)
    $request=Get-Content -Raw -Encoding UTF8 (Join-Path $Root ('operations/'+$OperationId+'/request.json'))|ConvertFrom-Json
    if($request.operationId -cne $OperationId -or $request.version -cne $Version -or $request.sourceDigest -cne $SourceDigest){throw 'DAILY_REQUEST_CONFLICT'}
    return @{operationId=$OperationId;phase='NOT_APPLIED';code='DAILY_NO_CODE_CHANGE';requestedVersion=$Version;selectedVersion='live-old';observedRuntimeVersion='live-old';observedBuildId='old-build'}
}
function Invoke-McpDailyUpdate {throw 'UNEXPECTED_BUILD_OR_UPDATE'}
Export-ModuleMember -Function Repair-McpDailyOperation,Invoke-McpDailyUpdate
'@
[IO.File]::WriteAllText((Join-Path $fixture 'McpControlCenter.DailyCode.psm1'),$fakeDaily)
$module=Import-Module (Join-Path $fixture 'McpControlCenter.WorkspaceUpdate.psm1') -Force -PassThru
$owner=[pscustomobject]@{result=$null}
$owner|Add-Member ScriptMethod CompleteUpdate {param($Id,$Phase,$Code,$Selected,$Observed,$Build,$Ready,$Prepared)
    $this.result=@{requestId=$Id;phase=$Phase;code=$Code;selectedVersion=$Selected;observedVersion=$Observed;observedBuildId=$Build;ready=$Ready;preparedBuildId=$Prepared}}
$id=[guid]::NewGuid().ToString();$operation=$id.Replace('-','')
$op=Join-Path $fixture ('codex_bridge/Runtime/operations/'+$operation);[void][IO.Directory]::CreateDirectory($op)
[IO.File]::WriteAllText((Join-Path $op 'request.json'),(@{operationId=$operation;version='requested-new';sourceDigest=('a'*64)}|ConvertTo-Json))
& $module {
    function script:Get-McpCcUpdateDefinition {throw 'UNEXPECTED_EDITABLE_DEFINITION_READ'}
    function script:Get-McpCcUpdateDigest {throw 'UNEXPECTED_EDITABLE_SOURCE_CHECK'}
    function script:Test-McpCcBridgeUpdateIdle {throw 'UNEXPECTED_IDLE_CHECK'}
}
$checks=0
foreach($phase in @('RECOVERY_REQUIRED','RUNNING','QUEUED')){
    $request=[pscustomobject]@{componentId='codex_bridge';requestId=$id;operationId=$operation;versionId='requested-new';expectedSourceDigest=('a'*64);phase=$phase}
    Invoke-McpCcWorkspaceUpdate $owner $request ([pscustomobject]@{codeDeployment=@{workspaceRoot=$fixture}}) $fixture
    if($owner.result.phase -cne 'REJECTED' -or $owner.result.code -cne 'DAILY_NO_CODE_CHANGE'){throw 'canonical terminal did not precede current source/idle'};$checks++
    if($owner.result.selectedVersion -cne 'live-old' -or $owner.result.observedBuildId -cne 'old-build' -or $owner.result.ready -ne $false){throw 'no-op was misrepresented as adoption'};$checks++
}
$request.expectedSourceDigest='b'*64
Invoke-McpCcWorkspaceUpdate $owner $request ([pscustomobject]@{codeDeployment=@{workspaceRoot=$fixture}}) $fixture
if($owner.result.phase -cne 'RECOVERY_REQUIRED' -or $owner.result.code -cne 'DAILY_REQUEST_CONFLICT'){throw 'parameter conflict consumed original terminal'};$checks++
Write-Output ('PASS workspace daily terminal: '+$checks+' checks; fixture='+$fixture)

# Cross the real canonical -> dispatcher -> Native durable receipt -> Workspace
# projection seam. Only lifecycle observation is replaced by an inert owner.
$repo=Split-Path -Parent $sourceRoot
Remove-Module $module
$module=Import-Module (Join-Path $sourceRoot 'src/McpControlCenter.DailyCode.psm1') -Force -PassThru
function Put([string]$Path,[string]$Text){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,$Text)}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'codex_bridge/tests/test-daily-code-update.ps1'),[ref]$tokens,[ref]$errors)
$builder=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'New-Case'},$true)
. ([scriptblock]::Create($builder.Extent.Text))
$case=New-Case canonical
Put (Join-Path $case.source 'codex_bridge/web/index.html') 'fixture code v1'
$null=New-McpDailyCandidate -Root $case.root -Source $case.source -Version requested-new
$workspace=Join-Path $fixture 'cross';[void][IO.Directory]::CreateDirectory((Join-Path $workspace 'codex_bridge'))
Copy-Item -LiteralPath $case.root -Destination (Join-Path $workspace 'codex_bridge/Runtime') -Recurse
$dailySource=Get-Content -LiteralPath (Join-Path $sourceRoot 'src/McpControlCenter.DailyCode.psm1') -Raw -Encoding UTF8
$ownerFixture=@'
function Read-DailySettingsForVersion {param($Root,$Version) return @{fixture=$true}}
function Invoke-DailyOwner {param($Root,$Version,$Action)
    Add-Content -LiteralPath (Join-Path $Root 'owner-calls.txt') -Value ($Version+':'+$Action)
    if($Action -cne 'Verify' -or $Version -cne 'v1'){throw 'UNEXPECTED_LIFECYCLE_MUTATION'}
    return @{version='v1';buildId='v1-loaded-proof'}
}
function Build-DailyCandidate {throw 'UNEXPECTED_REBUILD'}
function Set-DailySelector {throw 'UNEXPECTED_RESELECT'}
'@
Put (Join-Path $fixture 'McpControlCenter.DailyCode.psm1') ($dailySource+"`n"+$ownerFixture)
$native=Get-Content -LiteralPath (Join-Path $sourceRoot 'src/WorkspaceLocal.Native.cs') -Raw -Encoding UTF8
$nativeFixture=@'
namespace McpCc.WorkspaceLocal {
 public static class DailyTerminalFixture {
  public static Owner Open(string root) { return new Owner("daily-terminal-"+System.Guid.NewGuid().ToString("N"),root); }
  public static string Send(Owner owner,string op,string id) {
   bool update=op=="update";
   var r=new System.Collections.Generic.Dictionary<string,string>{{"v","2"},{"nonce",new string('a',64)},{"challenge",new string('b',64)},
    {"operation",op},{"componentId",update?"codex_bridge":""},{"requestId",id},{"action",update?"update_from_source":""},
    {"confirmation",update?"interrupt_current_requests":""},{"versionId",update?"requested-new":""},
    {"expectedSourceDigest",update?new string('a',64):""},{"idlePolicy",update?"wait_for_idle":""}};
   return owner.DispatchUpdate(Contract.Request(Contract.Json().Serialize(r),new string('b',64)));
  }
 }
}
'@
Add-Type -TypeDefinition ($native+"`n"+$nativeFixture) -ReferencedAssemblies System.Web.Extensions,System.Core
$owner=[McpCc.WorkspaceLocal.DailyTerminalFixture]::Open((Join-Path $fixture 'cc-durable'))
try{
    $id=[guid]::NewGuid().ToString();$operation=$id.Replace('-','')
    Put (Join-Path $workspace ('codex_bridge/Runtime/operations/'+$operation+'/request.json')) (@{operationId=$operation;version='requested-new';sourceDigest=('a'*64)}|ConvertTo-Json)
    $null=[McpCc.WorkspaceLocal.DailyTerminalFixture]::Send($owner,'update',$id)
    $request=$owner.TakePendingUpdate()
    $owner.CompleteUpdate($id,'RECOVERY_REQUIRED','DAILY_NO_CODE_CHANGE',$null,$null,$null,$null,$null)
    $null=[McpCc.WorkspaceLocal.DailyTerminalFixture]::Send($owner,'update',$id)
    $request=$owner.TakePendingUpdate()
    $module=Import-Module (Join-Path $fixture 'McpControlCenter.WorkspaceUpdate.psm1') -Force -PassThru
    & $module {
        function script:Get-McpCcUpdateDefinition {throw 'UNEXPECTED_EDITABLE_DEFINITION_READ'}
        function script:Get-McpCcUpdateDigest {throw 'UNEXPECTED_SOURCE_CHECK'}
        function script:Test-McpCcBridgeUpdateIdle {throw 'UNEXPECTED_IDLE_CHECK'}
    }
    Invoke-McpCcWorkspaceUpdate $owner $request ([pscustomobject]@{codeDeployment=@{workspaceRoot=$workspace}}) $fixture
    $wire=[McpCc.WorkspaceLocal.DailyTerminalFixture]::Send($owner,'update_receipt',$id)
    $receipt=($wire|ConvertFrom-Json).receipt
    if($receipt.phase -cne 'REJECTED' -or $receipt.code -cne 'DAILY_NO_CODE_CHANGE' -or $receipt.preparedBuildId){throw 'real canonical mapping failed'};$checks++
    if($receipt.requestId -cne $id -or $receipt.operationId -cne $operation -or $receipt.versionId -cne 'requested-new' -or $receipt.expectedSourceDigest -cne ('a'*64)){throw 'original parameters changed'};$checks++
    if($receipt.selectedVersion -cne 'v1' -or $receipt.observedVersion -cne 'v1' -or $receipt.observedBuildId -cne 'v1-loaded-proof'){throw 'actual identity lost'};$checks++
    $canonical=Get-Content -Raw -Encoding UTF8 (Join-Path $workspace ('codex_bridge/Runtime/operations/'+$operation+'/terminal.json'))|ConvertFrom-Json
    if($canonical.requestedVersion -cne 'requested-new' -or $canonical.phase -cne 'NOT_APPLIED'){throw 'canonical requested version lost'};$checks++
    $wirePath=Join-Path $fixture 'real-native-wire.json';Put $wirePath $wire
    & node.exe (Join-Path $PSScriptRoot 'workspace-daily-terminal-projection.mjs') $wirePath
    if($LASTEXITCODE -ne 0){throw 'Workspace projection failed'};$checks++
    # A legacy local intent cannot acquire remote authority through replay.
    $legacyId=[guid]::NewGuid().ToString();$legacyOp=$legacyId.Replace('-','')
    Put (Join-Path $workspace ('codex_bridge/Runtime/operations/'+$legacyOp+'/intent.json')) '{"old":"v1","next":"v2"}'
    $null=[McpCc.WorkspaceLocal.DailyTerminalFixture]::Send($owner,'update',$legacyId)
    $legacyRequest=$owner.TakePendingUpdate()
    $owner.CompleteUpdate($legacyId,'RECOVERY_REQUIRED','DAILY_REQUEST_BINDING_MISSING',$null,$null,$null,$null,$null)
    $null=[McpCc.WorkspaceLocal.DailyTerminalFixture]::Send($owner,'update',$legacyId)
    $legacyRequest=$owner.TakePendingUpdate()
    & $module {function script:Get-McpCcUpdateDefinition {param($Workspace,$Id) return @{root=$Workspace}}}
    $ownerCalls=Join-Path $workspace 'codex_bridge/Runtime/owner-calls.txt';$ownerHash=(Get-FileHash $ownerCalls).Hash
    Invoke-McpCcWorkspaceUpdate $owner $legacyRequest ([pscustomobject]@{codeDeployment=@{workspaceRoot=$workspace}}) $fixture
    if($owner.ReadUpdate($legacyId).phase -cne 'RECOVERY_REQUIRED' -or (Get-FileHash $ownerCalls).Hash -cne $ownerHash){throw 'unbound remote recovery reached lifecycle owner'};$checks++
    if(Test-Path (Join-Path $workspace ('codex_bridge/Runtime/operations/'+$legacyOp+'/request.json'))){throw 'legacy intent was rebound'};$checks++
    Write-Output ('PASS canonical/CC/Workspace terminal seam: '+$checks+' total checks; wire='+$wirePath)
}finally{$owner.Dispose()}
