using System;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

// Only local transport/authentication primitives. No process launch or lifecycle implementation.
public static class McpCcReloadNative {
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetNamedPipeClientSessionId(SafePipeHandle pipe, out uint session);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint instances,
        uint outputSize, uint inputSize, uint timeout, ref SecurityAttributes security);

    public static bool OutsideAllJobs() {
        bool member;
        if (!IsProcessInJob(System.Diagnostics.Process.GetCurrentProcess().Handle, IntPtr.Zero, out member))
            throw new InvalidOperationException("OWNER_JOB_UNKNOWN");
        return !member;
    }
    public static NamedPipeServerStream OpenPipe(string ownerSid, string bridgeSid) {
        return OpenPipe(ownerSid, bridgeSid, "McpCc.CodexBridge.Reload.R1");
    }
    public static NamedPipeServerStream OpenPipe(string ownerSid, string bridgeSid, string name) {
        var acl = new PipeSecurity();
        acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(ownerSid), PipeAccessRights.FullControl, AccessControlType.Allow));
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(bridgeSid), PipeAccessRights.ReadWrite, AccessControlType.Allow));
        // Deny network logons even when the same account can authenticate over SMB.
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier("S-1-5-2"), PipeAccessRights.FullControl, AccessControlType.Deny));
        var descriptor=acl.GetSecurityDescriptorBinaryForm(); var memory=Marshal.AllocHGlobal(descriptor.Length);
        try {
            Marshal.Copy(descriptor,0,memory,descriptor.Length);
            var security=new SecurityAttributes { Length=Marshal.SizeOf(typeof(SecurityAttributes)),Descriptor=memory,Inherit=0 };
            // FIRST_PIPE_INSTANCE + OVERLAPPED; REJECT_REMOTE_CLIENTS. .NET Framework PipeOptions
            // rejects FIRST_PIPE_INSTANCE, so create the handle natively and retain it for the owner lifetime.
            var handle=CreateNamedPipe(@"\\.\pipe\"+name,0x40080003,8,1,16384,16384,0,ref security);
            if(handle.IsInvalid) {handle.Dispose();throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
            try {return new NamedPipeServerStream(PipeDirection.InOut,true,false,handle);} catch {handle.Dispose();throw;}
        } finally {Marshal.FreeHGlobal(memory);}
    }
    public static int ServerPid(NamedPipeClientStream pipe) {
        uint pid;
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out pid) || pid == 0) throw new InvalidOperationException("IPC_IDENTITY_UNKNOWN");
        return checked((int)pid);
    }
    public static bool OutsideJobs(System.Diagnostics.Process process) {
        bool member;
        if (!IsProcessInJob(process.Handle, IntPtr.Zero, out member)) throw new InvalidOperationException("OWNER_JOB_UNKNOWN");
        return !member;
    }
    public static int ClientPid(NamedPipeServerStream pipe, string sid) {
        uint pid, session;
        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out pid) ||
            !GetNamedPipeClientSessionId(pipe.SafePipeHandle, out session)) throw new InvalidOperationException("IPC_IDENTITY_UNKNOWN");
        string actual = null;
        pipe.RunAsClient(() => { actual = WindowsIdentity.GetCurrent().User.Value; });
        if (actual != sid || pid == 0) throw new InvalidOperationException("IPC_UNAUTHORIZED");
        return checked((int)pid);
    }
    public static byte[] Decode(string value) {
        if (value == null || value.Length == 0 || value.Length > 8192 ||
            value.Any(c => !(char.IsLetterOrDigit(c) && c < 128 || c == '-' || c == '_')))
            throw new InvalidOperationException("INVALID_ASSERTION");
        string b64 = value.Replace('-', '+').Replace('_', '/');
        var bytes = Convert.FromBase64String(b64.PadRight((b64.Length + 3) / 4 * 4, '='));
        if (Encode(bytes) != value) throw new InvalidOperationException("INVALID_ASSERTION");
        return bytes;
    }
    public static string Encode(byte[] bytes) { return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_'); }
    public static byte[] Hash(byte[] bytes) { using (var h = SHA256.Create()) return h.ComputeHash(bytes); }
    public static string Digest(string text) { return BitConverter.ToString(Hash(System.Text.Encoding.UTF8.GetBytes(text))).Replace("-", "").ToLowerInvariant(); }
    public static string Nonce() { var bytes = new byte[32]; using (var r = RandomNumberGenerator.Create()) r.GetBytes(bytes); return Encode(bytes); }
    static byte[] DerSignature(byte[] der) {
        // ES256 ASN.1 DER: two minimally encoded positive integers, converted to CNG P1363.
        if (der.Length < 8 || der.Length > 72 || der[0] != 0x30 || der[1] != der.Length - 2) throw new InvalidOperationException("INVALID_SIGNATURE");
        var result = new byte[64]; int offset = 2;
        for (int part=0; part<2; part++) {
            if (offset + 2 > der.Length || der[offset++] != 2) throw new InvalidOperationException("INVALID_SIGNATURE");
            int len = der[offset++];
            if (len < 1 || len > 33 || offset + len > der.Length || (der[offset] & 128) != 0) throw new InvalidOperationException("INVALID_SIGNATURE");
            if (len > 1 && der[offset] == 0) {
                if ((der[offset+1] & 128) == 0) throw new InvalidOperationException("INVALID_SIGNATURE");
                offset++; len--;
            }
            if (len > 32) throw new InvalidOperationException("INVALID_SIGNATURE");
            Buffer.BlockCopy(der, offset, result, part*32+32-len, len); offset += len;
        }
        if (offset != der.Length) throw new InvalidOperationException("INVALID_SIGNATURE");
        return result;
    }
    public static void Verify(string x, string y, string rpId, string auth, string client, string signature) {
        var a = Decode(auth); var c = Decode(client); var px = Decode(x); var py = Decode(y);
        // No extensions or attested credential data in R1. Require UP and UV; disallow reserved bits.
        if (a.Length != 37 || (a[32] & 5) != 5 || (a[32] & 0xE2) != 0 ||
            !a.Take(32).SequenceEqual(Hash(System.Text.Encoding.UTF8.GetBytes(rpId))) || px.Length != 32 || py.Length != 32)
            throw new InvalidOperationException("INVALID_ASSERTION");
        if ((a[32] & 16) != 0 && (a[32] & 8) == 0) throw new InvalidOperationException("INVALID_ASSERTION");
        byte[] blob = new byte[72];
        Buffer.BlockCopy(BitConverter.GetBytes(0x31534345),0,blob,0,4); // BCRYPT_ECDSA_PUBLIC_P256_MAGIC
        Buffer.BlockCopy(BitConverter.GetBytes(32),0,blob,4,4);
        Buffer.BlockCopy(px,0,blob,8,32); Buffer.BlockCopy(py,0,blob,40,32);
        using (var key=CngKey.Import(blob,CngKeyBlobFormat.EccPublicBlob))
        using (var ecdsa=new ECDsaCng(key)) {
            if (!ecdsa.VerifyHash(Hash(a.Concat(Hash(c)).ToArray()), DerSignature(Decode(signature))))
                throw new InvalidOperationException("INVALID_SIGNATURE");
        }
    }
}
