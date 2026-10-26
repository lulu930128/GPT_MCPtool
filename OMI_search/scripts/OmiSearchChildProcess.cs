using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Private launch primitive for Start-OmiChildProcess, not a lifecycle owner.
// Windows PowerShell/.NET Framework ProcessStartInfo cannot redirect stdio to
// NUL directly. Long-lived children must not retain the controller's JSON pipes.
// https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw
// https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
public static class OmiSearchChildProcess
{
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { public int Size; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public int X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public short ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx { public StartupInfo Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { public IntPtr Process, Thread; public int Pid, Tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static Process StartDetached(ProcessStartInfo info)
    {
        if (info.UseShellExecute || info.RedirectStandardInput || info.RedirectStandardOutput || info.RedirectStandardError)
            throw new InvalidOperationException("CHILD_START_CONFIGURATION_INVALID");
        IntPtr attributes = IntPtr.Zero, handleList = IntPtr.Zero, environment = IntPtr.Zero;
        int environmentBytes = 0;
        bool initialized = false, resumed = false;
        ProcessInformation native = new ProcessInformation();
        Process managed = null;
        var security = new SecurityAttributes { Size = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = 1 };
        using (SafeFileHandle nul = CreateFile("NUL", 0xC0000000, 3, ref security, 3, 0, IntPtr.Zero))
        {
            try
            {
                if (nul.IsInvalid) throw new InvalidOperationException("CHILD_STDIO_UNAVAILABLE");
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                attributes = Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size))
                    throw new InvalidOperationException("CHILD_HANDLE_LIST_UNAVAILABLE");
                initialized = true;
                handleList = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(handleList, nul.DangerousGetHandle());
                // Explicit allowlist prevents all ambient controller pipe handles
                // from leaking into children, without changing parent std handles.
                if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handleList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                    throw new InvalidOperationException("CHILD_HANDLE_LIST_UNAVAILABLE");
                var startup = new StartupInfoEx();
                startup.Startup.Size = Marshal.SizeOf(typeof(StartupInfoEx));
                startup.Startup.Flags = 0x101; // USESTDHANDLES | USESHOWWINDOW (hidden)
                startup.Startup.Input = startup.Startup.Output = startup.Startup.Error = nul.DangerousGetHandle();
                startup.Attributes = attributes;
                var keys = new List<string>();
                foreach (string key in info.EnvironmentVariables.Keys) keys.Add(key);
                keys.Sort(StringComparer.OrdinalIgnoreCase);
                var block = new StringBuilder();
                foreach (string key in keys) block.Append(key).Append('=').Append(info.EnvironmentVariables[key]).Append('\0');
                block.Append('\0');
                environmentBytes = checked((block.Length + 1) * 2);
                environment = Marshal.StringToHGlobalUni(block.ToString());
                block.Clear();
                // Keep the original executable and arguments, including venv
                // redirectors. No wrapper process, alternate identity or shell.
                var command = new StringBuilder("\"" + info.FileName + "\" " + info.Arguments);
                // NO_WINDOW | UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO | SUSPENDED
                if (!CreateProcessW(info.FileName, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080404,
                    environment, info.WorkingDirectory, ref startup, out native))
                    throw new InvalidOperationException("CHILD_PROCESS_START_FAILED");
                // Retain a managed handle before allowing the exact new process
                // to run. The original native handle stays open through binding.
                managed = Process.GetProcessById(native.Pid);
                IntPtr retained = managed.Handle;
                if (ResumeThread(native.Thread) == UInt32.MaxValue)
                    throw new InvalidOperationException("CHILD_PROCESS_RESUME_FAILED");
                resumed = true;
                return managed;
            }
            finally
            {
                if (!resumed && native.Process != IntPtr.Zero) TerminateProcess(native.Process, 1);
                if (!resumed && managed != null) managed.Dispose();
                if (native.Thread != IntPtr.Zero) CloseHandle(native.Thread);
                if (native.Process != IntPtr.Zero) CloseHandle(native.Process);
                if (environment != IntPtr.Zero)
                {
                    // Environment blocks contain embedded NULs: zero the whole
                    // allocation, not only the first variable's string.
                    for (int index = 0; index < environmentBytes; index++) Marshal.WriteByte(environment, index, 0);
                    Marshal.FreeHGlobal(environment);
                }
                if (initialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            }
        }
    }
}
