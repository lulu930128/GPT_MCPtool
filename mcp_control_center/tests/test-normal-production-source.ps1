[CmdletBinding()]
param()
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSEdition -cne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) { throw 'WINDOWS_POWERSHELL_51_REQUIRED' }
$root=Split-Path -Parent $PSScriptRoot
$sources=@('NormalOperator.Native.cs','NormalOperator.Pipe.cs','NormalOperator.Security.cs','NormalOperator.Execution.cs','NormalOperator.Host.cs') |
    ForEach-Object { Join-Path $root ('src\'+$_) }
# In-memory isolated compilation only; no production DLL/dist or release tree write.
Add-Type -Path $sources -ReferencedAssemblies System.Web.Extensions,System.Core,System.Security,System.Windows.Forms,System.Drawing
$checks=0
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'src\McpControlCenter.NormalOperator.psm1'),[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'NORMAL_OPERATOR_PARSE_FAILED' }; $checks++
$calls=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst]},$true) | ForEach-Object {$_.GetCommandName()})
if ('Read-McpCcInstalledRelease' -notin $calls -or 'Assert-McpCcInstalledClosure' -notin $calls) { throw 'CANONICAL_INSTALL_CHECK_MISSING' }
if ($ast.Extent.Text -match 'normal-operator-source.json' -or $ast.Extent.Text -notmatch 'SINGLE_TRAY_OWNER_REQUIRED' -or $ast.Extent.Text -notmatch 'AUTHENTICATED_DIRECT_REQUEST_REQUIRED') { throw 'HOST_GATE_CHANGED' }; $checks++
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$descriptor=[McpCcNormalPipe]::Descriptor($sid,$sid)
[McpCcNormalSecurity]::AssertPipeDescriptor($descriptor,$sid,$sid); $checks++
$bad=New-Object Security.AccessControl.RawSecurityDescriptor('O:'+$sid+'D:P(A;;GA;;;WD)')
$bytes=New-Object byte[] $bad.BinaryLength; $bad.GetBinaryForm($bytes,0)
try { [McpCcNormalSecurity]::AssertPipeDescriptor($bytes,$sid,$sid); throw 'BAD_DACL_ACCEPTED' }
catch { if ($_.Exception.GetBaseException().Message -cne 'IPC_DACL_REJECTED') { throw } }; $checks++
$current=Get-Process -Id $PID
try {
    # Only this isolated test process; no live service/PID inventory or token changes.
    try { $proof=[McpCcNormalSecurity]::Observe($current) }
    catch {
        $failure=$_.Exception.GetBaseException()
        [pscustomobject]@{ operation=$failure.Data['operation']; informationClass=$failure.Data['informationClass'];
            returnedBytes=$failure.Data['returnedBytes']; hresult=$failure.HResult;
            nativeErrorCode=$(if($failure -is [ComponentModel.Win32Exception]){$failure.NativeErrorCode}else{$null}) } | ConvertTo-Json -Compress | Write-Output
        throw
    }
    if($proof.sid -cne $sid -or $proof.tokenId -cnotmatch '^[a-f0-9]{16}$' -or $proof.logonId -cnotmatch '^[a-f0-9]{16}$') { throw 'TOKEN_OBSERVATION_INVALID' }
    [McpCcNormalSecurity]::AssertUnchanged($current,$proof)
} finally { $current.Dispose() }; $checks++
$packet=New-Object 'McpCcNormalExecution+Packet'
$packet.requestId=[Guid]::NewGuid().ToString('D'); $packet.grantId=[Guid]::NewGuid().ToString('D'); $packet.consumptionId=[Guid]::NewGuid().ToString('D')
$packet.digest=('a'*64); $packet.mode='NORMAL'; $packet.script="[Console]::Out.WriteLine('READ_ONLY_ACCEPTANCE')"
$packet.scriptSha256=[McpCcNormalExecution]::Sha256([Text.Encoding]::UTF8.GetBytes($packet.script))
$packet.cwd=$root; $packet.args=@('','literal value'); $packet.expectedSid=$sid
$now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); $packet.expiresAt=$now+60000; $packet.receiptDeadline=$now+90000
[McpCcNormalExecution]::Validate($packet); $checks++
$savedCwd=$packet.cwd
foreach($cwd in @('C:\','C:\outside-configured-project','\\fixture-host\fixture-share\folder')) {
    $packet.cwd=$cwd;[McpCcNormalExecution]::Validate($packet)
}
foreach($cwd in @('C:relative','\root-relative','\\.\pipe\example','\\?\C:\folder','C:\folder\..\other')) {
    $packet.cwd=$cwd
    try { [McpCcNormalExecution]::Validate($packet);throw 'INVALID_CWD_ACCEPTED' }
    catch { if($_.Exception.GetBaseException().Message -cne 'NORMAL_CWD_REJECTED'){throw} }
}
$packet.cwd=$savedCwd;$checks++
$packet.script+='; changed'
try { [McpCcNormalExecution]::Validate($packet); throw 'CHANGED_SCRIPT_ACCEPTED' }
catch { if ($_.Exception.GetBaseException().Message -cne 'SCRIPT_DIGEST_MISMATCH') { throw } }; $checks++
$packet.script="[Console]::Out.WriteLine('READ_ONLY_ACCEPTANCE')"
# Exercise the public production entry; the guard must reject before Run/Process.Start.
# This is a refusal check, NOT a positive Host/Runner/OS-execution acceptance.
try { $null=[McpCcNormalExecution]::Execute($packet); throw 'UNAUTHENTICATED_RUNNER_ACCEPTED' }
catch { if ($_.Exception.GetBaseException().Message -cne 'BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED') { throw } }; $checks++
$packet.mode='ADMIN'
try { [McpCcNormalExecution]::Validate($packet); throw 'ADMIN_ACCEPTED' }
catch { if ($_.Exception.GetBaseException().Message -cne 'BLOCKED_AWAITING_LOCAL_UAC') { throw } }; $checks++
$bootstrap=[McpCcNormalExecution].GetField('Bootstrap',[Reflection.BindingFlags]'Static,NonPublic').GetRawConstantValue()
$null=[Management.Automation.Language.Parser]::ParseInput($bootstrap,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'RUNNER_BOOTSTRAP_PARSE_FAILED'}; $checks++
# Verify full native capture without launching PowerShell or touching a live Host.
$capture=[McpCcNormalExecution].GetMethod('Capture',[Reflection.BindingFlags]'Static,NonPublic')
$bytes=[Text.Encoding]::UTF8.GetBytes(('full output '+[char]0x4e2d)*10000)
$stream=New-Object IO.MemoryStream(,$bytes)
try {
    $task=$capture.Invoke($null,[object[]]@($stream.PSObject.BaseObject));$captured=$task.GetAwaiter().GetResult()
    if($captured.Length -ne $bytes.Length -or [McpCcNormalExecution]::Sha256($captured) -cne [McpCcNormalExecution]::Sha256($bytes)){throw 'CAPTURE_TRUNCATED'}
} finally { $stream.Dispose() };$checks++
# Execute the actual owner loop with inert listeners. Failed and completed
# sessions must both permit a new request, without a UI callback or dispatch.
$definition=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Invoke-McpCcNormalOperatorOwner'},$true)
Invoke-Expression $definition.Extent.Text
$script:ownerAttempts=0;$script:listenerDisposals=0
$script:ownerCancellation=New-Object Threading.CancellationTokenSource
function Open-McpCcNormalInstalledContext {
    $peer=[pscustomobject]@{};$peer | Add-Member ScriptMethod Dispose { }
    [pscustomobject]@{peer=$peer;sessionCheckedAt=$null;channel=[guid]::NewGuid();release=[pscustomobject]@{state=[pscustomobject]@{operatorSid='inert-test'}}}
}
function Assert-McpCcNormalClosure { }
function Get-NormalOperatorFailure { throw 'UNEXPECTED_OWNER_LOOP_FAILURE' }
function New-Object {
    param([string]$TypeName,$ArgumentList)
    if($TypeName -cne 'McpCcNormalPipe+Listener'){throw 'UNEXPECTED_OWNER_ALLOCATION'}
    $listener=[pscustomobject]@{}
    $listener | Add-Member ScriptMethod Serve {
        param($resolve,$handler,$cancellation)
        $script:ownerAttempts++
        if($script:ownerAttempts -eq 1){throw [IO.IOException]::new('isolated failed exchange')}
        if($script:ownerAttempts -eq 3){$script:ownerCancellation.Cancel()}
        if($script:ownerAttempts -gt 3){throw 'OWNER_DID_NOT_CANCEL'}
    }
    $listener | Add-Member ScriptMethod Dispose {$script:listenerDisposals++}
    return $listener
}
try {
    $state=Invoke-McpCcNormalOperatorOwner -ManagerRoot 'inert' -TrayProcessId $PID -Cancellation $script:ownerCancellation.Token
    if($state.status -cne 'STOPPED' -or $script:ownerAttempts -ne 3 -or $script:listenerDisposals -ne 3){throw 'OWNER_DID_NOT_ACCEPT_NEXT_REQUEST'}
} finally { $script:ownerCancellation.Dispose() };$checks++
# Execute the actual bounded reuse checks with inert dependencies. Never read a
# protected release, change ACLs, open a native pipe or launch a command here.
foreach($name in @('Assert-McpCcNormalBinding','Assert-McpCcNormalClosure','Assert-McpCcNormalSession')) {
    $definition=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
    Invoke-Expression $definition.Extent.Text
}
$script:deepChecks=0;$script:aclChecks=0;$script:fakeHash='pinned';$script:rejectAcl=$false
function Assert-McpCcInstalledClosure { $script:deepChecks++ }
function Assert-McpCcProtectedCodePath { $script:aclChecks++;if($script:rejectAcl){throw 'PROTECTED_WRITE_REJECTED'} }
function Get-FileHash { [pscustomobject]@{Hash=$script:fakeHash} }
$peer=[pscustomobject]@{checks=0;dead=$false}
$peer | Add-Member ScriptMethod Check { if($this.dead){throw 'PEER_EXITED'};$this.checks++ }
$context=[pscustomobject]@{release=[pscustomobject]@{sourcePath='inert'};pin='pinned';peer=$peer;sessionCheckedAt=$null}
Assert-McpCcNormalClosure $context
$context.sessionCheckedAt=[Diagnostics.Stopwatch]::GetTimestamp()
Assert-McpCcNormalSession $context
if($script:deepChecks -ne 1 -or $script:aclChecks -ne 3 -or $peer.checks -ne 3 -or $null -ne $context.sessionCheckedAt){throw 'SESSION_REUSE_INVALID'}
try { Assert-McpCcNormalSession $context;throw 'REPLAY_ACCEPTED' } catch { if($_.Exception.Message -cne 'NORMAL_SESSION_UNVERIFIED'){throw} }
foreach($failure in @('manifest','expired','acl','peer')) {
    $context.sessionCheckedAt=[Diagnostics.Stopwatch]::GetTimestamp()
    $expected=switch($failure) {
        'manifest' { $script:fakeHash='changed';'INSTALLED_CLOSURE_CHANGED' }
        'expired' { $context.sessionCheckedAt-=[Diagnostics.Stopwatch]::Frequency*121;'NORMAL_SESSION_EXPIRED' }
        'acl' { $script:rejectAcl=$true;'PROTECTED_WRITE_REJECTED' }
        'peer' { $peer.dead=$true;'PEER_EXITED' }
    }
    try { Assert-McpCcNormalSession $context;throw 'STALE_SESSION_ACCEPTED' }
    catch { if($_.Exception.GetBaseException().Message -cne $expected){throw} }
    if($null -ne $context.sessionCheckedAt){throw 'FAILED_SESSION_REUSABLE'}
    $script:fakeHash='pinned';$script:rejectAcl=$false;$peer.dead=$false
}
Assert-McpCcNormalClosure $context
if($script:deepChecks -ne 2){throw 'NEW_SESSION_SKIPPED_CLOSURE'};$checks++
[pscustomobject]@{ checks=$checks; result='PASS'; nativeCompile='PASS'; currentTestToken='OS_OBSERVED';
    productionEntry='REFUSED_BEFORE_LAUNCH'; nativePipeExchange='NOT_RUN'; runnerExecution='NOT_RUN';
    hostApproval='REMOTE_REQUEST_SOURCE_ONLY'; liveMutation=$false } | ConvertTo-Json -Compress
