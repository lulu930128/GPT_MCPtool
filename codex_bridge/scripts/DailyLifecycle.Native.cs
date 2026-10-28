using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Diagnostics;
using System.Threading;
using System.Collections.Generic;
using Microsoft.Win32.SafeHandles;

// File identity and retained-handle rename for the existing daily lifecycle.
// No credential access, journal IO, or persistent service.
public sealed class CbDailyLockFile : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct FileInfo {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out SafeFileHandle copy, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
    readonly FileStream stream;
    readonly bool exclusive;
    public string Identity { get; private set; }
    public string Sha256 { get; private set; }
    public string Text { get; private set; }
    public bool MetadataDecoded { get; private set; }
    public static bool SameProcessStart(long left, long right) { return left>0 && right>0 && left/10==right/10; }
    CbDailyLockFile(SafeFileHandle handle, bool exclusive) {
        this.exclusive=exclusive;
        try {
            FileInfo info;
            if (!GetFileInformationByHandle(handle,out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if ((info.Attributes & (0x400u|0x10u))!=0 || info.Links!=1 || info.SizeHigh!=0 || info.SizeLow>4096)
                throw new InvalidOperationException("DAILY_LOCK_FILE_UNSAFE");
            Identity=info.Volume.ToString("x8")+":"+info.IndexHigh.ToString("x8")+info.IndexLow.ToString("x8");
            stream=new FileStream(handle,FileAccess.Read);
            byte[] bytes=new byte[info.SizeLow]; int offset=0;
            while(offset<bytes.Length) { int n=stream.Read(bytes,offset,bytes.Length-offset); if(n==0) throw new IOException("DAILY_LOCK_CHANGED"); offset+=n; }
            using(var sha=SHA256.Create()) Sha256=BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
            try { Text=new UTF8Encoding(false,true).GetString(bytes);MetadataDecoded=true; }
            catch(DecoderFallbackException) { Text=null;MetadataDecoded=false; }
        } catch { handle.Dispose(); throw; }
    }
    public static CbDailyLockFile Open(string path, bool exclusive) {
        // The exclusive handle denies writes AND replacement throughout validation/rename.
        var h=CreateFile(path,0x80000000u|(exclusive?0x10000u:0u),exclusive?0u:7u,IntPtr.Zero,3,0x00200000u,IntPtr.Zero);
        if(h.IsInvalid) { int error=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(error); }
        return new CbDailyLockFile(h,exclusive);
    }
    public void Retire(string destination, string identity, string sha256) {
        if(!exclusive || Identity!=identity || Sha256!=sha256) throw new InvalidOperationException("DAILY_LOCK_CHANGED");
        byte[] name=Encoding.Unicode.GetBytes(Path.GetFullPath(destination));
        int nameOffset=IntPtr.Size==8?20:12;
        IntPtr data=Marshal.AllocHGlobal(nameOffset+name.Length+2);
        try {
            for(int i=0;i<nameOffset;i++) Marshal.WriteByte(data,i,0); // ReplaceIfExists=false; RootDirectory=NULL
            Marshal.WriteInt32(data,nameOffset-4,name.Length);
            Marshal.Copy(name,0,IntPtr.Add(data,nameOffset),name.Length);
            Marshal.WriteInt16(data,nameOffset+name.Length,0);
            if(!SetFileInformationByHandle(stream.SafeFileHandle,3,data,(uint)(nameOffset+name.Length+2)))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { Marshal.FreeHGlobal(data); }
    }
    public static SafeFileHandle DuplicateUpdateLock(int parentPid, long rawHandle, string expectedPath) {
        IntPtr parent=OpenProcess(0x40,false,parentPid);
        if(parent==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        SafeFileHandle copy=null;
        try {
            if(!DuplicateHandle(parent,new IntPtr(rawHandle),GetCurrentProcess(),out copy,0,false,2))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            var path=new StringBuilder(32768);
            uint n=GetFinalPathNameByHandle(copy,path,(uint)path.Capacity,0);
            if(n==0 || n>=path.Capacity || !String.Equals(path.ToString(),"\\\\?\\"+Path.GetFullPath(expectedPath),StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("DAILY_DELEGATION_REJECTED");
            return copy;
        } catch { if(copy!=null) copy.Dispose();throw; }
        finally { CloseHandle(parent); }
    }
    public void Dispose() { if(stream!=null) stream.Dispose(); }
}

// A delegated helper can never retain update.lock indefinitely after its parent
// dies or stops waiting. Only THIS temporary helper exits; no runtime is killed.
public sealed class CbDailyLease : IDisposable {
    readonly SafeFileHandle file;
    readonly Process parent;
    readonly ManualResetEvent closed=new ManualResetEvent(false);
    readonly Thread watchdog;
    public CbDailyLease(SafeFileHandle file, int parentPid, int timeoutMilliseconds) {
        this.file=file;parent=Process.GetProcessById(parentPid);
        IntPtr retained=parent.Handle;
        watchdog=new Thread(delegate() {
            var clock=Stopwatch.StartNew();
            while(!closed.WaitOne(100)) {
                if(parent.HasExited || clock.ElapsedMilliseconds>=timeoutMilliseconds) Environment.Exit(78);
            }
        });
        watchdog.IsBackground=true;watchdog.Start();
    }
    public void Dispose() {
        closed.Set();watchdog.Join(1000);file.Dispose();parent.Dispose();closed.Dispose();
    }
}

// Scope ONLY the updater-created finite helpers (compiler, probes, shutdown).
// Creation is suspended until assigned, so even legacy grandchildren cannot
// escape the parent's lifetime. Never use this scope for starting a service.
public sealed class CbDailyChild : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Security { public int Size;public IntPtr Descriptor;public int Inherit; }
    [StructLayout(LayoutKind.Sequential)] struct Startup {
        public int Size;public IntPtr Reserved,Desktop,Title;public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
        public ushort Show,ReservedBytes;public IntPtr ReservedData,Input,Output,Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread;public uint Pid,Tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime,JobTime;public uint Flags;public UIntPtr MinWorking,MaxWorking;public uint Active;
        public UIntPtr Affinity;public uint Priority,Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ROp,WOp,OOp,RBytes,WBytes,OBytes; }
    [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimits Basic;public Io Io;public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limits limits,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User,Kernel,PeriodUser,PeriodKernel;public uint PageFaults,Total,Active,Terminated; }
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting value,uint size,IntPtr length);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out SafeFileHandle read,out SafeFileHandle write,ref Security security,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(SafeFileHandle handle,uint mask,uint flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern bool CreateProcess(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo info);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    IntPtr job;
    public Process Process { get; private set; }
    public StreamReader StandardOutput { get; private set; }
    public StreamReader StandardError { get; private set; }
    public bool HasExited { get { return Process.HasExited; } }
    public int ExitCode { get { return Process.ExitCode; } }
    public int Id { get { return Process.Id; } }
    public DateTime StartTime { get { return Process.StartTime; } }
    public bool WaitForExit(int milliseconds) { return Process.WaitForExit(milliseconds); }
    // Only this retained, unnamed creation scope. Never find a process by name
    // or re-open a PID when proving that a timed-out finite writer has stopped.
    public bool StopAndConfirm(int milliseconds) {
        if(job==IntPtr.Zero) return false;
        if(!TerminateJobObject(job,79)) return false;
        var watch=Stopwatch.StartNew();
        do {
            Accounting value;
            if(!QueryInformationJobObject(job,1,out value,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) return false;
            if(value.Active==0 && Process.HasExited) return true;
            Thread.Sleep(10);
        } while(watch.ElapsedMilliseconds<milliseconds);
        return false;
    }
    public static CbDailyChild Start(ProcessStartInfo info) { return StartCore(info,null,null); }
    public static CbDailyChild StartTracked(ProcessStartInfo info,string jobName,Action<Process> beforeResume) {
        if(!System.Text.RegularExpressions.Regex.IsMatch(jobName,@"\ALocal\\McpComponentBuild\.[0-9a-f]{32}\z") || beforeResume==null) throw new InvalidOperationException("DAILY_CHILD_TRACKING_INVALID");
        return StartCore(info,jobName,beforeResume);
    }
    public static string QueryTrackedState(string jobName) {
        if(!System.Text.RegularExpressions.Regex.IsMatch(jobName,@"\ALocal\\McpComponentBuild\.[0-9a-f]{32}\z")) return "UNKNOWN";
        IntPtr handle=OpenJobObject(4,false,jobName);
        if(handle==IntPtr.Zero) return Marshal.GetLastWin32Error()==2 ? "ABSENT" : "UNKNOWN";
        try { Accounting value;return QueryInformationJobObject(handle,1,out value,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero) ? (value.Active==0 ? "EMPTY" : "ACTIVE") : "UNKNOWN"; }
        finally {CloseHandle(handle);}
    }
    static CbDailyChild StartCore(ProcessStartInfo info,string jobName,Action<Process> beforeResume) {
        if(info.UseShellExecute || !info.CreateNoWindow || !Path.IsPathRooted(info.FileName)) throw new InvalidOperationException("DAILY_CHILD_OPTIONS_REJECTED");
        var child=new CbDailyChild();var pi=new ProcessInfo();IntPtr env=IntPtr.Zero;
        SafeFileHandle outRead=null,outWrite=null,errRead=null,errWrite=null;
        try {
            IntPtr createdJob=CreateJobObject(IntPtr.Zero,jobName);int jobError=Marshal.GetLastWin32Error();
            if(createdJob==IntPtr.Zero) throw new Win32Exception(jobError);
            if(jobName!=null && jobError==183) {CloseHandle(createdJob);throw new InvalidOperationException("DAILY_CHILD_TRACKING_COLLISION");}
            child.job=createdJob;
            var limits=new Limits();limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE; no breakaway or permission change.
            if(!SetInformationJobObject(child.job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits)))) throw new Win32Exception(Marshal.GetLastWin32Error());
            var security=new Security { Size=Marshal.SizeOf(typeof(Security)),Inherit=1 };
            if(!CreatePipe(out outRead,out outWrite,ref security,0) || !CreatePipe(out errRead,out errWrite,ref security,0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if(!SetHandleInformation(outRead,1,0) || !SetHandleInformation(errRead,1,0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var keys=new List<string>();foreach(string key in info.EnvironmentVariables.Keys) keys.Add(key);keys.Sort(StringComparer.OrdinalIgnoreCase);
            var block=new StringBuilder();foreach(string key in keys) block.Append(key).Append('=').Append(info.EnvironmentVariables[key]).Append('\0');block.Append('\0');
            env=Marshal.StringToHGlobalUni(block.ToString());
            var startup=new Startup { Size=Marshal.SizeOf(typeof(Startup)),Flags=0x100,Output=outWrite.DangerousGetHandle(),Error=errWrite.DangerousGetHandle() };
            // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW.
            string cwd=String.IsNullOrEmpty(info.WorkingDirectory)?null:info.WorkingDirectory;
            if(!CreateProcess(info.FileName,new StringBuilder("\""+info.FileName+"\" "+info.Arguments),IntPtr.Zero,IntPtr.Zero,true,0x08000404,env,cwd,ref startup,out pi)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if(!AssignProcessToJobObject(child.job,pi.Process)) throw new Win32Exception(Marshal.GetLastWin32Error());
            child.Process=Process.GetProcessById((int)pi.Pid);IntPtr retained=child.Process.Handle;
            child.StandardOutput=new StreamReader(new FileStream(outRead,FileAccess.Read),Encoding.UTF8);outRead=null;
            child.StandardError=new StreamReader(new FileStream(errRead,FileAccess.Read),Encoding.UTF8);errRead=null;
            if(beforeResume!=null) beforeResume(child.Process);
            if(ResumeThread(pi.Thread)==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
            return child;
        } catch {
            // Only the exact creation handle, before any unverified PID lookup.
            if(pi.Process!=IntPtr.Zero) TerminateProcess(pi.Process,79);
            child.Dispose();throw;
        } finally {
            if(pi.Thread!=IntPtr.Zero) CloseHandle(pi.Thread);if(pi.Process!=IntPtr.Zero) CloseHandle(pi.Process);
            if(outRead!=null) outRead.Dispose();if(errRead!=null) errRead.Dispose();
            if(outWrite!=null) outWrite.Dispose();if(errWrite!=null) errWrite.Dispose();
            if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
        }
    }
    public void Dispose() {
        if(job!=IntPtr.Zero) { CloseHandle(job);job=IntPtr.Zero; }
        if(Process!=null) { Process.WaitForExit(5000);Process.Dispose();Process=null; }
        if(StandardOutput!=null) StandardOutput.Dispose();if(StandardError!=null) StandardError.Dispose();
    }
}
