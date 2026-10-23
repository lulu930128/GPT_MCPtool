# Read-only current-process evidence; no deployment paths, secrets, ACL changes or launch.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
try {
    if (-not ('NormalMarkerPreflight' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NormalMarkerPreflight {
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    public static bool InJob() {
        bool member;
        if (!IsProcessInJob(System.Diagnostics.Process.GetCurrentProcess().Handle, IntPtr.Zero, out member))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return member;
    }
}
'@
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $inJob = [NormalMarkerPreflight]::InJob()
    [ordered]@{
        contract='normal-marker-preflight-v1'; pid=$PID; sid=$identity.User.Value;
        elevated=$elevated; inAnyJob=$inJob; enabled=$false;
        status='BLOCKED_HOST_ACCEPTANCE'; osAcl='UNVERIFIED'; peerIdentity='UNVERIFIED';
        normal='BLOCKED_HOST_ACCEPTANCE'; admin='BLOCKED_AWAITING_LOCAL_UAC'
    } | ConvertTo-Json -Compress
    exit 0 # successful observation is NOT host acceptance
} catch {
    [ordered]@{ contract='normal-marker-preflight-v1'; enabled=$false;
        status='PREFLIGHT_FAILED'; errorType=$_.Exception.GetType().FullName;
        hresult=$_.Exception.HResult; nativeErrorCode=$_.Exception.NativeErrorCode
    } | ConvertTo-Json -Compress
    exit 1
}
