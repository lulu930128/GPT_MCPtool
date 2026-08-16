Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$testRoot = Join-Path $tempBase ("omi-search-runtime-test-" + [Guid]::NewGuid().ToString("N"))
$utf8NoBom = New-Object Text.UTF8Encoding($false)
$script:Passed = 0
$previousApiKey = $env:CONTROL_PLANE_API_KEY
$backendProcess = $null
$foreignProcess = $null

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

function Wait-TcpPort([int]$Port, [bool]$Open) {
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $client = New-Object Net.Sockets.TcpClient
    try {
      $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
      $actual = $async.AsyncWaitHandle.WaitOne(150, $false)
      if ($actual) { try { $client.EndConnect($async) } catch { $actual = $false } }
    }
    catch { $actual = $false }
    finally { $client.Dispose() }
    if ($actual -eq $Open) { return $true }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

function Start-TestBackend {
  $process = Start-Process -FilePath $pythonPath -ArgumentList "-B `"$backendScript`" $backendPort" -WorkingDirectory $testRoot -WindowStyle Hidden -PassThru
  if (-not (Wait-TcpPort -Port $backendPort -Open $true)) { throw "Fake OMI backend did not start." }
  return $process
}

function Stop-TestProcess([Diagnostics.Process]$Process) {
  if ($null -eq $Process) { return }
  try {
    if (-not $Process.HasExited) {
      Stop-Process -Id $Process.Id -Force -ErrorAction Stop
      $null = $Process.WaitForExit(5000)
    }
  }
  catch { }
  $Process.Dispose()
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
    "-OmiApiBaseUrl", "http://127.0.0.1:$backendPort",
    "-StrictOmiApiBaseUrl",
    "-PythonPath", $pythonPath,
    "-TunnelClientPath", $fakeTunnelPath,
    "-TunnelProfileDir", (Join-Path $testRoot ".tunnel-client"),
    "-TunnelProfile", "test-profile",
    "-TunnelHealthUrl", "http://127.0.0.1:$tunnelPort",
    "-KeyStorePath", (Join-Path $testRoot "scripts\key-store.ps1"),
    "-ServerReadyTimeoutSeconds", "5",
    "-TunnelRecoveryDelaysSeconds", "2"
  )
  $output = @(& powershell.exe @arguments 2>&1)
  $exitCode = $LASTEXITCODE
  $document = ($output -join [Environment]::NewLine) | ConvertFrom-Json
  if ($ExpectSuccess -and $exitCode -ne 0) {
    throw "Controller action $Action failed unexpectedly with $($document.errorCode): $($document.message)"
  }
  if (-not $ExpectSuccess -and $exitCode -eq 0) { throw "Controller action $Action unexpectedly succeeded." }
  return [pscustomobject]@{ exitCode = $exitCode; document = $document }
}

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $testRoot "scripts"), (Join-Path $testRoot "vendor\tunnel-client"), (Join-Path $testRoot ".tunnel-client") | Out-Null
  foreach ($name in @("runtime-control.ps1", "component-runtime.psm1", "omi-search-runtime.psm1")) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "scripts\$name") -Destination (Join-Path $testRoot "scripts\$name")
  }
  Copy-Item -LiteralPath (Join-Path $projectRoot "http_server.py") -Destination (Join-Path $testRoot "http_server.py")
  Copy-Item -LiteralPath (Join-Path $projectRoot "server.py") -Destination (Join-Path $testRoot "server.py")
  Copy-Item -LiteralPath (Join-Path $projectRoot "public_contract_snapshot.json") -Destination (Join-Path $testRoot "public_contract_snapshot.json")
  Copy-Item -LiteralPath (Join-Path $projectRoot "tw_market_dashboard_contract_snapshot.json") -Destination (Join-Path $testRoot "tw_market_dashboard_contract_snapshot.json")
  New-Item -ItemType Directory -Force -Path (Join-Path $testRoot "ui\tw-market-dashboard\dist") | Out-Null
  Copy-Item -LiteralPath (Join-Path $projectRoot "ui\tw-market-dashboard\dist\index.html") -Destination (Join-Path $testRoot "ui\tw-market-dashboard\dist\index.html")
  Copy-Item -LiteralPath "C:\GPT_MCPtool\project_reading\scripts\key-store.ps1" -Destination (Join-Path $testRoot "scripts\key-store.ps1")

  $pythonPath = (Get-Command python -ErrorAction Stop).Source
  $backendPort = Get-FreeTcpPort
  do { $serverPort = Get-FreeTcpPort } while ($serverPort -eq $backendPort)
  do { $tunnelPort = Get-FreeTcpPort } while ($tunnelPort -in @($backendPort, $serverPort))

  $backendScript = Join-Path $testRoot "fake_backend.py"
  $backendSource = @'
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/system/health":
            body = json.dumps({"status": "ok", "app_name": "Open Market Intelligence"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()
    def log_message(self, *_):
        pass

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
'@
  [IO.File]::WriteAllText($backendScript, $backendSource, $utf8NoBom)

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
  [IO.File]::WriteAllText((Join-Path $testRoot ".tunnel-client\test-profile.yaml"), "test: true", $utf8NoBom)
  [IO.File]::WriteAllText((Join-Path $testRoot ".tunnel-client\test-port.txt"), [string]$tunnelPort, $utf8NoBom)

  $env:CONTROL_PLANE_API_KEY = "isolated-test-placeholder"
  $backendProcess = Start-TestBackend

  $selfTest = Invoke-TestController -Action SelfTest
  Assert-Equal $selfTest.document.runtimeContract "unified-lifecycle-v3" "controller self-test contract is v3"
  Assert-True (@($selfTest.document.capabilities).Count -eq 6) "controller declares the complete capability set"
  Assert-Equal $selfTest.document.externalDependencyOwned $false "OMI backend remains an external dependency"

  $initial = Invoke-TestController -Action Status
  Assert-Equal $initial.document.after.status "Stopped" "isolated runtime starts stopped"

  $ensure = Invoke-TestController -Action EnsureRunning
  Assert-Equal $ensure.document.after.status "Ready" "ensure starts adapter and tunnel"
  $serverPid1 = [int]$ensure.document.after.server.pid
  $tunnelPid1 = [int]$ensure.document.after.tunnel.pid
  Assert-True ($serverPid1 -gt 0 -and $tunnelPid1 -gt 0) "ensure records both exact owned PIDs"

  $repair = Invoke-TestController -Action RepairConnectivity
  Assert-Equal $repair.document.after.status "Ready" "repair is idempotent when ready"
  Assert-Equal $repair.document.after.server.pid $serverPid1 "repair preserves healthy adapter"
  Assert-Equal $repair.document.after.tunnel.pid $tunnelPid1 "repair preserves healthy tunnel"

  Stop-TestProcess -Process $backendProcess
  $backendProcess = $null
  Assert-True (Wait-TcpPort -Port $backendPort -Open $false) "fake backend is stopped"
  $blocked = Invoke-TestController -Action Status
  Assert-Equal $blocked.document.after.status "BlockedUpstream" "dependency loss is visible without runtime takeover"
  Assert-Equal $blocked.document.after.server.pid $serverPid1 "dependency loss preserves adapter PID"
  Assert-Equal $blocked.document.after.tunnel.pid $tunnelPid1 "dependency loss preserves tunnel PID"

  $restartCore = Invoke-TestController -Action RestartCore
  $serverPid2 = [int]$restartCore.document.after.server.pid
  Assert-Equal $restartCore.document.after.status "BlockedUpstream" "restart core does not hide dependency loss"
  Assert-True ($serverPid2 -gt 0 -and $serverPid2 -ne $serverPid1) "restart core replaces only adapter PID"
  Assert-Equal $restartCore.document.after.tunnel.pid $tunnelPid1 "restart core preserves tunnel PID"

  $reload = Invoke-TestController -Action ReloadRuntime
  Assert-Equal $reload.document.after.status "BlockedUpstream" "reload preserves external dependency semantics"
  Assert-True ([int]$reload.document.after.server.pid -ne $serverPid2) "reload replaces adapter PID"
  Assert-True ([int]$reload.document.after.tunnel.pid -ne $tunnelPid1) "reload replaces tunnel PID"

  $backendProcess = Start-TestBackend
  $readyAgain = Invoke-TestController -Action Status
  Assert-Equal $readyAgain.document.after.status "Ready" "external dependency recovery returns status to ready"
  Assert-Equal $readyAgain.document.after.dependency.owned $false "recovered backend is still not owned"

  $shutdown = Invoke-TestController -Action ShutdownRuntime
  Assert-Equal $shutdown.document.after.status "Stopped" "shutdown stops owned adapter and tunnel"
  Assert-True (@($shutdown.document.after.ownedPids).Count -eq 0) "shutdown leaves no owned PID"
  Assert-True ($null -ne (Get-Process -Id $backendProcess.Id -ErrorAction SilentlyContinue)) "shutdown leaves the external backend untouched"

  $previousBaseUrl = $env:OMI_SEARCH_API_BASE_URL
  $env:OMI_SEARCH_API_BASE_URL = "http://127.0.0.1:$backendPort"
  $foreignProcess = Start-Process -FilePath $pythonPath -ArgumentList "-B `"$(Join-Path $testRoot 'http_server.py')`" --host 127.0.0.1 --port $serverPort" -WorkingDirectory $testRoot -WindowStyle Hidden -PassThru
  Assert-True (Wait-TcpPort -Port $serverPort -Open $true) "foreign adapter listener started"
  $foreignShutdown = Invoke-TestController -Action ShutdownRuntime -ExpectSuccess $false
  Assert-Equal $foreignShutdown.document.errorCode "OWNERSHIP_MISMATCH" "shutdown rejects an unmanaged exact listener"
  Assert-True ($null -ne (Get-Process -Id $foreignProcess.Id -ErrorAction SilentlyContinue)) "foreign listener remains untouched"
  Stop-TestProcess -Process $foreignProcess
  $foreignProcess = $null
  if ($null -eq $previousBaseUrl) { Remove-Item Env:\OMI_SEARCH_API_BASE_URL -ErrorAction SilentlyContinue } else { $env:OMI_SEARCH_API_BASE_URL = $previousBaseUrl }

  $actionLogPath = Join-Path $testRoot ".tmp\runtime-control.jsonl"
  Assert-True (Test-Path -LiteralPath $actionLogPath -PathType Leaf) "controller writes a component-owned action audit"
  $auditText = [IO.File]::ReadAllText($actionLogPath)
  Assert-True ($auditText.IndexOf("isolated-test-placeholder", [StringComparison]::Ordinal) -lt 0) "audit excludes runtime secrets"
  Assert-True ($auditText.IndexOf("http://127.0.0.1:$backendPort", [StringComparison]::OrdinalIgnoreCase) -lt 0) "audit excludes dependency endpoint details"

  [pscustomobject]@{
    ok = $true
    assertions = $script:Passed
    actions = @("SelfTest", "Status", "EnsureRunning", "RepairConnectivity", "BlockedUpstream", "RestartCore", "ReloadRuntime", "ShutdownRuntime", "ForeignOwnerGuard")
  } | ConvertTo-Json -Depth 4
}
finally {
  Stop-TestProcess -Process $foreignProcess
  Stop-TestProcess -Process $backendProcess
  foreach ($pair in @(
    @(".tmp\omi-search-http-server.pid", ".tmp\omi-search-http-server.owner.json"),
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
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  if ($resolvedTestRoot.StartsWith($tempBase + '\', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTestRoot)) {
    $removed = $false
    for ($attempt = 0; $attempt -lt 10 -and -not $removed; $attempt++) {
      try { Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force; $removed = $true }
      catch { if ($attempt -eq 9) { throw }; Start-Sleep -Milliseconds 300 }
    }
  }
}
