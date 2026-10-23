using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

// Read-only production token/peer checks. A successful observation is not human
// consent, installed-code provenance, a Grant, or permission to launch anything.
public static class McpCcNormalSecurity {
    [StructLayout(LayoutKind.Sequential)] internal struct Luid { public uint low; public int high;
        public override string ToString() { return ((uint)high).ToString("x8")+low.ToString("x8"); } }
    [StructLayout(LayoutKind.Sequential)] internal struct Statistics {
        public Luid tokenId, authenticationId; public long expiration;
        public int tokenType, impersonationLevel; public uint charged, available, groups, privileges;
        public Luid modifiedId;
    }
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int type, IntPtr value, int size, out int returned);
    [DllImport("advapi32.dll")] static extern bool IsTokenRestricted(IntPtr token);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);

    public sealed class TokenProof {
        public readonly string sid, tokenId, logonId, modifiedId;
        public readonly int integrityRid, session, tokenType, elevationType;
        public readonly bool elevated, restricted, appContainer;
        internal TokenProof(string user, Statistics s, int integrity, int tokenSession, int elevation,
            bool isElevated, bool isRestricted, bool isAppContainer) {
            sid=user; tokenId=s.tokenId.ToString(); logonId=s.authenticationId.ToString(); modifiedId=s.modifiedId.ToString();
            integrityRid=integrity; session=tokenSession; tokenType=s.tokenType; elevationType=elevation;
            elevated=isElevated; restricted=isRestricted; appContainer=isAppContainer;
        }
    }
    static IntPtr Information(IntPtr token, int kind, out int size) {
        GetTokenInformation(token,kind,IntPtr.Zero,0,out size);
        int error=Marshal.GetLastWin32Error();
        if (error!=122 || size<4 || size>65536) {
            var failure=new Win32Exception(error,"TOKEN_INFORMATION_UNAVAILABLE");
            failure.Data["operation"]="GetTokenInformation(size)";
            failure.Data["informationClass"]=kind; failure.Data["returnedBytes"]=size;
            throw failure;
        }
        IntPtr memory=Marshal.AllocHGlobal(size);
        try {
            int returned;
            if (!GetTokenInformation(token,kind,memory,size,out returned) || returned!=size)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return memory;
        } catch { Marshal.FreeHGlobal(memory); throw; }
    }
    static int Number(IntPtr token,int kind) {
        // Fixed DWORD classes need no sizing probe. Some Windows versions return
        // ERROR_BAD_LENGTH (24), rather than 122, for a zero-sized TokenElevation.
        IntPtr value=Marshal.AllocHGlobal(4);
        try {
            int size;
            if(!GetTokenInformation(token,kind,value,4,out size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if(size!=4) throw new InvalidOperationException("TOKEN_INFORMATION_INVALID");
            return Marshal.ReadInt32(value);
        }
        finally { Marshal.FreeHGlobal(value); }
    }
    static TokenProof ObserveToken(IntPtr token) {
        int size; Statistics statistics;
        IntPtr value=Information(token,10,out size); // TokenStatistics
        try {
            if(size!=Marshal.SizeOf(typeof(Statistics))) throw new InvalidOperationException("TOKEN_STATISTICS_INVALID");
            statistics=(Statistics)Marshal.PtrToStructure(value,typeof(Statistics));
        } finally { Marshal.FreeHGlobal(value); }
        int integrity;
        value=Information(token,25,out size); // TOKEN_MANDATORY_LABEL
        try {
            if(size<IntPtr.Size+4) throw new InvalidOperationException("TOKEN_INTEGRITY_INVALID");
            var label=new SecurityIdentifier(Marshal.ReadIntPtr(value));
            string prefix="S-1-16-";
            if(!label.Value.StartsWith(prefix,StringComparison.Ordinal) || !Int32.TryParse(label.Value.Substring(prefix.Length),out integrity))
                throw new InvalidOperationException("TOKEN_INTEGRITY_INVALID");
        } finally { Marshal.FreeHGlobal(value); }
        using(var identity=new WindowsIdentity(token)) {
            return new TokenProof(identity.User.Value,statistics,integrity,Number(token,12),Number(token,18),
                Number(token,20)!=0,IsTokenRestricted(token),Number(token,29)!=0);
        }
    }
    public static TokenProof Observe(Process retained) {
        IntPtr token;
        if(!OpenProcessToken(retained.Handle,8,out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var result=ObserveToken(token);
            if(retained.HasExited || retained.SessionId!=result.session) throw new InvalidOperationException("TOKEN_PROCESS_CHANGED");
            return result;
        } finally { CloseHandle(token); }
    }
    public static void AssertNormal(TokenProof proof,string expectedSid,int expectedSession) {
        if(proof==null || proof.sid!=expectedSid || proof.session!=expectedSession || proof.session<=0
            || proof.tokenType!=1 || proof.elevated || proof.elevationType==2 || proof.integrityRid!=0x2000
            || proof.restricted || proof.appContainer || proof.logonId=="0000000000000000")
            throw new InvalidOperationException("NORMAL_TOKEN_REJECTED");
    }
    public static void AssertUnchanged(Process retained,TokenProof expected) {
        var now=Observe(retained);
        if(expected==null || now.sid!=expected.sid || now.tokenId!=expected.tokenId || now.logonId!=expected.logonId
            || now.modifiedId!=expected.modifiedId || now.session!=expected.session || now.tokenType!=expected.tokenType
            || now.integrityRid!=expected.integrityRid || now.elevationType!=expected.elevationType
            || now.elevated!=expected.elevated || now.restricted!=expected.restricted || now.appContainer!=expected.appContainer)
            throw new InvalidOperationException("TOKEN_CHANGED");
    }
    // Exact pipe ACL, including owner and every ACE. An unexpected same-user
    // create-instance/write-DAC grant is rejected, not ignored as 'local'.
    public static void AssertPipeDescriptor(byte[] actual,string ownerSid,string clientSid) {
        var expected=new RawSecurityDescriptor(McpCcNormalPipe.Descriptor(ownerSid,clientSid),0);
        var observed=new RawSecurityDescriptor(actual,0);
        if(observed.Owner==null || observed.Owner.Value!=ownerSid || observed.DiscretionaryAcl==null
            || (observed.ControlFlags & ControlFlags.DiscretionaryAclProtected)==0
            || observed.DiscretionaryAcl.Count!=expected.DiscretionaryAcl.Count)
            throw new InvalidOperationException("IPC_DACL_REJECTED");
        for(int i=0;i<expected.DiscretionaryAcl.Count;i++) {
            var a=new byte[expected.DiscretionaryAcl[i].BinaryLength]; var b=new byte[observed.DiscretionaryAcl[i].BinaryLength];
            expected.DiscretionaryAcl[i].GetBinaryForm(a,0); observed.DiscretionaryAcl[i].GetBinaryForm(b,0);
            if(a.Length!=b.Length) throw new InvalidOperationException("IPC_DACL_REJECTED");
            for(int j=0;j<a.Length;j++) if(a[j]!=b[j]) throw new InvalidOperationException("IPC_DACL_REJECTED");
        }
    }
    public static void AssertServer(NamedPipeClientStream pipe,Process retained,TokenProof token,
        McpCcNormalNative.Proof identity,string clientSid,bool independent=true) {
        uint pid;
        if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle,out pid)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if(pid!=retained.Id) throw new InvalidOperationException("IPC_SERVER_REJECTED");
        if(independent) McpCcNormalNative.AssertServer(pipe,retained,identity);
        else McpCcNormalNative.AssertServerIdentity(pipe,retained,identity);
        AssertNormal(token,identity.sid,identity.session);
        AssertUnchanged(retained,token);
        AssertPipeDescriptor(pipe.GetAccessControl().GetSecurityDescriptorBinaryForm(),identity.sid,clientSid);
    }
    public static void AssertClient(NamedPipeServerStream pipe,Process retained,TokenProof token,
        McpCcNormalNative.Proof identity,string ownerSid) {
        uint pid;
        if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle,out pid)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if(pid!=retained.Id) throw new InvalidOperationException("IPC_CLIENT_REJECTED");
        McpCcNormalNative.AssertClient(pipe,retained,identity);
        AssertNormal(token,identity.sid,identity.session);
        AssertUnchanged(retained,token);
        pipe.RunAsClient(() => {
            using(var impersonated=WindowsIdentity.GetCurrent(true)) {
                if(impersonated==null) throw new InvalidOperationException("IPC_IMPERSONATION_REQUIRED");
                var observed=ObserveToken(impersonated.Token);
                if(observed.sid!=token.sid || observed.logonId!=token.logonId || observed.session!=token.session
                    || observed.integrityRid!=token.integrityRid || observed.restricted!=token.restricted
                    || observed.appContainer!=token.appContainer || observed.elevated!=token.elevated)
                    throw new InvalidOperationException("IPC_CLIENT_TOKEN_REJECTED");
            }
        });
        AssertPipeDescriptor(pipe.GetAccessControl().GetSecurityDescriptorBinaryForm(),ownerSid,token.sid);
    }
    public static int ObservedClientPid(NamedPipeServerStream pipe) {
        uint pid;
        if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle,out pid) || pid>Int32.MaxValue)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return (int)pid;
    }
}
