using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// NORMAL kernel for the existing CC owner. No listener, Journal, activation flag,
// breakaway, elevation, PATH lookup or tool-facing shell dispatch. The protected
// installed Host supplies a private, once-only authenticated request capability.
// The public Execute entry still fails before creating a process.
public static class McpCcNormalExecution {
    public const int TimeoutMs=30000;
    const string Executable=@"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
    // No candidate text is interpolated into command-line syntax. The fixed program
    // waits for stdin until identity/job checks pass, then invokes the exact ScriptBlock.
    const string Bootstrap="$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " +
        "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); " +
        "try { $line=[Console]::In.ReadLine(); if (!$line) { exit 125 }; " +
        "$p=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))); " +
        "$a=@(); foreach($v in $p.args) { $a+=,[string]$v }; " +
        "& ([ScriptBlock]::Create([string]$p.script)) @a; if (!$?) { exit 1 }; exit 0 } catch { [Console]::Error.WriteLine('POWERSHELL_EXECUTION_FAILED'); exit 1 }";
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long processTime, jobTime; public uint flags; public UIntPtr minimum, maximum;
        public uint active; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
        public BasicLimit basic; public Counters io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
    }
    sealed class JobHandle : SafeHandleZeroOrMinusOneIsInvalid {
        public JobHandle():base(true) {} protected override bool ReleaseHandle() { return CloseHandle(handle); }
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern JobHandle CreateJobObject(IntPtr security,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(JobHandle job,int type,ref ExtendedLimit limits,int length);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(JobHandle job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    public sealed class Packet {
        public string requestId, digest, grantId, consumptionId, mode, script, scriptSha256, cwd, expectedSid;
        public string[] args;
        public long expiresAt, receiptDeadline;
    }
    public sealed class Observation {
        public string requestId,digest,grantId,consumptionId,outcome,reason,outputSha256,sid,logonId;
        public int? exitCode;
        public int processId,session,stdoutBytes,stderrBytes;
        public string startedUtcTicks;
        public long completedAt;
        public bool elevated,outputTruncated;
        public string verification="OS_OBSERVATION_ONLY_NOT_INGESTED";
    }
    internal sealed class Execution {
        internal Observation observation;
        internal Dictionary<string,object> output;
    }
    public static string Sha256(byte[] bytes) {
        using(var hash=SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
    }
    static bool Hash(string value) { return value!=null && System.Text.RegularExpressions.Regex.IsMatch(value,"\\A[a-f0-9]{64}\\z"); }
    static bool Id(string value) { Guid id; return Guid.TryParseExact(value,"D",out id) && id!=Guid.Empty; }
    static long Now() { return (DateTime.UtcNow.Ticks-621355968000000000L)/10000; }
    /** Pure validation only. Never returns an execution capability. */
    public static void Validate(Packet p) {
        if(p!=null && p.mode=="ADMIN") throw new InvalidOperationException("BLOCKED_AWAITING_LOCAL_UAC");
        if(p==null || !Id(p.requestId) || !Id(p.grantId) || !Id(p.consumptionId) || !Hash(p.digest)
            || !Hash(p.scriptSha256) || p.mode!="NORMAL" || String.IsNullOrEmpty(p.script) || p.script.Length>8000
            || p.args==null || p.args.Length>32 || p.expiresAt<=Now() || p.expiresAt>Now()+120000
            || p.receiptDeadline<=Now() || p.receiptDeadline>Now()+120000 || String.IsNullOrEmpty(p.expectedSid))
            throw new InvalidOperationException("NORMAL_DELIVERY_REJECTED");
        // Throw on invalid Unicode; exact UTF-8 input cannot be silently replaced.
        if(Sha256(new UTF8Encoding(false,true).GetBytes(p.script))!=p.scriptSha256)
            throw new InvalidOperationException("SCRIPT_DIGEST_MISMATCH");
        foreach(var a in p.args) if(a==null || a.Length>512 || a.IndexOf('\0')>=0)
            throw new InvalidOperationException("NORMAL_ARGUMENT_REJECTED");
        // Canonical drive/UNC directories, including a drive root. CWD is an OS
        // location, not a project identity. Device namespaces remain forbidden.
        if(String.IsNullOrEmpty(p.cwd) || !System.Text.RegularExpressions.Regex.IsMatch(p.cwd,@"\A(?:[A-Za-z]:\\|\\\\(?![?.]\\)[^\\/:*?""<>|\r\n\0]+\\[^\\/:*?""<>|\r\n\0]+(?:\\|\z))[^/:*?""<>|\r\n\0]*\z")
            || !String.Equals(Path.GetFullPath(p.cwd),p.cwd,StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("NORMAL_CWD_REJECTED");
    }
    static void AssertDirectory(string path) {
        var item=new DirectoryInfo(path);
        if(!item.Exists) throw new InvalidOperationException("NORMAL_CWD_REJECTED");
        while(item!=null) {
            if((item.Attributes & FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("NORMAL_CWD_REPARSE_REJECTED");
            item=item.Parent;
        }
    }
    // This must become a receiver-owned, non-serializable capability ONLY after
    // installed closure, native peer/DACL, canonical fsync consume, and the exact authenticated
    // DIRECT request have all been independently verified. Never replace it with a bool,
    // caller delegate, password string, environment flag, or Review ACCEPTED.
    sealed class HostLease {
        public readonly Packet packet;
        HostLease(Packet p) { packet=p; }
        public static HostLease Require(Packet p,McpCcNormalHost.DirectRequestAuthority ceremony) {
            if(ceremony==null) throw new InvalidOperationException("BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED");
            ceremony.Consume(p);
            return new HostLease(p);
        }
    }
    public static Observation Execute(Packet packet) {
        Validate(packet);
        throw new InvalidOperationException("BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED");
    }
    internal static Execution ExecuteAuthorized(Packet packet,McpCcNormalHost.DirectRequestAuthority ceremony) {
        Validate(packet);
        // Detach mutable caller data before any future native authority work.
        var snapshot=new Packet { requestId=packet.requestId,digest=packet.digest,grantId=packet.grantId,
            consumptionId=packet.consumptionId,mode=packet.mode,script=packet.script,scriptSha256=packet.scriptSha256,
            cwd=packet.cwd,expectedSid=packet.expectedSid,args=(string[])packet.args.Clone(),
            expiresAt=packet.expiresAt,receiptDeadline=packet.receiptDeadline };
        Validate(snapshot);
        return Run(HostLease.Require(snapshot,ceremony));
    }
    static async Task<byte[]> Capture(Stream stream) {
        var chunk=new byte[1024];
        using(var output=new MemoryStream()) {
            int n;
            while((n=await stream.ReadAsync(chunk,0,chunk.Length).ConfigureAwait(false))>0) {
                output.Write(chunk,0,n);
            }
            return output.ToArray();
        }
    }
    static Execution Run(HostLease lease) {
        var p=lease.packet; Validate(p); AssertDirectory(p.cwd);
        using(var owner=Process.GetCurrentProcess()) {
            var ownerIdentity=McpCcNormalNative.Inspect(owner);
            var ownerToken=McpCcNormalSecurity.Observe(owner);
            McpCcNormalSecurity.AssertNormal(ownerToken,p.expectedSid,ownerIdentity.session);
            if(ownerIdentity.inAnyJob) throw new InvalidOperationException("OWNER_IN_JOB");
            // No breakaway. An independently installed owner starts an ordinary
            // child, then places it in a private kill-on-close Job before stdin.
            using(var job=CreateJobObject(IntPtr.Zero,null)) {
                if(job.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                var limits=new ExtendedLimit(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE; no BREAKAWAY_OK
                if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(ExtendedLimit))))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                var start=new ProcessStartInfo(Executable,"-NoLogo -NoProfile -NonInteractive -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(Bootstrap))) {
                    UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=p.cwd,
                    RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true
                };
                start.EnvironmentVariables.Clear();
                start.EnvironmentVariables["SystemRoot"]=@"C:\Windows"; start.EnvironmentVariables["WINDIR"]=@"C:\Windows";
                start.EnvironmentVariables["PATHEXT"]=".COM;.EXE;.BAT;.CMD";
                start.EnvironmentVariables["PSModulePath"]=@"C:\Windows\System32\WindowsPowerShell\v1.0\Modules";
                using(var child=new Process()) {
                    child.StartInfo=start;
                    if(!child.Start()) throw new InvalidOperationException("NORMAL_SPAWN_FAILED");
                    bool assigned=false;
                    try {
                        var identity=McpCcNormalNative.Inspect(child);
                        var token=McpCcNormalSecurity.Observe(child);
                        McpCcNormalSecurity.AssertNormal(token,p.expectedSid,ownerIdentity.session);
                        if(identity.inAnyJob || token.logonId!=ownerToken.logonId || !String.Equals(identity.image,Executable,StringComparison.OrdinalIgnoreCase))
                            throw new InvalidOperationException("NORMAL_PROCESS_REJECTED");
                        if(!AssignProcessToJobObject(job,child.Handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
                        assigned=true;
                        bool member;
                        if(!IsProcessInJob(child.Handle,job.DangerousGetHandle(),out member) || !member)
                            throw new InvalidOperationException("NORMAL_JOB_REJECTED");
                        var output=Capture(child.StandardOutput.BaseStream);
                        var error=Capture(child.StandardError.BaseStream);
                        McpCcNormalSecurity.AssertUnchanged(owner,ownerToken); McpCcNormalSecurity.AssertUnchanged(child,token);
                        Validate(p); // TTL after launch/setup, before any candidate bytes
                        var json=new JavaScriptSerializer().Serialize(new Dictionary<string,object> { {"script",p.script},{"args",p.args} });
                        var clock=Stopwatch.StartNew();
                        var write=child.StandardInput.WriteLineAsync(Convert.ToBase64String(new UTF8Encoding(false,true).GetBytes(json)));
                        int remaining=(int)Math.Min(TimeoutMs,Math.Max(1,p.receiptDeadline-Now()));
                        if(!write.Wait(remaining)) throw new TimeoutException("NORMAL_INPUT_TIMEOUT");
                        write.GetAwaiter().GetResult();
                        child.StandardInput.Close();
                        string reason="PROCESS_EXITED";
                        while(!child.WaitForExit(20)) {
                            if(clock.ElapsedMilliseconds>=TimeoutMs || Now()>=p.receiptDeadline) { reason="TIMEOUT"; break; }
                        }
                        int? exit=reason=="PROCESS_EXITED" ? (int?)child.ExitCode : null;
                        job.Dispose(); // close even on parent exit; no orphaned ordinary descendants
                        if(!child.WaitForExit(2000)) reason="TERMINATION_UNCERTAIN";
                        byte[] a=new byte[0],b=new byte[0];
                        if(Task.WaitAll(new Task[] {output,error},2000)) { a=output.Result; b=error.Result; }
                        else reason="OUTPUT_UNCERTAIN";
                        string hash;
                        using(var data=new MemoryStream()) {
                            data.Write(BitConverter.GetBytes(a.Length),0,4); data.Write(a,0,a.Length);
                            data.Write(BitConverter.GetBytes(b.Length),0,4); data.Write(b,0,b.Length);
                            hash=Sha256(data.ToArray());
                        }
                        var returned=new Dictionary<string,object> { {"stdoutBase64",Convert.ToBase64String(a)},{"stderrBase64",Convert.ToBase64String(b)} };
                        int stdout=a.Length,stderr=b.Length;
                        Array.Clear(a,0,a.Length); Array.Clear(b,0,b.Length);
                        return new Execution { output=returned,observation=new Observation { requestId=p.requestId,digest=p.digest,grantId=p.grantId,consumptionId=p.consumptionId,
                            outcome=reason!="PROCESS_EXITED" ? "UNKNOWN" : exit==0 ? "SUCCEEDED" : "FAILED",reason=reason,
                            exitCode=exit,processId=child.Id,session=token.session,startedUtcTicks=identity.startedUtcTicks.ToString(System.Globalization.CultureInfo.InvariantCulture),
                            sid=token.sid,logonId=token.logonId,elevated=token.elevated,completedAt=Now(),
                            stdoutBytes=stdout,stderrBytes=stderr,outputTruncated=false,outputSha256=hash } };
                    } finally {
                        // Always release the Job even if stdin/stream cleanup fails.
                        job.Dispose();
                        try { child.StandardInput.Close(); } catch(IOException) {} catch(ObjectDisposedException) {} catch(InvalidOperationException) {}
                        // Before assignment only the fixed stdin bootstrap exists.
                        // Exact retained child only, never PID/name/process-tree lookup.
                        if(!assigned && !child.HasExited) { child.Kill(); child.WaitForExit(2000); }
                    }
                }
            }
        }
    }
}
