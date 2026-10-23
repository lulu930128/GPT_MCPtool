using System;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

// Read-only OS facts. No launch, breakaway, elevation, ACL mutation or lifecycle API.
public static class McpCcNormalNative {
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool GetTokenInformation(IntPtr token, int type, out int value, int length, out int returned);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public sealed class Proof {
        public int pid, session;
        public long startedUtcTicks;
        public string sid, image;
        public bool elevated, inAnyJob;
    }
    static Exception Error() { return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    public static Proof Inspect(Process process) {
        bool inJob;
        if (!IsProcessInJob(process.Handle, IntPtr.Zero, out inJob)) throw Error();
        IntPtr token;
        if (!OpenProcessToken(process.Handle, 8, out token)) throw Error(); // TOKEN_QUERY only
        try {
            int elevated, returned;
            if (!GetTokenInformation(token, 20, out elevated, 4, out returned) || returned != 4) throw Error();
            using (var identity = new WindowsIdentity(token)) {
                if (process.HasExited) throw new InvalidOperationException("OWNER_EXITED");
                return new Proof { pid=process.Id, session=process.SessionId,
                    startedUtcTicks=process.StartTime.ToUniversalTime().Ticks, sid=identity.User.Value,
                    image=process.MainModule.FileName, elevated=elevated!=0, inAnyJob=inJob };
            }
        } finally { CloseHandle(token); }
    }
    static void Match(Process process, Proof expected, bool independent) {
        var actual=Inspect(process);
        if (actual.pid!=expected.pid || actual.startedUtcTicks!=expected.startedUtcTicks ||
            actual.session!=expected.session || actual.sid!=expected.sid ||
            !String.Equals(actual.image,expected.image,StringComparison.OrdinalIgnoreCase) ||
            actual.elevated || (independent && actual.inAnyJob)) throw new InvalidOperationException("IPC_PEER_REJECTED");
    }
    // The caller must retain the expected Process handle across the entire exchange and recheck
    // immediately before consuming a canonical grant. PID/SID supplied by a message are not proof.
    public static void AssertServer(NamedPipeClientStream pipe, Process retained, Proof expected) {
        AssertServerIdentity(pipe,retained,expected);
        Match(retained,expected,true);
    }
    // OS transport identity only. Production composition separately requires an
    // independent Tray; isolated transports must not manufacture out-of-job proof.
    public static void AssertServerIdentity(NamedPipeClientStream pipe, Process retained, Proof expected) {
        uint pid; if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle,out pid)) throw Error();
        if (pid!=retained.Id) throw new InvalidOperationException("IPC_SERVER_REJECTED");
        Match(retained,expected,false);
    }
    public static void AssertClient(NamedPipeServerStream pipe, Process retained, Proof expected) {
        uint pid; if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle,out pid)) throw Error();
        if (pid!=retained.Id) throw new InvalidOperationException("IPC_CLIENT_REJECTED");
        string sid=null;
        pipe.RunAsClient(() => { using(var identity=WindowsIdentity.GetCurrent()) sid=identity.User.Value; });
        if (sid!=expected.sid) throw new InvalidOperationException("IPC_CLIENT_REJECTED");
        Match(retained,expected,false);
    }
}
