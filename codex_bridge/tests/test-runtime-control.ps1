Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$projectRoot=(Resolve-Path -LiteralPath(Join-Path $PSScriptRoot '..')).Path
$tempBase=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$testRoot=Join-Path $tempBase("codex-bridge-runtime-test-"+[Guid]::NewGuid().ToString('N'))
$utf8=New-Object Text.UTF8Encoding($false);$script:Passed=0;$previousKey=$env:CONTROL_PLANE_API_KEY;$foreign=$null

function Assert-True([bool]$Condition,[string]$Message){if(-not$Condition){throw "Assertion failed: $Message"};$script:Passed+=1}
function Assert-Equal($Actual,$Expected,[string]$Message){if([string]$Actual-ne[string]$Expected){throw "Assertion failed: $Message. Expected '$Expected', got '$Actual'."};$script:Passed+=1}
function Get-FreeTcpPort{$listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0);$listener.Start();try{return([Net.IPEndPoint]$listener.LocalEndpoint).Port}finally{$listener.Stop()}}
function Wait-TcpPort([int]$Port,[bool]$Open){$deadline=[DateTime]::UtcNow.AddSeconds(5);do{$client=New-Object Net.Sockets.TcpClient;try{$async=$client.BeginConnect('127.0.0.1',$Port,$null,$null);$actual=$async.AsyncWaitHandle.WaitOne(150,$false);if($actual){try{$client.EndConnect($async)}catch{$actual=$false}}}catch{$actual=$false}finally{$client.Dispose()};if($actual-eq$Open){return $true};Start-Sleep -Milliseconds 100}while([DateTime]::UtcNow-lt$deadline);return $false}
function Stop-TestProcess([Diagnostics.Process]$Process){if($null-eq$Process){return};try{if(-not$Process.HasExited){Stop-Process -Id $Process.Id -Force -ErrorAction Stop;$null=$Process.WaitForExit(5000)}}catch{};$Process.Dispose()}

function Invoke-TestController{
  param([Parameter(Mandatory=$true)][string]$Action,[bool]$ExpectSuccess=$true)
  $arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $testRoot 'scripts\runtime-control.ps1'),'-Action',$Action,'-ProjectRoot',$testRoot,'-Port',[string]$serverPort,'-ProjectsFile',(Join-Path $testRoot '.local\projects.json'),'-DataDir',(Join-Path $testRoot 'runtime-data'),'-NodePath',$nodePath,'-TunnelClientPath',$fakeTunnelPath,'-TunnelProfileDir',(Join-Path $testRoot '.tunnel-client'),'-TunnelProfile','test-profile','-TunnelHealthUrl',"http://127.0.0.1:$tunnelPort",'-KeyStorePath',(Join-Path $testRoot 'scripts\key-store.ps1'),'-SecretPath',(Join-Path $testRoot '.secrets\test.dpapi'),'-ExpectedBuildId','test-build','-TestActiveFlag',$activeFlag,'-ServerReadyTimeoutSeconds','5','-TunnelRecoveryDelaysSeconds','2')
  $output=@(& powershell.exe @arguments 2>&1);$exitCode=$LASTEXITCODE;$document=($output-join[Environment]::NewLine)|ConvertFrom-Json
  if($ExpectSuccess-and$exitCode-ne 0){throw "Controller $Action failed unexpectedly with $($document.errorCode): $($document.message)"};if(-not$ExpectSuccess-and$exitCode-eq 0){throw "Controller $Action unexpectedly succeeded."};return [pscustomobject]@{exitCode=$exitCode;document=$document}
}

try{
  New-Item -ItemType Directory -Force -Path(Join-Path $testRoot 'scripts'),(Join-Path $testRoot 'dist\src'),(Join-Path $testRoot 'vendor\tunnel-client'),(Join-Path $testRoot '.tunnel-client'),(Join-Path $testRoot '.local'),(Join-Path $testRoot 'web')|Out-Null
  foreach($name in @('runtime-control.ps1','component-runtime.psm1','codex-bridge-runtime.psm1')){Copy-Item -LiteralPath(Join-Path $projectRoot "scripts\$name")-Destination(Join-Path $testRoot "scripts\$name")}
  Copy-Item -LiteralPath 'C:\GPT_MCPtool\project_reading\scripts\key-store.ps1' -Destination(Join-Path $testRoot 'scripts\key-store.ps1')
  [IO.File]::WriteAllText((Join-Path $testRoot 'package.json'),'{}',$utf8);[IO.File]::WriteAllText((Join-Path $testRoot '.local\projects.json'),'{"projects":[{"id":"test","name":"Test","path":"C:\\\\GPT_MCPtool"}]}',$utf8);[IO.File]::WriteAllText((Join-Path $testRoot 'web\widget.html'),'test',$utf8)
  $serverSource=@'
const fs=require("fs");
const http=require("http");
const port=Number(process.env.CODEX_BRIDGE_HTTP_PORT);
const activeFlag=process.env.CODEX_BRIDGE_TEST_ACTIVE_FLAG;
const buildId=process.env.CODEX_BRIDGE_EXPECTED_TEST_BUILD;
http.createServer((request,response)=>{
  if(request.url==="/health"){
    const mode=activeFlag&&fs.existsSync(activeFlag)?fs.readFileSync(activeFlag,"utf8").trim():"idle";
    const active=mode==="active"?1:0;
    const controller=mode==="ready"?"ready":active?"starting":"idle";
    const body=JSON.stringify({ok:true,service:"codex-handoff-bridge",version:"test",buildId,controller,jobs:{totalVisible:active,active,awaitingApproval:active}});
    response.writeHead(200,{"content-type":"application/json","content-length":Buffer.byteLength(body)});response.end(body);return;
  }
  response.writeHead(200);response.end("ok");
}).listen(port,"127.0.0.1");
'@
  [IO.File]::WriteAllText((Join-Path $testRoot 'dist\src\http-main.js'),$serverSource,$utf8)
  $fakeTunnelPath=Join-Path $testRoot 'vendor\tunnel-client\fake-tunnel.exe'
  $tunnelSource=@'
using System;using System.Diagnostics;using System.IO;using System.Net;using System.Net.Sockets;using System.Text;
public static class FakeTunnel{public static int Main(string[] args){string pidPath=null;string profileDir=null;for(int i=0;i+1<args.Length;i++){if(args[i]=="--pid.file")pidPath=args[i+1];if(args[i]=="--profile-dir")profileDir=args[i+1];}if(!string.IsNullOrWhiteSpace(pidPath)){Directory.CreateDirectory(Path.GetDirectoryName(pidPath));File.WriteAllText(pidPath,Process.GetCurrentProcess().Id.ToString());}int port=int.Parse(File.ReadAllText(Path.Combine(profileDir,"test-port.txt")));TcpListener listener=new TcpListener(IPAddress.Loopback,port);listener.Start();while(true){using(TcpClient client=listener.AcceptTcpClient())using(NetworkStream stream=client.GetStream()){byte[] request=new byte[4096];int count=stream.Read(request,0,request.Length);if(count<=0)continue;byte[] body=Encoding.UTF8.GetBytes("ready");byte[] headers=Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: "+body.Length+"\r\nConnection: close\r\n\r\n");stream.Write(headers,0,headers.Length);stream.Write(body,0,body.Length);}}}}
'@
  Add-Type -TypeDefinition $tunnelSource -Language CSharp -OutputAssembly $fakeTunnelPath -OutputType ConsoleApplication
  [IO.File]::WriteAllText((Join-Path $testRoot '.tunnel-client\test-profile.yaml'),'test: true',$utf8)
  $serverPort=Get-FreeTcpPort;do{$tunnelPort=Get-FreeTcpPort}while($tunnelPort-eq$serverPort);[IO.File]::WriteAllText((Join-Path $testRoot '.tunnel-client\test-port.txt'),[string]$tunnelPort,$utf8)
  $activeFlag=Join-Path $testRoot 'active-work.flag';$nodePath=(Get-Command node -ErrorAction Stop).Source;$env:CONTROL_PLANE_API_KEY='isolated-test-placeholder'

  $self=Invoke-TestController -Action SelfTest;Assert-Equal $self.document.runtimeContract 'unified-lifecycle-v3' 'SelfTest contract is v3';Assert-True(@($self.document.capabilities).Count-eq 6)'controller declares six capabilities';Assert-Equal $self.document.activeWorkMutationBlocked $true 'active work mutation guard is declared';Assert-Equal $self.document.approvalDecisionsDelegated $false 'controller cannot decide approvals'
  $sourceBoundary=[IO.File]::ReadAllText((Join-Path $testRoot 'scripts\codex-bridge-runtime.psm1'))+[IO.File]::ReadAllText((Join-Path $testRoot 'scripts\runtime-control.ps1'));foreach($forbidden in @('codex_job_dispatch','turn/start','codex_approval_decide','decideApproval')){Assert-True($sourceBoundary.IndexOf($forbidden,[StringComparison]::OrdinalIgnoreCase)-lt 0)"lifecycle source excludes $forbidden"}
  $initial=Invoke-TestController -Action Status;Assert-Equal $initial.document.after.status 'Stopped' 'isolated runtime starts stopped'
  $ensure=Invoke-TestController -Action EnsureRunning;Assert-Equal $ensure.document.after.status 'Ready' 'ensure starts server and tunnel';$serverPid1=[int]$ensure.document.after.server.pid;$tunnelPid1=[int]$ensure.document.after.tunnel.pid;Assert-True($serverPid1-gt 0-and$tunnelPid1-gt 0)'both owned PIDs are recorded'
  $repair=Invoke-TestController -Action RepairConnectivity;Assert-Equal $repair.document.after.server.pid $serverPid1 'repair preserves core';Assert-Equal $repair.document.after.tunnel.pid $tunnelPid1 'repair preserves tunnel'
  [IO.File]::WriteAllText($activeFlag,'active',$utf8);$blocked=Invoke-TestController -Action RestartCore -ExpectSuccess $false;Assert-Equal $blocked.document.errorCode 'ACTIVE_WORK_PRESENT' 'active work blocks core restart';Assert-Equal $blocked.document.after.server.pid $serverPid1 'blocked restart preserves core PID';Assert-Equal $blocked.document.after.tunnel.pid $tunnelPid1 'blocked restart preserves tunnel PID';Assert-True($null-ne(Get-Process -Id $serverPid1 -ErrorAction SilentlyContinue))'blocked restart leaves core alive';Remove-Item -LiteralPath $activeFlag -Force
  [IO.File]::WriteAllText($activeFlag,'ready',$utf8);$restart=Invoke-TestController -Action RestartCore;Remove-Item -LiteralPath $activeFlag -Force;$serverPid2=[int]$restart.document.after.server.pid;Assert-Equal $restart.document.after.status 'Ready' 'initialized but inactive core restart returns ready';Assert-True($serverPid2-ne$serverPid1)'initialized but inactive core restart replaces core';Assert-Equal $restart.document.after.tunnel.pid $tunnelPid1 'core restart preserves tunnel'
  $reload=Invoke-TestController -Action ReloadRuntime;Assert-Equal $reload.document.after.status 'Ready' 'idle full reload returns ready';Assert-True([int]$reload.document.after.server.pid-ne$serverPid2)'reload replaces core';Assert-True([int]$reload.document.after.tunnel.pid-ne$tunnelPid1)'reload replaces tunnel'
  $shutdown=Invoke-TestController -Action ShutdownRuntime;Assert-Equal $shutdown.document.after.status 'Stopped' 'shutdown stops owned runtime';Assert-True(@($shutdown.document.after.ownedPids).Count-eq 0)'shutdown leaves no owned PID';$shutdownAgain=Invoke-TestController -Action ShutdownRuntime;Assert-Equal $shutdownAgain.document.after.status 'Stopped' 'shutdown is idempotent when runtime is already stopped'

  $oldPort=$env:CODEX_BRIDGE_HTTP_PORT;$oldBuild=$env:CODEX_BRIDGE_EXPECTED_TEST_BUILD;$oldFlag=$env:CODEX_BRIDGE_TEST_ACTIVE_FLAG;$env:CODEX_BRIDGE_HTTP_PORT=[string]$serverPort;$env:CODEX_BRIDGE_EXPECTED_TEST_BUILD='test-build';$env:CODEX_BRIDGE_TEST_ACTIVE_FLAG=$activeFlag
  $foreign=Start-Process -FilePath $nodePath -ArgumentList "`"$(Join-Path $testRoot 'dist\src\http-main.js')`"" -WorkingDirectory $testRoot -WindowStyle Hidden -PassThru;Assert-True(Wait-TcpPort -Port $serverPort -Open $true)'foreign exact listener starts';$foreignShutdown=Invoke-TestController -Action ShutdownRuntime -ExpectSuccess $false;Assert-Equal $foreignShutdown.document.errorCode 'OWNERSHIP_MISMATCH' 'unmanaged exact listener is rejected';Assert-True($null-ne(Get-Process -Id $foreign.Id -ErrorAction SilentlyContinue))'foreign listener remains untouched';Stop-TestProcess -Process $foreign;$foreign=$null
  if($null-eq$oldPort){Remove-Item Env:\CODEX_BRIDGE_HTTP_PORT -ErrorAction SilentlyContinue}else{$env:CODEX_BRIDGE_HTTP_PORT=$oldPort};if($null-eq$oldBuild){Remove-Item Env:\CODEX_BRIDGE_EXPECTED_TEST_BUILD -ErrorAction SilentlyContinue}else{$env:CODEX_BRIDGE_EXPECTED_TEST_BUILD=$oldBuild};if($null-eq$oldFlag){Remove-Item Env:\CODEX_BRIDGE_TEST_ACTIVE_FLAG -ErrorAction SilentlyContinue}else{$env:CODEX_BRIDGE_TEST_ACTIVE_FLAG=$oldFlag}
  $audit=Join-Path $testRoot '.tmp\runtime-control.jsonl';Assert-True(Test-Path -LiteralPath $audit -PathType Leaf)'action audit exists';$auditText=[IO.File]::ReadAllText($audit);Assert-True($auditText.IndexOf('isolated-test-placeholder',[StringComparison]::Ordinal)-lt 0)'audit excludes secret';Assert-True($auditText.IndexOf((Join-Path $testRoot 'runtime-data'),[StringComparison]::OrdinalIgnoreCase)-lt 0)'audit excludes data path';Assert-True($auditText.IndexOf((Join-Path $testRoot '.local\projects.json'),[StringComparison]::OrdinalIgnoreCase)-lt 0)'audit excludes allowlist path'
  [pscustomobject]@{ok=$true;assertions=$script:Passed;actions=@('SelfTest','Status','EnsureRunning','RepairConnectivity','ActiveWorkGuard','RestartCore','ReloadRuntime','ShutdownRuntime','ForeignOwnerGuard')}|ConvertTo-Json -Depth 4
}
finally{
  Stop-TestProcess -Process $foreign
  foreach($pair in @(@('.tmp\codex-bridge-http-server.pid','.tmp\codex-bridge-http-server.owner.json'),@('.tmp\tunnel-client.pid','.tmp\tunnel-client.owner.json'))){$pidPath=Join-Path $testRoot $pair[0];$ownerPath=Join-Path $testRoot $pair[1];if(-not(Test-Path -LiteralPath $pidPath -PathType Leaf)-or-not(Test-Path -LiteralPath $ownerPath -PathType Leaf)){continue};try{$value=0;if(-not[int]::TryParse(([IO.File]::ReadAllText($pidPath).Trim()),[ref]$value)){continue};$metadata=[IO.File]::ReadAllText($ownerPath)|ConvertFrom-Json;$process=Get-Process -Id $value -ErrorAction Stop;if([IO.Path]::GetFullPath([string]$process.Path).Equals([IO.Path]::GetFullPath([string]$metadata.executablePath),[StringComparison]::OrdinalIgnoreCase)-and$process.StartTime.ToUniversalTime().ToString('o')-eq[string]$metadata.startTimeUtc){Stop-Process -Id $value -Force -ErrorAction Stop;$null=$process.WaitForExit(5000)}}catch{}}
  if($null-eq$previousKey){Remove-Item Env:\CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue}else{$env:CONTROL_PLANE_API_KEY=$previousKey}
  $resolved=[IO.Path]::GetFullPath($testRoot);if($resolved.StartsWith($tempBase+'\',[StringComparison]::OrdinalIgnoreCase)-and(Test-Path -LiteralPath $resolved)){for($attempt=0;$attempt-lt 10;$attempt++){try{Remove-Item -LiteralPath $resolved -Recurse -Force;break}catch{if($attempt-eq 9){throw};Start-Sleep -Milliseconds 300}}}
}
