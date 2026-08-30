Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$testRoot = Join-Path $tempBase ("project-reading-runtime-test-" + [Guid]::NewGuid().ToString("N"))
$script:Passed = 0
$previousApiKey = $env:CONTROL_PLANE_API_KEY
$previousTunnelPort = $env:PROJECT_READING_TEST_TUNNEL_PORT
$foreign = $null
$staleForeign = $null

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "Assertion failed: $Message" }
  $script:Passed += 1
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ([string]$Actual -ne [string]$Expected) {
    throw "Assertion failed: $Message. Expected '$Expected', got '$Actual'."
  }
  $script:Passed += 1
}

function Get-FreeTcpPort {
  $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([Net.IPEndPoint]$listener.LocalEndpoint).Port }
  finally { $listener.Stop() }
}

function Invoke-TestController {
  param(
    [Parameter(Mandatory = $true)][string]$Action,
    [bool]$ExpectSuccess = $true
  )
  $arguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $testRoot "scripts\runtime-control.ps1"),
    "-Action", $Action,
    "-ProjectRoot", $testRoot,
    "-Port", [string]$serverPort,
    "-TunnelClientPath", $fakeTunnelPath,
    "-TunnelProfileDir", (Join-Path $testRoot ".tunnel-client"),
    "-TunnelProfile", "test-profile",
    "-TunnelHealthUrl", "http://127.0.0.1:$tunnelPort",
    "-ServerReadyTimeoutSeconds", "5",
    "-TunnelRecoveryDelaysSeconds", "2"
  )
  $output = @(& powershell.exe @arguments 2>&1)
  $exitCode = $LASTEXITCODE
  $document = ($output -join [Environment]::NewLine) | ConvertFrom-Json
  if ($ExpectSuccess -and $exitCode -ne 0) {
    throw "Controller action $Action failed unexpectedly with $($document.errorCode): $($document.message)"
  }
  if (-not $ExpectSuccess -and $exitCode -eq 0) {
    throw "Controller action $Action unexpectedly succeeded."
  }
  return [pscustomobject]@{ exitCode = $exitCode; document = $document }
}

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $testRoot "scripts"), (Join-Path $testRoot "dist\src"), (Join-Path $testRoot "vendor\tunnel-client"), (Join-Path $testRoot ".tunnel-client") | Out-Null
  foreach ($name in @("runtime-control.ps1", "component-runtime.psm1", "project-reading-runtime.psm1", "key-store.ps1")) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "scripts\$name") -Destination (Join-Path $testRoot "scripts\$name")
  }

  $serverSource = @'
const http = require("http");
const port = Number(process.env.WORKSPACE_MCP_HTTP_PORT);
const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "gpt-project-workspace-mcp" }));
    return;
  }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ok");
});
server.listen(port, "127.0.0.1");
'@
  [IO.File]::WriteAllText((Join-Path $testRoot "dist\src\http-main.js"), $serverSource, (New-Object Text.UTF8Encoding($false)))

  $fakeTunnelPath = Join-Path $testRoot "vendor\tunnel-client\fake-tunnel.exe"
  $tunnelSource = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;

public static class FakeTunnel
{
    public static int Main(string[] args)
    {
        string pidPath = null;
        string profileDir = null;
        for (int i = 0; i + 1 < args.Length; i++)
        {
            if (args[i] == "--pid.file") pidPath = args[i + 1];
            if (args[i] == "--profile-dir") profileDir = args[i + 1];
        }
        if (!string.IsNullOrWhiteSpace(pidPath))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(pidPath));
            File.WriteAllText(pidPath, Process.GetCurrentProcess().Id.ToString());
        }
        int port = int.Parse(File.ReadAllText(Path.Combine(profileDir, "test-port.txt")));
        TcpListener listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        while (true)
        {
            using (TcpClient client = listener.AcceptTcpClient())
            using (NetworkStream stream = client.GetStream())
            {
                byte[] request = new byte[4096];
                int requestBytes = stream.Read(request, 0, request.Length);
                if (requestBytes <= 0) continue;
                byte[] body = Encoding.UTF8.GetBytes("ready");
                byte[] headers = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: " + body.Length + "\r\nConnection: close\r\n\r\n");
                stream.Write(headers, 0, headers.Length);
                stream.Write(body, 0, body.Length);
            }
        }
    }
}
'@
  Add-Type -TypeDefinition $tunnelSource -Language CSharp -OutputAssembly $fakeTunnelPath -OutputType ConsoleApplication
  [IO.File]::WriteAllText((Join-Path $testRoot ".tunnel-client\test-profile.yaml"), "test: true", (New-Object Text.UTF8Encoding($false)))

  $serverPort = Get-FreeTcpPort
  do { $tunnelPort = Get-FreeTcpPort } while ($tunnelPort -eq $serverPort)
  [IO.File]::WriteAllText((Join-Path $testRoot ".tunnel-client\test-port.txt"), [string]$tunnelPort, (New-Object Text.UTF8Encoding($false)))
  $env:CONTROL_PLANE_API_KEY = "isolated-test-placeholder"
  $env:PROJECT_READING_TEST_TUNNEL_PORT = [string]$tunnelPort

  $selfTest = Invoke-TestController -Action SelfTest
  Assert-Equal $selfTest.document.runtimeContract "unified-lifecycle-v3" "controller self-test contract is v3"
  Assert-True (@($selfTest.document.capabilities).Count -eq 6) "controller declares the complete Option C capability set"

  $initial = Invoke-TestController -Action Status
  Assert-Equal $initial.document.after.status "Stopped" ("isolated runtime starts stopped; evidence=" + ($initial.document.after | ConvertTo-Json -Compress -Depth 5))

  $staleForeign = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-Command", "Start-Sleep -Seconds 120") -WindowStyle Hidden -PassThru
  $serverPidFile = Join-Path $testRoot ".tmp\project-reading-server.pid"
  $serverOwnerFile = Join-Path $testRoot ".tmp\project-reading-server.owner.json"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $serverPidFile) | Out-Null
  [IO.File]::WriteAllText($serverPidFile, [string]$staleForeign.Id, (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText($serverOwnerFile, '{}', (New-Object Text.UTF8Encoding($false)))
  $reused = Invoke-TestController -Action Status
  Assert-Equal $reused.document.after.server.ownership "Stopped" "listener-free reused PID is classified stopped"
  Assert-True (-not (Test-Path -LiteralPath $serverPidFile)) "listener-free reused PID file is removed"
  Assert-True (-not (Test-Path -LiteralPath $serverOwnerFile)) "listener-free reused owner file is removed"
  Assert-True ($null -ne (Get-Process -Id $staleForeign.Id -ErrorAction SilentlyContinue)) "listener-free reused process remains untouched"
  Stop-Process -Id $staleForeign.Id -Force -ErrorAction Stop
  $null = $staleForeign.WaitForExit(5000)
  $staleForeign.Dispose()
  $staleForeign = $null

  $nodePath = (Get-Command node -ErrorAction Stop).Source
  $sameExecutablePath = Join-Path $testRoot "same-executable.js"
  [IO.File]::WriteAllText($sameExecutablePath, 'setInterval(()=>{},1000);', (New-Object Text.UTF8Encoding($false)))
  $staleForeign = Start-Process -FilePath $nodePath -ArgumentList "`"$sameExecutablePath`"" -WorkingDirectory $testRoot -WindowStyle Hidden -PassThru
  $sameExecutableMetadata = [ordered]@{
    schemaVersion = 1; role = "server"; pid = $staleForeign.Id; executablePath = $nodePath
    startTimeUtc = [DateTime]::UtcNow.AddDays(-1).ToString("o"); identity = (Join-Path $testRoot "dist\src\http-main.js")
    recordedAt = [DateTime]::UtcNow.AddDays(-1).ToString("o")
  }
  [IO.File]::WriteAllText($serverPidFile, [string]$staleForeign.Id, (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText($serverOwnerFile, ($sameExecutableMetadata | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  $sameExecutable = Invoke-TestController -Action Status
  Assert-Equal $sameExecutable.document.after.server.ownership "Stopped" "same executable with wrong start time is stale when listener-free"
  Assert-True ($null -ne (Get-Process -Id $staleForeign.Id -ErrorAction SilentlyContinue)) "same-executable unrelated process remains untouched"
  Stop-Process -Id $staleForeign.Id -Force -ErrorAction Stop
  $null = $staleForeign.WaitForExit(5000)
  $staleForeign.Dispose()
  $staleForeign = $null

  $staleForeign = Start-Process -FilePath $nodePath -ArgumentList "`"$sameExecutablePath`"" -WorkingDirectory $testRoot -WindowStyle Hidden -PassThru
  [IO.File]::WriteAllText($serverPidFile, [string]$staleForeign.Id, (New-Object Text.UTF8Encoding($false)))
  Remove-Item -LiteralPath $serverOwnerFile -Force -ErrorAction SilentlyContinue
  $missingOwner = Invoke-TestController -Action Status
  Assert-Equal $missingOwner.document.after.server.ownership "OwnershipUnknown" "live exact executable with missing metadata remains unknown"
  Assert-Equal $missingOwner.document.after.status "OwnershipUnknown" "role ownership unknown propagates to top-level runtime status"
  Assert-True (Test-Path -LiteralPath $serverPidFile) "unknown ownership preserves PID evidence"
  Assert-True ($null -ne (Get-Process -Id $staleForeign.Id -ErrorAction SilentlyContinue)) "unknown ownership does not stop the process"
  Stop-Process -Id $staleForeign.Id -Force -ErrorAction Stop
  $null = $staleForeign.WaitForExit(5000)
  $staleForeign.Dispose()
  $staleForeign = $null
  Remove-Item -LiteralPath $serverPidFile,$serverOwnerFile -Force -ErrorAction SilentlyContinue

  $ensure = Invoke-TestController -Action EnsureRunning
  Assert-Equal $ensure.document.after.status "Ready" "ensure running starts the isolated server and tunnel"
  $serverPid1 = [int]$ensure.document.after.server.pid
  $tunnelPid1 = [int]$ensure.document.after.tunnel.pid
  Assert-True ($serverPid1 -gt 0 -and $tunnelPid1 -gt 0) "ensure running records both exact owned PIDs"

  $repair = Invoke-TestController -Action RepairConnectivity
  Assert-Equal $repair.document.after.status "Ready" "repair connectivity is idempotent when ready"
  Assert-Equal $repair.document.after.server.pid $serverPid1 "repair connectivity does not restart a healthy core"
  Assert-Equal $repair.document.after.tunnel.pid $tunnelPid1 "repair connectivity does not replace a healthy tunnel"

  $restartCore = Invoke-TestController -Action RestartCore
  $serverPid2 = [int]$restartCore.document.after.server.pid
  Assert-Equal $restartCore.document.after.status "Ready" "restart core returns to ready"
  Assert-True ($serverPid2 -gt 0 -and $serverPid2 -ne $serverPid1) "restart core replaces only the server PID"
  Assert-Equal $restartCore.document.after.tunnel.pid $tunnelPid1 "restart core preserves the tunnel PID"

  $reload = Invoke-TestController -Action ReloadRuntime
  Assert-Equal $reload.document.after.status "Ready" "reload runtime returns to ready"
  Assert-True ([int]$reload.document.after.server.pid -ne $serverPid2) "reload runtime replaces the server PID"
  Assert-True ([int]$reload.document.after.tunnel.pid -ne $tunnelPid1) "reload runtime replaces the tunnel PID"

  $shutdown = Invoke-TestController -Action ShutdownRuntime
  Assert-Equal $shutdown.document.after.status "Stopped" "shutdown runtime stops both owned processes"
  Assert-True (@($shutdown.document.after.ownedPids).Count -eq 0) "shutdown leaves no owned PID"

  $foreignSource = 'const http=require("http");const p=Number(process.argv[2]);http.createServer((q,s)=>{s.writeHead(200,{"content-type":"application/json"});s.end(JSON.stringify({ok:true,service:"not-project-reading"}))}).listen(p,"127.0.0.1");'
  $foreignPath = Join-Path $testRoot "foreign.js"
  [IO.File]::WriteAllText($foreignPath, $foreignSource, (New-Object Text.UTF8Encoding($false)))
  $foreign = Start-Process -FilePath $nodePath -ArgumentList "`"$foreignPath`" $serverPort" -WorkingDirectory $testRoot -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 600
  $staleForeign = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-Command", "Start-Sleep -Seconds 120") -WindowStyle Hidden -PassThru
  [IO.File]::WriteAllText($serverPidFile, [string]$staleForeign.Id, (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText($serverOwnerFile, '{}', (New-Object Text.UTF8Encoding($false)))
  $foreignShutdown = Invoke-TestController -Action ShutdownRuntime -ExpectSuccess $false
  Assert-Equal $foreignShutdown.document.errorCode "OWNERSHIP_MISMATCH" "shutdown rejects a foreign listener"
  Assert-True ($null -ne (Get-Process -Id $foreign.Id -ErrorAction SilentlyContinue)) "foreign listener remains untouched"
  Assert-True ($null -ne (Get-Process -Id $staleForeign.Id -ErrorAction SilentlyContinue)) "stale PID process remains untouched while a foreign listener exists"
  Assert-True (Test-Path -LiteralPath $serverPidFile) "foreign-listener conflict preserves stale PID evidence"
  Stop-Process -Id $foreign.Id -Force -ErrorAction SilentlyContinue
  $null = $foreign.WaitForExit(5000)
  $foreign.Dispose()
  $foreign = $null
  Stop-Process -Id $staleForeign.Id -Force -ErrorAction SilentlyContinue
  $null = $staleForeign.WaitForExit(5000)
  $staleForeign.Dispose()
  $staleForeign = $null
  Remove-Item -LiteralPath $serverPidFile,$serverOwnerFile -Force -ErrorAction SilentlyContinue

  Assert-True (Test-Path -LiteralPath (Join-Path $testRoot ".tmp\runtime-control.jsonl") -PathType Leaf) "controller writes a component-owned action audit"
  [pscustomobject]@{
    ok = $true
    assertions = $script:Passed
    actions = @("SelfTest", "Status", "EnsureRunning", "RepairConnectivity", "RestartCore", "ReloadRuntime", "ShutdownRuntime", "ForeignOwnerGuard")
  } | ConvertTo-Json -Depth 4
}
finally {
  if ($null -ne $foreign) {
    Stop-Process -Id $foreign.Id -Force -ErrorAction SilentlyContinue
    try { $null = $foreign.WaitForExit(5000) } catch { }
    $foreign.Dispose()
  }
  if ($null -ne $staleForeign) {
    Stop-Process -Id $staleForeign.Id -Force -ErrorAction SilentlyContinue
    try { $null = $staleForeign.WaitForExit(5000) } catch { }
    $staleForeign.Dispose()
  }
  foreach ($pair in @(
    @(".tmp\project-reading-server.pid", ".tmp\project-reading-server.owner.json"),
    @(".tmp\tunnel-client.pid", ".tmp\tunnel-client.owner.json")
  )) {
    $pidPath = Join-Path $testRoot $pair[0]
    $ownerPath = Join-Path $testRoot $pair[1]
    if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf) -or -not (Test-Path -LiteralPath $ownerPath -PathType Leaf)) { continue }
    try {
      $pidValue = 0
      if (-not [int]::TryParse(([IO.File]::ReadAllText($pidPath).Trim()), [ref]$pidValue)) { continue }
      $metadata = [IO.File]::ReadAllText($ownerPath) | ConvertFrom-Json
      $process = Get-Process -Id $pidValue -ErrorAction Stop
      if (
        [IO.Path]::GetFullPath([string]$process.Path).Equals([IO.Path]::GetFullPath([string]$metadata.executablePath), [StringComparison]::OrdinalIgnoreCase) -and
        $process.StartTime.ToUniversalTime().ToString("o") -eq [string]$metadata.startTimeUtc
      ) {
        Stop-Process -Id $pidValue -Force -ErrorAction Stop
        $null = $process.WaitForExit(5000)
      }
    }
    catch { }
  }
  if ($null -eq $previousApiKey) { Remove-Item Env:\CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue }
  else { $env:CONTROL_PLANE_API_KEY = $previousApiKey }
  if ($null -eq $previousTunnelPort) { Remove-Item Env:\PROJECT_READING_TEST_TUNNEL_PORT -ErrorAction SilentlyContinue }
  else { $env:PROJECT_READING_TEST_TUNNEL_PORT = $previousTunnelPort }
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  if ($resolvedTestRoot.StartsWith($tempBase + '\', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTestRoot)) {
    $removed = $false
    for ($attempt = 0; $attempt -lt 10 -and -not $removed; $attempt++) {
      try {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
        $removed = $true
      }
      catch {
        if ($attempt -eq 9) { throw }
        Start-Sleep -Milliseconds 300
      }
    }
  }
}
