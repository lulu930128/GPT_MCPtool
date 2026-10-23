# Source control-flow tests only; never counted as Windows IPC acceptance.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$count=0
foreach($file in @('scripts/process-identity.ps1','scripts/cooperative-shutdown-host.ps1','scripts/codex-bridge-runtime.psm1',
  'tests/diagnose-fixture-listener.ps1','tests/test-cooperative-source.ps1','tests/test-runtime-control.ps1','tests/test-lifecycle-preflight.ps1')){
  $tokens=$null;$errors=$null
  [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $root $file),[ref]$tokens,[ref]$errors)
  if($errors){throw ($errors|Out-String)};$count++
}
$tokens=$null;$errors=$null
$hostAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'scripts/cooperative-shutdown-host.ps1'),[ref]$tokens,[ref]$errors)
$aclFunction=$hostAst.Find({param($node) $node-is[Management.Automation.Language.FunctionDefinitionAst]-and$node.Name-eq'Assert-LocalPipeAcl'},$true)
if($null-eq$aclFunction){throw 'ACL verifier missing'}
$ownerSid='S-1-5-21-1-2-3-1001'
$allow=[pscustomobject]@{AccessControlType=[Security.AccessControl.AccessControlType]::Allow;IdentityReference=[pscustomobject]@{Value=$ownerSid};PipeAccessRights=[IO.Pipes.PipeAccessRights]::FullControl}
$deny=[pscustomobject]@{AccessControlType=[Security.AccessControl.AccessControlType]::Deny;IdentityReference=[pscustomobject]@{Value='S-1-5-2'};PipeAccessRights=[IO.Pipes.PipeAccessRights]::FullControl}
$acl=[pscustomobject]@{AreAccessRulesProtected=$true;rules=@($allow,$deny)}
$acl|Add-Member ScriptMethod GetAccessRules {param($explicit,$inherited,$type) return $this.rules}
$stream=[pscustomobject]@{acl=$acl}
$stream|Add-Member ScriptMethod GetAccessControl {return $this.acl}
& $aclFunction.Body.GetScriptBlock() $stream $ownerSid
$count++
foreach($case in @('unprotected','missing-network-deny','foreign-allow')){
  $acl.AreAccessRulesProtected=$case-ne'unprotected'
  $acl.rules=if($case-eq'missing-network-deny'){@($allow)}else{@($allow,$deny)}
  $allow.IdentityReference.Value=if($case-eq'foreign-allow'){'S-1-1-0'}else{$ownerSid}
  try{& $aclFunction.Body.GetScriptBlock() $stream $ownerSid;throw 'EXPECTED_FAILURE'}catch{if($_.Exception.Message-cne'IPC_ACL_REJECTED'){throw}}
  $count++
}
# Exercise the actual CC producer, wrapper decoder/invocation builder and Host
# verifier in memory. No controller, process, named pipe or lifecycle is started.
$managerRoot=Join-Path (Split-Path -Parent $root) 'mcp_control_center'
$managerAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $managerRoot 'src/McpControlCenter.Core.psm1'),[ref]$tokens,[ref]$errors)
if($errors){throw ($errors|Out-String)}
$producer=$managerAst.Find({param($n) $n-is[Management.Automation.Language.FunctionDefinitionAst]-and$n.Name-eq'Invoke-McpCcBoundedPowerShell'},$true)
$quote=$managerAst.Find({param($n) $n-is[Management.Automation.Language.FunctionDefinitionAst]-and$n.Name-eq'ConvertTo-McpCcWindowsArgument'},$true)
$producerText=$quote.Extent.Text
foreach($name in @('wrapperPath','argumentDocument','argumentsBase64','processArguments','argumentLine')){
  $assignment=$producer.Find({param($n) $n-is[Management.Automation.Language.AssignmentStatementAst]-and$n.Left.Extent.Text-ceq('$'+$name)},$true)
  if($null-eq$assignment){throw ('CC producer assignment missing: '+$name)}
  $producerText+="`n"+$assignment.Extent.Text
}
$produce=[scriptblock]::Create('param([string]$ProducerRoot) $PSScriptRoot=$ProducerRoot'+"`n"+$producerText+"`n"+'$argumentLine')
$resultPipe=[pscustomobject]@{}
$resultPipe|Add-Member ScriptMethod GetClientHandleAsString {return '1234'}
$MaxCapturedOutputBytes=65536
$hostVerifier=$hostAst.Find({param($n) $n-is[Management.Automation.Language.FunctionDefinitionAst]-and$n.Name-eq'Test-CbCooperativeControllerCommandLine'},$true)
if($null-eq$hostVerifier){throw 'Controller command verifier missing'}
$verifyBody=$hostVerifier.Body.Extent.Text
$verify=[scriptblock]::Create('param([string]$CommandLine,[string]$ScriptsRoot) $PSScriptRoot=$ScriptsRoot'+"`n"+$verifyBody.Substring(1,$verifyBody.Length-2))
$wrapperAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $managerRoot 'scripts/invoke-component-controller.ps1'),[ref]$tokens,[ref]$errors)
if($errors){throw ($errors|Out-String)}
$decodeText=''
foreach($name in @('argumentJson','argumentDocument','controllerArguments','invocationTokens')){
  $assignment=$wrapperAst.Find({param($n) $n-is[Management.Automation.Language.AssignmentStatementAst]-and$n.Left.Extent.Text-ceq('$'+$name)},$true)
  if($null-eq$assignment){throw ('Wrapper assignment missing: '+$name)}
  $decodeText+="`n"+$assignment.Extent.Text
}
$invocationLoop=$wrapperAst.Find({param($n) $n-is[Management.Automation.Language.ForEachStatementAst]-and$n.Variable.VariablePath.UserPath-ceq'controllerArgument'},$true)
$decode=[scriptblock]::Create($decodeText+"`n"+$invocationLoop.Extent.Text+"`n"+'$invocationTokens -join '' ''')
$addScript=$wrapperAst.Find({param($n) $n-is[Management.Automation.Language.InvokeMemberExpressionAst]-and$n.Extent.Text-ceq'$controllerPowerShell.AddScript(($invocationTokens -join '' ''))'},$true)
if($null-eq$addScript){throw 'Wrapper no longer invokes the decoded controller in its runspace'}
$count++
function Test-ControllerCommand([string]$Line,[string]$ScriptsRoot){
  # Bind the physical Host script location without running its top-level pipe loop.
  return (& $verify $Line $ScriptsRoot)
}
function New-ManagerCommand([string]$TreeRoot,[string[]]$ControllerArguments){
  $producerRoot=Join-Path $TreeRoot 'mcp_control_center/src'
  $ScriptPath=Join-Path $TreeRoot 'codex_bridge/scripts/runtime-control.ps1'
  $Arguments=$ControllerArguments
  return ('"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" '+(& $produce $producerRoot))
}
$sourceTree=Split-Path -Parent $root
# Include a relocated release with spaces; no such tree is read or created.
foreach($tree in @($sourceTree,'C:\fixture release\versions\r10')){
  $scriptsRoot=Join-Path $tree 'codex_bridge/scripts'
  foreach($action in @('RestartCore','ReloadRuntime','ShutdownRuntime')){
    $line=New-ManagerCommand $tree @('-Action',$action)
    if(-not(Test-ControllerCommand $line $scriptsRoot)){throw ('Formal CC command rejected: '+$action)};$count++
    $ArgumentsBase64=[regex]::Match($line,'-ArgumentsBase64 ([A-Za-z0-9+/=]+)').Groups[1].Value
    $ControllerPath=Join-Path $scriptsRoot 'runtime-control.ps1'
    $invocation=& $decode
    $expected="& '$($ControllerPath.Replace("'", "''"))' -Action '$action'"
    if($invocation-cne$expected){throw 'Wrapper invocation differs from verified controller/action'};$count++
  }
}
$scriptsRoot=Join-Path $root 'scripts'
$valid=New-ManagerCommand $sourceTree @('-Action','ReloadRuntime')
$wrapperPath=Join-Path $managerRoot 'scripts\invoke-component-controller.ps1'
$controllerPath=Join-Path $scriptsRoot 'runtime-control.ps1'
$payload=[regex]::Match($valid,'-ArgumentsBase64 ([A-Za-z0-9+/=]+)').Groups[1].Value
$rejected=@(
  $valid.Replace($wrapperPath,$wrapperPath+'.other.ps1'),
  $valid.Replace($controllerPath,$controllerPath+'.other.ps1'),
  $valid.Replace($wrapperPath,'C:\other-release\mcp_control_center\scripts\invoke-component-controller.ps1'),
  ($valid+' -Action ReloadRuntime'),
  ($valid+' -ControllerPath "'+$controllerPath+'"'),
  ($valid+' -File "'+$controllerPath+'" -Action ReloadRuntime'),
  ($valid+' -Command exit'),
  $valid.Replace('-NoProfile','-NoProfile -EncodedCommand ZQB4AGkAdAA='),
  $valid.Replace('-ResultPipeHandle 1234','-ResultPipeHandle 0'),
  $valid.Replace('-MaxCapturedOutputBytes 65536','-MaxCapturedOutputBytes 1048577'),
  $valid.Replace('-MaxCapturedOutputBytes 65536','-MaxCapturedOutputBytes 1023'),
  $valid.Replace($payload,$payload.ToLowerInvariant()),
  $valid.Replace($payload,'malformed!'),
  (New-ManagerCommand $sourceTree @('-Action','Status')),
  (New-ManagerCommand $sourceTree @('-Action','EnsureRunning')),
  (New-ManagerCommand $sourceTree @('-Action','ReloadRuntime','-ProjectRoot','C:\other')),
  (New-ManagerCommand $sourceTree @('-Action','ReloadRuntime','-Action','ShutdownRuntime')),
  (New-ManagerCommand $sourceTree @('-Action','ReloadRuntime; exit'))
)
foreach($json in @('{"arguments":["-Action","ReloadRuntime"],"extra":true}',
  '{"arguments":["-Action","Status"],"arguments":["-Action","ReloadRuntime"]}',
  '{"arguments":"-Action ReloadRuntime"}')){
  $rejected+=$valid.Replace($payload,[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
}
foreach($line in $rejected){
  if(Test-ControllerCommand $line $scriptsRoot){throw 'Untrusted wrapper command accepted'};$count++
}
if(Test-ControllerCommand $valid 'C:\other-release\codex_bridge\scripts'){throw 'Cross-release client accepted'};$count++
foreach($action in @('RestartCore','ReloadRuntime','ShutdownRuntime')){
  $direct='"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "'+$controllerPath+'" -Action '+$action+' -ProjectRoot "'+$root+'"'
  if(-not(Test-ControllerCommand $direct $scriptsRoot)){throw 'Existing direct controller rejected'};$count++
  if(Test-ControllerCommand ($direct.Replace(' -File ',' -Command ')) $scriptsRoot){throw 'Command entry accepted'};$count++
}
Add-Type -Path (Join-Path $root 'scripts/OwnedProcess.Native.cs') -ErrorAction Stop
$count++
$module=Import-Module (Join-Path $root 'scripts/codex-bridge-runtime.psm1') -PassThru -Force
& $module {
  param($root)
  # File checks are observed in memory. Never generate a dist or touch a live process.
  $script:checkedPaths=New-Object 'System.Collections.Generic.List[string]'
  $script:missingSource=$false
  function script:Test-CbInstalledLayout {return $false}
  function script:Test-Path {param($LiteralPath,$PathType)
    $script:checkedPaths.Add($LiteralPath)
    return -not($script:missingSource-and$LiteralPath-like'*process-identity.js')
  }
  $context=[pscustomobject]@{projectRoot=$root}
  Assert-CbCooperativeSourceAvailable $context
  if($script:checkedPaths.Count-ne 7){throw 'Incomplete dependency closure check'}
  $script:missingSource=$true
  try{Assert-CbCooperativeSourceAvailable $context;throw 'EXPECTED_FAILURE'}catch{
    if($_.Exception.Message-notlike'COOPERATIVE_SOURCE_INCOMPLETE:*'){throw}
  }
  Remove-Item Function:script:Test-Path
} $root
$count+=2
& $module {
  function script:Resolve-CbRoleOwnership {param($Context,$Role,[switch]$ReadOnly) $Context.ownership}
  function script:Assert-CbIdleForMutation {param($Context) if($Context.busy){throw 'ACTIVE_WORK_PRESENT'}}
  function script:Invoke-CbCooperativeExchange {param($Context,$ProcessId,$Action)
    if($Action-cne'probe'-or$ProcessId-ne 123){throw 'BAD_PROBE_BINDING'}
    if($Context.unavailable){throw 'BLOCKED_GRACEFUL_SHUTDOWN_UNAVAILABLE'}
    $Context.probes++
  }
  $context=[pscustomobject]@{ownership=[pscustomobject]@{canMutate=$true;state='OwnedReady';pid=123};busy=$false;unavailable=$false;probes=0}
  Assert-CbCooperativeShutdownAvailable $context
  if($context.probes-ne 1){throw 'Running core did not probe its verified channel'}
  $context.busy=$true
  try{Assert-CbCooperativeShutdownAvailable $context;throw 'EXPECTED_FAILURE'}catch{if($_.Exception.Message-cne'ACTIVE_WORK_PRESENT'){throw}}
  $context.busy=$false;$context.unavailable=$true
  try{Assert-CbCooperativeShutdownAvailable $context;throw 'EXPECTED_FAILURE'}catch{if($_.Exception.Message-cne'BLOCKED_GRACEFUL_SHUTDOWN_UNAVAILABLE'){throw}}
  $context.ownership.state='Stopped'
  Assert-CbCooperativeShutdownAvailable $context
  if($context.probes-ne 1){throw 'Stopped core must not probe or start a channel'}
}
$count+=4
& $module {
  $script:events=New-Object 'System.Collections.Generic.List[string]'
  function script:Assert-CbInstalledMutationBlocked {param($Context)}
  function script:Get-CbExpectedBuildId {param($Context) 'fixture'}
  function script:Assert-CbShutdownPreflight {param($Context) $script:events.Add('ownership')}
  function script:Assert-CbStartupPreflight {param($Context,[switch]$IncludeTunnel) $script:events.Add('startup')}
  function script:Assert-CbCooperativeShutdownAvailable {param($Context) $script:events.Add('probe')}
  function script:Stop-CbOwnedRole {param($Context,$Role) $script:events.Add('stop-'+$Role)}
  function script:Start-CbServer {param($Context) $script:events.Add('start')}
  function script:Repair-CbConnectivity {param($Context) $script:events.Add('repair')}
}
foreach($case in @(
  @{action='RestartCore';expected='ownership,startup,probe,stop-server,start'},
  @{action='ReloadRuntime';expected='ownership,startup,probe,stop-server,start,repair'},
  @{action='ShutdownRuntime';expected='ownership,probe,stop-server,stop-tunnel'})){
  & $module {$script:events.Clear()}
  Invoke-CodexBridgeLifecycleAction -Context ([pscustomobject]@{}) -Action $case.action
  $actual=& $module {$script:events-join','}
  if($actual-cne$case.expected){throw "sequence: $actual"};$count++
}
foreach($errorCode in @('ACTIVE_WORK_PRESENT','COOPERATIVE_SHUTDOWN_UNKNOWN','BLOCKED_GRACEFUL_SHUTDOWN_UNAVAILABLE')){
  & $module {param($code) $script:failure=$code;function script:Stop-CbOwnedRole {param($Context,$Role) $script:events.Add('stop-'+$Role);throw $script:failure}} $errorCode
  foreach($action in @('RestartCore','ReloadRuntime','ShutdownRuntime')){
    & $module {$script:events.Clear()}
    try{Invoke-CodexBridgeLifecycleAction -Context ([pscustomobject]@{}) -Action $action;throw 'EXPECTED_FAILURE'}catch{if($_.Exception.Message-cne$errorCode){throw}}
    $events=& $module {$script:events.ToArray()}
    if(@($events|Where-Object{$_-in@('stop-tunnel','start','repair')}).Count){throw 'refusal mutated tunnel or restarted'};$count++
  }
}
Write-Output "PASS: $count parser/native-compile/control-flow checks (SOURCE_ONLY; no IPC acceptance)"
