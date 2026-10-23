using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

// One OS process object from inspection through termination and exit wait.
// Never reacquire by PID after validation; no process-name or tree termination.
public sealed class CbOwnedProcess : IDisposable
{
    private readonly SafeProcessHandle handle;
    public int ProcessId { get; private set; }
    public string ExecutablePath { get; private set; }
    public string StartTimeUtc { get; private set; }

    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetProcessTimes(SafeProcessHandle h, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool QueryFullProcessImageName(SafeProcessHandle h, int flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool TerminateProcess(SafeProcessHandle h, uint code);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern uint WaitForSingleObject(SafeProcessHandle h, uint milliseconds);

    public CbOwnedProcess(int pid) : this(pid, false) { }
    public CbOwnedProcess(int pid, bool queryOnly)
    {
        // PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
        handle = OpenProcess(queryOnly ? 0x00101000u : 0x00101001u, false, pid);
        if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
        try {
            ProcessId = pid;
            long creation, exit, kernel, user;
            if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
            StartTimeUtc = DateTime.FromFileTimeUtc(creation).ToString("o");
            var path = new StringBuilder(32768); int size = path.Capacity;
            if (!QueryFullProcessImageName(handle, 0, path, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            ExecutablePath = path.ToString();
            if (HasExited) throw new InvalidOperationException("PROCESS_EXITED_BEFORE_VALIDATION");
        } catch { handle.Dispose(); throw; }
    }

    public bool HasExited {
        get {
            if (handle.IsClosed) throw new ObjectDisposedException("CbOwnedProcess");
            uint result = WaitForSingleObject(handle, 0);
            if (result == 0) return true;
            if (result == 258) return false;
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }
    public void TerminateAndWait()
    {
        if (handle.IsClosed) throw new ObjectDisposedException("CbOwnedProcess");
        if (HasExited) throw new InvalidOperationException("PROCESS_EXITED_BEFORE_TERMINATION");
        if (!TerminateProcess(handle, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint result = WaitForSingleObject(handle, 5000);
        if (result == 258) throw new TimeoutException("STOP_TIMEOUT");
        if (result != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public void WaitForExit(int milliseconds)
    {
        if (milliseconds < 1 || milliseconds > 30000) throw new ArgumentOutOfRangeException("milliseconds");
        uint result = WaitForSingleObject(handle, (uint)milliseconds);
        if (result == 258) throw new TimeoutException("COOPERATIVE_SHUTDOWN_UNKNOWN");
        if (result != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public void Dispose() { handle.Dispose(); }
}

// Used only after the installed Controller validates its fixed executable,
// arguments, working directory and environment. Keep the caller's token and job
// membership, but inherit only NUL: never a Controller/Operator output pipe.
public static class CbDetachedProcess
{
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes {
        public int Length; public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public ushort ShowWindow, ReservedBytes;
        public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx { public StartupInfo Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
        ref SecurityAttributes attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr bytes);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute,
        IntPtr value, IntPtr bytes, IntPtr previous, IntPtr returnedBytes);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool CreateProcessW(string application, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
        IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static Process Start(ProcessStartInfo info)
    {
        if (info == null) throw new ArgumentNullException("info");
        if (info.UseShellExecute || !info.CreateNoWindow || info.RedirectStandardInput ||
            info.RedirectStandardOutput || info.RedirectStandardError ||
            !String.IsNullOrEmpty(info.UserName) || !String.IsNullOrEmpty(info.Domain) ||
            info.Password != null || !String.IsNullOrEmpty(info.Verb) || info.LoadUserProfile)
            throw new InvalidOperationException("INSTALLED_CHILD_START_OPTIONS_REJECTED");
        if (String.IsNullOrEmpty(info.FileName) || !Path.IsPathRooted(info.FileName) ||
            !String.Equals(Path.GetFullPath(info.FileName), info.FileName, StringComparison.OrdinalIgnoreCase) ||
            info.FileName.IndexOf('"') >= 0 || info.FileName.IndexOf('\0') >= 0 ||
            String.IsNullOrEmpty(info.WorkingDirectory) || !Path.IsPathRooted(info.WorkingDirectory) ||
            !String.Equals(Path.GetFullPath(info.WorkingDirectory), info.WorkingDirectory, StringComparison.OrdinalIgnoreCase) ||
            info.Arguments.IndexOf('\0') >= 0)
            throw new InvalidOperationException("INSTALLED_CHILD_START_PATH_REJECTED");
        var commandLine = new StringBuilder("\"" + info.FileName + "\" " + info.Arguments);
        if (commandLine.Length >= 32767) throw new InvalidOperationException("INSTALLED_CHILD_COMMAND_TOO_LONG");
        var keys = new List<string>();
        foreach (string key in info.EnvironmentVariables.Keys) keys.Add(key);
        keys.Sort(StringComparer.OrdinalIgnoreCase);
        var environmentText = new StringBuilder();
        foreach (string key in keys) {
            string value = info.EnvironmentVariables[key];
            if (String.IsNullOrEmpty(key) || key.IndexOf('=') >= 0 || key.IndexOf('\0') >= 0 ||
                value == null || value.IndexOf('\0') >= 0)
                throw new InvalidOperationException("INSTALLED_CHILD_ENVIRONMENT_REJECTED");
            environmentText.Append(key).Append('=').Append(value).Append('\0');
        }
        environmentText.Append('\0');
        if (keys.Count == 0) environmentText.Append('\0');
        IntPtr environment = IntPtr.Zero, attributeList = IntPtr.Zero, handles = IntPtr.Zero;
        bool initialized = false;
        var pi = new ProcessInformation();
        SafeFileHandle nul = null;
        Process result = null;
        try {
            environment = Marshal.StringToHGlobalUni(environmentText.ToString());
            var sa = new SecurityAttributes { Length=Marshal.SizeOf(typeof(SecurityAttributes)), Inherit=true };
            nul = CreateFileW("NUL", 0xC0000000u, 3, ref sa, 3, 0, IntPtr.Zero);
            if (nul.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            IntPtr bytes = IntPtr.Zero;
            // The first call intentionally reports the required allocation size.
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
            if (bytes == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            attributeList = Marshal.AllocHGlobal(bytes);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref bytes))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            initialized = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(handles, nul.DangerousGetHandle());
            // PROC_THREAD_ATTRIBUTE_HANDLE_LIST (0x00020002).
            if (!UpdateProcThreadAttribute(attributeList, 0, new UIntPtr(0x00020002u),
                handles, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            var si = new StartupInfoEx();
            si.Startup.Size = Marshal.SizeOf(typeof(StartupInfoEx));
            si.Startup.Flags = 0x100; // STARTF_USESTDHANDLES
            si.Startup.Input = si.Startup.Output = si.Startup.Error = nul.DangerousGetHandle();
            si.Attributes = attributeList;
            // CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT.
            // No breakaway, alternate token, parent override or elevation.
            if (!CreateProcessW(info.FileName, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                0x08080400u, environment, info.WorkingDirectory, ref si, out pi))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            long created, exited, kernel, user, observed, observedExit, observedKernel, observedUser;
            if (!GetProcessTimes(pi.Process, out created, out exited, out kernel, out user))
                throw new InvalidOperationException("INSTALLED_CHILD_START_UNKNOWN_DO_NOT_RETRY");
            result = Process.GetProcessById(checked((int)pi.ProcessId));
            // Acquire the managed handle while the original creation handle is
            // still held, then verify it names the same process instance.
            if (!GetProcessTimes(result.Handle, out observed, out observedExit, out observedKernel, out observedUser) ||
                observed != created)
                throw new InvalidOperationException("INSTALLED_CHILD_START_UNKNOWN_DO_NOT_RETRY");
            return result;
        } catch {
            if (result != null) result.Dispose();
            // An uncertain child is never killed or automatically re-created.
            throw;
        } finally {
            if (pi.Thread != IntPtr.Zero) CloseHandle(pi.Thread);
            if (pi.Process != IntPtr.Zero) CloseHandle(pi.Process);
            if (initialized) DeleteProcThreadAttributeList(attributeList);
            if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (nul != null) nul.Dispose();
            if (environment != IntPtr.Zero) {
                for (int i=0; i <= environmentText.Length; i++) Marshal.WriteInt16(environment, i*2, 0);
                Marshal.FreeHGlobal(environment);
            }
        }
    }
}
