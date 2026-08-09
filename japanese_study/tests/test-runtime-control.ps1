Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$script:Passed = 0
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "Assertion failed: $Message" }; $script:Passed++ }
function Assert-Equal($Actual, $Expected, [string]$Message) { if ([string]$Actual -ne [string]$Expected) { throw "Assertion failed: $Message. Expected '$Expected', got '$Actual'." }; $script:Passed++ }
function Get-FreeTcpPort { $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $listener.Start(); try { return ([Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() } }
function Wait-TcpPort([int]$Port, [bool]$Open, [int]$Seconds = 10) { $deadline = [DateTime]::UtcNow.AddSeconds($Seconds); do { $client = New-Object Net.Sockets.TcpClient; try { $task = $client.ConnectAsync('127.0.0.1', $Port); $connected = $task.Wait(200) -and $client.Connected } catch { $connected = $false } finally { $client.Dispose() }; if ($connected -eq $Open) { return $true }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $deadline); return $false }
function Stop-TestProcess($Process) { if ($null -ne $Process -and -not $Process.HasExited) { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue; try { $Process.WaitForExit(3000) | Out-Null } catch { } } }

$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("japanese-study-controller-" + [Guid]::NewGuid().ToString('N'))
$hubRoot = Join-Path $testRoot 'hub'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$hubPort = Get-FreeTcpPort
$mcpPort = Get-FreeTcpPort
$tunnelPort = Get-FreeTcpPort
while ($mcpPort -in @($hubPort) -or $tunnelPort -in @($hubPort, $mcpPort)) { $mcpPort = Get-FreeTcpPort; $tunnelPort = Get-FreeTcpPort }
$utf8 = New-Object Text.UTF8Encoding($false)
$foreign = $null
$context = $null

try {
  foreach ($directory in @('scripts', 'tests', 'dist\src', '.tmp', '.tunnel-client', '.secrets')) { New-Item -ItemType Directory -Force -Path (Join-Path $testRoot $directory) | Out-Null }
  New-Item -ItemType Directory -Force -Path $hubRoot | Out-Null
  foreach ($name in @('japanese-study-runtime.psm1', 'component-runtime.psm1', 'runtime-control.ps1')) { Copy-Item -LiteralPath (Join-Path $sourceRoot "scripts\$name") -Destination (Join-Path $testRoot "scripts\$name") }
  [IO.File]::WriteAllText((Join-Path $hubRoot 'pyproject.toml'), '[project]', $utf8)
  [IO.File]::WriteAllText((Join-Path $testRoot '.tunnel-client\test.yaml'), 'test', $utf8)
  [IO.File]::WriteAllText((Join-Path $testRoot '.secrets\test.dpapi'), 'isolated-test-placeholder', $utf8)
  [IO.File]::WriteAllText((Join-Path $testRoot 'scripts\key-store.ps1'), 'function Set-ControlPlaneApiKeyEnvFromSecret { $env:CONTROL_PLANE_API_KEY = ''isolated-test-placeholder''; return $true }', $utf8)

  $hubChild = @'
const http=require("http");
const port=Number(process.argv[2]);
http.createServer((request,response)=>{const body=JSON.stringify({ok:true,service:"japanese-study-hub",version:"test"});response.writeHead(200,{"content-type":"application/json","content-length":Buffer.byteLength(body)});response.end(body)}).listen(port,"127.0.0.1");
'@
  $hubRunner = @'
const {spawn}=require("child_process");
const {join}=require("path");
const child=spawn(process.execPath,[join(__dirname,"fake-hub-child.js"),process.env.JSTUDY_API_PORT],{stdio:"ignore",windowsHide:true});
const finish=()=>{try{child.kill()}catch{};process.exit(0)};
process.on("SIGTERM",finish);process.on("SIGINT",finish);setInterval(()=>{},1000);
'@
  $mcpServer = @'
const http=require("http");
const port=Number(process.env.JSTUDY_MCP_PORT);
http.createServer((request,response)=>{const body=JSON.stringify({ok:true,service:"japanese-study-mcp",version:"test",contractVersion:"test-contract",buildId:"test-build",toolCount:14});response.writeHead(200,{"content-type":"application/json","content-length":Buffer.byteLength(body)});response.end(body)}).listen(port,"127.0.0.1");
'@
  $tunnelServer = @"
const http=require("http");
const port=$tunnelPort;
http.createServer((request,response)=>{const body=request.url==="/readyz"?"ready":"ok";response.writeHead(200,{"content-type":"text/plain","content-length":Buffer.byteLength(body)});response.end(body)}).listen(port,"127.0.0.1");
"@
  [IO.File]::WriteAllText((Join-Path $testRoot 'fake-hub-child.js'), $hubChild, $utf8)
  [IO.File]::WriteAllText((Join-Path $testRoot 'fake-hub-runner.js'), $hubRunner, $utf8)
  [IO.File]::WriteAllText((Join-Path $testRoot 'dist\src\http-main.js'), $mcpServer, $utf8)
  foreach ($artifact in @('api-client.js', 'config.js', 'http-server.js', 'server.js')) { [IO.File]::WriteAllText((Join-Path $testRoot "dist\src\$artifact"), '// test', $utf8) }
  [IO.File]::WriteAllText((Join-Path $testRoot 'fake-tunnel.js'), $tunnelServer, $utf8)

  $controller = Join-Path $testRoot 'scripts\runtime-control.ps1'
  $hubArguments = Join-Path $testRoot 'fake-hub-runner.js'
  $tunnelArguments = Join-Path $testRoot 'fake-tunnel.js'
  Import-Module (Join-Path $testRoot 'scripts\component-runtime.psm1') -Force
  $context = New-JapaneseStudyRuntimeContext `
    -ProjectRoot $testRoot -HubRoot $hubRoot -HostName '127.0.0.1' -HubPort $hubPort -McpPort $mcpPort `
    -NodePath $nodePath -UvPath $nodePath -HubArguments $hubArguments -HubIdentity 'fake-hub-runner.js' `
    -TunnelClientPath $nodePath -TunnelProfileDir (Join-Path $testRoot '.tunnel-client') -TunnelProfile 'test' `
    -TunnelHealthUrl "http://127.0.0.1:$tunnelPort" -TunnelArguments $tunnelArguments -TunnelIdentity 'fake-tunnel.js' `
    -KeyStorePath (Join-Path $testRoot 'scripts\key-store.ps1') -SecretPath (Join-Path $testRoot '.secrets\test.dpapi') `
    -ExpectedBuildId 'test-build' -ExpectedMcpVersion 'test' -ExpectedContractVersion 'test-contract' -ExpectedToolCount 14 `
    -CoreReadyTimeoutSeconds 10 -TunnelRecoveryDelaysSeconds 5
  function Invoke-TestController([string]$Action, [bool]$ExpectSuccess = $true) {
    if ($Action -eq 'SelfTest') {
      $document = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $controller -Action SelfTest -ProjectRoot $testRoot -HubRoot $hubRoot -NodePath $nodePath -UvPath $nodePath -TunnelClientPath $nodePath -TunnelProfileDir (Join-Path $testRoot '.tunnel-client') -KeyStorePath (Join-Path $testRoot 'scripts\key-store.ps1') -SecretPath (Join-Path $testRoot '.secrets\test.dpapi')) | ConvertFrom-Json
      $exitCode = $LASTEXITCODE
      Assert-Equal $exitCode 0 'SelfTest exits successfully'
      return [pscustomobject]@{ document = $document; exitCode = $exitCode }
    }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $before = Get-JapaneseStudyRuntimeStatus -Context $context
    $errorCode = $null
    $message = 'Lifecycle action completed.'
    try {
      if ($Action -ne 'Status') { Invoke-JapaneseStudyLifecycleAction -Context $context -Action $Action }
      $exitCode = 0
    }
    catch {
      $exitCode = 1
      $raw = ([string]$_.Exception.Message -replace '[\r\n]+', ' ').Trim()
      if ($raw -match '^([A-Z][A-Z0-9_]+):\s*(.*)$') { $errorCode = $matches[1]; $message = $matches[2] }
      else { $errorCode = 'ACTION_FAILED'; $message = 'Lifecycle action failed.' }
    }
    $after = Get-JapaneseStudyRuntimeStatus -Context $context
    $clock.Stop()
    $document = [pscustomobject]@{ ok = ($exitCode -eq 0); action = $Action; before = $before; after = $after; ownedPids = @($after.ownedPids); elapsedMs = [int]$clock.ElapsedMilliseconds; errorCode = $errorCode; message = $message }
    Write-JapaneseStudyLifecycleEvent -Context $context -Action $Action -Ok ($exitCode -eq 0) -BeforeStatus $before.status -AfterStatus $after.status -OwnedPids @($after.ownedPids) -ElapsedMs $document.elapsedMs -ErrorCode $errorCode -Message $message
    if ($ExpectSuccess) { Assert-Equal $exitCode 0 "$Action exits successfully ($($errorCode): $message)" } else { Assert-True ($exitCode -ne 0) "$Action fails safely" }
    return [pscustomobject]@{ document = $document; exitCode = $exitCode }
  }

  $self = Invoke-TestController -Action SelfTest
  Assert-Equal $self.document.runtimeContract 'unified-lifecycle-v3' 'SelfTest contract is v3'
  Assert-Equal (@($self.document.orderedCoreRoles) -join ',') 'hub,mcp' 'SelfTest declares ordered core roles'
  Assert-Equal $self.document.credentialValuesExposed $false 'SelfTest declares credential redaction'
  $initial = Invoke-TestController -Action Status
  Assert-Equal $initial.document.after.status 'Stopped' 'isolated runtime starts stopped'

  $ensure = Invoke-TestController -Action EnsureRunning
  Assert-Equal $ensure.document.after.status 'Ready' 'ensure starts Hub, MCP and tunnel'
  Assert-Equal $ensure.document.after.hub.relation 'Descendant' 'Hub listener is a descendant of its exact runner'
  $hubPid1 = [int]$ensure.document.after.hub.pid; $hubListener1 = [int]$ensure.document.after.hub.listenerPid
  $mcpPid1 = [int]$ensure.document.after.mcp.pid; $tunnelPid1 = [int]$ensure.document.after.tunnel.pid
  Assert-True ($hubPid1 -gt 0 -and $hubListener1 -gt 0 -and $hubPid1 -ne $hubListener1) 'Hub runner and listener identities are distinct'
  Assert-True (@($ensure.document.after.ownedPids).Count -eq 3) 'three managed root PIDs are recorded'

  $repair = Invoke-TestController -Action RepairConnectivity
  Assert-Equal $repair.document.after.hub.pid $hubPid1 'repair preserves Hub runner'
  Assert-Equal $repair.document.after.mcp.pid $mcpPid1 'repair preserves MCP adapter'
  Assert-Equal $repair.document.after.tunnel.pid $tunnelPid1 'repair preserves tunnel'

  $restart = Invoke-TestController -Action RestartCore
  $hubPid2 = [int]$restart.document.after.hub.pid; $mcpPid2 = [int]$restart.document.after.mcp.pid
  Assert-Equal $restart.document.after.status 'Ready' 'multi-core restart returns Ready'
  Assert-True ($hubPid2 -ne $hubPid1 -and $mcpPid2 -ne $mcpPid1) 'core restart replaces Hub and MCP roots'
  Assert-Equal $restart.document.after.tunnel.pid $tunnelPid1 'core restart preserves tunnel PID'

  $reload = Invoke-TestController -Action ReloadRuntime
  Assert-Equal $reload.document.after.status 'Ready' 'full reload returns Ready'
  Assert-True ([int]$reload.document.after.hub.pid -ne $hubPid2) 'reload replaces Hub runner'
  Assert-True ([int]$reload.document.after.mcp.pid -ne $mcpPid2) 'reload replaces MCP adapter'
  Assert-True ([int]$reload.document.after.tunnel.pid -ne $tunnelPid1) 'reload replaces tunnel'

  $shutdown = Invoke-TestController -Action ShutdownRuntime
  Assert-Equal $shutdown.document.after.status 'Stopped' 'shutdown stops all owned roles'
  Assert-True (@($shutdown.document.after.ownedPids).Count -eq 0) 'shutdown leaves no owned roots'
  $shutdownAgain = Invoke-TestController -Action ShutdownRuntime
  Assert-Equal $shutdownAgain.document.after.status 'Stopped' 'shutdown is idempotent'

  $oldForeignPort = $env:JSTUDY_MCP_PORT
  $env:JSTUDY_MCP_PORT = [string]$mcpPort
  try { $foreign = Start-Process -FilePath $nodePath -ArgumentList "`"$(Join-Path $testRoot 'dist\src\http-main.js')`"" -WorkingDirectory $testRoot -WindowStyle Hidden -PassThru }
  finally { if ($null -eq $oldForeignPort) { Remove-Item Env:\JSTUDY_MCP_PORT -ErrorAction SilentlyContinue } else { $env:JSTUDY_MCP_PORT = $oldForeignPort } }
  Assert-True (Wait-TcpPort -Port $mcpPort -Open $true) 'foreign exact MCP listener starts'
  $foreignShutdown = Invoke-TestController -Action ShutdownRuntime -ExpectSuccess $false
  Assert-Equal $foreignShutdown.document.errorCode 'OWNERSHIP_MISMATCH' 'foreign listener blocks shutdown'
  Assert-True ($null -ne (Get-Process -Id $foreign.Id -ErrorAction SilentlyContinue)) 'foreign listener remains untouched'
  Stop-TestProcess -Process $foreign; $foreign = $null

  $audit = Join-Path $testRoot '.tmp\runtime-control.jsonl'
  Assert-True (Test-Path -LiteralPath $audit -PathType Leaf) 'action audit exists'
  $auditText = [IO.File]::ReadAllText($audit)
  Assert-True ($auditText.IndexOf('isolated-test-placeholder', [StringComparison]::Ordinal) -lt 0) 'audit excludes credential material'
  Assert-True ($auditText.IndexOf($hubRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0) 'audit excludes authoritative Hub path'

  [pscustomobject]@{
    ok = $true; assertions = $script:Passed
    actions = @('SelfTest', 'Status', 'EnsureRunning', 'RepairConnectivity', 'RestartCore', 'ReloadRuntime', 'ShutdownRuntime', 'ForeignOwnerGuard')
  } | ConvertTo-Json -Depth 4
}
finally {
  Stop-TestProcess -Process $foreign
  if ($null -ne $context) {
    try { Invoke-JapaneseStudyLifecycleAction -Context $context -Action ShutdownRuntime } catch { }
  }
  try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($testRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  catch { }
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
