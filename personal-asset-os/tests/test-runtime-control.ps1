Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$script:Passed = 0
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "Assertion failed: $Message" }; $script:Passed++ }
function Assert-Equal($Actual, $Expected, [string]$Message) { if ([string]$Actual -ne [string]$Expected) { throw "Assertion failed: $Message. Expected '$Expected', got '$Actual'." }; $script:Passed++ }
function Get-FreeTcpPort { $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $listener.Start(); try { return ([Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() } }
function Wait-TcpPort([int]$Port, [bool]$Open, [int]$Seconds = 10) { $deadline = [DateTime]::UtcNow.AddSeconds($Seconds); do { $client = New-Object Net.Sockets.TcpClient; try { $task = $client.ConnectAsync('127.0.0.1', $Port); $connected = $task.Wait(200) -and $client.Connected } catch { $connected = $false } finally { $client.Dispose() }; if ($connected -eq $Open) { return $true }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $deadline); return $false }
function Stop-TestProcess($Process) { if ($null -ne $Process -and -not $Process.HasExited) { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue; try { $Process.WaitForExit(3000) | Out-Null } catch { } } }

$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runtimeSource = [IO.File]::ReadAllText((Join-Path $sourceRoot 'scripts\personal-asset-os-runtime.psm1'))
Assert-Equal ([regex]::Matches($runtimeSource, 'UseShellExecute\s*=\s*\$true').Count) 2 'server and tunnel children detach from redirected controller stdio'
Assert-True ($runtimeSource -notmatch 'UseShellExecute\s*=\s*\$false') 'long-lived runtime children never inherit redirected controller stdio'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("paos-controller-" + [Guid]::NewGuid().ToString('N'))
$dataRoot = Join-Path $testRoot 'formal-data-isolated'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$serverPort = Get-FreeTcpPort
$tunnelPort = Get-FreeTcpPort
while ($tunnelPort -eq $serverPort) { $tunnelPort = Get-FreeTcpPort }
$utf8 = New-Object Text.UTF8Encoding($false)
$foreign = $null
$staleForeign = $null
$context = $null

try {
  foreach ($directory in @('scripts', 'tests', 'frontend\dist', '.tmp', '.tunnel-client', 'formal-data-isolated')) { New-Item -ItemType Directory -Force -Path (Join-Path $testRoot $directory) | Out-Null }
  foreach ($name in @('personal-asset-os-runtime.psm1', 'component-runtime.psm1', 'runtime-control.ps1')) { Copy-Item -LiteralPath (Join-Path $sourceRoot "scripts\$name") -Destination (Join-Path $testRoot "scripts\$name") }
  [IO.File]::WriteAllText((Join-Path $testRoot 'frontend\dist\index.html'), '<!doctype html>', $utf8)
  [IO.File]::WriteAllText((Join-Path $testRoot '.tunnel-client\test.yaml'), 'test', $utf8)
  $localEnv = @'
function Set-ControlPlaneApiKeyFromLocalEnv { $env:CONTROL_PLANE_API_KEY = 'isolated-key-placeholder'; return $true }
function Set-ControlPlaneOrganizationIdFromLocalEnv { $env:CONTROL_PLANE_ORGANIZATION_ID = 'isolated-org-placeholder'; return $true }
'@
  [IO.File]::WriteAllText((Join-Path $testRoot 'scripts\local-env.ps1'), $localEnv, $utf8)

  $serverChild = @'
const http=require("http");
const port=Number(process.argv[2]);
http.createServer((request,response)=>{const ready=request.url==="/api/readyz";const body=JSON.stringify(ready?{ready:true,databaseReady:true,frontendReady:true,buildId:"test-build"}:{ok:true,service:"personal-asset-os",version:"test",database:"ready",schemaRevision:"test",buildId:"test-build"});response.writeHead(200,{"content-type":"application/json","content-length":Buffer.byteLength(body)});response.end(body)}).listen(port,"127.0.0.1");
'@
  $serverRunner = @'
const {spawn}=require("child_process");
const {join}=require("path");
const child=spawn(process.execPath,[join(__dirname,"fake-server-child.js"),process.argv[2]],{stdio:"ignore",windowsHide:true});
const finish=()=>{try{child.kill()}catch{};process.exit(0)};
process.on("SIGTERM",finish);process.on("SIGINT",finish);setInterval(()=>{},1000);
'@
  $tunnelServer = @"
const http=require("http");
const port=$tunnelPort;
http.createServer((request,response)=>{const body=request.url==="/readyz"?"ready":"ok";response.writeHead(200,{"content-type":"text/plain","content-length":Buffer.byteLength(body)});response.end(body)}).listen(port,"127.0.0.1");
"@
  [IO.File]::WriteAllText((Join-Path $testRoot 'fake-server-child.js'), $serverChild, $utf8)
  [IO.File]::WriteAllText((Join-Path $testRoot 'fake-server-runner.js'), $serverRunner, $utf8)
  [IO.File]::WriteAllText((Join-Path $testRoot 'fake-tunnel.js'), $tunnelServer, $utf8)

  $controller = Join-Path $testRoot 'scripts\runtime-control.ps1'
  $serverArguments = "`"$(Join-Path $testRoot 'fake-server-runner.js')`" $serverPort"
  $tunnelArguments = Join-Path $testRoot 'fake-tunnel.js'
  $localEnvPath = Join-Path $testRoot 'scripts\local-env.ps1'
  Import-Module (Join-Path $testRoot 'scripts\component-runtime.psm1') -Force
  $context = New-PersonalAssetOsRuntimeContext `
    -ProjectRoot $testRoot -HostName '127.0.0.1' -Port $serverPort -DataDir $dataRoot `
    -PythonPath $nodePath -ServerArguments $serverArguments -ServerIdentity 'fake-server-runner.js' `
    -TunnelClientPath $nodePath -TunnelProfileDir (Join-Path $testRoot '.tunnel-client') -TunnelProfile 'test' `
    -TunnelHealthUrl "http://127.0.0.1:$tunnelPort" -TunnelArguments $tunnelArguments -TunnelIdentity 'fake-tunnel.js' `
    -LocalEnvScript $localEnvPath -ExpectedBuildId 'test-build' -CoreReadyTimeoutSeconds 10 -TunnelRecoveryDelaysSeconds 5

  function Invoke-TestController([string]$Action, [bool]$ExpectSuccess = $true) {
    if ($Action -eq 'SelfTest') {
      $document = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $controller -Action SelfTest -ProjectRoot $testRoot -DataDir $dataRoot -PythonPath $nodePath -TunnelClientPath $nodePath -TunnelProfileDir (Join-Path $testRoot '.tunnel-client') -LocalEnvScript $localEnvPath -ExpectedBuildId 'test-build') | ConvertFrom-Json
      $exitCode = $LASTEXITCODE
      Assert-Equal $exitCode 0 'SelfTest exits successfully'
      return [pscustomobject]@{ document = $document; exitCode = $exitCode }
    }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $before = Get-PersonalAssetOsRuntimeStatus -Context $context
    $errorCode = $null; $message = 'Lifecycle action completed.'
    try {
      if ($Action -ne 'Status') { Invoke-PersonalAssetOsLifecycleAction -Context $context -Action $Action }
      $exitCode = 0
    }
    catch {
      $exitCode = 1
      $raw = ([string]$_.Exception.Message -replace '[\r\n]+', ' ').Trim()
      if ($raw -match '^([A-Z][A-Z0-9_]+):\s*(.*)$') { $errorCode = $matches[1]; $message = $matches[2] }
      else { $errorCode = 'ACTION_FAILED'; $message = 'Lifecycle action failed.' }
    }
    $after = Get-PersonalAssetOsRuntimeStatus -Context $context
    $clock.Stop()
    $document = [pscustomobject]@{ ok = ($exitCode -eq 0); action = $Action; before = $before; after = $after; ownedPids = @($after.ownedPids); elapsedMs = [int]$clock.ElapsedMilliseconds; errorCode = $errorCode; message = $message }
    Write-PersonalAssetOsLifecycleEvent -Context $context -Action $Action -Ok ($exitCode -eq 0) -BeforeStatus $before.status -AfterStatus $after.status -OwnedPids @($after.ownedPids) -ElapsedMs $document.elapsedMs -ErrorCode $errorCode -Message $message
    if ($ExpectSuccess) { Assert-Equal $exitCode 0 "$Action exits successfully ($($errorCode): $message)" } else { Assert-True ($exitCode -ne 0) "$Action fails safely" }
    return [pscustomobject]@{ document = $document; exitCode = $exitCode }
  }

  $self = Invoke-TestController -Action SelfTest
  Assert-Equal $self.document.runtimeContract 'unified-lifecycle-v3' 'SelfTest contract is v3'
  Assert-Equal $self.document.formalDataPathExposed $false 'SelfTest declares formal-data path redaction'
  Assert-Equal $self.document.managerDomainDataAccess 'none' 'SelfTest declares no domain access'
  Assert-True ((($self.document | ConvertTo-Json -Depth 8).IndexOf($dataRoot, [StringComparison]::OrdinalIgnoreCase)) -lt 0) 'SelfTest omits the isolated data path'
  $initial = Invoke-TestController -Action Status
  Assert-Equal $initial.document.after.status 'Stopped' 'isolated runtime starts stopped'

  $staleForeign = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 120') -WindowStyle Hidden -PassThru
  [IO.File]::WriteAllText($context.serverPidFile, [string]$staleForeign.Id, $utf8)
  [IO.File]::WriteAllText($context.serverOwnerFile, '{}', $utf8)
  $reused = Invoke-TestController -Action Status
  Assert-Equal $reused.document.after.server.ownership 'Stopped' 'listener-free reused PID is classified stopped'
  Assert-True (-not (Test-Path -LiteralPath $context.serverPidFile)) 'listener-free reused PID file is removed'
  Assert-True (-not (Test-Path -LiteralPath $context.serverOwnerFile)) 'listener-free reused owner file is removed'
  Assert-True ($null -ne (Get-Process -Id $staleForeign.Id -ErrorAction SilentlyContinue)) 'listener-free reused process remains untouched'
  Stop-TestProcess -Process $staleForeign; $staleForeign = $null

  $staleForeign = Start-Process -FilePath $nodePath -ArgumentList @('-e','setInterval(()=>{},1000)') -WindowStyle Hidden -PassThru
  $sameExecutableOwner = [ordered]@{
    schemaVersion=1; role='server'; pid=$staleForeign.Id; executablePath=$nodePath
    startTimeUtc=[DateTime]::UtcNow.AddDays(-1).ToString('o'); identity=$context.serverIdentity
    recordedAt=[DateTime]::UtcNow.AddDays(-1).ToString('o')
  }
  [IO.File]::WriteAllText($context.serverPidFile, [string]$staleForeign.Id, $utf8)
  [IO.File]::WriteAllText($context.serverOwnerFile, ($sameExecutableOwner | ConvertTo-Json -Compress), $utf8)
  $sameExecutable = Invoke-TestController -Action Status
  Assert-Equal $sameExecutable.document.after.server.ownership 'Stopped' 'same executable wrong instance is stale when listener-free'
  Assert-True ($null -ne (Get-Process -Id $staleForeign.Id -ErrorAction SilentlyContinue)) 'same-executable unrelated process remains untouched'
  Stop-TestProcess -Process $staleForeign; $staleForeign = $null

  $staleForeign = Start-Process -FilePath $nodePath -ArgumentList @('-e','setInterval(()=>{},1000)',[string]$context.serverIdentity) -WindowStyle Hidden -PassThru
  [IO.File]::WriteAllText($context.serverPidFile, [string]$staleForeign.Id, $utf8)
  Remove-Item -LiteralPath $context.serverOwnerFile -Force -ErrorAction SilentlyContinue
  $missingOwner = Invoke-TestController -Action Status
  Assert-Equal $missingOwner.document.after.server.ownership 'OwnershipUnknown' 'live exact-command process with missing owner metadata remains unknown'
  Assert-Equal $missingOwner.document.after.status 'OwnershipUnknown' 'role ownership unknown propagates to top-level runtime status'
  Assert-True (Test-Path -LiteralPath $context.serverPidFile) 'unknown ownership preserves PID evidence'
  Assert-True ($null -ne (Get-Process -Id $staleForeign.Id -ErrorAction SilentlyContinue)) 'unknown ownership leaves the process untouched'
  Stop-TestProcess -Process $staleForeign; $staleForeign = $null
  Remove-Item -LiteralPath $context.serverPidFile,$context.serverOwnerFile -Force -ErrorAction SilentlyContinue

  $ensure = Invoke-TestController -Action EnsureRunning
  Assert-Equal $ensure.document.after.status 'Ready' 'ensure starts server and tunnel'
  Assert-Equal $ensure.document.after.server.relation 'Descendant' 'server listener is a descendant of its exact runner'
  $serverPid1 = [int]$ensure.document.after.server.pid; $listenerPid1 = [int]$ensure.document.after.server.listenerPid; $tunnelPid1 = [int]$ensure.document.after.tunnel.pid
  Assert-True ($serverPid1 -gt 0 -and $listenerPid1 -gt 0 -and $serverPid1 -ne $listenerPid1) 'server runner and listener identities are distinct'
  Assert-True (@($ensure.document.after.ownedPids).Count -eq 2) 'two managed root PIDs are recorded'

  $repair = Invoke-TestController -Action RepairConnectivity
  Assert-Equal $repair.document.after.server.pid $serverPid1 'repair preserves server runner'
  Assert-Equal $repair.document.after.tunnel.pid $tunnelPid1 'repair preserves tunnel'

  $restart = Invoke-TestController -Action RestartCore
  $serverPid2 = [int]$restart.document.after.server.pid
  Assert-Equal $restart.document.after.status 'Ready' 'core restart returns Ready'
  Assert-True ($serverPid2 -ne $serverPid1) 'core restart replaces server root'
  Assert-Equal $restart.document.after.tunnel.pid $tunnelPid1 'core restart preserves tunnel PID'

  $reload = Invoke-TestController -Action ReloadRuntime
  Assert-Equal $reload.document.after.status 'Ready' 'full reload returns Ready'
  Assert-True ([int]$reload.document.after.server.pid -ne $serverPid2) 'reload replaces server runner'
  Assert-True ([int]$reload.document.after.tunnel.pid -ne $tunnelPid1) 'reload replaces tunnel'

  $shutdown = Invoke-TestController -Action ShutdownRuntime
  Assert-Equal $shutdown.document.after.status 'Stopped' 'shutdown stops all owned roles'
  Assert-True (@($shutdown.document.after.ownedPids).Count -eq 0) 'shutdown leaves no owned roots'
  $shutdownAgain = Invoke-TestController -Action ShutdownRuntime
  Assert-Equal $shutdownAgain.document.after.status 'Stopped' 'shutdown is idempotent'

  $foreign = Start-Process -FilePath $nodePath -ArgumentList "`"$(Join-Path $testRoot 'fake-server-child.js')`" $serverPort" -WorkingDirectory $testRoot -WindowStyle Hidden -PassThru
  Assert-True (Wait-TcpPort -Port $serverPort -Open $true) 'foreign server listener starts'
  $staleForeign = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 120') -WindowStyle Hidden -PassThru
  [IO.File]::WriteAllText($context.serverPidFile, [string]$staleForeign.Id, $utf8)
  [IO.File]::WriteAllText($context.serverOwnerFile, '{}', $utf8)
  $foreignShutdown = Invoke-TestController -Action ShutdownRuntime -ExpectSuccess $false
  Assert-Equal $foreignShutdown.document.errorCode 'OWNERSHIP_MISMATCH' 'foreign listener blocks shutdown'
  Assert-True ($null -ne (Get-Process -Id $foreign.Id -ErrorAction SilentlyContinue)) 'foreign listener remains untouched'
  Assert-True ($null -ne (Get-Process -Id $staleForeign.Id -ErrorAction SilentlyContinue)) 'stale PID process remains untouched while listener exists'
  Assert-True (Test-Path -LiteralPath $context.serverPidFile) 'listener conflict preserves stale PID evidence'
  Stop-TestProcess -Process $foreign; $foreign = $null
  Stop-TestProcess -Process $staleForeign; $staleForeign = $null
  Remove-Item -LiteralPath $context.serverPidFile,$context.serverOwnerFile -Force -ErrorAction SilentlyContinue

  $audit = Join-Path $testRoot '.tmp\runtime-control.jsonl'
  Assert-True (Test-Path -LiteralPath $audit -PathType Leaf) 'action audit exists'
  $auditText = [IO.File]::ReadAllText($audit)
  Assert-True ($auditText.IndexOf('isolated-key-placeholder', [StringComparison]::Ordinal) -lt 0) 'audit excludes credential material'
  Assert-True ($auditText.IndexOf('isolated-org-placeholder', [StringComparison]::Ordinal) -lt 0) 'audit excludes organization material'
  Assert-True ($auditText.IndexOf($dataRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0) 'audit excludes formal data path'

  [pscustomobject]@{ ok = $true; assertions = $script:Passed; actions = @('SelfTest', 'Status', 'EnsureRunning', 'RepairConnectivity', 'RestartCore', 'ReloadRuntime', 'ShutdownRuntime', 'ForeignOwnerGuard') } | ConvertTo-Json -Depth 4
}
finally {
  Stop-TestProcess -Process $foreign
  Stop-TestProcess -Process $staleForeign
  if ($null -ne $context) { try { Invoke-PersonalAssetOsLifecycleAction -Context $context -Action ShutdownRuntime } catch { } }
  try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($testRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  catch { }
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
