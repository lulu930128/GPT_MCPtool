param([Parameter(Mandatory=$true)][int]$CoreId,[Parameter(Mandatory=$true)][Guid]$Instance)
# Transport adapter owned by http-main. No launch, stop, approval, Journal or secret API.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$pipe=$null;$core=$null;$client=$null;$reader=$null;$stage='LOAD_NATIVE'
function Read-LineBounded($stream,[int]$Milliseconds=5000) {
  $bytes=New-Object byte[] 8192;$length=0;$clock=[Diagnostics.Stopwatch]::StartNew()
  while($length-lt$bytes.Length){
    $read=$stream.ReadAsync($bytes,$length,1);$left=$Milliseconds-[int]$clock.ElapsedMilliseconds
    if($left-le 0-or-not$read.Wait($left)-or$read.Result-ne 1){throw 'IPC_UNKNOWN'}
    if($bytes[$length]-eq 10){return [Text.Encoding]::UTF8.GetString($bytes,0,$length)};$length++
  };throw 'IPC_FRAME_LIMIT'
}
function Write-LineBounded($stream,$value) {
  $bytes=[Text.Encoding]::UTF8.GetBytes(($value|ConvertTo-Json -Compress -Depth 6)+"`n")
  if(-not$stream.WriteAsync($bytes,0,$bytes.Length).Wait(3000)){throw 'IPC_UNKNOWN'}
}
function Assert-LocalPipeAcl($stream,[string]$OwnerSid) {
  $acl=$stream.GetAccessControl()
  if(-not$acl.AreAccessRulesProtected){throw 'IPC_ACL_REJECTED'}
  $ownerAllowed=$false;$networkDenied=$false
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
    if($rule.AccessControlType-eq[Security.AccessControl.AccessControlType]::Allow){
      if($rule.IdentityReference.Value-cne$OwnerSid){throw 'IPC_ACL_REJECTED'}
      if(($rule.PipeAccessRights-band[IO.Pipes.PipeAccessRights]::FullControl)-eq[IO.Pipes.PipeAccessRights]::FullControl){$ownerAllowed=$true}
    }
    if($rule.AccessControlType-eq[Security.AccessControl.AccessControlType]::Deny-and$rule.IdentityReference.Value-ceq'S-1-5-2'-and
      ($rule.PipeAccessRights-band[IO.Pipes.PipeAccessRights]::FullControl)-eq[IO.Pipes.PipeAccessRights]::FullControl){$networkDenied=$true}
  }
  if(-not$ownerAllowed-or-not$networkDenied){throw 'IPC_ACL_REJECTED'}
}
function Test-CbCooperativeControllerCommandLine([string]$CommandLine) {
  if([string]::IsNullOrWhiteSpace($CommandLine)-or$CommandLine.Length-gt 32767){return $false}
  $entry=[regex]::Escape((Join-Path $PSScriptRoot 'runtime-control.ps1'))
  $exe=[regex]::Escape('C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')
  $executable='(?:"'+$exe+'"|'+$exe+')'
  $controller='(?:"'+$entry+'"|'+$entry+')'
  # Preserve the direct controller entry used by the existing local tray. Bind
  # -File at the actual entry position, never a substring in wrapper arguments.
  $direct='\A'+$executable+'[ \t]+(?:(?:-NoProfile|-NonInteractive|-ExecutionPolicy[ \t]+Bypass)[ \t]+)*-File[ \t]+'+$controller+'(?:[ \t]|\z)'
  if($CommandLine-imatch$direct){
    return ($CommandLine-notmatch '(?i)-(EncodedCommand|Command)\b'-and
      $CommandLine-match '(?i)-Action\s+"?(RestartCore|ReloadRuntime|ShutdownRuntime)"?(\s|$)')
  }
  # CC runs the controller in this wrapper's runspace, so the pipe client PID
  # belongs to the wrapper. Trust only the sibling in this source/release tree
  # and the complete fixed Invoke-McpCcBoundedPowerShell argument shape.
  $wrapperPath=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\mcp_control_center\scripts\invoke-component-controller.ps1'))
  $wrapper=[regex]::Escape($wrapperPath)
  $pattern='\A'+$executable+'[ \t]+-NoProfile[ \t]+-ExecutionPolicy[ \t]+Bypass[ \t]+-File[ \t]+(?:"'+$wrapper+'"|'+$wrapper+')'+
    '[ \t]+-ControllerPath[ \t]+'+$controller+'[ \t]+-ArgumentsBase64[ \t]+(?<payload>[A-Za-z0-9+/=]{1,256})'+
    '[ \t]+-ResultPipeHandle[ \t]+[1-9][0-9]{0,18}[ \t]+-MaxCapturedOutputBytes[ \t]+(?<limit>[0-9]{4,7})\z'
  $match=[regex]::Match($CommandLine,$pattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if(-not$match.Success){return $false}
  $limit=[int]$match.Groups['limit'].Value
  if($limit-lt 1024-or$limit-gt 1048576){return $false}
  # Compare canonical wire bytes, not loosely parsed JSON. Reject duplicate keys,
  # extra arguments/overrides, malformed data and case changes in Base64 itself.
  foreach($action in @('RestartCore','ReloadRuntime','ShutdownRuntime')){
    $json=[pscustomobject]@{arguments=@('-Action',$action)}|ConvertTo-Json -Compress
    $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    if($match.Groups['payload'].Value-ceq$encoded){return $true}
  }
  return $false
}
try {
  $runtime=Import-Module (Join-Path $PSScriptRoot 'codex-bridge-runtime.psm1') -PassThru -ErrorAction Stop
  & $runtime {Initialize-CbCooperativeNative}
  $core=[Diagnostics.Process]::GetProcessById($CoreId)
  $stage='INSPECT_CORE'
  $proof=[McpCcNormalNative]::Inspect($core)
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $stage='VERIFY_PARENT_CIM'
  $self=Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
  if($self.ParentProcessId-ne$CoreId-or$proof.sid-cne$sid-or$proof.elevated){throw 'CORE_IDENTITY_REJECTED'}
  $name='Cb.Core.Close.'+$CoreId+'.'+$proof.startedUtcTicks
  # Console.In is a synchronized reader whose ReadLineAsync can block the caller.
  $reader=New-Object IO.StreamReader([Console]::OpenStandardInput(),[Text.Encoding]::UTF8)
  $inputLine=$reader.ReadLineAsync()
  $stage='CREATE_LOCAL_PIPE'
  $pipe=[McpCcReloadNative]::OpenPipe($sid,$sid,$name)
  Assert-LocalPipeAcl $pipe $sid
  [Console]::WriteLine('{"type":"ready"}')
  while(-not$core.HasExited){
    $wait=$pipe.WaitForConnectionAsync()
    while(-not$wait.Wait(200)){if($inputLine.IsCompleted-or$core.HasExited){return}}
    try {
      # Client first sends one fixed byte; required for Windows pipe impersonation.
      $hello=New-Object byte[] 1;$read=$pipe.ReadAsync($hello,0,1)
      if(-not$read.Wait(3000)-or$read.Result-ne 1-or$hello[0]-ne 1){throw 'IPC_HELLO_REJECTED'}
      $clientId=[McpCcReloadNative]::ClientPid($pipe,$sid)
      $client=[Diagnostics.Process]::GetProcessById($clientId)
      $clientProof=[McpCcNormalNative]::Inspect($client)
      $command=Get-CimInstance Win32_Process -Filter "ProcessId=$clientId" -ErrorAction Stop
      if($clientProof.image-ine'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'-or
        $clientProof.sid-cne$sid-or$clientProof.session-ne$proof.session-or$clientProof.elevated-or
        -not(Test-CbCooperativeControllerCommandLine $command.CommandLine)) {throw 'CONTROLLER_IDENTITY_REJECTED'}
      [McpCcNormalNative]::AssertClient($pipe,$client,$clientProof)
      $nonce=[McpCcReloadNative]::Nonce()
      $binding=[ordered]@{contract='bridge-cooperative-close-v1';instance=$Instance.ToString();nonce=$nonce;pid=$CoreId;startedUtcTicks=[string]$proof.startedUtcTicks;image=$proof.image;sid=$proof.sid}
      Write-LineBounded $pipe $binding
      $request=(Read-LineBounded $pipe)|ConvertFrom-Json
      if(@($request.PSObject.Properties.Name).Count-ne 8-or$request.contract-cne$binding.contract-or
        $request.instance-cne$binding.instance-or$request.nonce-cne$nonce-or$request.pid-ne$CoreId-or
        $request.startedUtcTicks-cne$binding.startedUtcTicks-or$request.image-ine$proof.image-or
        $request.action-notin@('probe','shutdown')-or$request.requestId-notmatch'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'){throw 'IPC_BINDING_REJECTED'}
      [McpCcNormalNative]::AssertClient($pipe,$client,$clientProof)
      if($core.HasExited){throw 'CORE_EXITED'}
      if($request.action-eq'probe'){
        Write-LineBounded $pipe @{requestId=$request.requestId;nonce=$nonce;code='AVAILABLE'}
      }else{
        # One accepted message per connection. The nonce cannot be reused.
        [Console]::WriteLine(($request|ConvertTo-Json -Compress))
        if(-not$inputLine.Wait(25000)){throw 'IPC_UNKNOWN'}
        $line=$inputLine.Result
        if($null-eq$line-or$line.Length-gt 8192){throw 'IPC_UNKNOWN'}
        $result=$line|ConvertFrom-Json
        if($result.requestId-cne$request.requestId-or$result.nonce-cne$nonce-or$result.code-notin@('CLOSED','ACTIVE_WORK_PRESENT','UNKNOWN')){throw 'IPC_UNKNOWN'}
        [McpCcNormalNative]::AssertClient($pipe,$client,$clientProof)
        Write-LineBounded $pipe $result
        if($result.code-ne'ACTIVE_WORK_PRESENT'){return}
        $inputLine=$reader.ReadLineAsync()
      }
    }catch{[Console]::Error.WriteLine('COOPERATIVE_IPC_UNKNOWN')}
    finally{if($client){$client.Dispose();$client=$null};$pipe.Dispose();$pipe=$null}
    if($inputLine.IsCompleted){return}
    $pipe=[McpCcReloadNative]::OpenPipe($sid,$sid,$name)
    Assert-LocalPipeAcl $pipe $sid
  }
}catch{[Console]::Error.WriteLine(('COOPERATIVE_CHANNEL_UNAVAILABLE stage={0} hresult={1}' -f $stage,$_.Exception.HResult));exit 1}
finally{if($pipe){$pipe.Dispose()};if($client){$client.Dispose()};if($core){$core.Dispose()};if($reader){$reader.Dispose()}}
