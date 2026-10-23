Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $root 'src\McpControlCenter.SelfReload.Owner.psm1')
$passed=0
function Check([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:passed++}
foreach($file in @('src\McpControlCenter.SelfReload.psm1','src\McpControlCenter.SelfReload.Owner.psm1','scripts\tray.ps1')) {
    $tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile((Join-Path $root $file),[ref]$tokens,[ref]$errors)
    Check ($errors.Count -eq 0) "AST: $file"
}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$name='McpCc.R1.Synthetic.'+[guid]::NewGuid().ToString('N')
$server=[McpCcReloadNative]::OpenPipe($sid,$sid,$name)
$client=New-Object IO.Pipes.NamedPipeClientStream('.', $name,[IO.Pipes.PipeDirection]::InOut,[IO.Pipes.PipeOptions]::Asynchronous,[Security.Principal.TokenImpersonationLevel]::Identification)
try {
    $wait=$server.WaitForConnectionAsync();$client.Connect(1000);Check ($wait.Wait(1000)) 'Synthetic pipe connected'
    Check ([McpCcReloadNative]::ServerPid($client) -eq $PID) 'OS authenticates actual server process'
    # Impersonation identity is available only after the server has read at least one message.
    $client.WriteByte(1);Check ($server.ReadByte() -eq 1) 'Pipe byte delivered'
    Check ([McpCcReloadNative]::ClientPid($server,$sid) -eq $PID) 'OS authenticates actual client process and SID'
    $denied=$false;try{[void][McpCcReloadNative]::ClientPid($server,'S-1-5-18')}catch{$denied=$true};Check $denied 'Wrong SID rejected'
    $squat=$null;$denied=$false;try{$squat=[McpCcReloadNative]::OpenPipe($sid,$sid,$name)}catch{$denied=$true}finally{if($squat){$squat.Dispose()}}
    Check $denied 'First pipe instance prevents name squatting while dispatching'
}finally{$client.Dispose();$server.Dispose()}
$owner=Get-Content -LiteralPath (Join-Path $root 'src\McpControlCenter.SelfReload.Owner.psm1') -Raw
Check ($owner -match "Invoke-McpCcComponentAction -Manifest \`$manifest -ComponentId 'codex_bridge' -Action 'reload_runtime'") 'Single fixed existing controller action'
Check ($owner -notmatch 'Stop-Process|Start-Process|\bRunAs\b|Register-ScheduledTask') 'Owner has no parallel lifecycle or elevation implementation'
Check ($owner -match 'OutsideAllJobs' -and $owner -match 'RUNTIME_IDENTITY_MISMATCH' -and $owner -match 'PROTECTED_INSTALL_REQUIRED') 'Deployment guards remain mandatory'
$script:statusFixture=401
$module=Get-Module McpControlCenter.SelfReload.Owner
& $module {
    function script:Invoke-WebRequest {
        $e=New-Object Exception('Synthetic HTTP auth');$e|Add-Member NoteProperty Response ([pscustomobject]@{StatusCode=401});throw $e
    }
}
$schema=Test-R1ToolSchema
Check (-not $schema.verified -and $schema.code -eq 'AUTHENTICATED_CONNECTOR_REQUIRED') '401 is a separate schema gate, never a fabricated reload failure'
# Exercise the actual production callback assignments in their module session state.
# Only the external controller/HTTP boundaries are synthetic; no runtime is invoked.
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'src\McpControlCenter.SelfReload.Owner.psm1'),[ref]$tokens,[ref]$errors)
$loop=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-R1OwnerLoop'},$true)
$assignments=@($loop.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and $node.Left.VariablePath.UserPath -in @('ownerModule','snapshot','execute','postcheck')},$true)|Sort-Object {$_.Extent.StartOffset})
Check ($assignments.Count -eq 4) 'Production owner callback assignments found'
$callbackSource=($assignments|ForEach-Object {$_.Extent.Text}) -join "`n"
$wiring=& $module {
    param($code)
    $script:fixtureSnapshot=[pscustomobject]@{oldPid=8101;oldBuildId='1111111111111111';targetBuildId='2222222222222222';active=0;awaitingApproval=0;
        controller='ready';scope='all';drainRequestId='fixture';drainExpiresAt=[DateTime]::UtcNow.AddMinutes(5).ToString('o');ownerVerified=$true}
    $script:fixtureDispatch=0
    function script:Get-R1RuntimeSnapshot { $script:fixtureSnapshot }
    function script:Read-R1Http { 'ready' }
    function script:Test-R1ToolSchema { [pscustomobject]@{verified=$false;code='AUTHENTICATED_CONNECTOR_REQUIRED';hostCacheVerified=$false} }
    function script:Invoke-McpCcComponentAction {
        param($Manifest,$ComponentId,$Action,$RuntimeRoot)
        if ($ComponentId -cne 'codex_bridge' -or $Action -cne 'reload_runtime') {throw 'Wrong action'}
        $script:fixtureDispatch++;[pscustomobject]@{delegated=$true;exitCode=0}
    }
    $manifest=[pscustomobject]@{};$RuntimeRoot='SYNTHETIC_NOT_USED'
    . ([scriptblock]::Create($code))
    $r=[pscustomobject]@{requestId='fixture';oldPid=8101;oldBuildId='1111111111111111';targetBuildId='2222222222222222';expiresAt=$script:fixtureSnapshot.drainExpiresAt}
    $before=& $snapshot;$action=& $execute $r
    $script:fixtureSnapshot.active=1;$blocked=$false;try{& $execute $r|Out-Null}catch{$blocked=$true}
    $script:fixtureSnapshot.active=0;$script:fixtureSnapshot.oldPid=8102;$script:fixtureSnapshot.oldBuildId=$r.targetBuildId
    $after=& $postcheck $r $action
    [pscustomobject]@{beforePid=$before.oldPid;dispatches=$script:fixtureDispatch;activeBlocked=$blocked;evidence=$after}
} $callbackSource
Check ($wiring.dispatches -eq 1) 'Production callback delegates exactly once through the fixed existing mapping'
Check $wiring.activeBlocked 'Production callback rechecks active jobs immediately before delegation'
Check ($wiring.evidence.ok -and $wiring.evidence.newPid -eq 8102 -and -not $wiring.evidence.schema.verified) 'Local reload and authenticated schema remain separate in production postcheck'
[pscustomobject]@{ok=$true;assertions=$passed;synthetic=$true;liveDeployed=$false}|ConvertTo-Json
