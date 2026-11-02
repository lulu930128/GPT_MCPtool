# Disposable fake Launcher only. The test copies this file to a temporary
# repository's scripts/omi-launcher.ps1; never use the production pipe name.
$ErrorActionPreference = 'Stop'
$fixtureRoot = Split-Path $PSScriptRoot -Parent
$fixtureConfig = Get-Content -LiteralPath (Join-Path $fixtureRoot 'fixture.json') -Raw | ConvertFrom-Json
if ($fixtureConfig.mode -eq 'controller_snapshot') {
    # Compile only byte copies selected by the test. Never dot-source the real
    # Launcher, call its lifecycle or connect to its pipe/store.
    Add-Type -Path @((Join-Path $fixtureRoot 'OmiRuntimeControl.cs'), (Join-Path $fixtureRoot 'OmiOwnedShutdown.cs')) -ReferencedAssemblies @('System.Web.Extensions','System.Core','System.Windows.Forms')
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $syntheticHash = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::ASCII.GetBytes(('a' * 64))))).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose() }
    $controller = [Omi.RuntimeControl.Controller]::new((Join-Path $fixtureRoot 'receipts'), $syntheticHash, [string]$fixtureConfig.pipe)
    try {
        $process = [Diagnostics.Process]::GetCurrentProcess()
        $identity = [Omi.RuntimeControl.Identity]::new()
        $identity.pid = $PID
        $identity.created_at = $process.StartTime.ToUniversalTime().ToString('o')
        # No Backend process, listener, DB or owner lifecycle is created. An
        # optional synthetic binding tests Restart admission only.
        $backend = $null
        $attested = $false
        if ($fixtureConfig.binding -ne 'absent') {
            $backend = [Omi.RuntimeControl.Identity]::new()
            $backend.pid = [int]$fixtureConfig.client_pid
            $backend.created_at = [Diagnostics.Process]::GetProcessById($backend.pid).StartTime.ToUniversalTime().ToString('o')
            if ($fixtureConfig.binding -eq 'owned') { $backend = $identity }
            if ($fixtureConfig.binding -eq 'recycled') { $backend.created_at = '2000-01-01T00:00:00.0000000Z' }
            $attested = $true
        }
        $snapshot = '{"backend":{"status":"stopped"},"restart":{"available":false}}'
        $controller.Publish($snapshot, $backend, $attested)
        $controller.Start()
        [IO.File]::WriteAllText((Join-Path $fixtureRoot 'ready'), 'ready')
        $consumed = $false
        for ($i=0; $i -lt 1200 -and -not (Test-Path -LiteralPath (Join-Path $fixtureRoot 'stop')); $i++) {
            $controller.Publish($snapshot, $backend, $attested)
            if (-not $consumed -and (Test-Path -LiteralPath (Join-Path $fixtureRoot 'consume'))) {
                $id = $controller.TakePending()
                if ($id) {
                    $action = $controller.PendingAction($id)
                    $first = $controller.BeginRemoteOperation($id)
                    $second = $controller.BeginRemoteOperation($id)
                    if ($first) {
                        # No fabricated success: only consume the real Controller
                        # intent, then terminate UNKNOWN with no lifecycle work.
                        $controller.CompleteRemoteOperation($id, $false, 'NOT_ATTEMPTED', 'NOT_ATTEMPTED', 'NOT_ATTEMPTED', $null, $null)
                    }
                    $consumed = $true
                    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'consumed.json'), (@{
                        action=$action; first=$first; second=$second; pending_after=$controller.TakePending()
                    } | ConvertTo-Json -Compress))
                }
            }
            Start-Sleep -Milliseconds 25
        }
    } finally { $controller.Dispose() }
    exit 0
}
Add-Type -ReferencedAssemblies @('System.Web.Extensions') -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;
using System.Collections.Generic;
public static class DisposableLauncherPipe {
    public static void Run(string root) {
        var json = new JavaScriptSerializer();
        var config = json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,"fixture.json")));
        string name = (string)config["pipe"];
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid,null), PipeAccessRights.FullControl, AccessControlType.Deny));
        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
        using(var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous, 16384, 16384, security)) {
            var connection = server.BeginWaitForConnection(null,null);
            File.WriteAllText(Path.Combine(root,"ready"),"ready");
            using(var wait = connection.AsyncWaitHandle) {
                for(int i=0; !wait.WaitOne(25); i++)
                    if(i>=400 || File.Exists(Path.Combine(root,"stop"))) return;
                server.EndWaitForConnection(connection);
            }
            var bytes = new List<byte>();
            var buffer = new byte[1024];
            while(bytes.Count < 16384) {
                var reading = server.BeginRead(buffer,0,buffer.Length,null,null);
                using(var wait = reading.AsyncWaitHandle) {
                    if(!wait.WaitOne(3000)) return;
                    int count = server.EndRead(reading);
                    if(count == 0) return;
                    for(int i=0;i<count;i++) bytes.Add(buffer[i]);
                }
                if(bytes.Contains(10)) break;
            }
            var request = json.Deserialize<Dictionary<string,string>>(Encoding.UTF8.GetString(bytes.ToArray()));
            // Persist only synthetic receipt metadata. Never log request/token.
            File.WriteAllText(Path.Combine(root,"received.json"), json.Serialize(new {
                action=request["action"], request_id=request["request_id"],
                expected_owner_id=request["expected_owner_id"],
                authenticated=request["token"] == new string('a',64),
                fields=request.Count
            }));
            if((string)config["mode"] == "timeout") {
                for(int i=0;i<140 && !File.Exists(Path.Combine(root,"stop"));i++) Thread.Sleep(25);
                return;
            }
            var reply = Encoding.UTF8.GetBytes((string)config["raw"]);
            server.Write(reply,0,reply.Length);
            // Keep owner alive until client validates the retained handle.
            for(int i=0;i<140 && !File.Exists(Path.Combine(root,"stop"));i++) Thread.Sleep(25);
        }
    }
}
'@
try { [DisposableLauncherPipe]::Run((Split-Path $PSScriptRoot -Parent)) }
catch {
    # Test diagnostics contain exception type only, never message/paths/token.
    [IO.File]::WriteAllText((Join-Path (Split-Path $PSScriptRoot -Parent) 'fixture-error'), $_.Exception.GetBaseException().GetType().Name)
    exit 2
}
